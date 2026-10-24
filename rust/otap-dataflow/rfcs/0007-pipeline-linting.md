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
to express more complicated logic. This forms a programming language for pipelines.

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

Programming languages have solved this problem through static program linters like rustc
and clippy. We can do the same for Dataflow Engine pipelines.

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
- **Extensions** can define lints. This is how users add their own rules, for
  example forbidding a particular node or configuration, without writing a node.
  Such lints are namespaced by the extension's URN.

Node lints declared by a node type only visit nodes of that type. Extension
node lints are not tied to a node type, so each one declares which node
types it visits (its **node interests**), which may be all of them.

Engine lints work differently from component lints. Rather than having a
check function that the engine invokes, each engine lint is emitted directly
by the engine code that already detects the condition, during the lint stage.
For example, the engine already determines which nodes are unconnected so
that it can remove them; the `unconnected_node` lint is reported at that
point, and the unconnected nodes are removed before the pipeline is admitted.
This avoids duplicating detection logic in a separate check. The
[meta lints](#meta-lints) are engine lints too.

Which lints are _active_ for a given pipeline depends on the
pipeline:

| Source    | Active in                                                                                                                                                                                                                             | Initial level |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Engine    | Every pipeline; emitted by the engine during the lint stage                                                                                                                                                                           | Its default   |
| Node      | Pipelines that contain at least one node of that type                                                                                                                                                                                 | Its default   |
| Extension | Pipelines and nodes within the extension's reach (every pipeline for a controller extension in `engine.controller.extensions`, one pipeline for a pipeline extension). Node lints only visit nodes matching the lint's node interests | Its default   |

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
| ------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `unknown_lints`                 | `suspicious` | A `lints:` block names a lint, component, or category the engine does not know |
| `renamed_and_removed_lints`     | `suspicious` | A `lints:` block uses a renamed or removed lint name                           |
| `unfulfilled_lint_expectations` | `suspicious` | An `expect` entry's lint did not fire                                          |

Meta lints are emitted where the engine checks the lint configuration:

| Lint                            | Emitted                                | Location                                                 |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| `unknown_lints`                 | When a `lints:` block is admitted      | The scope of that block (root, group, pipeline, or node) |
| `renamed_and_removed_lints`     | When a `lints:` block is admitted      | The scope of that block                                  |
| `unfulfilled_lint_expectations` | At the end of each pipeline's lint run | The pipeline or node where the `expect` entry is set     |

A mistake in a shared `lints:` block, such as the root or a group, is
therefore reported once at that block rather than once for every pipeline
that inherits it. As with any lint, the level is resolved from the location
outwards: `unknown_lints: allow` in a block silences unknown entries in that
block and the blocks nested inside it, but a pipeline cannot silence a
mistake in the root block.

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

Every lint declares the scope it checks, which is either a **node** or a
**pipeline**:

- A **node lint** checks a single node and is run once for each node of the
  type that declares it. Its diagnostics always point at that node.
- A **pipeline lint** checks a pipeline as a whole and is run once per
  pipeline. Its diagnostics always point at the pipeline. A diagnostic that
  concerns specific nodes (for example, a rule about node ordering) lists
  them as related locations, similar to rustc's secondary spans. Related
  locations are informational only; they do not affect the diagnostic's
  level.

A diagnostic's location (the node or the pipeline) determines which
configurations apply when resolving its level. More on that below. The only
diagnostics located elsewhere are [meta lints](#meta-lints) about the root
or a group's `lints:` block, which are located at that root or group.

A lint's scope is separate from where the component that declares it is
configured. In particular, extensions are declared at the engine or pipeline
level, which determines their **reach** (the pipelines their lints run
against), but their lints can still be pipeline or node lints.

The engine's observability pipeline (`engine.observability.pipeline`) is
linted like any other pipeline. It has no group, so its scopes are the root,
the observability pipeline itself, and its nodes.

### Enforcement Levels

Enforcement levels determine if a lint is enforced and if it's a warning or error.
Errors will prevent the creation of pipelines that don't pass the lint, whereas
warnings are just reported as events.

| Level    | Reported?                   | Overrideable? |
| -------- | --------------------------- | ------------- |
| `allow`  | No                          | Yes           |
| `expect` | Yes, warning if unfulfilled | Yes           |
| `warn`   | Yes, as a warning           | Yes           |
| `deny`   | Yes, as an error            | Yes           |
| `forbid` | Yes, as an error            | **No**        |

### Categories

Every lint belongs to exactly one of a fixed set of categories which defines the
default enforcement level.

| Category      | Default Level | Meaning                                                                                                  |
| ------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `correctness` | warn          | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | warn          | Probably a mistake, but there are legitimate uses.                                                       |
| `perf`        | warn          | Correct, but wastes CPU, memory, or throughput.                                                          |
| `style`       | warn          | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

A useful test when classifying a lint: _is there any configuration where
this is what the author wanted?_ If not, it is `correctness`. If rarely, it
is `suspicious`. If it is fine but costly, it is `perf`. If it is fine but
untidy, it is `style`.

#### Examples

The following examples illustrate possible lints for category.

**`correctness`**

- _Merging batches upstream of a content router._ A batch processor merges
  requests from different senders into one batch. If the resources in a
  merged batch route to different outputs of a downstream content router, the
  router permanently NACKs the entire batch, and because the batch processor
  does not return payloads on NACK, the data cannot be retried. Each request
  would have routed correctly on its own. Routing first and batching on each
  route avoids the problem. This is `correctness` because the pipeline can
  frequently reject data as soon as senders with different routing keys share
  it, which is the reason to use a content router in the first place.

**`suspicious`**

- _A retry processor that can never retry._ If the first retry delay (the
  smaller of `initial_interval` and `max_interval`) is not shorter than
  `max_elapsed_time`, the retry processor gives up before its first attempt
  and only passes NACKs through. The config is valid, and there are
  conceivable reasons for it (e.g. temporarily disabling retries without
  restructuring the pipeline), but it is much more likely to be a mistake.

**`perf`**

- _Temporal reaggregation after a batch processor._ Temporal reaggregation
  resizes batches and generally emits more, smaller batches than it receives,
  so batching before it is wasted work. The processor's documentation
  recommends placing it before any batch processor. The output is correct
  either way, so this is `perf`.
- _Two batch processors on the same path._ When one batch processor is
  downstream of another on the same branch of a pipeline, the second
  re-batches data that has already been batched, adding latency, memory, and
  cpu. It's likely that the pipeline could be restructured to batch a single
  time at the end.

**`style`**

- _Deprecated OTAP receiver compression setting._ The OTAP receiver's
  `compression_method` field is deprecated in favor of `request_compression`
  and `response_compression`. It still works, so this is neither a
  correctness nor a performance problem, but configs should migrate before
  the field is removed. Today this is a warning logged when the receiver
  starts; as a lint it is reported before the pipeline is deployed and can be
  configured like any other lint.

### Selectors

Lints are referenced via **selectors**. The basic selector is the fully qualified lint
urn, but selectors can refer to classes of lints based on component or category:

| Selector             | Example                     | Matches                                          |
| -------------------- | --------------------------- | ------------------------------------------------ |
| Full Urn             | `processor:batch:<lint_id>` | Exactly one lint                                 |
| Component + category | `processor:batch:perf`      | Lints defined by that component in that category |
| Component            | `processor:batch`           | All lints defined by that component              |
| Category             | `correctness`               | All lints in that category, from every source    |

Engine lints are selected by their bare name (e.g. `unconnected_node`) and
categories are also reserved names that select the entire category of lints at
the specified scope.

### Configuring lints

Lints are configured with a `lints:` block, which can appear at four scopes:
the root of the config, a pipeline group, a pipeline, and a node. Each entry
maps a selector to a level.

```yaml
version: otel_dataflow/v1
lints: # root scope
  correctness: forbid
  warnings: deny
engine:
  lint_cap: warn # operator-only, see "Capping lint levels"
groups:
  dev:
    lints: # group scope
      perf: allow
    pipelines:
      main:
        lints: # pipeline scope
          processor:batch:<lint_id>: warn # TODO: real example
          urn:acme:extension:prod_policy: allow
        nodes:
          passthrough:
            type: processor:batch
            config:
              min_size: 0
            lints: # node scope
              # intentionally forwards everything unbatched
              processor:batch:<node_lint_id>: allow
```

A lint can only be configured at its own scope and the scopes that enclose
it:

| Lint scope | Can be configured at             |
| ---------- | -------------------------------- |
| Pipeline   | CLI, root, group, pipeline       |
| Node       | CLI, root, group, pipeline, node |

A pipeline lint therefore applies to a pipeline as a whole: it cannot be
allowed for some nodes of a pipeline and not others. If some nodes need
different rules, they belong in a different pipeline. Broad selectors at
node scope (e.g. `perf: allow` or `processor:batch: allow`) apply only to
the node lints they match.

TODO: Decide how to report a node-scope entry that names a pipeline lint
exactly, which can never take effect (e.g. a hard error or a meta lint).

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

The level of a lint is resolved from its location outwards: from the node
for node lints, and from the pipeline for pipeline lints.

```text
 CLI flags                    (outermost)   ^
   root        lints:                       |  search from the innermost
     group       lints:                     |  scope outwards; the first
       pipeline    lints:                   |  scope with a matching entry
         node        lints:   (innermost)   |  wins
              ^
              node lints start here; pipeline lints start one level up
```

Because a lint's location is known before it runs, its level is resolved
before its check is invoked, and a lint that resolves to `allow` is not run
at all.

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
          processor:batch:<lint_id>: allow # error if <lint_id> is a correctness lint
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
Unlike `allow`, a lint resolved to `expect` is still run so that the engine
can tell whether it fired; its diagnostics are suppressed. An `expect` set
through a broad selector (e.g. `perf: expect`) is fulfilled if any lint it
matches fires at that location.
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
  the change. Warnings are emitted as `pipeline.lint.diagnostic` events.
- **With `df_engine --validate-and-exit`.** Validates and lints a config
  file without starting any pipelines.

### Lint events

Every diagnostic that is reported (i.e. whose final level is `warn`, `deny`,
or `forbid`) is emitted as an internal telemetry event named
`pipeline.lint.diagnostic`. Diagnostics therefore show up wherever the
engine's other events do: on the console through the console log provider
(including when running `df_engine --validate-and-exit`), in the admin
`/logs` tap, and in OTLP exported by the observability pipeline.

The event's severity is `WARN` for `warn` and `ERROR` for `deny` and
`forbid`. Its body is the message produced by the lint, and its attributes
identify the lint, where it fired, and where its level came from.

For example, a hypothetical batch processor node lint that fires when a batch
processor is configured to forward everything without batching, in a
pipeline whose root `lints:` block sets `warnings: deny`:

```yaml
event_name: pipeline.lint.diagnostic
severity: ERROR
body: batch processor forwards every request without batching (min_size is 0 and max_size is unset)
attributes:
  pipeline.group.id: dev
  pipeline.id: main
  node.id: batch
  node.urn: urn:otel:processor:batch
  lint.name: urn:otel:processor:batch:forwards_everything # illustrative
  lint.level: deny
  lint.level.selector: warnings
  lint.level.scope: root
```

Here `lint.level.selector` and `lint.level.scope` show that the lint, which
warns by default, was promoted to `deny` by `warnings: deny` in the root
`lints:` block. When a lint fires at its default level, these two attributes
are omitted. Diagnostics located at the root or a group (only possible for
meta lints) carry no pipeline attributes. See
[Emitting lint events](#emitting-lint-events) in the reference-level
explanation for the full attribute list.

## Reference-level explanation

Code samples in this section are illustrative. They show the shape of the
proposed types and where they live, not final signatures.

### Crate layout

The majority of the core linting machinery will be added in a new `lint` crate
(`otel-arrow-dfe-lint`).

The crate will define the new lint config types for the `lint:` sections as well
as:

- The lint registry
- Level resolution logic
- Lint execution
- Parsing code for selectors
- Common linting helper functions such as for constructing node before or node after
  placement lints.

Putting all of this in `config` would avoid a new crate, but would add lint
execution and a registry to a crate that today only describes the config
format.

### Lint types

```rust
/// Static description of one lint. Used by the registry, selectors, events,
/// and generated documentation.
pub struct LintInfo {
    /// Local id, e.g. "oversized_batch". For component lints, the full name is
    /// derived from the owning component's URN at registration time.
    pub id: &'static str,
    pub category: Category,
    /// One-line summary used in diagnostics and generated docs.
    pub summary: &'static str,
    /// Longer explanation: what, why, and how to fix.
    pub docs: &'static str,
}

/// A component lint: its description plus the code that checks it.
pub struct Lint {
    pub info: LintInfo,
    /// The scope this lint checks, and the function that checks it.
    pub check: Check,
}

/// A lint's scope and check function.
pub enum Check {
    /// Run once per pipeline in which the lint is active.
    Pipeline(fn(&LintContext<'_>, &mut LintSink<'_>)),
    /// Run once per node in which the lint is active.
    Node {
        /// Which nodes the lint visits.
        interests: NodeInterests,
        check: fn(&LintContext<'_>, NodeRef<'_>, &mut LintSink<'_>),
    },
}

/// Which nodes a node lint visits.
pub enum NodeInterests {
    /// Only nodes of the declaring node type. Required for node-declared lints.
    Own,
    /// Every node.
    All,
    /// Nodes of the listed types (URNs).
    Types(&'static [&'static str]),
}

/// Lint category
pub enum Category { Correctness, Suspicious, Perf, Style }

/// Enforcement level
pub enum Level { Allow, Expect, Warn, Deny, Forbid }
```

Component lints (declared by nodes and extensions) are `Lint`s. Engine
lints, including meta lints, are bare `LintInfo`s: they have no check
function because the engine emits them directly (see
[Executing lints](#executing-lints)). The split makes it impossible to
declare a component lint without a check or an engine lint with one.

A `LintInfo` does not contain its full name. For component lints, the
registry derives it by appending the id to the URN of the component that
declared the lint; engine lints use the bare id. This
keeps declarations short, guarantees that a component's lints share its
namespace, and means renaming a component URN renames all of its lints in
one place.

All `LintInfo` and `Lint` fields are `const`-constructible, so lints are
declared as `static` items and referenced from the `static` factory items
that are already registered through `linkme` distributed slices, in the same
way as `WiringContract` and `ContextDeclarationProvider`.

**One check per lint.** Each lint carries its own check function, and the
check's signature encodes the lint's scope. The engine, not the lint, is
responsible for invoking each check at every construct of the right kind
and for skipping it wherever it resolves to `allow`. Each invocation gets a
context and a sink bound to exactly that lint and that location:

```rust
pub struct LintContext<'a> {
    /// Per-run state shared by every check invocation in this pipeline's run.
    state: &'a PipelineLintState<'a>,
    /// The component that declared the running lint: a node type, or a
    /// specific extension instance.
    owner: Owner<'a>,
}

impl<'a> LintContext<'a> {
    /// The pipeline being linted, with resolved policies.
    pub fn pipeline(&self) -> &'a ResolvedPipelineConfig;

    /// A node's config as JSON. Never fails.
    pub fn raw_config(&self, node: &NodeId) -> &'a serde_json::Value;

    /// A node's config deserialized as `T`. Cached per run.
    pub fn typed_config<T: DeserializeOwned + Send + Sync + 'static>(
        &self,
        node: &NodeId,
    ) -> Result<Arc<T>, LintError>;

    /// The config of the extension instance that declared the running lint,
    /// deserialized as `T`. Cached per run. `None` for node-declared lints.
    pub fn extension_config<T: DeserializeOwned + Send + Sync + 'static>(&self)
        -> Option<Arc<T>>;

    /// Connectivity queries over the pipeline graph (upstream, downstream,
    /// paths between nodes). Built at most once per run.
    pub fn graph(&self) -> &PipelineGraph;
}

impl LintSink<'_> {
    /// Emit a diagnostic for the lint being checked, at the location being
    /// checked. Returns a builder for related nodes.
    pub fn emit(&mut self, message: impl Into<String>) -> DiagnosticBuilder<'_>;
}

impl DiagnosticBuilder<'_> {
    /// Add a related node (pipeline lints only).
    pub fn related(self, node: &NodeId) -> Self;
}
```

This design has several consequences:

- **Lints cannot emit undeclared lints.** A check can only emit through a
  sink bound to its own lint, so there is no way for a component to emit a
  lint it has not declared.
- **Allowed lints are not run.** A lint's location is known before it runs
  (the node for node lints, the pipeline for pipeline lints), so the engine
  resolves the level first and skips the check entirely if it is `allow`.
  Checks never need to ask whether they are enabled. A lint resolved to
  `expect` is still run, so that the engine can tell whether the expectation
  was fulfilled; its diagnostics are suppressed.
- **Shared work happens once.** Separate checks for separate lints could
  repeat work, such as deserializing a node's config or walking the graph.
  The context caches both, so several lints on the same node or pipeline
  share the work.

**Caching.** The engine creates a `PipelineLintState` at the start of each
pipeline's lint run and drops it at the end, so cached values never outlive
a run or leak between pipelines. It holds:

- the pipeline being linted;
- the graph, in a `OnceCell` that is filled on the first `graph()` call;
- typed node configs, in a map keyed by `(NodeId, TypeId)`;
- typed extension configs, in a map keyed by `(extension instance, TypeId)`.

The engine builds a small `LintContext` for each check invocation, pointing
at the shared state and recording the lint's owner, which is how
`extension_config` knows whose config to return. Caches are filled lazily, so
a node whose lints all resolve to `allow` never has its config deserialized.

Because checks share the context through `&self`, filling a cache on a miss
requires interior mutability. The config caches are maps behind a `RefCell`
holding `Arc<dyn Any + Send + Sync>` values; a lookup clones the `Arc` and
downcasts it to `Arc<T>`. Returning `Arc<T>` rather than `&T` avoids holding
a `RefCell` borrow across the caller's use of the value, without `unsafe` or
new dependencies, at the cost of a reference count increment per call. If
lint runs are ever parallelized, the `RefCell` becomes a lock or concurrent
map without changing the API. `graph()` can return a plain reference because
a `OnceCell` never changes once set.

**Failure.** `raw_config` cannot fail. `typed_config` can: validation has
proven that each node config deserializes into _that node's_ config type,
but a lint may ask for a different type. Extension node lints in particular
visit nodes of many types and usually deserialize into their own small view
structs rather than other crates' config types. A failed `typed_config` is
treated as an internal error in the lint (reported as an event), not as a
lint diagnostic, and does not affect admission. `extension_config` returns
`None` only for node-declared lints; for extension lints it deserializes the
extension's own, already-validated config.

### Declaring lints in nodes

`ReceiverFactory`, `ProcessorFactory`, and `ExporterFactory` each gain a
`lints: &'static [&'static Lint]` field (the hand-written `Clone` impls for
these factories are updated accordingly). Nodes without lints use `&[]`.

A node type can declare both node lints and pipeline lints:

- Its **node lints** run once for each node of that type, and only for nodes
  of that type. A rule about another node type is declared by that type.
  Node-declared node lints therefore must use `NodeInterests::Own`, and
  registration rejects anything else.
- Its **pipeline lints** run once per pipeline that contains at least one
  node of that type.

For example, the batch processor could declare a node lint for a
configuration that disables batching, and a pipeline lint for two batch
processors on the same path:

```rust
// batch_processor/mod.rs
#[distributed_slice(OTAP_PROCESSOR_FACTORIES)]
pub static OTAP_BATCH_PROCESSOR_FACTORY: ProcessorFactory<OtapPdata> = ProcessorFactory {
    name: OTAP_BATCH_PROCESSOR_URN,
    create: |pipeline_ctx, node, node_config, proc_cfg, _caps| { /* ... */ },
    context_declarations: None,
    wiring_contract: WiringContract::UNRESTRICTED,
    validate_config: validate_typed_config::<Config>,
    lints: &[&lint::FORWARDS_EVERYTHING, &lint::REDUNDANT_BATCH],
};

// batch_processor/lint.rs

/// Node lint: this batch processor does not batch.
pub static FORWARDS_EVERYTHING: Lint = Lint {
    info: LintInfo {
        id: "forwards_everything",
        category: Category::Suspicious,
        summary: "batch processor forwards every request without batching",
        docs: "...",
    },
    check: Check::Node {
        interests: NodeInterests::Own,
        check: check_forwards_everything,
    },
};

fn check_forwards_everything(cx: &LintContext<'_>, node: NodeRef<'_>, sink: &mut LintSink<'_>) {
    // Own config type, already validated.
    let Ok(config) = cx.typed_config::<Config>(node.id()) else { return };
    if config.min_size == 0 && config.max_size.is_none() {
        sink.emit("min_size is 0 and max_size is unset, so requests are never batched");
    }
}

/// Pipeline lint: two batch processors on the same path.
pub static REDUNDANT_BATCH: Lint = Lint {
    info: LintInfo {
        id: "redundant_batch",
        category: Category::Perf,
        summary: "batch processor downstream of another batch processor",
        docs: "...",
    },
    check: Check::Pipeline(check_redundant_batch),
};

fn check_redundant_batch(cx: &LintContext<'_>, sink: &mut LintSink<'_>) {
    let graph = cx.graph();
    let batches = graph.nodes_of_type(OTAP_BATCH_PROCESSOR_URN);
    for (upstream, downstream) in graph.ordered_pairs_on_a_path(&batches) {
        sink.emit("batch processor is downstream of another batch processor")
            .related(upstream)
            .related(downstream);
    }
}
```

`FORWARDS_EVERYTHING` is checked for each batch processor node and can be
allowed on an individual node. `REDUNDANT_BATCH` is checked once per
pipeline containing a batch processor, reports one diagnostic per offending
pair with both nodes as related locations, and can only be allowed for the
pipeline as a whole.

### Declaring lints in extensions

Extensions declare lints the same way as nodes. Both kinds of extension
factory gain a `lints: &'static [&'static Lint]` field:

- `ExtensionFactory` (engine crate), for extensions declared in a pipeline's
  `extensions:` block.
- `ControllerExtensionFactory` (controller crate), for extensions declared in
  `engine.controller.extensions`.

Extension lints use the same pipeline and node scopes as other lints. Where
the extension is declared determines its **reach**: its lints only run
against pipelines, and nodes within pipelines, that are at or below the
extension in the configuration hierarchy.

| Extension kind | Declared in                    | Reach                                                         |
| -------------- | ------------------------------ | ------------------------------------------------------------- |
| Pipeline       | `pipelines.<p>.extensions`     | The declaring pipeline and its nodes                          |
| Controller     | `engine.controller.extensions` | Every pipeline and node, including the observability pipeline |

Within its reach:

- An extension **pipeline lint** runs once per pipeline.
- An extension **node lint** runs once per node whose type matches the lint's
  `NodeInterests` (`All`, or `Types` with a list of URNs). Unlike
  node-declared lints, extension lints are usually interested in other node
  types rather than their own.

As for any lint, a pipeline or node at which the lint resolves to `allow` is
skipped.

Node interests are static. An extension whose rules depend on its config
(for example, a list of disallowed node types) declares `All` and filters in
its check; deriving interests from config is listed under
[Future possibilities](#future-possibilities).

A check reads its extension's config with `LintContext::extension_config`.
For example, an organisation policy extension that disallows certain node
types:

```rust
#[derive(Deserialize)]
struct PolicyConfig {
    disallowed: Vec<String>,
}

pub static DISALLOWED_NODE: Lint = Lint {
    info: LintInfo {
        id: "disallowed_node",
        category: Category::Correctness,
        summary: "node type is disallowed by organisation policy",
        docs: "...",
    },
    check: Check::Node {
        interests: NodeInterests::All,
        check: check_disallowed_node,
    },
};

fn check_disallowed_node(cx: &LintContext<'_>, node: NodeRef<'_>, sink: &mut LintSink<'_>) {
    let Some(policy) = cx.extension_config::<PolicyConfig>() else { return };
    if policy.disallowed.iter().any(|urn| urn == node.urn().as_str()) {
        sink.emit(format!("node type `{}` is disallowed", node.urn()));
    }
}
```

**Multiple instances.** Several instances of the same extension type can be
within reach of one pipeline (for example, one in
`engine.controller.extensions` and one in the pipeline's `extensions:`).
Each instance runs its lints independently with its own config, and
diagnostics identify the instance through the `extension.id` event
attribute. Because levels are configured by lint name, and lint names are
derived from the extension _type_, setting a lint to `allow` silences it for
every instance of the extension; there is currently no way to allow a lint
for one instance but not another.

### Gathering lints

Lints are gathered into a `LintRegistry` once per process:

```text
 engine lints (lint crate)   ----------------+
 node factories (receivers/processors/       |
   exporters)                ----------------+--> LintRegistry
 pipeline extension factories ---------------+    full name -> &LintInfo, owner, category
 controller extension factories -------------+    owner URN -> [&Lint]
```

`PipelineFactory<PData>` gains a non-generic accessor that returns, for each
compiled-in factory, its URN and its lints. Like the existing factory maps,
the result is computed once and cached in a `OnceLock`. The controller
combines it with the controller extension factories and the engine's
`LintInfo` statics, which are declared in the `lint` crate, to build the
registry.

Building the registry fails with a hard error if:

- two lints have the same full name, or
- a lint id is reserved (a category name or `warnings`).

Component lint names always have at least three segments and engine lint
names have one, so the two can never collide; engine lint names only need to
be checked against each other and against reserved words.

The same checks run as a unit test in the `component-inventory` crate, which
already links every node and extension crate, so collisions are caught in
CI rather than at deploy time.

### Executing lints

Lints run as a new stage immediately after component validation and before context
compilation:

```text
 parse --> validate() --> validate_engine_components --> LINT STAGE --> compile_initial_context --> run
           structural      URNs known, node and          on resolved
                           extension configs             pipelines
                           deserialize
```

At this point every URN is known to the registry and every node and
extension config has been deserialized at least once, so checks can rely on
both, just as clippy relies on code having type-checked.

**Lint scopes.** Resolution (`OtelDataflowSpec::resolve()`) currently merges
policies and drops the root and group config. Lint levels cannot be merged
the same way: resolving a level and checking `forbid` require each scope
separately. `ResolvedPipelineConfig` therefore gains a `lint_scopes` field
holding the outer `lints:` blocks, unmerged and in order. The pipeline and
node blocks are already reachable through the `PipelineConfig` it holds.

| Pipeline               | Scope chain (outermost to innermost)                   |
| ---------------------- | ------------------------------------------------------ |
| Regular                | CLI flags, root, group, pipeline, node                 |
| `system/observability` | CLI flags, root, `engine.observability.pipeline`, node |

The stage has two phases.

**A. Lint configuration.** Each `lints:` block being admitted has its
selectors checked against the registry, emitting `unknown_lints` and
`renamed_and_removed_lints` located at that block's scope. At startup every
block is checked; on live reconfiguration, only the blocks being created or
changed (a group's block on group creation, a pipeline's and its nodes'
blocks on pipeline creation or replacement, and changed blocks on
reconcile). A diagnostic that resolves to `deny` stops startup or rejects the
change, like any other lint error.

**B. Pipelines.** For each resolved pipeline being admitted:

1. **Check `forbid`.** Using the registry to map lints to categories and
   components, check every scope for an entry that would change the level of
   a lint forbidden in an enclosing scope or by a less specific selector in
   the same scope. A conflict is a hard error and no checks run.
2. **Prune unconnected nodes.** Determine which nodes are unconnected
   (using the existing iterative pruning rules), emit `unconnected_node` for
   each, and remove them. If no nodes remain, the pipeline is rejected
   (today's `EmptyPipeline` error, now raised at admission).
3. **Run pipeline lints.** The active pipeline lints are those declared by
   node types present in the pipeline and by extensions whose reach includes
   the pipeline (the pipeline's extensions and all controller extensions).
   For each, resolve its level at the pipeline. If it is `allow`, skip it;
   otherwise invoke its check.
4. **Run node lints.** For each node, the active node lints are those
   declared by the node's type, plus node lints of extensions within reach
   whose `NodeInterests` match the node's type. For each, resolve the lint's
   level at the node. If it is `allow`, skip it; otherwise invoke its check
   with that node. Lints resolved to `expect` are run, and their diagnostics
   are suppressed and recorded as fulfilling the expectation.
5. **Report unfulfilled expectations.** Emit
   `unfulfilled_lint_expectations` for each `expect` entry in the pipeline or
   its nodes that no diagnostic fulfilled.
6. **Cap.** Apply `lint_cap` to every diagnostic.

Diagnostics are collected through each check's sink with the level resolved
before the check ran. A lint declared by an extension type with several
instances within reach is run once per instance. A `PipelineLintState` is
created for each pipeline's run and shared by all of its check invocations
(see [Lint types](#lint-types)).

Pipeline and node lints run on the pruned pipeline, so they only judge
nodes that will actually run, and no work is spent on nodes that are about
to be removed. `lints:` entries on a removed node, including `expect`
entries, are ignored; `unconnected_node` is the only diagnostic a removed
node receives, and its `expect` entries are not reported as unfulfilled.

**Pruning moves to admission.** The pruned `ResolvedPipelineConfig` is what
is admitted and passed to `PipelineFactory::build()`. `build()` no longer
prunes, and the `otel_warn!` it logs today for unconnected nodes is removed,
since `unconnected_node` replaces it. Detection now runs once per admission
rather than once per core. Callers and tests of `build()` that relied on
build-time pruning must supply an already-pruned config. The separate
pruning check that `OtelDataflowSpec::validate()` performs on the
observability pipeline (to require that the internal telemetry receiver stays
connected) is unchanged.

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

**Acting on the report.** Every reported diagnostic, error or warning, is
emitted as a `pipeline.lint.diagnostic` event (see
[Emitting lint events](#emitting-lint-events)). In addition:

| Path                  | Error diagnostics     | Warning diagnostics  |
| --------------------- | --------------------- | -------------------- |
| Startup               | Engine does not start | Pipeline is admitted |
| `--validate-and-exit` | Non-zero exit         | Zero exit            |
| Live reconfiguration  | Change rejected       | Change is admitted   |

**Locations.** Diagnostics locate problems by config path (e.g.
`groups.dev.pipelines.main.nodes.debug`). File, line, and column are not
available: `serde_yaml` 0.9 does not retain source positions, and
environment variable substitution happens before parsing, so offsets would
not match the original file.

### Emitting lint events

The `lint` crate depends only on `config` and has no telemetry dependency, so
it returns diagnostics as plain values. The controller converts each reported
diagnostic in a `LintReport` into a `pipeline.lint.diagnostic` event using
the `otel_warn!` (for `warn`) or `otel_error!` (for `deny` and `forbid`)
macros. Diagnostics at `allow` or `expect` are not emitted. The event body
is the diagnostic's message.

| Attribute               | Present                                         | Description                                                                                                             |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `lint.location`         | Always                                          | Where the diagnostic is located; one of `root`, `group`, `pipeline`, `node`                                             |
| `pipeline.group.id`     | Location is a group, pipeline, or node          | Group of the diagnostic (`system` for the observability pipeline)                                                       |
| `pipeline.id`           | Location is a pipeline or node                  | Pipeline of the diagnostic                                                                                              |
| `node.id`               | Node lint                                       | Node the diagnostic points at                                                                                           |
| `node.urn`              | Node lint                                       | URN of that node                                                                                                        |
| `extension.id`          | Lint declared by an extension                   | Instance id of the declaring extension, distinguishing multiple instances of one type                                   |
| `lint.name`             | Always                                          | Full lint name, e.g. `urn:otel:processor:batch:<lint_id>`                                                               |
| `lint.related.node.ids` | Pipeline lint with related nodes                | Ids of the related nodes (string array)                                                                                 |
| `lint.level`            | Always                                          | Final level after `warnings` and the cap; one of `warn`, `deny`, `forbid`                                               |
| `lint.level.selector`   | Level was set by a `lints:` entry or a CLI flag | The selector that set the level, e.g. `correctness` or `warnings`                                                       |
| `lint.level.scope`      | Level was set by a `lints:` entry or a CLI flag | Where that selector was configured; one of `cli`, `root`, `group`, `pipeline`, `node` (never `node` for pipeline lints) |

The identity attributes use the canonical entity keys
(`crates/engine/src/attributes.rs`). The telemetry guides place entity
attributes on the instrumentation scope rather than on each record, but
lints run in the controller before a pipeline is built, and a rejected
pipeline is never built at all, so there is no pipeline or node entity
context to attach. Lint events therefore carry identity as record attributes,
as other config-time events already do.

The lint cap is not represented separately: a capped diagnostic simply has a
lower `lint.level`.

The event is declared in the Weaver registry as
`semconv/groups/event.pipeline.lint.diagnostic.yaml`, and the
`live-check` run gains a trigger config containing an unconnected node so
that the event is exercised in CI.

### Remaining work

- Testing strategies
  - Handling of circular/contradictory/conflicting lints. Every core lint
    should be able to define an example config that passes the lint AND no
    other core lint should trigger on that config
  - Testing that there are no conflicting lint names
  - Testing that lint names remain stable
- TODO: How `forbid` and lint scopes interact with live reconfiguration
  when a change adds or removes an extension
- Reusing validated configs. Component validation already deserializes every
  node config and discards the result; it could hand the typed value to the
  lint stage to avoid deserializing it again.

## Rationale and alternatives

### Alternatives considered

- **Pruning unconnected nodes in `build()`.** Instead of pruning at
  admission, `build()` could keep pruning, and the lint stage could call a
  shared, non-mutating helper to find unconnected nodes and report
  `unconnected_node`. This is a smaller change to `build()`, but detection
  runs once at admission and again on every core, and the admitted config
  differs from what is actually built.
- **Linting the unpruned pipeline.** Pipeline and node lints could run on the
  pipeline as configured, before unconnected nodes are removed. Every node
  would be linted as written and no `lints:` entry would be silently ignored,
  at the cost of extra diagnostics and work on nodes that are about to be
  removed.
- **Engine lints with check functions.** Engine lints could be declared like
  component lints, with a `Check` invoked by the lint stage. Most engine
  lints, however, report conditions the engine already detects (such as
  unconnected nodes or unknown selectors), so a separate check would
  duplicate that detection and risk diverging from it.

## Prior art

Discuss prior art, both good and bad. What can we learn from how other
projects (Rust, OpenDAL, the OpenTelemetry Collector, etc.) solved this?
If there is no prior art, say so -- new ideas are welcome.

- TODO: Cargo clippy. See the
  [guide-level explanation](#guide-level-explanation).
- TODO: Otel collector

## Unresolved questions

- Can the root `lints:` block be changed live (e.g. through
  `/config/reconcile`), or does changing it require a restart?
- When a pipeline level lint concerns two nodes i.e. "dont place batch after
  retry", what node should own the lint?
  - Should core node lints just be baked directly into the engine? How do we
    remember to garbage collect if a core node is removed? How would we handle
    similar contrib lints?
- Upgrades. Lints run at engine startup rather than at build time, so a new
  deny-by-default lint in a minor release could stop an engine from starting
  with a config that worked before. Options include:
  - (a) Default `correctness` to `warn`.
  - (b) Introduce new lints in an allow-by-default `nursery` category and
    promote them only during major version bumps.
  - (c) Associate all lints with a release version and pin a lint baseline in the
    config (e.g. `lints_version`) so that lints in any later default to `warn`.
- How should lints that span node types learn about other node types? For
  example, "retry upstream of batch" depends on the batch processor not
  returning data on NACK. Rather than hard-coding other nodes' URNs, node
  types could declare properties (e.g. "merges batches", "returns data on
  NACK") that pipeline lints query.
- Should security lints be a category? Most security lints can probably fit in
  "suspicious", but it could be a common category of things that folks would want
  to forbid always like binding to 0.0.0.0.

## Future possibilities

- Lint parameters. Should lints accept configuration beyond a level?
- A language for describing lints
- Inclusion of lints into dfctl. It's not clear how to compile custom lints into
  dfctl at this time. Maybe we can link some linting modules in with wasm.
- Lints across pipelines connected by topics. Lints are currently limited to
  a single pipeline, which avoids a change to one pipeline causing a lint
  failure in another.
- Changing lint configuration at runtime (see
  [Unresolved questions](#unresolved-questions))
- Suppression reasons. A `lints:` entry could accept a structured form such
  as `{ level, reason }`, with the reason shown in diagnostics and lint
  reports, like rustc's `reason = "..."`.
- Automatic documentation generation from `Lint::summary` and `Lint::docs`
- Aliases for renamed lints and renamed component URNs
- Returning lint warnings in admin API responses
- Config-driven node interests. Extension node lints currently declare static
  `NodeInterests`; an extension could instead derive them from its config
  (e.g. a list of disallowed node types) so the engine only invokes the lint
  for relevant nodes.
- A `Connection` lint scope for rules about individual edges. Connections
  can already be inspected from pipeline lints through `graph()`.
