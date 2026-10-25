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
to express more complicated logic. This forms a programming language of sorts for 
telemetry pipelines.

Not all pipeline programs that can be expressed in the language of nodes, connections,
and configurations are good ones. Some nodes (probably) should not be placed before
or after others, and some combinations of node configurations are unlikely to yield
good results for performance, correctness, or other reasons.

The rules are many and it is unreasonable for any human (or agent), experienced or not,
to be aware of the constantly evolving set of nodes and configurations nor the accumulated
wisdom in how best to use them, let alone, consistently and perfectly apply these rules
in practice.

Additionally, organizations and individual users are likely to have their own individual
preferences for pipelines that they want to follow. This includes disagreement with or
exceptions to existing best practices defined by the project.

Programming languages have addressed this problem through static program linters like rustc
and clippy. We can do the same for Dataflow Engine pipelines.

## Guide-level explanation

### What is a lint?

A lint is a single rule about how pipelines or nodes should generally be
constructed. Every lint has:

- a stable **name** (see [Lint names](#lint-names)),
- exactly one **category**, which determines its default enforcement level,
- exactly one **scope**, either node or pipeline (see
  [Lint scopes](#lint-scopes)),
- **documentation** explaining what the lint detects, why it matters, and how
  to fix it.

Lints are distinct from validation and type-checking errors. Validation and
type-checking are concerned with the question "does this pipeline/node even compile?"
and validation failures are hard errors that cannot be suppressed. For example,
if a config property has the wrong type or if a connection references a node that
doesn't exist.

Lints on the other hand say "this pipeline can run, but it likely shouldn't look
like this" and are fully configurable. For example, while you can do it, it's not
recommended to place a retry processor before the batch processor, as you may
duplicate batching work unnecessarily.

The basic pipeline for engine config processing:

```text
 YAML --> parse --> validate structure --> resolve lints --> validate nodes --> run   --> admit /
          (serde)   cycles, unknown URNs,  levels           hard errors +      linters      reject
                    bad ports, ...         (lints: blocks,  config lints
                    never suppressible     forbid)          emitted
```

### Where lints come from

Lints are declared in two places:

- **Nodes** declare **config lints** about their own configuration. A config
  lint is strictly node-local: it is emitted by the node's `validate_config`
  function while it validates that node's configuration.
- **Linters** declare lints that can see a whole pipeline. A linter is a
  component whose only purpose is to carry lints. Any rule that is not
  local to one node's configuration, such as a rule about where a node is
  placed relative to other nodes, is declared by a linter.

Every lint is namespaced by the URN of the component that declared it, so
config lints are named after their node type and linter lints after their
linter (see [Lint names](#lint-names)).

**Linters.** Linters have their own URN kind (`linter`) and are linked into
the engine the same way nodes and extensions are. Unlike nodes and
extensions, they are not placed in a configuration: **every linter that is
linked into the engine runs on every pipeline**, as if it were part of the
engine. Users control linters only through levels in `lints:` blocks. For
example, `linter:core-nodes: allow` turns off every lint in that linter for
the scope it is set at, and an individual lint can be allowed or denied by
name. Linters have no configuration for now (see
[Future possibilities](#future-possibilities)).

Each linter lint has exactly one check function, which the engine invokes
during the lint stage. Because each check is tied to one lint, the engine
can skip checks that cannot apply: a check that resolves to `allow` is not
run, and a check only runs on the nodes, or on pipelines containing the
nodes, that it declares an interest in.

**Built-in linters.** Pipeline-level rules written by the engine
maintainers are packaged as linters that live next to the nodes they are
about:

| Linter                 | Crate           | Contents                                       |
|------------------------|-----------------|------------------------------------------------|
| `linter:core-nodes`    | `core-nodes`    | Rules about core nodes and pipelines generally |
| `linter:contrib-nodes` | `contrib-nodes` | Rules about contrib nodes                      |

**Engine-emitted lints.** A few lints are detected by the engine itself
rather than by a node or a linter. They are emitted directly by the engine
code that already detects the condition, so detection logic is not
duplicated in a separate check. To keep every lint namespaced, they are
grouped under two reserved **pseudo-linters**: URNs that name a set of lints
but have no linter component behind them.

| Pseudo-linter   | Contents                                                                          |
|-----------------|-----------------------------------------------------------------------------------|
| `linter:meta`   | [Meta lints](#meta-lints) about the lint configuration itself                     |
| `linter:engine` | Lints about pipeline structure detected by the engine, such as `unconnected_node` |

For example, the engine already determines which nodes are unconnected so
that it can remove them when the pipeline is built; the lint stage uses the
same detection to report `linter:engine:unconnected_node`.

Which lints are _active_ for a given pipeline depends on the pipeline:

| Declared by   | Active in                                                                             | Initial level |
|---------------|---------------------------------------------------------------------------------------|---------------|
| Node          | Nodes of that type; emitted while each node's config is validated                     | Its default   |
| Linter        | Every pipeline. Node-scoped lints only visit nodes matching the lint's node interests | Its default   |
| Pseudo-linter | Every pipeline; emitted by the engine where it detects the condition                  | Its default   |

```text
 1. names known     all node, linter, and pseudo-linter lint names (compiled in)
 2. validate        structural config validation
 3. resolve         levels resolved from lints: blocks; forbid checked
 4. activate        per pipeline: config lints of node types used in the pipeline
                                + lints of every linked linter
                                + engine-emitted lints
 5. validate nodes  each node's validate_config runs and emits its config lints
 6. run             linter checks run, engine-emitted lints reported;
                    diagnostics reported or pipeline rejected
```

### Meta lints

The `linter:meta` lints report problems with the lint configuration itself.
They are ordinary lints and can be configured like any other.

| Lint                                        | Category     | Fires when                                                                     |
|---------------------------------------------|--------------|--------------------------------------------------------------------------------|
| `linter:meta:unknown_lints`                 | `suspicious` | A `lints:` block names a lint, component, or category the engine does not know |
| `linter:meta:renamed_and_removed_lints`     | `suspicious` | A `lints:` block uses a renamed or removed lint name                           |
| `linter:meta:unfulfilled_lint_expectations` | `suspicious` | An `expect` entry's lint did not fire                                          |

Meta lints are emitted where the engine checks the lint configuration:

| Lint                            | Emitted                                | Location                                                 |
|---------------------------------|----------------------------------------|----------------------------------------------------------|
| `unknown_lints`                 | When a `lints:` block is admitted      | The scope of that block (root, group, pipeline, or node) |
| `renamed_and_removed_lints`     | When a `lints:` block is admitted      | The scope of that block                                  |
| `unfulfilled_lint_expectations` | At the end of each pipeline's lint run | The pipeline or node where the `expect` entry is set     |

A mistake in a shared `lints:` block, such as the root or a group, is
therefore reported once at that block rather than once for every pipeline
that inherits it. As with any lint, the level is resolved from the location
outwards: `linter:meta:unknown_lints: allow` in a block silences unknown
entries in that block and the blocks nested inside it, but a pipeline cannot
silence a mistake in the root block.

### Lint names

Lints are referred to by name. Every lint is namespaced according to the URN
of the component that declared it (see [URN format](../docs/urns.md)): the
node type for config lints, and the linter or pseudo-linter for every other
lint. Lint names follow the same shortcut rules as component URNs:

```text
urn:otel:processor:batch:<lint_id>                 config lint, canonical form
processor:batch:<lint_id>                          config lint, otel shortcut form
linter:core-nodes:redundant_batch                  built-in linter
linter:meta:unknown_lints                          meta lint (pseudo-linter)
linter:engine:unconnected_node                     engine-emitted lint (pseudo-linter)
urn:acme:linter:prod_policy:no_debug_exporters     third-party linter
```

Rules:

- The otel shortcut form follows the same rule as node URNs: it is only
  valid for the `otel` namespace. All other namespaces must use the full
  `urn:` form. Because the `otel` namespace is reserved, so are lints
  defined by otel components.
- `linter` is a new URN kind, alongside `receiver`, `processor`,
  `exporter`, and `extension`.
- `urn:otel:linter:meta` and `urn:otel:linter:engine` are reserved for the
  pseudo-linters. No linter component may use them.
- A lint id uses the same character set as URN segments (`[a-z0-9._-]`) and
  cannot contain `:`.
- The category names (`correctness`, `suspicious`, `perf`, `style`) and
  `warnings` are reserved and may not be used as lint ids, so that they
  remain unambiguous as [selectors](#selectors).
- Lint names are stable. A lint that is renamed keeps its old name as an
  alias, and using the alias triggers `linter:meta:renamed_and_removed_lints`.
  Removing a lint entirely is considered a breaking change.
- Defining the same fully qualified lint name twice is a hard error when the
  engine starts.

### Lint scopes

For now, lints operate on a single pipeline at a time. A lint may inspect any node,
connection, or setting within that pipeline (including the settings it inherits from
its group and the root). In the future we may extend lints to operate across pipelines,
including those connected by a topic.

Every lint has a scope, which is either **node** or **pipeline**. The scope
is independent of who declared the lint:

- A **node-scoped lint** checks a single node, and its diagnostics always
  point at that node. Config lints are always node-scoped: they are emitted
  while each node of the declaring type is validated, and only see that
  node's configuration. Linters can also declare node-scoped lints, which
  are run once for each node matching their node interests and can see the
  whole pipeline.
- A **pipeline-scoped lint** checks a pipeline as a whole and is run once
  per pipeline. Only linters declare pipeline-scoped lints. Their
  diagnostics always point at the pipeline. A diagnostic that concerns
  specific nodes (for example, a rule about node ordering) lists them as
  related locations, similar to rustc's secondary spans. Related locations
  are informational only; they do not affect the diagnostic's level.

A diagnostic's location (the node or the pipeline) determines which
configurations apply when resolving its level. More on that below. The only
diagnostics located elsewhere are [meta lints](#meta-lints) about the root
or a group's `lints:` block, which are located at that root or group.

The engine's observability pipeline (`engine.observability.pipeline`) is
linted like any other pipeline. It has no group, so its scopes are the root,
the observability pipeline itself, and its nodes.

### Enforcement Levels

Enforcement levels determine if a lint is enforced and if it's a warning or error.
Errors will prevent the creation of pipelines that don't pass the lint, whereas
warnings are just reported as events.

| Level    | Reported?                   | Overrideable? |
|----------|-----------------------------|---------------|
| `allow`  | No                          | Yes           |
| `expect` | Yes, warning if unfulfilled | Yes           |
| `warn`   | Yes, as a warning           | Yes           |
| `deny`   | Yes, as an error            | Yes           |
| `forbid` | Yes, as an error            | **No**        |

### Categories

Every lint belongs to exactly one of a fixed set of categories which defines the
default enforcement level.

| Category      | Default Level | Meaning                                                                                                  |
|---------------|---------------|----------------------------------------------------------------------------------------------------------|
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

| Selector             | Example                                          | Matches                                          |
|----------------------|--------------------------------------------------|--------------------------------------------------|
| Full Urn             | `processor:batch:<lint_id>`                      | Exactly one lint                                 |
| Component + category | `processor:batch:perf`, `linter:core-nodes:perf` | Lints defined by that component in that category |
| Component            | `processor:batch`, `linter:meta`                 | All lints defined by that component              |
| Category             | `correctness`                                    | All lints in that category, from every source    |

Linters and pseudo-linters are components for the purpose of selectors.
Categories are reserved names that select the entire category of lints at
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
          urn:acme:linter:prod_policy: allow
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
|------------|----------------------------------|
| Pipeline   | CLI, root, group, pipeline       |
| Node       | CLI, root, group, pipeline, node |

A pipeline lint therefore applies to a pipeline as a whole: it cannot be
allowed for some nodes of a pipeline and not others. If some nodes need
different rules, they belong in a different pipeline. Broad selectors at
node scope (e.g. `perf: allow` or `linter:core-nodes: allow`) apply only to
the node-scoped lints they match.

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
for node-scoped lints, and from the pipeline for pipeline-scoped lints.

```text
 CLI flags                    (outermost)   ^
   root        lints:                       |  search from the innermost
     group       lints:                     |  scope outwards; the first
       pipeline    lints:                   |  scope with a matching entry
         node        lints:   (innermost)   |  wins
              ^
              node-scoped lints start here; pipeline-scoped lints start one level up
```

In the first scope that has any entry matching the lint, the most specific
matching entry wins. If no scope matches, the lint's default level is used.
The `warnings` selector then promotes `warn` to `deny` where it is set to
`deny` or `forbid`, and finally the [cap](#capping-lint-levels) lowers the
level if it is set.

The final level decides what happens to a diagnostic: `allow` drops it,
`warn` reports it, and `deny` and `forbid` report it and reject the
pipeline.

Every lint's location is known before anything is emitted, so the engine
resolves levels up front, before any node is validated (see
[Level tables](#level-tables)). For config lints and engine-emitted lints
this means a diagnostic that resolves to `allow` is dropped at the moment it
is emitted. Linter lints go one step further: a linter lint that resolves to
`allow` is not run at all.

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

Setting `expect` is similar to `allow`, but it will trigger the
`linter:meta:unfulfilled_lint_expectations` meta lint if the diagnostic is
not present at the scope that `expect` is declared on. Config lints and
engine-emitted lints are always evaluated, so their diagnostics are simply
suppressed and recorded as fulfilling the expectation. Unlike `allow`, a
linter lint resolved to `expect` is still run so that the engine can tell
whether it fired; its diagnostics are suppressed. An `expect` set
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
  Pipeline and node `lints:` blocks can be changed this way; the pipeline is
  re-linted with the new levels before the change is admitted, but is not
  restarted. The root `lints:` block, `engine.lint_cap`, and the `lints:`
  block of a group that contains pipelines can only be changed by restarting
  the engine (see
  [Live changes to lint configuration](#live-changes-to-lint-configuration)).
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

For example, a hypothetical batch processor config lint that fires when a batch
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

Linting is split across three crates:

| Crate                                        | Contents                                                                                                                                                                                                                                                                                                   |
|----------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `config` (existing), new `lint` module       | Config types for the `lints:` blocks, and the declaration API used by config lints: `LintSet`, `LintSetDescriptor`, `LintInfo`, `Category`, `Level`, `ConfigLintContext`, `LintHandle`                                                                                                                     |
| `lint-macros` (`otel-arrow-dfe-lint-macros`) | The `#[derive(Lints)]` proc macro                                                                                                                                                                                                                                                                          |
| `lint` (`otel-arrow-dfe-lint`)               | `LinterFactory` and the `LINTER_FACTORIES` distributed slice, the check types (`Check`, `NodeInterests`, `LintContext`, `LintSink`), the pseudo-linter lint sets, the lint registry, selector parsing, level resolution and level tables, the lint stage, and common helpers such as node-placement checks |

The declaration API used by config lints has to live in `config`. Node
factories reference it through `validate_config`, and the shared validation
helpers in `config::validation` (`validate_typed_config`, `no_config`) need
it in their signatures. `config` therefore cannot depend on the `lint`
crate. The `lint` crate depends on `config`, so the derive's generated code
refers to `otel_arrow_dfe_config::lint`, and the pseudo-linters in the
`lint` crate use the derive like any other lint set.

Crates that define linters, including `core-nodes` and `contrib-nodes` for
the built-in linters, depend on the `lint` crate. The `lint` crate does not
depend on the engine, so linters have no `PData` type parameter.

Putting everything in `config` would avoid a new crate. It would also add
lint execution and a registry to a crate that today only describes the
config format.

### Lint types

```rust
// config::lint

/// Static description of one lint. Used by the registry, selectors, events,
/// and generated documentation.
pub struct LintInfo {
    /// Local id, e.g. "forwards_everything". The full name is derived from
    /// the owning component's URN at registration time.
    pub id: &'static str,
    pub category: Category,
    /// One-line summary used in generated docs.
    pub summary: &'static str,
    /// Longer explanation: what, why, and how to fix.
    pub docs: &'static str,
    /// Previous ids of this lint, accepted with `renamed_and_removed_lints`.
    pub renamed_from: &'static [&'static str],
}

/// Every lint in one lint set, in declaration order. A lint's position in
/// `lints` is its index.
pub struct LintSetDescriptor {
    pub lints: &'static [LintInfo],
}

/// Implemented by `#[derive(Lints)]` on a unit-only enum. Each variant is
/// one lint.
pub trait LintSet: Copy + 'static {
    const DESCRIPTOR: &'static LintSetDescriptor;
    /// Position of this lint in `DESCRIPTOR.lints`.
    fn index(self) -> usize;
}

/// Lint category
pub enum Category { Correctness, Suspicious, Perf, Style }

/// Enforcement level
pub enum Level { Allow, Expect, Warn, Deny, Forbid }
```

Every lint, whoever declares it, is declared the same way as metric sets
and attribute enums: as a Rust type, annotated with a derive macro that
generates static metadata. A **lint set** is a unit-only enum deriving
`Lints`, in which every variant is one lint:

```rust
#[derive(Clone, Copy, Lints)]
pub enum BatchLint {
    /// Long-form documentation: what the lint detects, why it matters,
    /// and how to fix it. Taken from the variant's doc comment.
    #[lint(suspicious, summary = "batch processor forwards every request without batching")]
    ForwardsEverything,

    /// ...
    #[lint(perf, summary = "...", renamed_from = "old_lint_id")]
    SomeOtherLint,
}
```

`#[lint(...)]` accepts the following arguments:

| Argument              | Required | Meaning                                                          |
|-----------------------|----------|------------------------------------------------------------------|
| category              | Yes      | One of `correctness`, `suspicious`, `perf`, `style`              |
| `summary = "..."`     | Yes      | One-line summary                                                 |
| `id = "..."`          | No       | Lint id. Defaults to the variant name in snake_case              |
| `renamed_from = ".."` | No       | Previous id, can be repeated. Keeps old names working as aliases |

The variant's `///` doc comment becomes `LintInfo::docs`, the same way a
metric field's doc comment becomes its `brief`. The derive rejects
non-unit variants, explicit discriminants, generic enums, and missing
categories or summaries at compile time, and checks that ids are
well-formed and are not reserved words. Because there is no runtime
construction, `DESCRIPTOR` is a `static`, and `index()` compiles to the
enum discriminant. The derive also generates an inherent
`const fn index_const(self) -> usize`, so that linters can refer to their
lints in `static` items.

A `LintSetDescriptor` does not contain any names. The registry derives each
lint's full name by appending its id to the URN of the component that owns
the set. This keeps declarations short, guarantees that a component's lints
share its namespace, and means renaming a component URN renames all of its
lints in one place.

A lint set does not declare scopes. Config lints are always node-scoped,
and each linter lint's scope comes from its check (see
[Declaring linters](#declaring-linters)).

#### Config lints

Config lints are emitted during config validation, so `validate_config` on
every node factory gains a context parameter:

```rust
pub validate_config: fn(
    config: &serde_json::Value,
    lints: &mut ConfigLintContext<'_>,
) -> Result<(), otel_arrow_dfe_config::error::Error>,
```

The derive generates an inherent `register` function, mirroring the
`register` function that `#[metric_set]` generates:

```rust
impl BatchLint {
    pub fn register<'a>(cx: &'a mut ConfigLintContext<'_>) -> LintHandle<'a, BatchLint>;
}
```

The engine creates a `ConfigLintContext` for each node it validates. The
context holds that node's precomputed [level table](#level-tables), which
maps each lint in the node's lint set to its final level. A validator
registers its lint set to get a typed handle, and emits through the handle:

```rust
/// Created by the engine for each node it validates.
pub struct ConfigLintContext<'a> { /* ... */ }

impl ConfigLintContext<'_> {
    /// A context that drops everything. Used when a config is validated
    /// for a purpose other than admission, and in tests.
    pub fn discard() -> ConfigLintContext<'static>;
}

/// A node's registered lint set, bound to that node's level table.
pub struct LintHandle<'a, L: LintSet> { /* ... */ }

impl<L: LintSet> LintHandle<'_, L> {
    /// Emit a diagnostic for `lint` at the node being validated.
    pub fn emit(&mut self, lint: L, message: impl Into<String>);

    /// Like `emit`, but only builds the message if it will be recorded.
    pub fn emit_with(&mut self, lint: L, message: impl FnOnce() -> String);
}
```

`emit` looks up the lint's resolved level by `lint.index()` and acts on it
immediately:

```text
 emit(L::X, msg)
   levels[L::X.index()]
     allow                -> dropped; the message is never stored
     expect               -> dropped; marks the expectation fulfilled
     warn / deny / forbid -> recorded as a diagnostic with that level
```

The level already includes the `warnings` promotion and the cap, so
emitting a lint costs an index and a branch, and validators never need to
ask whether a lint is enabled. Message arguments are evaluated before
`emit` is called, as with any function, so a validator that builds an
expensive message can use `emit_with(lint, || ...)`, which only calls the
closure if the diagnostic is recorded.

Registration plays the same role as metric set registration: it binds a
typed handle to the storage the engine prepared for this node. `register`
checks that `L::DESCRIPTOR` is the descriptor declared by the node's
factory, comparing pointers. A mismatch is a bug in the node, not in the
user's configuration, so it is reported as an internal error event, does
not affect admission, and the handle drops every diagnostic. Node unit
tests that exercise a lint catch this kind of mismatch.

This design has several consequences:

- **Nodes cannot emit undeclared lints.** A validator can only emit
  variants of the enum its factory declared. Any other enum fails the
  registration check.
- **Config lints are cheap to evaluate, so they always are.** Config lints
  run as part of validation, which already deserializes the config. Rather
  than deciding whether to call each lint, the engine lets the validator
  run in full and suppresses diagnostics when they are emitted. `expect`
  therefore needs no special handling for config lints.
- **Work is shared with validation.** A validator deserializes its config
  once and uses the typed value both to validate it and to check its
  lints. No separate typed-config cache is needed for config lints.
- **No new phase for config lints.** Config lints follow the validator: any
  path that validates a node, and passes it a real context, also lints it.

#### Linter checks

Linter lints are not part of any component's validation, so each one has a
check function that the engine invokes during the lint stage. The check's
variant encodes the lint's scope:

```rust
// lint crate

/// A linter lint's scope and check function.
pub enum Check {
    /// A pipeline-scoped lint, run once per pipeline.
    Pipeline {
        /// If set, the lint only runs on pipelines that contain at least one
        /// node matching these interests.
        requires: Option<NodeInterests>,
        check: fn(&LintContext<'_>, &mut LintSink<'_>),
    },
    /// A node-scoped lint, run once per node that matches `interests`.
    Node {
        interests: NodeInterests,
        check: fn(&LintContext<'_>, NodeRef<'_>, &mut LintSink<'_>),
    },
}

/// Which node types a lint is interested in.
pub enum NodeInterests {
    /// Every node.
    All,
    /// Nodes of the listed types (URNs).
    Types(&'static [&'static str]),
}
```

The engine, not the lint, invokes each check at every construct of the
right kind, and skips it wherever it resolves to `allow` or where its
interests do not match. A linter lint resolved to `expect` is still run, so
that the engine can tell whether the expectation was fulfilled. Each
invocation gets a context and a sink bound to exactly that lint and that
location:

```rust
/// Context for linter checks: the whole pipeline.
pub struct LintContext<'a> {
    /// Per-run state shared by every check invocation in this pipeline's run.
    state: &'a PipelineLintState<'a>,
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
    /// Add a related node (pipeline-scoped lints only).
    pub fn related(self, node: &NodeId) -> Self;
}
```

Linters therefore cannot emit undeclared lints either: a check can only
emit through a sink bound to its own lint.

**Caching.** Several linter checks often look at the same pipeline, so the
engine creates a `PipelineLintState` at the start of each pipeline's lint
run and drops it at the end. Cached values never outlive a run or leak
between pipelines. It holds:

- the pipeline being linted;
- the graph, in a `OnceCell` that is filled on the first `graph()` call;
- typed node configs, in a map keyed by `(NodeId, TypeId)`.

The engine builds a small `LintContext` for each check invocation, pointing
at the shared state. Caches are filled lazily.

Because checks share the context through `&self`, filling a cache on a miss
requires interior mutability. The config cache is a map behind a `RefCell`
holding `Arc<dyn Any + Send + Sync>` values; a lookup clones the `Arc` and
downcasts it to `Arc<T>`. Returning `Arc<T>` rather than `&T` avoids holding
a `RefCell` borrow across the caller's use of the value, without `unsafe` or
new dependencies, at the cost of a reference count increment per call. If
lint runs are ever parallelized, the `RefCell` becomes a lock or concurrent
map without changing the API. `graph()` can return a plain reference because
a `OnceCell` never changes once set.

**Failure.** `raw_config` cannot fail. `typed_config` can: validation has
proven that each node config deserializes into _that node's_ config type,
but a check may ask for a different type, such as a small view struct. A
failed `typed_config` is treated as an internal error in the lint (reported
as an event), not as a lint diagnostic, and does not affect admission.

### Declaring config lints

`ReceiverFactory`, `ProcessorFactory`, and `ExporterFactory` each gain a
`lints: Option<&'static LintSetDescriptor>` field naming the node's lint set.
The hand-written `Clone` impls for these factories are updated accordingly.
Each factory declares at most one lint set, and nodes without lints use
`None`.

A config lint is emitted while a node of the declaring type is validated,
and only for nodes of that type. It is strictly node-local: the validator
only has the node's own configuration. Rules that involve other nodes or the
pipeline's structure are declared by a linter (see
[Declaring linters](#declaring-linters)).

For example, the batch processor could declare a config lint for a
configuration that disables batching:

```rust
// batch_processor/lint.rs
#[derive(Clone, Copy, Lints)]
pub enum BatchLint {
    /// With `min_size` set to 0 and no `max_size`, every request is
    /// forwarded as soon as it arrives, so the processor adds overhead
    /// without batching anything. Set `min_size`, or remove the processor.
    #[lint(suspicious, summary = "batch processor forwards every request without batching")]
    ForwardsEverything,
}

// batch_processor/mod.rs
#[distributed_slice(OTAP_PROCESSOR_FACTORIES)]
pub static OTAP_BATCH_PROCESSOR_FACTORY: ProcessorFactory<OtapPdata> = ProcessorFactory {
    name: OTAP_BATCH_PROCESSOR_URN,
    create: |pipeline_ctx, node, node_config, proc_cfg, _caps| { /* ... */ },
    context_declarations: None,
    wiring_contract: WiringContract::UNRESTRICTED,
    validate_config: validate_batch_config,
    lints: Some(BatchLint::DESCRIPTOR),
};

fn validate_batch_config(
    raw: &serde_json::Value,
    cx: &mut ConfigLintContext<'_>,
) -> Result<(), Error> {
    let config: Config = deserialize_typed_config(raw)?;
    let mut lints = BatchLint::register(cx);
    if config.min_size == 0 && config.max_size.is_none() {
        lints.emit(
            BatchLint::ForwardsEverything,
            "min_size is 0 and max_size is unset, so requests are never batched",
        );
    }
    Ok(())
}
```

`BatchLint::ForwardsEverything` is named
`urn:otel:processor:batch:forwards_everything`, is evaluated for each batch
processor node, and can be allowed on an individual node.

**Shared validators.** The shared helpers in `config::validation`,
`validate_typed_config::<T>` and `no_config`, gain the context parameter and
ignore it. The roughly 40 nodes that use them do not change, and nodes
without lints never register a set. The handful of hand-written validators
gain the parameter mechanically.

**Extension validators.** `ExtensionFactory` and `ControllerExtensionFactory`
share the same `validate_config` signature, so the shared helpers work for
them too. Extensions do not declare config lints for now: they are
validated with a context that has no lint set, so registering one would
fail the registration check. Letting extensions emit config lints the same
way as nodes is listed under [Future possibilities](#future-possibilities).

### Declaring linters

A linter is declared by a `LinterFactory` registered in the
`LINTER_FACTORIES` distributed slice, the same way node and extension
factories are registered:

```rust
// lint crate
pub struct LinterFactory {
    /// The linter's URN, e.g. `urn:otel:linter:core-nodes`.
    pub name: &'static str,
    /// The linter's lint set.
    pub lints: &'static LintSetDescriptor,
    /// Exactly one check per lint in `lints`.
    pub checks: &'static [LintCheck],
}

pub struct LintCheck {
    /// Index of the lint in the linter's lint set.
    pub lint: usize,
    pub check: Check,
}

#[distributed_slice]
pub static LINTER_FACTORIES: [LinterFactory] = [..];
```

Linters and their lints map **strictly one to one**: every lint in the set
has exactly one check, and every check names a lint in the set. Building
the registry fails if a lint has no check, has more than one, or if a check
names an index outside the set. A unit test in every crate that defines a
linter runs the same check, so mistakes are caught in CI.

Every linter linked into the engine is active for every pipeline, including
the observability pipeline. There is no configuration to place or
instantiate a linter; its lints are controlled only by levels.

### Built-in linters

Rules written by the engine maintainers that are not local to one node's
configuration are packaged as built-in linters. They live in the crates
of the nodes they are about:

| Linter                          | Crate           | Rules about                        |
|---------------------------------|-----------------|------------------------------------|
| `urn:otel:linter:core-nodes`    | `core-nodes`    | Core nodes and pipelines generally |
| `urn:otel:linter:contrib-nodes` | `contrib-nodes` | Contrib nodes                      |

Because a built-in linter lives next to the nodes it lints, it can refer to
their URN constants and, if desired, their config types. A linter in
`contrib-nodes` that needs to reason about core nodes refers to them by
URN. Whether built-in linters should read node configuration through the
nodes' own config types or through small view structs is an
[unresolved question](#unresolved-questions).

For example, the core-nodes linter could include a lint for two batch
processors on the same path:

```rust
// core-nodes/src/linter.rs
#[derive(Clone, Copy, Lints)]
pub enum CoreNodesLint {
    /// ...
    #[lint(perf, summary = "batch processor downstream of another batch processor")]
    RedundantBatch,
}

#[distributed_slice(LINTER_FACTORIES)]
pub static CORE_NODES_LINTER: LinterFactory = LinterFactory {
    name: "urn:otel:linter:core-nodes",
    lints: CoreNodesLint::DESCRIPTOR,
    checks: &[LintCheck {
        lint: CoreNodesLint::RedundantBatch.index_const(),
        check: Check::Pipeline {
            requires: Some(NodeInterests::Types(&[OTAP_BATCH_PROCESSOR_URN])),
            check: check_redundant_batch,
        },
    }],
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

`CoreNodesLint::RedundantBatch` is named
`urn:otel:linter:core-nodes:redundant_batch` (shortcut
`linter:core-nodes:redundant_batch`). It runs once per pipeline containing a
batch processor, reports one diagnostic per offending pair with both nodes
as related locations, and can be allowed for a pipeline (or any enclosing
scope) like any other pipeline-scoped lint.

### Pseudo-linters

Lints that the engine detects itself are declared with the same derive in
the `lint` crate, as two lint sets:

```rust
/// Lints about the lint configuration. Registered as `urn:otel:linter:meta`.
#[derive(Clone, Copy, Lints)]
pub enum MetaLint {
    /// ...
    #[lint(suspicious, summary = "lints: block names an unknown lint, component, or category")]
    UnknownLints,
    /// ...
    #[lint(suspicious, summary = "lints: block uses a renamed or removed lint name")]
    RenamedAndRemovedLints,
    /// ...
    #[lint(suspicious, summary = "an expect entry's lint did not fire")]
    UnfulfilledLintExpectations,
}

/// Lints about pipeline structure detected by the engine. Registered as
/// `urn:otel:linter:engine`.
#[derive(Clone, Copy, Lints)]
pub enum EngineLint {
    /// ...
    #[lint(suspicious, summary = "node is not connected and will be removed")]
    UnconnectedNode,
}
```

The registry registers these sets under their reserved pseudo-linter URNs.
They have no `LinterFactory` and no checks; the 1:1 rule applies only to
real linters. A `LinterFactory` that uses a reserved URN is a registry
error. The engine emits these lints through a `LintHandle` bound to the
level table of the location where it detected the condition, so they are
suppressed in exactly the same way as config lints.

Unlike a node's lint set, pseudo-linter lints are located at different
kinds of scope: `unconnected_node` at a node, `unknown_lints` at whichever
scope holds the offending `lints:` block, and
`unfulfilled_lint_expectations` at the pipeline or node that set the
`expect`. The engine therefore keeps level tables for them at every scope
it may emit at (see [Level tables](#level-tables)).

### Gathering lints

Lints are gathered into a `LintRegistry` once per process:

```text
 node factories: lints: Option<&Descriptor>  --+   owner = node factory name (URN)
 LINTER_FACTORIES: lints + checks            --+--> LintRegistry
 MetaLint / EngineLint (lint crate)          --+    full name -> (LintInfo, owner, category, scope)
                                                    alias     -> full name
                                                    owner URN -> lint set (+ checks for linters)
```

`PipelineFactory<PData>` gains a non-generic accessor that returns, for each
compiled-in node factory, its URN and its lint set descriptor. Like the
existing factory maps, the result is computed once and cached in a
`OnceLock`. The controller combines it with `LINTER_FACTORIES` and the two
pseudo-linter sets to build the registry. The `renamed_from` aliases of
every lint are entered in the same name table, so selectors that use an old
name resolve to the lint and trigger `linter:meta:renamed_and_removed_lints`.

The registry records each lint's scope: node for config lints, the
`Check` variant for linter lints, and the emission site for pseudo-linter
lints. It also keeps, for each lint set, the full names of its lints in
index order. This is what [level tables](#level-tables) are built from.

Building the registry fails with a hard error if:

- two lints, or a lint and an alias, have the same full name;
- a linter's lints and checks are not one to one; or
- a linter uses a reserved pseudo-linter URN.

The derive already rejects reserved lint ids at compile time.

The same checks run as a unit test in the `component-inventory` crate, which
already links every node crate, so collisions are caught in CI rather than
at deploy time.

### Executing lints

Linting is woven into the existing validation path rather than running as a
separate stage after it. Level resolution moves ahead of component
validation, so that node validators can drop suppressed diagnostics as they
emit them:

```text
 parse --> validate() --> LINT CONFIG --> validate_engine_components --> LINT STAGE --> compile_initial_context --> run
           structural     lints: blocks,   per node: validate_config     linter checks,
                          forbid, level    (raw, cx) emits config lints  engine-emitted
                          tables                                         lints
```

Resolving levels only needs the registry and the `lints:` blocks, which
are both available after structural validation, so nothing is lost by
doing it first. When the lint stage runs, every URN is known to the
registry and every node and extension config has been validated, so
linter checks can rely on both, just as clippy relies on code having
type-checked.

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

#### Level tables

A **level table** maps every lint of one lint set to its final level at one
location. It is a slice indexed by `LintSet::index()`:

```rust
/// A lint's level at one location, after `warnings` and the cap.
pub struct ResolvedLevel {
    pub level: Level,
    /// The selector and scope that set the level, if not the default.
    /// Used for the `lint.level.selector` and `lint.level.scope` event
    /// attributes, and to attribute `expect` fulfillment to its entry.
    pub source: Option<LevelSource>,
}
```

To fill an entry, the engine walks the scope chain from the location
outwards. In the first scope with any entry matching the lint, it takes the
most specific matching entry (full name, then component and category, then
component, then category). If no scope matches, it uses the lint's default
level. A `warn` is then promoted to `deny` if the `warnings` selector
resolves to `deny` or `forbid` at the same location, and finally the level
is lowered to at most `lint_cap`, if set.

The engine builds the following tables for each pipeline being admitted:

| Location    | Tables                                                                                     |
|-------------|--------------------------------------------------------------------------------------------|
| Root, group | `MetaLint` (built once per admission of that scope)                                        |
| Pipeline    | `MetaLint`, and every linter's pipeline-scoped lints                                       |
| Node        | `MetaLint`, `EngineLint`, the node type's lint set, and every linter's node-scoped lints   |

Tables are small (one entry per declared lint) and live only for the
duration of the admission. Each table also has a bitset recording which
`expect` levels were fulfilled.

#### Stages

**A. Lint configuration.** After structural validation:

1. **Check `lints:` blocks.** Each `lints:` block being admitted has its
   selectors checked against the registry, emitting
   `linter:meta:unknown_lints` and `linter:meta:renamed_and_removed_lints`
   located at that block's scope. The root
   block is checked at startup. Group blocks are checked at startup and on
   group creation. Pipeline and node blocks are checked whenever their
   pipeline is created or replaced, whether through a pipeline update or a
   reconcile.
2. **Check `forbid`.** Using the registry to map lints to categories and
   components, check every scope for an entry that would change the level of
   a lint forbidden in an enclosing scope or by a less specific selector in
   the same scope. A conflict is a hard error, and nothing else is run.
3. **Build level tables** for every pipeline being admitted, as described
   above.

**B. Component validation.** `validate_engine_components` runs as it does
today, except that it creates a `ConfigLintContext` for each node, bound to
the node's level table and lint set, and passes it to the node's
`validate_config`. A validation error is a hard error and stops admission as
it does today; any diagnostics the failing node had already emitted are
discarded with it. Every node is validated, including nodes that are
unconnected and will be removed when the pipeline is built, so they also
receive their config lints.

Pipeline extensions are validated in the same pass with a context that
has no lint set. Controller extensions are validated by
`validate_controller_extensions` in the same way.

**C. Lint stage.** For each resolved pipeline being admitted:

1. **Report unconnected nodes.** Determine which nodes are unconnected,
   using `PipelineConfig::remove_unconnected_nodes` on a copy of the
   pipeline (as `OtelDataflowSpec::validate()` already does for the
   observability pipeline), and emit `linter:engine:unconnected_node` for
   each. The pipeline itself is not modified; see
   [Unconnected nodes](#unconnected-nodes).
2. **Run pipeline-scoped linter lints.** For every linter, run each
   `Check::Pipeline` whose `requires` (if any) matches at least one node in
   the pipeline. If the lint's level at the pipeline is `allow`, skip it;
   otherwise invoke its check.
3. **Run node-scoped linter lints.** For each node, run every linter's
   `Check::Node` whose `NodeInterests` match the node's type. If the lint's
   level at the node is `allow`, skip it; otherwise invoke its check with
   that node.
4. **Report unfulfilled expectations.** Emit
   `linter:meta:unfulfilled_lint_expectations` for each `expect` entry in
   the pipeline or its nodes that no diagnostic fulfilled, from any source:
   config lints emitted during component validation, engine-emitted lints,
   and linter lints.

Linter checks run on the pipeline as configured, including unconnected
nodes, so that every lint sees the same pipeline and every `lints:` entry,
on every node, takes effect. A `PipelineLintState` is created for each
pipeline's run and shared by all of its check invocations (see
[Linter checks](#linter-checks)).

Diagnostics from all three stages are collected with the level they had
when emitted. Because levels are final when the tables are built, there is
no separate step to apply the cap or `warnings`.

#### Unconnected nodes

Pruning is unchanged. `PipelineFactory::build()` still removes unconnected
nodes when it builds a pipeline, and still fails with `EmptyPipeline` if no
nodes remain. The lint stage only reports them. The build-time
`otel_info!`/`otel_warn!` events for removed nodes are kept for now, since
they describe what the build actually did on each core; whether they become
redundant with `linter:engine:unconnected_node` can be revisited separately.

As a consequence, an unconnected node is validated and linted like any
other node before it is removed: it may receive config lints, linter lints,
and engine-emitted lints, its `lints:` entries apply, and its `expect`
entries are checked.

#### Other callers of `validate_config`

`validate_config` is also called outside admission:

- `node_context_declarations` (`crates/engine/src/context_declaration.rs`)
  validates each node again before collecting its context declarations.
  It passes `ConfigLintContext::discard()`, so diagnostics are not reported
  twice.
- The validator tests in `crates/validation/tests/validate_config_tests.rs`,
  which check that every registered validator rejects invalid configs,
  pass `ConfigLintContext::discard()`.
- Node unit tests that test their lints use a test helper that returns a
  context with every lint at `warn` and exposes the recorded diagnostics.

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
|-----------------------|-----------------------|----------------------|
| Startup               | Engine does not start | Pipeline is admitted |
| `--validate-and-exit` | Non-zero exit         | Zero exit            |
| Live reconfiguration  | Change rejected       | Change is admitted   |

**Locations.** Diagnostics locate problems by config path (e.g.
`groups.dev.pipelines.main.nodes.debug`). File, line, and column are not
available: `serde_yaml` 0.9 does not retain source positions, and
environment variable substitution happens before parsing, so offsets would
not match the original file.

### Live changes to lint configuration

Lint configuration that is shared by several pipelines can only be changed
by restarting the engine, following the same rule live reconfiguration
already applies to shared policies:

| Lint configuration                                     | Changed live?                                       |
|--------------------------------------------------------|-----------------------------------------------------|
| Root `lints:` block                                    | No; restart required                                |
| Group `lints:` block, group has pipelines              | No; restart required                                |
| Group `lints:` block on group creation                 | Yes (new groups are empty)                          |
| `engine.lint_cap`                                      | No; restart required (as for other `engine` fields) |
| CLI lint flags (`-A`, `-W`, `-D`, `-F`, `--cap-lints`) | No; fixed for the lifetime of the process           |
| Pipeline and node `lints:` blocks                      | Yes, through pipeline updates and reconcile         |

Live reconciliation compares only the fields it knows about, so a new root
`lints` field would otherwise be accepted and silently ignored.
`validate_reconcile_capabilities` therefore gains an explicit check that
rejects changes to the root `lints:` block and to the `lints:` block of any
group with current or requested pipelines, with the same
`unsupported_mutation` error and "restart required" message as for shared
policies. `reconcile_target_config`, which copies root fields from the
desired config, carries the new field. The capability table in
`docs/admin/live-reconfiguration.md` gains a matching row.

**Lint-only pipeline changes.** A pipeline change that only modifies the
pipeline's or its nodes' `lints:` blocks goes through the full lint stage
like any other pipeline change: the pipeline is linted with the new levels,
any error rejects the change, and the resulting warnings are emitted as
`pipeline.lint.diagnostic` events. Because lints do not affect a running
pipeline, `ResolvedPipelineConfig::runtime_matches` ignores `lints:` blocks,
so an admitted lint-only change is planned as a `noop` rollout: the new
configuration is committed and the pipeline keeps running without a
restart.

### Emitting lint events

The `lint` crate depends only on `config` and has no telemetry dependency, so
it returns diagnostics as plain values. The controller converts each reported
diagnostic in a `LintReport` into a `pipeline.lint.diagnostic` event using
the `otel_warn!` (for `warn`) or `otel_error!` (for `deny` and `forbid`)
macros. Diagnostics at `allow` or `expect` are not emitted. The event body
is the diagnostic's message.

| Attribute               | Present                                         | Description                                                                                                                    |
|-------------------------|-------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `lint.location`         | Always                                          | Where the diagnostic is located; one of `root`, `group`, `pipeline`, `node`                                                    |
| `pipeline.group.id`     | Location is a group, pipeline, or node          | Group of the diagnostic (`system` for the observability pipeline)                                                              |
| `pipeline.id`           | Location is a pipeline or node                  | Pipeline of the diagnostic                                                                                                     |
| `node.id`               | Location is a node                              | Node the diagnostic points at                                                                                                  |
| `node.urn`              | Location is a node                              | URN of that node                                                                                                               |
| `lint.name`             | Always                                          | Full lint name, e.g. `urn:otel:processor:batch:<lint_id>`                                                                      |
| `lint.related.node.ids` | Pipeline-scoped lint with related nodes         | Ids of the related nodes (string array)                                                                                        |
| `lint.level`            | Always                                          | Final level after `warnings` and the cap; one of `warn`, `deny`, `forbid`                                                      |
| `lint.level.selector`   | Level was set by a `lints:` entry or a CLI flag | The selector that set the level, e.g. `correctness` or `warnings`                                                              |
| `lint.level.scope`      | Level was set by a `lints:` entry or a CLI flag | Where that selector was configured; one of `cli`, `root`, `group`, `pipeline`, `node` (never `node` for pipeline-scoped lints) |

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
- Linked linters and upgrades. Linking a new linter, or upgrading one that
  gains lints, changes which lints run without any configuration change.
  This interacts with the upgrade question under
  [Unresolved questions](#unresolved-questions).
- Reusing validated configs for linter checks. Config lints already share
  their validator's deserialized config. Linter checks still deserialize
  node configs into their own types, through the per-run cache.

## Rationale and alternatives

### Alternatives considered

- **Extensions as linters.** An earlier version of this design let pipeline
  and controller extensions declare lints, with built-in lints packaged as
  controller extensions. Extensions are a poor fit for components whose only
  purpose is to carry lints:
  - Extensions are runtime components. A pipeline extension's `create` is
    called on every core when the pipeline is built, and an extension that no
    node binds to is dropped with an `extension.unbound` warning. A lint-only
    pipeline extension would be built and discarded on every core, and a
    lint-only controller extension would need a `start` that does nothing.
  - Lints are needed at admission, before any build, and sometimes without
    any build at all (`--validate-and-exit`, rejected changes).
  - An extension's reach is fixed by where it is declared: one pipeline, or
    the whole engine. There are no group-level extensions, so a policy for one
    group could not be expressed by placement.
  - Packaging lints with an extension links the extension's runtime
    dependencies (SDKs, clients, async runtimes) into anything that wants to
    run its lints, such as a future `dfctl lint`.
  - Several instances of one extension type would each run the same lints,
    while levels are configured by lint name, so instances could not be
    told apart in `lints:` blocks.
- **Lints as an extension capability.** Capabilities are how extensions
  provide services to nodes, so declaring a "pipeline linter" capability was
  considered. Capabilities, however, are produced by an extension instance
  built at pipeline build time on each core, are consumed by nodes through
  explicit `capabilities:` bindings in node config, and come in async local
  and shared variants for the data path. Linting needs none of this: it runs
  synchronously in the controller at admission, is consumed by the engine
  rather than a node, and must work without building anything. Controller
  extensions also have no capability mechanism. A lint capability would
  share only the name with existing capabilities.
- **Placing linter instances in the configuration.** Linters could be
  configured like nodes and extensions, in a `linters:` section at the root,
  group, and pipeline scopes, with one entry per instance and its own
  config. This would allow several differently configured instances of a
  linter and scope a linter by placement. It also adds a new configuration
  section at three scopes, instance ids, and live-reconfiguration rules for
  each scope. Running every linked linter, and scoping it with levels, covers
  the common case (turning a set of rules on or off for part of the
  configuration) with no new configuration. Linter configuration can be
  added later (see [Future possibilities](#future-possibilities)).
- **Bare names for engine-emitted lints.** Engine-emitted lints could have
  bare names (`unconnected_node`, `unknown_lints`), like rustc's built-in
  lints. Grouping them under the `linter:meta` and `linter:engine`
  pseudo-linters keeps every lint name namespaced, lets them be selected as
  a group like any other component, and avoids a second naming rule.
- **Node lints with check functions.** An earlier version of this design
  had nodes declare `NodeLint { info, check }` statics in a factory field,
  and the lint stage invoked each check with a node-local context that
  cached the node's typed config. Checks resolved to `allow` were not run.
  This duplicated the deserialization that validation already performs,
  required a typed-config cache and a separate context type for nodes, and
  split a node's knowledge about its own config between its validator and
  its lints. Config lints are cheap enough that always evaluating them and
  suppressing at emit time is simpler.
- **One check function per linter.** A linter could provide a single check
  that registers its lint set and emits any of its lints, like a config
  validator. Linter checks can be much more expensive than config lints
  (graph traversal, deserializing many node configs), so one check per lint
  lets the engine skip checks that resolve to `allow` and checks whose node
  interests do not match.
- **Registering lint sets through `linkme`.** Instead of a factory field, a
  node's lint set could register itself in a distributed slice with its
  owner's URN as an attribute argument (`#[lints(urn = ...)]`). This
  decouples lint sets from factories, but duplicates the URN, allows lint
  sets that no factory owns, and makes it harder to check that a validator
  only registers its own factory's set.
- **Several lint sets per factory.** A factory could declare a slice of lint
  sets, for example to share a set between related nodes. One set per
  factory keeps one level table per node and a single registration check.
  Nodes that want to share lints can share a validator and its enum.
- **Resolving levels after validation.** Node validators could emit into an
  unfiltered buffer that is resolved afterwards. This avoids moving
  resolution ahead of component validation, but stores every diagnostic,
  including those that will be dropped, and makes `expect` fulfillment a
  separate pass.
- **Pruning unconnected nodes at admission.** The lint stage could remove
  unconnected nodes and admit the pruned pipeline, so that `build()` no
  longer prunes. Detection would run once per admission instead of once per
  core, and lints would only judge nodes that will run, but this changes
  pruning behavior, every caller of `build()`, and means that `lints:`
  entries on removed nodes are silently ignored. Pruning is left as it is,
  and every node as written is validated and linted.
- **Linter checks on the pruned pipeline.** Linter checks could see a
  pipeline without its unconnected nodes, avoiding diagnostics about paths
  that will never carry data. Linting the pipeline as configured keeps one
  consistent view for config lints, linter lints, and engine-emitted lints.
- **Applying root and group lint changes on next admission.** Instead of
  requiring a restart, changes to shared `lints:` blocks could be committed
  without re-linting and take effect the next time each pipeline is
  admitted. Pipelines that violate a tightened rule would keep running
  unnoticed, and a later, unrelated change to one of them would be rejected
  unexpectedly.
- **Engine-emitted lints with check functions.** The `linter:engine` and
  `linter:meta` lints could be real linters with checks invoked by the lint
  stage. These lints, however, report conditions the engine already detects
  (such as unconnected nodes or unknown selectors), so a separate check
  would duplicate that detection and risk diverging from it.

## Prior art

Discuss prior art, both good and bad. What can we learn from how other
projects (Rust, OpenDAL, the OpenTelemetry Collector, etc.) solved this?
If there is no prior art, say so -- new ideas are welcome.

- TODO: Cargo clippy. See the
  [guide-level explanation](#guide-level-explanation).
- TODO: Otel collector

## Unresolved questions

- Should a linked third-party linter be active by default? Linking a
  linter activates all of its lints at their categories' default levels. A
  linter could instead declare a default level for its lints (e.g. `allow`)
  so that it only takes effect where a `lints:` block enables it.
- Upgrades. Lints run at engine startup rather than at build time, so a new
  deny-by-default lint in a minor release could stop an engine from starting
  with a config that worked before. Options include:
  - (a) Default `correctness` to `warn`.
  - (b) Introduce new lints in an allow-by-default `nursery` category and
    promote them only during major version bumps.
  - (c) Associate all lints with a release version and pin a lint baseline in the
    config (e.g. `lints_version`) so that lints in any later default to `warn`.
- Should security lints be a category? Most security lints can probably fit in
  "suspicious", but it could be a common category of things that folks would want
  to forbid always like binding to 0.0.0.0.

## Future possibilities

- Linter configuration. Linters have no configuration today. Options include
  a dedicated engine-level section with settings keyed by linter URN (e.g.
  `engine.linters.<urn>: {...}`), validated and linted by the linter like a
  node's config; or linter instances placed at the root, group, and pipeline
  scopes (see [Alternatives considered](#alternatives-considered)). Either
  would also allow config-driven node interests, so that a check only runs
  on node types named in its config.
- Programmatic registration. A custom distribution could register linters
  with a builder API (e.g. `Controller::with_linter(...)`) instead of
  through `linkme`, configuring them in Rust.
- Lint parameters. Should individual lints accept configuration beyond a
  level?
- A language for describing lints including rego. This could be shaped
  similar to the transform processor, where a rego linter runs user programs
  for more complicated lints.
- Inclusion of lints into dfctl. Linters depend only on the `lint` and
  `config` crates, so a CLI can link them. Config lints and built-in linters
  that use node config types require linking the node crates. Custom lints
  could perhaps be linked in with wasm.
- Lints across pipelines connected by topics. Lints are currently limited to
  a single pipeline, which avoids a change to one pipeline causing a lint
  failure in another.
- Live changes to root and group `lints:` blocks. Because lints do not
  affect running pipelines, such a change would not need any rollouts: it
  could be admitted by re-linting every pipeline under the changed scope
  (every pipeline for the root), rejecting the whole change if any pipeline
  fails, emitting the resulting warnings, and committing the new
  configuration. `engine.lint_cap` could similarly be made changeable live,
  as an emergency override that does not require a restart.
- Suppression reasons. A `lints:` entry could accept a structured form such
  as `{ level, reason }`, with the reason shown in diagnostics and lint
  reports, like rustc's `reason = "..."`.
- Automatic documentation generation from `LintInfo::summary` and
  `LintInfo::docs`, which the derive takes from attributes and doc comments.
- Aliases for renamed component URNs. Renamed lint ids are covered by
  `renamed_from`.
- Removed lints. A `#[lint(removed)]` variant could keep a deleted lint's
  name registered so that `lints:` blocks naming it trigger
  `linter:meta:renamed_and_removed_lints` instead of
  `linter:meta:unknown_lints`.
- Config lints for extensions. Extension factories could declare a lint set
  and emit lints about their own config from `validate_config`, as nodes do.
  Their diagnostics would be located at the extension, which needs a
  `lints:` block on extension configs and an `extension` location.
- Extensions that lint their consumers. A runtime extension could declare
  checks about the nodes bound to it, for example warning when a node bound
  to a token provider sends to a plain `http://` endpoint.
- Returning lint warnings in admin API responses.
- A `Connection` lint scope for rules about individual edges. Connections
  can already be inspected from pipeline-scoped lints through `graph()`.
