---
Proposal Name: pipeline-linting
Start Date: 2026-10-20
RFC PR: open-telemetry/otel-arrow#0000
Tracking Issue: open-telemetry/otel-arrow#0000
---

# RFC 0007: Pipeline Linting

## Summary

The goal of this RFC is to describe how we can incorporate static pipeline checks into
the Dataflow Engine project with the goal of reducing the number of mistakes pipeline
authors can make. 

## Motivation

In the Dataflow Engine, we design nodes under the philosophy of composability. Each
node offers simple and unique behaviors that can be composed together into a pipeline
to express more complicated logic. This is not unlike a programming language, which 
may expose simple product types, functions, conditionals, and loops that can 
be composed into an arbitrary program.

Not all pipeline programs that can be expressed in the language of nodes, connections,
and configurations are good ones. Some nodes (probably) should not be placed before
or after others, and some combinations of node configurations are unlikely to yield
good results for performance, correctness, or other reasons.

The rules are many and it is unreasonable for any human (or agent), experienced or not,
to be aware of the constantly evolving set of nodes and configurations nor the accumulated
wisdom in how best to use them, let alone, consistently and perfectly apply these rules
in practice.

Additionally, organizations and individual users are likely to have their own individual
preferences or guidelines for pipelines that they want to follow.

Programming languages have solved this problem through static program linters like clippy.
We can do the same for Dataflow Engine pipelines.

## Guide-level explanation

Pipeline linting is deliberately modeled on rustc's lint system and
[clippy](https://github.com/rust-lang/rust-clippy). Most of what Rust
programmers already do with lints (silence one false positive or deny a whole
category in CI) is also what pipeline authors and engine operators need. Reusing
the same model gives us a proven design and makes the system easy to explain 
to anyone who has used clippy.

### What is a lint?

A lint is a single rule about how pipelines or nodes should generally be
constructed. Every lint has:

- a stable **name** (see [Lint names](#lint-names)),
- exactly one **category**, which determines its default enforcement level
- **documentation** explaining what the lint detects, why it matters, and how
  to fix it.

Lints are distinct from config validation. Config Validation is concerned with the
question "does this pipeline/node even compile?" and validation failures are hard
errors that cannot be suppressed. For example, if a config property has the wrong
type or if a connection references a node that doesn't exist.

Lints on the other hand say "this pipeline can run, but it probably shouldn't look 
like this" and are fully configurable. Lints only run on configurations that have
some level of sanity and already passed validation, just as clippy only runs on
code that type-checks. For example, while "correct", it's not recommended to place a
retry processor before the batch processor, as you may duplicate batching work
unnecessarily.

The basic pipeline for linting:

```text
 YAML --> parse --> validate --------------> lint ----------------> admit / reject
          (serde)   hard errors:             only runs on configs
                    cycles, unknown URNs,    that validated; the
                    bad ports, ...           resolved levels decide
                    never suppressible       the outcome
```

### Where lints come from

There are three sources of lints:

- **The engine** defines engine lints, including the meta lints.
- **Nodes** define lints about their own use, for example rules about their
  configuration or their position in a pipeline. A node lint may inspect the
  rest of the pipeline and other node types.
- **Extensions** can define lints. This is how organisations add their own
  rules, for example forbidding a particular node or configuration, without
  writing a node. Such lints are namespaced by the extension's URN.

Which lints are *active* for a given pipeline depends on the
pipeline:

| Source    | Active in                                                                                                                                                      | Initial level |
|-----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| Engine    | Every pipeline                                                                                                                                                 | Its default   |
| Node      | Pipelines that contain at least one node of that type                                                                                                          | Its default   |
| Extension | The scope where the extension is declared (every pipeline for a controller extension in `engine.controller.extensions`, one pipeline for a pipeline extension) | Its default   |

```text
 1. names known     all engine, node, and extension lint names (compiled in)
 2. validate        config validation, including extension configs
 3. activate        per pipeline: engine lints
                                + lints of node types used in the pipeline
                                + lints of extensions declared in scope
 4. resolve         levels resolved from lints: blocks; forbid checked
 5. run             active lints run; diagnostics reported or pipeline rejected
```

### Meta lints

A few engine lints report problems with the lint configuration itself. They
are ordinary lints and can be configured like any other.

| Lint                            | Category     | Fires when                                                                     |
|---------------------------------|--------------|--------------------------------------------------------------------------------|
| `unknown_lints`                 | `suspicious` | A `lints:` block names a lint, component, or category the engine does not know |
| `renamed_and_removed_lints`     | `suspicious` | A `lints:` block uses a renamed or removed lint name                           |
| `unfulfilled_lint_expectations` | `suspicious` | An `expect` entry's lint did not fire                                          |


`lints:` entries apply on top of these defaults in the usual way. In
particular, an extension's defaults never override a `forbid` from an
enclosing scope.

### Lint names

Lints are referred to by name. There are two categories of lints - Engine lints
and Component lints.

**Engine lints** are defined by the engine itself, are not tied to any component,
and therefore have no prefix, like rustc's built-in lints:

```text
unconnected_node
unknown_lints
```

**Component lints** are defined by a node or an extension and are namespaced
according to the component's URN (see [URN format](../docs/urns.md)). The vast
majority of lints are in this category. Lints follow the same shortcut rules
as component urns:

```text
urn:otel:processor:batch:<lint_id>                    canonical form
processor:batch:<lint_id>                             otel shortcut form
urn:acme:extension:prod_policy:no_debug_exporters     third-party lint
```

Rules:

- The otel shortcut form follows the same rule as node URNs: it is only
  valid for the `otel` namespace. All other namespaces must use the full
  `urn:` form. Because the `otel` namespace is reserved, so are lints
  defined by otel components.
- A lint id uses the same character set as URN segments (`[a-z0-9._-]`) and
  cannot contain `:`.
- The category names (`correctness`, `suspicious`, `perf`, `style`) and
  `warnings` are reserved and may not be used as lint ids, so that they
  remain unambiguous as [selectors](#selectors).
- Lint names are stable. A lint that is renamed keeps its old name as an
  alias, and using the alias triggers `renamed_and_removed_lints`. Removing
  a lint entirely is considered a breaking change.
- Defining the same fully qualified lint name twice is a hard error when the
  engine starts.

### Lint scopes

For now, lints operate on a single pipeline at a time. A lint may inspect any node,
connection, or setting within that pipeline (including the settings it inherits from
its group and the root). In the future we may extend lints to operate across pipelines,
including those connected by a topic.

Each diagnostic has exactly one **primary location**, which is the engine root,
a group, a pipeline, or a node. A diagnostic that concerns several nodes
(for example, a rule about node ordering) picks one of them as its primary
location and lists the others as related locations, similar to rustc's
secondary spans. The primary location determines which configurations apply
when resolving the diagnostic's level. More on that below.

The engine's observability pipeline (`engine.observability.pipeline`) is
linted like any other pipeline. It has no group, so its scopes are the root,
the observability pipeline itself, and its nodes.

### Enforcement Levels

Enforcement levels determine if a lint is enforced and if it's a warning or error.
Errors will prevent the creation of pipelines that don't pass the lint, whereas
warnings are just reported as events.

| Level    | Reported?                                   | Overrideable? | 
|----------|---------------------------------------------|---------------|
| `allow`  | No                                          | Yes           |
| `expect` | Yes, warning if unfulfilled                 | Yes           |
| `warn`   | Yes, as a warning                           | Yes           |
| `deny`   | Yes, as an error                            | Yes           |
| `forbid` | Yes, as an error                            | **No**        |

### Categories

Every lint belongs to exactly one of a fixed set of categories which defines the
default enforcement level.

| Category      | Default Level | Meaning                                                                                                  |
|---------------|---------------|-------------------------------------------------------------------------------------------------|
| `correctness` | deny | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | warn | Probably a mistake, but there are legitimate uses.                                                       |
| `perf`        | warn | Correct, but wastes CPU, memory, or throughput.                                                          |
| `style`       | warn | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

A useful test when classifying a lint: *is there any configuration where
this is what the author wanted?* If not, it is `correctness`. If rarely, it
is `suspicious`. If it is fine but costly, it is `perf`. If it is fine but
untidy, it is `style`.

TODO: Concrete example lints for each category.

### Selectors

Lints are referenced via **selectors**. The basic selector is the fully qualified lint
urn, but selectors can refer to classes of lints based on component or category:

| Selector             | Example                     | Matches                                                                                                  |
|----------------------|-----------------------------|----------------------------------------------------------------------------------------------------------|
| Full Urn             | `processor:batch:<lint_id>` | Exactly one lint                                                                                         |
| Component + category | `processor:batch:perf`      | Lints defined by that component in that category                                                         |
| Component            | `processor:batch`           | All lints defined by that component                                                                      |
| Category             | `correctness`               | All lints in that category, from every source                                                            |

Engine lints are selected by their bare name (e.g. `unconnected_node`) and
categories are also reserved names that select the entire category of lints at
the specified scope.

### Configuring lints

Lints are configured with a `lints:` block, which can appear at four scopes:
the root of the config, a pipeline group, a pipeline, and a node. Each entry
maps a selector to a level.

```yaml
version: otel_dataflow/v1
lints:                                          # root scope
  correctness: forbid
  warnings: deny
engine:
  lint_cap: warn                                # operator-only, see "Capping lint levels"
groups:
  dev:
    lints:                                      # group scope
      perf: allow
    pipelines:
      main:
        lints:                                  # pipeline scope
          processor:batch:<lint_id>: warn       # TODO: real example
          urn:acme:extension:prod_policy: allow
        nodes:
          debug:
            type: processor:debug
            lints:                              # node scope
              # connected by a follow-up reconfiguration
              unconnected_node: warn
```

When several entries in the **same** `lints:` block match a lint, the most
specific one wins. In order of most to least specific:

```text
full urn  >  component + category  >  component  >  category
```

A dedicated `lints:` block is used rather than a field in `policies`.
Policies are resolved by taking the first scope that sets a field and
replacing the field wholesale, while lint configuration has to be merged per
selector. For example if the root lints block sets `correctness: forbid`, then
enabling a specific lint at the pipeline level should not remove that. Policies
also do not exist at node scope, which is useful for individual suppressions.

### Resolving a lint's level

The level of a diagnostic is resolved from its primary location outwards.

```text
 CLI flags                    (outermost)   ^
   root        lints:                       |  search from the innermost
     group       lints:                     |  scope outwards; the first
       pipeline    lints:                   |  scope with a matching entry
         node        lints:   (innermost)   |  wins
              ^
              diagnostic's primary location
```

TODO: Move the description of the algorithm to the implementation section

For each diagnostic:

1. **Find the configured level.** Walk from the innermost scope outwards.
   In the first scope that has any entry matching the lint, take the most
   specific matching entry. If no scope matches, use the lint's default
   level.
2. **Apply `warnings`.** If the level is `warn` and the `warnings` selector
   resolves to `deny` or `forbid` at this location, the level becomes `deny`.
3. **Apply the cap.** If `lint_cap` is set, the level is lowered to at most
   the cap.
4. **Act on the level.** `allow` drops the diagnostic. `warn` reports it.
   `deny` and `forbid` report it and reject the pipeline.

### `forbid`

`forbid` behaves like `deny`, except that once a lint is forbidden in some
scope, no inner scope and no more specific selector in the same scope may
change its level. Attempting to do so is a **hard validation error**, not a
lint, so it cannot itself be suppressed. This mirrors rustc's `E0453`.

```yaml
lints:
  correctness: forbid
groups:
  default:
    pipelines:
      main:
        lints:
          processor:batch:<lint_id>: allow   # error if <lint_id> is a correctness lint
```

### Capping lint levels

The lint cap sets a **maximum severity** for all diagnostics. It does not
limit the number of lints. It corresponds to rustc's `--cap-lints`, which
Cargo uses so that a dependency's `#![deny(warnings)]` cannot break your
build.

```text
configured level:   allow   warn   deny   forbid
with cap = warn:    allow   warn   warn   warn      <- nothing blocks admission
```

The cap is the break-glass mechanism for "allow pipelines even with lint
errors", for example to keep a pipeline running during an incident without
editing every `lints:` block. It lowers the severity of forbidden lints, but
does not permit inner scopes to override them.

Because it can defeat `forbid`, the cap is operator-only. It can be set in
`engine.lint_cap` or with `--cap-lints`, and cannot be set at group,
pipeline, or node scope.

### Suppressing lints

Lints can be suppressed in two ways, by setting a lint's level to `allow` or
`expect`. Setting `allow` for some scope means that the lint is completely suppressed
at that level except in the case that the lint is `forbid`den at a higher level. `allow`
can be set at any scope.

Setting `expect` is similar to `allow`, but it will trigger the `unfulfilled_lint_expectations`
meta lint if the diagnostic is not present at the scope that `expect` is declared on.
Additionally, `expect` is only allowed on pipelines or nodes. This is because expect
fullfillment at higher scopes cannot be determined by looking at a single pipeline 
in isolation. For example, determining whether a group satisfies a lint is only
possible by iterating the entire group, which may be expensive to do when a single
pipeline is added or removed.

### Where lints run

Lints run wherever the engine admits a pipeline configuration, and can also
be run ahead of time:

- **At startup.** The initial configuration is linted. A diagnostic that
  resolves to `deny` or `forbid` stops the engine from starting, the same
  way a validation error does.
- **On live reconfiguration.** Every change made through the admin API
  (creating or replacing a pipeline, or reconciling the whole config) lints
  each affected pipeline as it would look after the change. Errors reject
  the change. Warnings are returned in the admin response and recorded as
  warning-level events for the pipeline.
- **With `df_engine --validate-and-exit`.** Validates and lints a config
  file without starting any pipelines.

### Reading a diagnostic

TODO: We can't describe a diagnostic in this way, we need to describe it as
an otel event with a name, attributes, etc.

Each diagnostic records the lint name, its primary location as a config path,
and where its level came from. The level notes matter because a level can be
influenced by four config scopes, CLI flags, and the cap.

```text
error[unconnected_node]: node `debug` has no connections and will be removed
  --> groups.dev.pipelines.main.nodes.debug
   = note: `warn` by default (category: suspicious)
   = note: promoted to `deny` by `warnings: deny` at <root>
   = help: connect the node or remove it
   = docs: <generated lint documentation link>
```

## Reference-level explanation

Code samples in this section are illustrative. They show the shape of the
proposed types and where they live, not final signatures.

### Crate layout

Linting is split across the existing `config` crate and a new `lint` crate
(`otel-arrow-dfe-lint`):

**`config` owns syntax.** Every config struct that can carry a `lints:`
block gains a `lints` field. These structs use `deny_unknown_fields`, so the
field has to exist in `config`:

- `OtelDataflowSpec` (root)
- `PipelineGroupConfig`
- `PipelineConfig`
- `EngineObservabilityPipelineConfig`
- `NodeUserConfig`

`config` also parses selectors. Because category names and `warnings` are
reserved, selectors can be classified by their shape alone, without knowing
which lints exist:

| Segments (shortcut) | Segments (canonical) | Selector                                                                       |
|---------------------|----------------------|--------------------------------------------------------------------------------|
| 1                   | -                    | Engine lint, category, or `warnings`                                           |
| 2                   | 4                    | Component                                                                      |
| 3                   | 5                    | Component lint, or component + category if the last segment is a category name |

`config` does not know which lints exist, so it never reports
`unknown_lints`. A selector that is malformed (e.g. invalid characters) is a
config validation error.

**`lint` owns behavior.** The new crate holds the lint types, the registry,
level resolution and `forbid` checking, the diagnostic and report types,
and the engine lints (including meta lints). It depends only on `config`,
so it is not tied to the engine's `PData` type parameter, and `dfctl` can
depend on it without depending on `engine`.

Putting all of this in `config` would avoid a new crate, but would add lint
execution and a registry to a crate that today only describes the config
format.

### Lint types

```rust
/// Static description of one lint.
pub struct Lint {
    /// Local id, e.g. "oversized_batch". The full name is derived from the
    /// owning component's URN at registration time.
    pub id: &'static str,
    pub category: Category,
    /// One-line summary used in diagnostics and generated docs.
    pub summary: &'static str,
    /// Longer explanation: what, why, and how to fix.
    pub docs: &'static str,
}

pub enum Category { Correctness, Suspicious, Perf, Style }

pub enum Level { Allow, Expect, Warn, Deny, Forbid }

/// Where a diagnostic points.
pub enum Location {
    Pipeline,
    Node(NodeId),
    Extension(ExtensionId),
}
```

A `Lint` does not contain its full name. The registry derives it by
appending the id to the URN of the component that declared the lint (or no
prefix for engine lints). This keeps declarations short, guarantees that a
component's lints share its namespace, and means renaming a component URN
renames all of its lints in one place.

Lints are grouped into **lint declarations**, which pair the static lints a
component defines with a single check function that may emit diagnostics for
any of them, similar to clippy's split between lints and lint passes:

```rust
#[derive(Clone, Copy)]
pub struct LintDeclarations {
    pub lints: &'static [&'static Lint],
    pub check: Option<fn(&LintContext<'_>, &mut LintSink<'_>)>,
}

impl LintDeclarations {
    pub const NONE: Self = Self { lints: &[], check: None };
}
```

`LintDeclarations` is `const`-constructible, so it can be stored in the
`static` factory items that are already registered through `linkme`
distributed slices, in the same way as `WiringContract` and
`ContextDeclarationProvider`.

A check function receives a context and a sink:

```rust
pub struct LintContext<'a> {
    /// The pipeline being linted, with resolved policies.
    pub pipeline: &'a ResolvedPipelineConfig,
    /// What caused this check to be invoked.
    pub subject: Subject<'a>,
    /// All registered lints and components, e.g. to recognize other node URNs.
    pub registry: &'a LintRegistry,
}

pub enum Subject<'a> {
    /// Engine lints.
    Pipeline,
    /// A node type's lints: every node of that type in the pipeline.
    NodeType { urn: &'a NodeUrn, nodes: &'a [NodeId] },
    /// An extension's lints, with that extension's own config.
    Extension { id: Option<&'a ExtensionId>, config: &'a serde_json::Value },
}

impl LintSink<'_> {
    /// Whether `lint` would be reported at `at`. Lets checks skip expensive
    /// work for lints that are allowed.
    pub fn is_enabled(&self, lint: &'static Lint, at: &Location) -> bool;

    /// Emit a diagnostic. Returns a builder for related locations and help.
    pub fn emit(&mut self, lint: &'static Lint, at: Location, message: impl Into<String>)
        -> DiagnosticBuilder<'_>;
}
```

The sink resolves each diagnostic's level when it is emitted, using the
pipeline's lint scopes (see [Executing lints](#executing-lints)), and records
which scope and selector the level came from so diagnostics can explain it.
Emitting a lint that the caller did not declare is a bug and is caught by a
debug assertion.

Most node lints need the node's typed configuration rather than raw JSON.
`LintContext` provides a helper, `typed_config::<T>(node_id)`, to
deserialize it. By the time lints run, component validation has already
proven that every node config deserializes, so the helper cannot fail in
practice.

### Declaring lints in nodes

`ReceiverFactory`, `ProcessorFactory`, and `ExporterFactory` each gain a
`lints: LintDeclarations` field (the hand-written `Clone` impls for these
factories are updated accordingly). Nodes without lints use
`LintDeclarations::NONE`.

```rust
// batch_processor/mod.rs
#[distributed_slice(OTAP_PROCESSOR_FACTORIES)]
pub static OTAP_BATCH_PROCESSOR_FACTORY: ProcessorFactory<OtapPdata> = ProcessorFactory {
    name: OTAP_BATCH_PROCESSOR_URN,
    create: |pipeline_ctx, node, node_config, proc_cfg, _caps| { /* ... */ },
    context_declarations: None,
    wiring_contract: WiringContract::UNRESTRICTED,
    validate_config: validate_typed_config::<Config>,
    lints: LintDeclarations {
        lints: &[&lint::EXAMPLE_LINT],   // TODO: real lints
        check: Some(lint::check),
    },
};

// batch_processor/lint.rs
pub static EXAMPLE_LINT: Lint = Lint {
    id: "example_lint",
    category: Category::Perf,
    summary: "...",
    docs: "...",
};

pub fn check(cx: &LintContext<'_>, sink: &mut LintSink<'_>) {
    let Subject::NodeType { nodes, .. } = cx.subject else { return };
    for node_id in nodes {
        let config: Config = cx.typed_config(node_id);
        // inspect `config` and `cx.pipeline`, then:
        // sink.emit(&EXAMPLE_LINT, Location::Node(node_id.clone()), "...");
    }
}
```

A node's check runs **once per pipeline** that contains at least one node of
that type, and receives every node of that type in the pipeline. This lets a
check compare instances (e.g. "more than one X in a pipeline") without
running once per node, while still giving it the whole pipeline to inspect.

### Declaring lints in extensions

Extensions declare lints the same way as nodes. Both kinds of extension
factory gain a `lints: LintDeclarations` field:

- `ExtensionFactory` (engine crate), for extensions declared in a pipeline's
  `extensions:` block.
- `ControllerExtensionFactory` (controller crate), for extensions declared in
  `engine.controller.extensions`.

Their checks receive `Subject::Extension` with the extension's own config,
so an extension can implement configurable policy (e.g. a list of nodes an
organisation does not allow), and are activated as follows:

| Extension kind | Declared in                    | Check runs against                                   |
|----------------|--------------------------------|------------------------------------------------------|
| Pipeline       | `pipelines.<p>.extensions`     | The declaring pipeline                               |
| Controller     | `engine.controller.extensions` | Every pipeline, including the observability pipeline |

There are no group-level extensions in the config today, so these are the
only two activation scopes.

Adding a first-class `lints` field is the working proposal. An alternative
is to model lints as an extension capability; see
[Unresolved questions](#unresolved-questions).

### Gathering lints

Lints are gathered into a `LintRegistry` once per process:

```text
 engine lints (lint crate)  -----------------+
 node factories (receivers/processors/       |
   exporters)                ----------------+--> LintRegistry
 pipeline extension factories ---------------+    full name -> &Lint, owner, category
 controller extension factories -------------+    owner URN -> LintDeclarations
```

`PipelineFactory<PData>` gains a non-generic accessor that returns, for each
compiled-in factory, its URN and `LintDeclarations`. Like the existing
factory maps, the result is computed once and cached in a `OnceLock`. The
controller combines it with the engine lints and the controller extension
factories to build the registry.

Building the registry fails with a hard error if:

- two lints have the same full name, or
- a lint id is reserved (a category name or `warnings`).

The same checks run as a unit test in the `component-inventory` crate, which
already links every node and extension crate, so collisions are caught in
CI rather than at deploy time.

### Executing lints

**Where the lint stage runs.** Lints run as a new stage immediately after
component validation and before context compilation:

```text
 parse --> validate() --> validate_engine_components --> LINT STAGE --> compile_initial_context --> run
           structural      URNs known, node and          on resolved
                           extension configs             pipelines
                           deserialize
```

At this point every URN is known to the registry and every node and
extension config has been deserialized at least once, so checks can rely on
both, just as clippy relies on code having type-checked. Lints see the
pipeline graph as configured. In particular they run before
`PipelineFactory::build()` prunes unconnected nodes, so the
`unconnected_node` lint sees those nodes and replaces the `otel_warn!` that
`build()` logs today. The pruning itself is unchanged.

**Lint scopes.** Resolution (`OtelDataflowSpec::resolve()`) currently merges
policies and drops the root and group config. Lint levels cannot be merged
the same way: resolving a level and checking `forbid` require each scope
separately. `ResolvedPipelineConfig` therefore gains a `lint_scopes` field
holding the outer `lints:` blocks, unmerged and in order. The pipeline and
node blocks are already reachable through the `PipelineConfig` it holds.

| Pipeline               | Scope chain (outermost to innermost)                   |
|------------------------|--------------------------------------------------------|
| Regular                | CLI flags, root, group, pipeline, node                 |
| `system/observability` | CLI flags, root, `engine.observability.pipeline`, node |

**Steps.** For each resolved pipeline:

1. **Check `forbid`.** Using the registry to map lints to categories and
   components, check every scope for an entry that would change the level of
   a lint forbidden in an enclosing scope or by a less specific selector in
   the same scope. A conflict is a hard error and no checks run.
2. **Activate.** Select the checks to run: engine lints, the check of each
   node type present in the pipeline, the pipeline's extensions, and all
   controller extensions.
3. **Run.** Invoke each active check with its `Subject`. Diagnostics are
   collected through the sink with their resolved levels.
4. **Meta lints.** Report `unknown_lints` for selectors that do not match
   the registry, `renamed_and_removed_lints` for aliases, and
   `unfulfilled_lint_expectations` for `expect` entries that matched no
   diagnostic.
5. **Cap.** Apply `lint_cap` to every diagnostic.

The result is a `LintReport` per pipeline, containing the diagnostics and
whether any of them is an error.

**Entry point.** A single function in the controller, roughly
`validate_and_lint(spec, factory) -> Result<LintReport, Error>`, performs
validation, component validation, and the lint stage. It is used by:

- engine startup and `df_engine --validate-and-exit`
- live reconfiguration: rollout planning, `/config/reconcile`, and group
  creation

Today these paths call validation inconsistently (group creation, for
example, does not run component validation), so sharing one entry point
also makes validation consistent.

**Acting on the report.**

| Path                  | Error diagnostics     | Warning diagnostics                                |
|-----------------------|-----------------------|----------------------------------------------------|
| Startup               | Engine does not start | Logged                                             |
| `--validate-and-exit` | Non-zero exit         | Printed                                            |
| Live reconfiguration  | Change rejected       | Returned in the admin response, recorded as events |

**Locations.** Diagnostics locate problems by config path (e.g.
`groups.dev.pipelines.main.nodes.debug`). File, line, and column are not
available: `serde_yaml` 0.9 does not retain source positions, and
environment variable substitution happens before parsing, so offsets would
not match the original file.

### Remaining work

- Testing strategies
  - Handling of circular/contradictory/conflicting lints. Every core lint
    should be able to define an example config that passes the lint AND no
    other core lint should trigger on that config
  - Testing that there are no conflicting lint names
  - Testing that lint names remain stable
- TODO: How `forbid` and lint scopes interact with live reconfiguration
  when a change adds or removes an extension
  API responses
- TODO: Efficiency. `LintSink::is_enabled` lets checks skip allowed lints;
  repeated typed-config deserialization could be cached per run.

## Drawbacks

Why should we *not* do this?

## Rationale and alternatives

- Why is this design the best in the space of possible designs?
- What other designs were considered, and why were they not chosen?
- What is the impact of not doing this?

## Prior art

Discuss prior art, both good and bad. What can we learn from how other
projects (Rust, OpenDAL, the OpenTelemetry Collector, etc.) solved this?
If there is no prior art, say so -- new ideas are welcome.

- TODO: Cargo clippy. See the
  [guide-level explanation](#guide-level-explanation).


## Unresolved questions

- How should configuration related lints and config validation be reconciled?
  - Should we make a lot of config validations that emit warnings just emit
    lints instead?
- TODO: Who owns which lint settings? Unlike Rust, where the code author
  configures lints, the engine operator and the pipeline author may be
  different people submitting different configuration changes.
- Can the root `lints:` block be changed live (e.g. through
  `/config/reconcile`), or does changing it require a restart?
- Upgrades. Lints run at engine startup rather than at build time, so a new
  deny-by-default lint in a minor release could stop an engine from starting
  with a config that worked before. Options include:
  - (a) Default `correctness` to `warn`.
  - (b) Introduce new lints in an allow-by-default `nursery` category and
    promote them after a release or two (clippy's approach).
  - (c) Rely on operators running `--validate-and-exit` in CI before
    upgrading, with the lint cap as a fallback.
  - (d) Pin a lint baseline in the config (e.g. `lints_version`) so that
    lints added later default to `warn`, similar to Rust editions.
- Should there be allow-by-default categories such as `nursery`,
  `restriction` (opt-in rules for specific environments), or `pedantic`?
- Should security lints be a category, or tags that cut across categories?
- Lint parameters. Should lints accept configuration beyond a level, like
  clippy's `disallowed_methods` configured in `clippy.toml`?
  - If so, how do parameter values merge across scopes (replace or extend)?
- Should engine lints keep using bare names, or have their own URN (e.g.
  `urn:otel:engine:core:<lint_id>`) so that every lint is named the same way?
- What happens when multiple instances of the same extension type, each
  defining the same lints, are declared in one scope?
- Should lints be an extension capability or a first-class property of
  extension factories? This RFC proposes a first-class `lints` field, the
  same as on node factories. A capability would reuse the existing mechanism
  for describing what an extension provides, and binding semantics could let
  pipelines opt in to an extension's lints. However, capabilities today are
  runtime services handed out by created extension instances, while lints
  run before anything is created; background extensions have no
  capabilities; and controller extensions have no capability system at all.
- Should configuring a lint in a scope where it can never be active (e.g. a
  root entry for a lint whose extension is declared in only one pipeline) be
  reported by a lint?

## Future possibilities

- Serializing lints to/from a file
- A language for describing lints
- Inclusion of lints into dfctl. It's not clear how to compile custom lints into
  dfctl at this time. Maybe we can link some linting modules in with wasm.
- Lints across pipelines connected by topics. Lints are currently limited to
  a single pipeline, which avoids a change to one pipeline causing a lint
  failure in another.
- File, line, and column in diagnostics. This needs a YAML parser that
  retains source positions, and a way to map positions back through
  environment variable substitution.
- Changing lint configuration at runtime (see
  [Unresolved questions](#unresolved-questions))
- Suppression reasons. A `lints:` entry could accept a structured form such
  as `{ level, reason }`, with the reason shown in diagnostics and lint
  reports, like rustc's `reason = "..."`. Until then, reasons live in YAML
  comments, which are lost when a config is submitted through the admin API
  and re-serialized. Lint parameters, if adopted, would likely need the same
  structured form.
- Automatic documentation generation from `Lint::summary` and `Lint::docs`
- Aliases for renamed lints and renamed component URNs
- Warning-level events in the observed state, and warnings in admin
