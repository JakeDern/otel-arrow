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

### Where lints come from

- **Nodes** check their own configuration. These are **config lints**: for
  example, a batch processor configured so that it never batches.
- **Linters** check whole pipelines, such as where a node is placed relative
  to other nodes. A linter is a component that only carries lints. Every
  linter built into the engine runs on every pipeline; there is nothing to
  add to your configuration, and you control its lints only through
  [levels](#configuring-lints). The engine ships with two:

  | Linter                 | Rules about                                    |
  |------------------------|------------------------------------------------|
  | `linter:core-nodes`    | Core nodes and pipelines in general            |
  | `linter:contrib-nodes` | Contrib nodes                                  |

- **The engine** reports a few lints itself, grouped under two reserved
  names: `linter:meta` for problems with the lint configuration itself (see
  [Meta lints](#meta-lints)), and `linter:engine` for problems with pipeline
  structure, such as `linter:engine:unconnected_node`.

### Lint names

Every lint is named after the component that declares it: the node type for
config lints, and the linter otherwise. Names follow the same shortcut rules
as component URNs (see [URN format](../docs/urns.md)): the short form is
only valid for the `otel` namespace.

```text
urn:otel:processor:batch:forwards_everything       config lint, canonical form
processor:batch:forwards_everything                config lint, otel shortcut form
linter:core-nodes:redundant_batch                  built-in linter
linter:meta:unknown_lints                          lint reported by the engine
urn:acme:linter:prod_policy:no_debug_exporters     third-party linter
```

Lint names are stable. A renamed lint keeps its old name as an alias, and
removing a lint is a breaking change.

### Lint scopes

Lints operate on a single pipeline at a time, and every lint has one of two
scopes:

- A **node** lint is about a single node, and its diagnostics point at that
  node. All config lints are node lints.
- A **pipeline** lint is about a pipeline as a whole, and its diagnostics
  point at the pipeline. A diagnostic that concerns specific nodes (for
  example, a rule about node ordering) also lists them as related nodes,
  similar to rustc's secondary spans.

A diagnostic's location, the node or the pipeline, decides which `lints:`
blocks apply to it (see [How a lint's level is decided](#how-a-lints-level-is-decided)).
The engine's observability pipeline (`engine.observability.pipeline`) is
linted like any other pipeline; it has no group.

### Levels and categories

A lint's **level** decides whether it is reported and whether it is an
error. Errors prevent a pipeline from being admitted; warnings are only
reported.

| Level    | Reported?                   | Overrideable? |
|----------|-----------------------------|---------------|
| `allow`  | No                          | Yes           |
| `expect` | Yes, warning if unfulfilled | Yes           |
| `warn`   | Yes, as a warning           | Yes           |
| `deny`   | Yes, as an error            | Yes           |
| `forbid` | Yes, as an error            | **No**        |

Every lint belongs to exactly one **category**, which sets its default
level:

| Category      | Default Level | Meaning                                                                                                  |
|---------------|---------------|----------------------------------------------------------------------------------------------------------|
| `correctness` | warn          | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | warn          | Probably a mistake, but there are legitimate uses.                                                       |
| `perf`        | warn          | Correct, but wastes CPU, memory, or throughput.                                                          |
| `style`       | warn          | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

### Configuring lints

Lints are configured with a `lints:` block, which can appear at four scopes:
the root of the config, a pipeline group, a pipeline, and a node. Each entry
maps a **selector** to a level:

| Selector             | Example                                          | Matches                                          |
|----------------------|--------------------------------------------------|--------------------------------------------------|
| Full name            | `processor:batch:forwards_everything`            | Exactly one lint                                 |
| Component + category | `processor:batch:perf`, `linter:core-nodes:perf` | Lints defined by that component in that category |
| Component            | `processor:batch`, `linter:meta`                 | All lints defined by that component              |
| Category             | `correctness`                                    | All lints in that category                       |
| `warnings`           | `warnings`                                       | Promotes every `warn` to `deny` (see below)      |

```yaml
version: otel_dataflow/v1
lints: # root scope
  correctness: forbid
  warnings: deny
engine:
  lint_cap: warn # operator-only, see below
groups:
  dev:
    lints: # group scope
      perf: allow
    pipelines:
      main:
        lints: # pipeline scope
          linter:core-nodes:redundant_batch: warn
          urn:acme:linter:prod_policy: allow
        nodes:
          passthrough:
            type: processor:batch
            config:
              min_size: 0
            lints: # node scope
              # intentionally forwards everything unbatched
              processor:batch:forwards_everything: allow
```

When several entries in the **same** `lints:` block match a lint, the most
specific one wins:

```text
full name  >  component + category  >  component  >  category
```

A lint can only be configured at its own scope and the scopes that enclose
it, so a pipeline lint cannot be allowed for some nodes of a pipeline and
not others:

| Lint scope | Can be configured at             |
|------------|----------------------------------|
| Pipeline   | CLI, root, group, pipeline       |
| Node       | CLI, root, group, pipeline, node |

Broad selectors at node scope (e.g. `perf: allow`) apply only to the node
lints they match.

### How a lint's level is decided

A lint's level is resolved from its location outwards: from the node for
node lints, and from the pipeline for pipeline lints. In the first scope
with any entry matching the lint, the most specific matching entry wins. If
no scope matches, the lint's default level is used.

```text
 CLI flags                    (outermost)   ^
   root        lints:                       |  search from the innermost
     group       lints:                     |  scope outwards; the first
       pipeline    lints:                   |  scope with a matching entry
         node        lints:   (innermost)   |  wins
              ^
              node lints start here; pipeline lints start one level up
```

Three rules then adjust the result:

- **`warnings`.** If the level is `warn` and `warnings` resolves to `deny` or
  `forbid` at the same location, the level becomes `deny`.
- **`forbid`.** Once a lint is forbidden in some scope, no inner scope and
  no more specific selector in the same scope may change its level.
  Attempting to do so is a hard validation error, not a lint, mirroring
  rustc's `E0453`:

  ```yaml
  lints:
    correctness: forbid
  groups:
    default:
      pipelines:
        main:
          lints:
            processor:batch:some_lint: allow # error if some_lint is a correctness lint
  ```

- **The cap.** `engine.lint_cap` (or `--cap-lints`) sets a maximum severity
  for every diagnostic, like rustc's `--cap-lints`. It is the break-glass
  mechanism for admitting pipelines despite lint errors, for example during
  an incident. Because it can defeat `forbid`, it can only be set by the
  operator, never at group, pipeline, or node scope.

  ```text
  configured level:   allow   warn   deny   forbid
  with cap = warn:    allow   warn   warn   warn      <- nothing blocks admission
  ```

### Suppressing lints

A lint is suppressed by setting it to `allow` or `expect` at the scope where
it fires, unless it is forbidden in an enclosing scope.

`expect` also suppresses the lint, but reports
`linter:meta:unfulfilled_lint_expectations` if the lint does **not** fire at
that location, so stale suppressions are noticed. An `expect` set through a
broad selector (e.g. `perf: expect`) is fulfilled if any lint it matches
fires there. `expect` can only be set on pipelines and nodes: whether an
expectation set on a group or the root is fulfilled could only be decided by
linting every pipeline under it.

### Meta lints

The `linter:meta` lints report mistakes in the lint configuration itself.
They are ordinary lints and can be configured like any other.

| Lint                            | Category     | Fires when                                                                     | Located at                                           |
|---------------------------------|--------------|--------------------------------------------------------------------------------|------------------------------------------------------|
| `unknown_lints`                 | `suspicious` | A `lints:` block names a lint, component, or category the engine does not know | The scope of that block                              |
| `renamed_and_removed_lints`     | `suspicious` | A `lints:` block uses a renamed or removed lint name                           | The scope of that block                              |
| `unfulfilled_lint_expectations` | `suspicious` | An `expect` entry's lint did not fire                                          | The pipeline or node where the `expect` entry is set |

A mistake in a shared `lints:` block, such as the root or a group, is
therefore reported once at that block rather than once for every pipeline
that inherits it. As with any lint, the level is resolved from the location
outwards: `linter:meta:unknown_lints: allow` in a block silences unknown
entries in that block and the blocks nested inside it, but a pipeline cannot
silence a mistake in the root block.

### When lints run and where you see them

Lints run wherever the engine admits a configuration:

- **At startup.** An error stops the engine from starting, the same way a
  validation error does.
- **On live reconfiguration.** Every change made through the admin API lints
  each affected pipeline as it would look after the change, and an error
  rejects the change. Pipeline and node `lints:` blocks can be changed live
  without restarting the pipeline; root and group `lints:` blocks and the
  cap require an engine restart (see
  [Live changes to lint configuration](#live-changes-to-lint-configuration)).
- **With `df_engine --validate-and-exit`**, which validates and lints a
  config file without starting any pipelines.

Every reported diagnostic is emitted as a `pipeline.lint.diagnostic`
internal telemetry event, so it shows up wherever the engine's other events
do: on the console, in the admin `/logs` tap, and in OTLP exported by the
observability pipeline. Its severity is `WARN` for `warn` and `ERROR` for
`deny` and `forbid`. For example, the batch processor's
`forwards_everything` lint, in a pipeline whose root `lints:` block sets
`warnings: deny`:

```yaml
event_name: pipeline.lint.diagnostic
severity: ERROR
body: min_size is 0 and max_size is unset, so requests are never batched
attributes:
  pipeline.group.id: dev
  pipeline.id: main
  node.id: batch
  node.urn: urn:otel:processor:batch
  lint.name: urn:otel:processor:batch:forwards_everything
  lint.level: deny
  lint.level.selector: warnings
  lint.level.scope: root
```

`lint.level.selector` and `lint.level.scope` show where the level came
from; here, the lint, which warns by default, was promoted to `deny` by
`warnings: deny` in the root block. See
[Emitting lint events](#emitting-lint-events) for the full attribute list.

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

### Lint sets

Every lint, whoever declares it, is declared the same way as metric sets
and attribute enums: as a Rust type, annotated with a derive macro that
generates static metadata. A **lint set** is a unit-only enum deriving
`Lints`, in which every variant is one lint. Each component that declares
lints has exactly one lint set.

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

The variant's `///` doc comment becomes the lint's `docs`, the same way a
metric field's doc comment becomes its `brief`. The derive generates:

```rust
// config::lint

/// Static description of one lint.
pub struct LintInfo {
    pub id: &'static str,
    pub category: Category,
    pub summary: &'static str,
    pub docs: &'static str,
    pub renamed_from: &'static [&'static str],
}

/// Every lint in one lint set, in declaration order. A lint's position in
/// `lints` is its index.
pub struct LintSetDescriptor {
    pub lints: &'static [LintInfo],
}

pub trait LintSet: Copy + 'static {
    const DESCRIPTOR: &'static LintSetDescriptor;
    /// Position of this lint in `DESCRIPTOR.lints`.
    fn index(self) -> usize;
}

pub enum Category { Correctness, Suspicious, Perf, Style }
pub enum Level { Allow, Expect, Warn, Deny, Forbid }
```

`DESCRIPTOR` is a `static`, and `index()` compiles to the enum discriminant.
The derive also generates a `const fn index_const(self) -> usize`, so that
linters can refer to their lints in `static` items, and the `register`
function used by [config lints](#writing-config-lints). It rejects non-unit
variants, explicit discriminants, generic enums, missing categories or
summaries, malformed ids, and [reserved ids](#registry) at compile time.

A lint set contains no names or scopes. The registry derives each lint's
full name by appending its id to the URN of the component that owns the
set, which guarantees that a component's lints share its namespace and that
renaming a component URN renames all of its lints. Config lints are always
node lints, and each linter lint's scope comes from its
[check](#writing-linters).

#### Choosing a category

A useful test when classifying a lint: _is there any configuration where
this is what the author wanted?_ If not, it is `correctness`. If rarely, it
is `suspicious`. If it is fine but costly, it is `perf`. If it is fine but
untidy, it is `style`. For example:

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

### Writing config lints

A node declares config lints by naming its lint set on its factory and
emitting them from its config validator. `ReceiverFactory`,
`ProcessorFactory`, and `ExporterFactory` each gain a
`lints: Option<&'static LintSetDescriptor>` field (nodes without lints use
`None`; the hand-written `Clone` impls are updated accordingly), and
`validate_config` gains a context parameter:

```rust
pub validate_config: fn(
    config: &serde_json::Value,
    lints: &mut ConfigLintContext<'_>,
) -> Result<(), otel_arrow_dfe_config::error::Error>,
```

For example, the batch processor's `forwards_everything` lint:

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

The engine creates a `ConfigLintContext` for each node it validates, holding
that node's precomputed [level table](#level-tables). The validator
registers its lint set to get a typed handle, mirroring the `register`
function that `#[metric_set]` generates, and emits through the handle:

```rust
impl BatchLint {
    pub fn register<'a>(cx: &'a mut ConfigLintContext<'_>) -> LintHandle<'a, BatchLint>;
}

impl ConfigLintContext<'_> {
    /// A context that drops everything. Used when a config is validated
    /// for a purpose other than admission.
    pub fn discard() -> ConfigLintContext<'static>;
}

impl<L: LintSet> LintHandle<'_, L> {
    /// Emit a diagnostic for `lint` at the node being validated.
    pub fn emit(&mut self, lint: L, message: impl Into<String>);

    /// Like `emit`, but only builds the message if it will be recorded.
    pub fn emit_with(&mut self, lint: L, message: impl FnOnce() -> String);
}
```

`emit` looks up the lint's final level by `lint.index()` and acts on it
immediately:

```text
 emit(L::X, msg)
   levels[L::X.index()]
     allow                -> dropped; the message is never stored
     expect               -> dropped; marks the expectation fulfilled
     warn / deny / forbid -> recorded as a diagnostic with that level
```

Config lints are expected to be cheap, so validators always evaluate all of
them and never need to ask whether a lint is enabled; suppression costs an
index and a branch. Validation already deserializes the config, so the
typed value is shared between validation and linting.

`register` checks that `L::DESCRIPTOR` is the descriptor declared by the
node's factory, comparing pointers, so a node cannot emit lints it has not
declared. A mismatch is a bug in the node rather than in the user's
configuration: it is reported as an internal error event, does not affect
admission, and the handle drops every diagnostic.

**Shared validators.** `validate_typed_config::<T>` and `no_config` in
`config::validation` gain the context parameter and ignore it, so the
roughly 40 nodes that use them do not change. The handful of hand-written
validators gain the parameter mechanically.

**Extension validators.** `ExtensionFactory` and `ControllerExtensionFactory`
share the same `validate_config` signature, so the shared helpers work for
them too. Extensions do not declare config lints for now: they are
validated with a context that has no lint set, so registering one fails the
registration check.

**Testing.** Node unit tests use a test helper that returns a context with
every lint at `warn` and exposes the recorded diagnostics.

### Writing linters

A linter is declared by a `LinterFactory` registered in the
`LINTER_FACTORIES` distributed slice, the same way node and extension
factories are registered. Each lint in the linter's lint set has exactly
one check function, which the engine invokes during the lint stage:

```rust
// lint crate
pub struct LinterFactory {
    /// The linter's URN, e.g. `urn:otel:linter:core-nodes`.
    pub name: &'static str,
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

/// A linter lint's scope and check function.
pub enum Check {
    /// A pipeline lint, run once per pipeline.
    Pipeline {
        /// If set, the lint only runs on pipelines that contain at least one
        /// node matching these interests.
        requires: Option<NodeInterests>,
        check: fn(&LintContext<'_>, &mut LintSink<'_>),
    },
    /// A node lint, run once per node that matches `interests`.
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

Linter checks can be expensive (graph traversal, deserializing many node
configs), so unlike config lints the engine decides whether to run each
one. It invokes a check at every construct of the right kind, skipping
pipelines and nodes that do not match its interests and locations where the
lint resolves to `allow`. A lint resolved to `expect` is still run, so that
the engine can tell whether the expectation was fulfilled; its diagnostics
are suppressed. Each invocation gets a context, and a sink bound to exactly
that lint and location, so a check cannot emit any other lint:

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
    /// Add a related node (pipeline lints only).
    pub fn related(self, node: &NodeId) -> Self;
}
```

For example, the built-in `linter:core-nodes` linter could include a lint
for two batch processors on the same path:

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

`linter:core-nodes:redundant_batch` runs once per pipeline containing a
batch processor and reports one diagnostic per offending pair, with both
nodes as related locations.

**Built-in linters.** `linter:core-nodes` and `linter:contrib-nodes` live in
the `core-nodes` and `contrib-nodes` crates, next to the nodes they lint, so
they can refer to those nodes' URN constants and, if desired, their config
types (see [Unresolved questions](#unresolved-questions)). A linter that
reasons about nodes in another crate refers to them by URN.

**Caching.** Several checks often look at the same pipeline, so the engine
creates a `PipelineLintState` at the start of each pipeline's lint run and
drops it at the end. Cached values never outlive a run or leak between
pipelines. It holds:

- the pipeline being linted;
- the graph, in a `OnceCell` that is filled on the first `graph()` call;
- typed node configs, in a map keyed by `(NodeId, TypeId)`.

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

### Pseudo-linters

Lints that the engine detects itself are declared with the same derive in
the `lint` crate, as two lint sets registered under reserved URNs:

```rust
/// Registered as `urn:otel:linter:meta`.
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

/// Registered as `urn:otel:linter:engine`.
#[derive(Clone, Copy, Lints)]
pub enum EngineLint {
    /// ...
    #[lint(suspicious, summary = "node is not connected and will be removed")]
    UnconnectedNode,
}
```

Pseudo-linters have no `LinterFactory` and no checks. The engine emits their
lints directly from the code that already detects each condition, so
detection logic is not duplicated, through a `LintHandle` bound to the level
table of the location where it detected the condition. They are therefore
suppressed in the same way as config lints. Unlike a node's lint set, their
lints are located at different kinds of scope: `unconnected_node` at a
node, `unknown_lints` at whichever scope holds the offending `lints:` block,
and `unfulfilled_lint_expectations` at the pipeline or node that set the
`expect`.

### Registry

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

The registry records each lint's scope (node for config lints, the `Check`
variant for linter lints, and the emission site for pseudo-linter lints) and
keeps, for each lint set, the full names of its lints in index order. This
is what [level tables](#level-tables) are built from.

Naming rules:

- `linter` is a new URN kind, alongside `receiver`, `processor`, `exporter`,
  and `extension`.
- `urn:otel:linter:meta` and `urn:otel:linter:engine` are reserved for the
  pseudo-linters.
- A lint id uses the same character set as URN segments (`[a-z0-9._-]`) and
  cannot contain `:`.
- The category names and `warnings` are reserved and may not be used as lint
  ids, so that they remain unambiguous as selectors. The derive enforces
  this at compile time.

Building the registry fails with a hard error if:

- two lints, or a lint and an alias, have the same full name;
- a linter's lints and checks are not one to one: a lint has no check or
  more than one, or a check names an index outside the set; or
- a linter uses a reserved pseudo-linter URN.

The same checks run as a unit test in the `component-inventory` crate, which
already links every node crate, so mistakes are caught in CI rather than at
deploy time.

### Admission

Linting is woven into the existing validation path. Level resolution moves
ahead of component validation, so that config lints can be dropped as they
are emitted:

```text
 parse --> validate() --> LINT CONFIG --> validate_engine_components --> LINT STAGE --> compile_initial_context --> run
           structural     lints: blocks,   per node: validate_config     linter checks,
                          forbid, level    (raw, cx) emits config lints  engine-emitted
                          tables                                         lints
```

Resolving levels only needs the registry and the `lints:` blocks, which
are both available after structural validation. When the lint stage runs,
every URN is known to the registry and every node config has been
validated, so linter checks can rely on both, just as clippy relies on code
having type-checked.

**Scope chains.** Resolution (`OtelDataflowSpec::resolve()`) currently
merges policies and drops the root and group config. Lint levels cannot be
merged the same way: resolving a level and checking `forbid` require each
scope separately. `ResolvedPipelineConfig` therefore gains a `lint_scopes`
field holding the outer `lints:` blocks, unmerged and in order. The pipeline
and node blocks are already reachable through the `PipelineConfig` it holds.

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

Each entry is computed with the rules in
[How a lint's level is decided](#how-a-lints-level-is-decided), including
`warnings` and the cap, so diagnostics need no further processing once
emitted. The engine builds the following tables for each pipeline being
admitted:

| Location    | Tables                                                                                   |
|-------------|------------------------------------------------------------------------------------------|
| Root, group | `MetaLint` (built once per admission of that scope)                                      |
| Pipeline    | `MetaLint`, and every linter's pipeline lints                                            |
| Node        | `MetaLint`, `EngineLint`, the node type's lint set, and every linter's node lints        |

Tables are small (one entry per declared lint) and live only for the
duration of the admission. Each table also has a bitset recording which
`expect` levels were fulfilled.

#### Stages

**A. Lint configuration.** After structural validation:

1. **Check `lints:` blocks.** Each `lints:` block being admitted has its
   selectors checked against the registry, emitting `unknown_lints` and
   `renamed_and_removed_lints` at that block's scope. The root block is
   checked at startup. Group blocks are checked at startup and on group
   creation. Pipeline and node blocks are checked whenever their pipeline is
   created or replaced, whether through a pipeline update or a reconcile.
2. **Check `forbid`.** Using the registry to map lints to categories and
   components, check every scope for an entry that would change the level of
   a lint forbidden in an enclosing scope or by a less specific selector in
   the same scope. A conflict is a hard error, and nothing else is run.
3. **Build level tables** for every pipeline being admitted.

**B. Component validation.** `validate_engine_components` runs as it does
today, except that it passes each node's `validate_config` a
`ConfigLintContext` bound to the node's level table and lint set. A
validation error is a hard error and stops admission as it does today; any
diagnostics the failing node had already emitted are discarded with it.
Extensions are validated with a context that has no lint set.

**C. Lint stage.** For each resolved pipeline being admitted:

1. **Report unconnected nodes** (see [Unconnected nodes](#unconnected-nodes)).
2. **Run pipeline lints.** For every linter, run each `Check::Pipeline`
   whose `requires` (if any) matches at least one node in the pipeline,
   unless its level at the pipeline is `allow`.
3. **Run node lints.** For each node, run every linter's `Check::Node` whose
   `NodeInterests` match the node's type, unless its level at the node is
   `allow`.
4. **Report unfulfilled expectations.** Emit `unfulfilled_lint_expectations`
   for each `expect` entry in the pipeline or its nodes that no diagnostic
   fulfilled, from any source.

The result is a `LintReport` per pipeline, containing the diagnostics and
whether any of them is an error.

#### Unconnected nodes

Pruning is unchanged. `PipelineFactory::build()` still removes unconnected
nodes when it builds a pipeline, and still fails with `EmptyPipeline` if no
nodes remain. The lint stage only reports them: it finds unconnected nodes
with `PipelineConfig::remove_unconnected_nodes` on a copy of the pipeline
(as `OtelDataflowSpec::validate()` already does for the observability
pipeline) and emits `linter:engine:unconnected_node` for each. The
build-time `otel_info!`/`otel_warn!` events for removed nodes are kept for
now, since they describe what the build actually did on each core.

Every other lint sees the pipeline as configured, including unconnected
nodes, so that all lints see the same pipeline and every `lints:` entry,
on every node, takes effect.

#### Other callers of `validate_config`

`node_context_declarations` (`crates/engine/src/context_declaration.rs`)
validates each node again before collecting its context declarations, and
the validator tests in `crates/validation/tests/validate_config_tests.rs`
call every registered validator. Both pass `ConfigLintContext::discard()`.

#### Entry point and outcome

A single function in the controller, roughly
`validate_and_lint(spec, factory) -> Result<LintReport, Error>`, performs
validation, component validation, and the lint stage. It is used by:

- engine startup and `df_engine --validate-and-exit`
- live reconfiguration: rollout planning, `/config/reconcile`, and group
  creation

Today these paths call validation inconsistently (group creation, for
example, does not run component validation), so sharing one entry point
also makes validation consistent.

Every reported diagnostic is emitted as an event (see
[Emitting lint events](#emitting-lint-events)). In addition:

| Path                  | Error diagnostics     | Warning diagnostics  |
|-----------------------|-----------------------|----------------------|
| Startup               | Engine does not start | Pipeline is admitted |
| `--validate-and-exit` | Non-zero exit         | Zero exit            |
| Live reconfiguration  | Change rejected       | Change is admitted   |

Diagnostics locate problems by config path (e.g.
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
pipeline's or its nodes' `lints:` blocks is admitted like any other
pipeline change. Because lints do not affect a running pipeline,
`ResolvedPipelineConfig::runtime_matches` ignores `lints:` blocks, so an
admitted lint-only change is planned as a `noop` rollout: the new
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
| `lint.related.node.ids` | Pipeline lint with related nodes                | Ids of the related nodes (string array)                                                                                        |
| `lint.level`            | Always                                          | Final level after `warnings` and the cap; one of `warn`, `deny`, `forbid`                                                      |
| `lint.level.selector`   | Level was set by a `lints:` entry or a CLI flag | The selector that set the level, e.g. `correctness` or `warnings`                                                              |
| `lint.level.scope`      | Level was set by a `lints:` entry or a CLI flag | Where that selector was configured; one of `cli`, `root`, `group`, `pipeline`, `node` (never `node` for pipeline lints)        |

The identity attributes use the canonical entity keys
(`crates/engine/src/attributes.rs`). The telemetry guides place entity
attributes on the instrumentation scope rather than on each record, but
lints run in the controller before a pipeline is built, and a rejected
pipeline is never built at all, so there is no pipeline or node entity
context to attach. Lint events therefore carry identity as record attributes,
as other config-time events already do.

Diagnostics located at the root or a group (only possible for meta lints)
carry no pipeline attributes. When a lint fires at its default level,
`lint.level.selector` and `lint.level.scope` are omitted. The lint cap is
not represented separately: a capped diagnostic simply has a lower
`lint.level`.

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

- **Lint levels in `policies`.** Lint configuration could be a field of the
  existing `policies` blocks instead of a dedicated `lints:` block. Policies
  are resolved by taking the first scope that sets a field and replacing
  the field wholesale, while lint configuration has to be merged per
  selector: if the root sets `correctness: forbid`, enabling a specific
  lint in a pipeline must not remove that. Policies also do not exist at
  node scope, which is where individual suppressions are most useful.
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

- How should a node-scope `lints:` entry that names a pipeline lint exactly,
  which can never take effect, be reported: as a hard error or as a meta
  lint?
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
  can already be inspected from pipeline lints through `graph()`.
