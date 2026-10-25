---
Proposal Name: pipeline-linting
Start Date: 2026-10-20
RFC PR: open-telemetry/otel-arrow#0000
Tracking Issue: open-telemetry/otel-arrow#0000
---

# RFC 0007: Pipeline Linting

## Summary

The goal of this RFC is to describe how we can incorporate the concept of linting
into the Dataflow Engine project to help educate users on best practices and reduce
mistakes in pipeline authorship.

## Motivation

In the Dataflow Engine, we design nodes under the philosophy of
composability. Each node offers simple behaviors that can be composed together
into a pipeline to express more complicated logic. This forms a language
for telemetry pipelines.

Not all pipeline programs that can be expressed in the language of nodes,
connections, and configurations are good ones. Some nodes (probably) should
not be placed before or after others, and some combinations of node
configurations are unlikely to yield good results for performance,
correctness, or other reasons.

The rules are many and it is unreasonable for any human (or agent),
experienced or not, to be aware of the constantly evolving set of nodes and
configurations nor the accumulated wisdom in how best to use them (let
alone, consistently and perfectly apply these rules in practice).

Additionally, organizations and individual users are likely to have their
own individual preferences for pipelines that they want to follow. This
includes disagreement with or exceptions to existing best practices defined
by other authors.

Programming languages have addressed this problem through configurable linting
systems. We can do the same for Dataflow Engine pipelines.

## Guide-level explanation

### What is a lint?

A lint is a single opinion about how pipelines or nodes should generally be
constructed. Every lint has a stable [name](#lint-names), exactly one
[category](#levels-and-categories), and documentation explaining what it
detects, why it matters, and how to fix it.

Lints are distinct from validation errors. Validation asks "can this
pipeline run at all?" (a property has the wrong type, a connection names a
node that does not exist), and its failures cannot be suppressed. Lints say
"this pipeline can run, but it likely shouldn't look like this" and are
fully configurable. For example, placing a retry processor before a batch
processor works, but may duplicate batching work unnecessarily.

### When lints run

Lints run wherever the engine admits a pipeline configuration: at startup,
on live reconfiguration, and with `df_engine --validate-and-exit`. The
engine reports the resulting diagnostics, but how depends on when the lints
ran (see [Reporting](#reporting)).

### Where lints come from

- Existing **Nodes** can lint their own configuration. These are **config lints**,
  for example a batch processor configured so that it never batches.
- Dedicated **Linters** can be linked into the engine to check whole pipelines,
  such as where a node is placed relative to other nodes. A linter is a component
  that only carries lints. Every linter compiled into the engine runs on every
  pipeline and is controlled through [levels](#configuring-lints). The engine
  will initially ship two linters: `linter:core-nodes` (core nodes and pipelines
  containing core nodes in general) and `linter:contrib-nodes` (similar for contrib
  nodes).
- **The engine** reports a few special lints itself, under two reserved names:
  `linter:meta` for mistakes in lint configuration (see
  [Meta lints](#meta-lints)), and `linter:engine` for pipeline structure,
  such as `linter:engine:unconnected_node`.

### Lint names

Every lint is named after the component that provides the lint: the node type for
config lints, the linter otherwise. Names follow the shortcut rules of
component URNs (see [URN format](../docs/urns.md)); the short form is only
valid for the `otel` namespace.

```text
urn:otel:processor:batch:forwards_everything       config lint, canonical form
processor:batch:forwards_everything                config lint, otel shortcut form
linter:core-nodes:redundant_batch                  built-in linter
linter:meta:unknown_lints                          lint reported by the engine
urn:acme:linter:prod_policy:no_debug_exporters     third-party linter
```

Lint names are stable. A renamed lint keeps its old name as an alias, and
removing a lint is a breaking change.

### Locations

Every diagnostic has a **location**: a node, a pipeline, a group, or the
root. The location decides which `lints:` blocks apply to it.

- Config lints are located at their node.
- Each linter lint is either a **node lint**, located at the node it is
  about, or a **pipeline lint**, located at the pipeline. A pipeline lint
  that concerns specific nodes (for example, node ordering) lists them as
  related nodes, like rustc's secondary spans.
- Engine lints are located where the engine detects the condition; see
  [Engine lints](#engine-lints).

The engine's observability pipeline (`engine.observability.pipeline`) is
linted like any other pipeline and reported under the group `system`.

### Levels and categories

A lint's **level** decides whether it is reported and whether it is an
error. Errors prevent a pipeline from being admitted; warnings are only
reported.

| Level   | Effect                |
|---------|-----------------------|
| `allow` | Not reported          |
| `warn`  | Reported as a warning |
| `deny`  | Reported as an error  |

Every lint is `warn` by default. Every lint also belongs to exactly one
**category**, which groups lints so that they can be configured together:

| Category      | Meaning                                                                                                  |
|---------------|----------------------------------------------------------------------------------------------------------|
| `security`    | A security concern, e.g. the pipeline exposes data or endpoints to unauthorized access or interception.  |
| `correctness` | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | Probably a mistake, but there are legitimate uses.                                                       |
| `perf`        | Correct, but wastes CPU, memory, or throughput.                                                          |
| `style`       | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

### Configuring lints

Lints are configured with a `lints:` block, which can appear at the root of
the config, a pipeline group, a pipeline, or a node. Each entry maps a
**selector** to a level:

| Selector             | Example                                          | Matches                                          |
|----------------------|--------------------------------------------------|--------------------------------------------------|
| Full name            | `processor:batch:forwards_everything`            | Exactly one lint                                 |
| Component + category | `processor:batch:perf`, `linter:core-nodes:perf` | Lints defined by that component in that category |
| Component            | `processor:batch`, `linter:meta`                 | All lints defined by that component              |
| Category             | `correctness`                                    | All lints in that category                       |

A selector naming a known component that declares no lints is valid and
matches nothing.

```yaml
version: otel_dataflow/v1
lints: # root
  correctness: deny
engine:
  lint_cap: warn # Overall cap on the lint level for the whole engine, see below
groups:
  dev:
    lints: # group
      perf: allow
    pipelines:
      main:
        lints: # pipeline
          linter:core-nodes:redundant_batch: warn
          urn:acme:linter:prod_policy: allow
        nodes:
          passthrough:
            type: processor:batch
            config:
              otap:
                min_size: 0
            lints: # node
              # intentionally forwards everything unbatched
              processor:batch:forwards_everything: allow
```

A lint's level at a location is found by searching the `lints:` blocks from
the location outwards (node, pipeline, group, root). The first block with an
entry matching the lint decides the level. Within that block the most specific
matching entry wins:

```text
full name  >  component + category  >  component  >  category
```

If no block matches, the lint is `warn`. A block only applies to lints
located at its own scope or inside it, so a pipeline lint cannot be allowed
for some nodes of a pipeline and not others. Broad selectors in a node block
(e.g. `perf: allow`) only affect lints located at that node, and a node
block entry that can only match pipeline lints is a validation error.

**The cap.** `engine.lint_cap` (overridden by the `--cap-lints` CLI flag)
lowers every resolved level to at most the cap, like rustc's `--cap-lints`.
It is the break-glass mechanism for admitting pipelines despite lint errors,
for example during an incident, and is only settable by the operator.

### Meta lints

The `linter:meta` lints report mistakes in the lint configuration itself.
They are ordinary lints and can be configured like any other.

| Lint            | Category | Fires when                                                                     |
|-----------------|----------|--------------------------------------------------------------------------------|
| `unknown_lints` | `style`  | A `lints:` block names a lint, component, or category the engine does not know |
| `renamed_lints` | `style`  | A `lints:` block uses a lint's old name                                        |

A meta lint is reported at the scope whose `lints:` block contains the bad
entry, so a mistake in the root block is reported once, not once per
pipeline. Its level is resolved like any other lint, starting at that scope:

```yaml
lints:
  linter:meta:unknown_lints: allow # silences bad entries everywhere
groups:
  dev:
    pipelines:
      main:
        lints:
          linter:meta:unknown_lints: allow # silences bad entries in `main`
                                           # and its nodes, not in the root
```

## Reference-level explanation

Code samples in this section are illustrative. They show the shape of the
proposed types and where they live, not final signatures.

### Crate layout

| Crate                                  | Contents                                                                                                                        |
|----------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `config` (existing), new `lint` module | `lints:` config types; `LintInfo`, `Category`, `Level`, `ConfigLint`, `NodeConfig`, `NodeConfigSpec`, `LintSink`, `LintSinks`   |
| `lint` (`otel-arrow-dfe-lint`)         | `LinterFactory`, `LinterLint`, `LINTER_FACTORIES`, `Check`, `LintContext`, engine lints, registry, level resolution, lint stage |

Node factories reference `NodeConfig` and `ConfigLint`, so these types live
in `config`, which cannot depend on `lint`. `LintSink` is among them because
config lints emit through it; linter checks use the same type. The `lint`
crate depends only on `config`, so linters have no `PData` parameter and no
telemetry dependency. Crates that define linters, including `core-nodes` and
`contrib-nodes`, depend on `lint`.

### Declaring lints

Every lint is a `static` holding its declaration together with its check
(see [config lints](#writing-config-lints) and [linters](#writing-linters)).
The declaration is a `LintInfo`:

```rust
// config::lint
pub struct LintInfo {
    /// Unique within the owning component; `[a-z0-9._-]`.
    pub id: &'static str,
    pub category: Category,
    /// One-line summary.
    pub summary: &'static str,
    /// What the lint detects, why it matters, and how to fix it.
    pub docs: &'static str,
    /// Previous ids, kept as aliases.
    pub renamed_from: &'static [&'static str],
}

pub enum Category { Security, Correctness, Suspicious, Perf, Style }
pub enum Level { Allow, Warn, Deny }
```

Each component lists its lints in its factory. A lint contains no full name:
the registry derives it by appending the id to the URN of the component that
lists it, so a component's lints always share its namespace. A lint that is
declared but not listed never runs; nothing can detect an unlisted `static`,
so this is left to review and the lint's own tests.

#### Choosing a category

If the problem exposes data or endpoints, it is `security`. Otherwise, a
useful test: _is there any configuration where this is what the author
wanted?_ If not, it is `correctness`. If rarely, `suspicious`. If it is fine
but costly, `perf`. If it is fine but untidy, `style`. For example:

- **`security`: a receiver bound to `0.0.0.0`, or an exporter sending to an
  `http://` endpoint.** The first listens on every interface, often exposing
  the endpoint more widely than needed; the second sends telemetry
  unencrypted. Both have legitimate uses (inside a container, to a local
  sidecar), so they are lints rather than validation errors.
- **`correctness`: merging batches upstream of a content router.** If the
  resources in a merged batch route to different outputs of a downstream
  content router, the router permanently NACKs the entire batch, and because
  the batch processor does not return payloads on NACK, the data cannot be
  retried. Each request could have routed correctly on its own.
- **`suspicious`: a retry processor that can never retry.** If the first
  retry delay (the smaller of `initial_interval` and `max_interval`) is not
  shorter than `max_elapsed_time`, the processor gives up before its first
  attempt. There are conceivable reasons for it (temporarily disabling
  retries), but it is much more likely to be a mistake.
- **`perf`: two batch processors on the same path.** The second re-batches
  data that has already been batched, adding latency, memory, and CPU.
  Likewise, batching before temporal reaggregation is wasted work, since
  reaggregation resizes batches.
- **`style`: deprecated OTAP receiver compression setting.**
  `compression_method` is deprecated in favor of `request_compression` and
  `response_compression`. It still works, but configs should migrate before
  the field is removed. Today this is a warning logged at receiver start; as
  a lint it is reported before deployment and is configurable.

### Writing config lints

Node factories no longer validate config through an opaque function. Each
declares a `NodeConfig<T>`: how to parse its config into a typed value, and
the lints to run on that value. The engine parses, stores the result, and
runs the lints itself, so a node cannot forget to run them.

```rust
// config::lint
pub struct ConfigLint<T: 'static> {
    pub info: LintInfo,
    pub check: fn(&T, &mut LintSink<'_>),
}

pub struct NodeConfig<T: 'static> {
    /// Parses and validates the raw config. Errors are validation errors.
    pub parse: fn(&serde_json::Value) -> Result<T, Error>,
    pub lints: &'static [&'static ConfigLint<T>],
}

impl<T: DeserializeOwned + 'static> NodeConfig<T> {
    /// Serde deserialization, no lints.
    pub const TYPED: Self = Self { parse: deserialize_typed_config::<T>, lints: &[] };
}
impl NodeConfig<()> {
    /// Accepts only a missing or empty config, no lints.
    pub const NONE: Self = Self { parse: no_config, lints: &[] };
}
```

`ReceiverFactory`, `ProcessorFactory`, and `ExporterFactory` replace
`validate_config` with a type-erased `config: &'static dyn NodeConfigSpec`,
implemented once for every `NodeConfig<T>`:

```rust
// config::lint
pub trait NodeConfigSpec: Sync {
    fn parse(&self, raw: &serde_json::Value) -> Result<Box<dyn Any>, Error>;
    fn lints(&self) -> Vec<&'static LintInfo>;
    /// Runs every lint on a value returned by this spec's `parse`.
    fn run_lints(&self, config: &dyn Any, sinks: &mut dyn LintSinks);
}

/// Implemented by the engine for one node.
pub trait LintSinks {
    /// A sink bound to `lint` at this node, or `None` if it resolves to `allow`.
    fn sink(&mut self, lint: &'static LintInfo) -> Option<LintSink<'_>>;
}

impl<T: 'static> NodeConfigSpec for NodeConfig<T> {
    fn parse(&self, raw: &serde_json::Value) -> Result<Box<dyn Any>, Error> {
        (self.parse)(raw).map(|config| Box::new(config) as Box<dyn Any>)
    }

    fn lints(&self) -> Vec<&'static LintInfo> {
        self.lints.iter().map(|lint| &lint.info).collect()
    }

    fn run_lints(&self, config: &dyn Any, sinks: &mut dyn LintSinks) {
        let config = config.downcast_ref::<T>().expect("value from this spec's parse");
        for lint in self.lints {
            if let Some(mut sink) = sinks.sink(&lint.info) {
                (lint.check)(config, &mut sink);
            }
        }
    }
}
```

The downcast cannot fail: `parse` and `run_lints` belong to the same
`NodeConfig<T>`, and the engine only passes a value back to the spec that
produced it. Lints are identified by the address of their `LintInfo`, so
order never matters, and a lint resolved to `allow` is never run.

For example, the batch processor's existing build-time
`batch.config.forwards_everything` warning becomes a lint:

```rust
// batch_processor
static FORWARDS_EVERYTHING: ConfigLint<Config> = ConfigLint {
    info: LintInfo {
        id: "forwards_everything",
        category: Category::Suspicious,
        summary: "batch processor forwards every request without batching",
        docs: "With min_size 0 and no max_size, every request is forwarded as \
               it arrives. Set min_size, or remove the processor.",
        renamed_from: &[],
    },
    check: |config, sink| {
        for (format, plan) in config.plans().unwrap_or_default() {
            if plan.settings().forwards_everything() {
                sink.emit(format!(
                    "{} format: min_size is 0 and max_size is unset, so requests are never batched",
                    format.name(),
                ));
            }
        }
    },
};

#[distributed_slice(OTAP_PROCESSOR_FACTORIES)]
pub static OTAP_BATCH_PROCESSOR_FACTORY: ProcessorFactory<OtapPdata> = ProcessorFactory {
    // ...existing fields...
    config: &NodeConfig::<Config> {
        parse: parse_batch_config,
        lints: &[&FORWARDS_EVERYTHING],
    },
};
```

Migration is mechanical. The roughly 40 nodes using `validate_typed_config::<C>`
switch to `&NodeConfig::<C>::TYPED`, nodes using `no_config` to
`&NodeConfig::NONE`, and hand-written validators return their parsed value
instead of discarding it. Extension factories keep `validate_config` and
declare no lints in this RFC. Each check is a plain function and is unit
tested by calling it with a typed config and a recording sink.

### Writing linters

A linter is a `LinterFactory` registered in the `LINTER_FACTORIES`
distributed slice. Each of its lints bundles its declaration with its check:

```rust
// lint crate
pub struct LinterFactory {
    /// The linter's URN, e.g. `urn:otel:linter:core-nodes`.
    pub name: &'static str,
    pub lints: &'static [&'static LinterLint],
}

pub struct LinterLint {
    pub info: LintInfo,
    pub check: Check,
}

pub enum Check {
    /// A pipeline lint, run once per pipeline containing at least one node
    /// matching `interests`.
    Pipeline {
        interests: NodeInterests,
        check: fn(&LintContext<'_>, &mut LintSink<'_>),
    },
    /// A node lint, run once per node matching `interests`.
    Node {
        interests: NodeInterests,
        check: fn(&LintContext<'_>, NodeRef<'_>, &mut LintSink<'_>),
    },
}

pub enum NodeInterests {
    All,
    /// Node type URNs.
    Types(&'static [&'static str]),
}

impl<'a> LintContext<'a> {
    /// The pipeline being linted, with resolved policies.
    pub fn pipeline(&self) -> &'a ResolvedPipelineConfig;
    /// A node's config as JSON.
    pub fn raw_config(&self, node: &NodeId) -> &'a serde_json::Value;
    /// A node's config deserialized as `T`.
    pub fn typed_config<T: DeserializeOwned + 'static>(&self, node: &NodeId)
        -> Result<Arc<T>, LintError>;
    /// Connectivity queries (upstream, downstream, paths between nodes).
    pub fn graph(&self) -> &PipelineGraph;
}

// config::lint
impl LintSink<'_> {
    /// Emit a diagnostic for the lint being checked, at the location being
    /// checked. Returns a builder for related nodes (pipeline lints only).
    pub fn emit(&mut self, message: impl Into<String>) -> DiagnosticBuilder<'_>;
}
```

Linter checks can be expensive, so the engine skips a check where its lint
resolves to `allow` and at pipelines or nodes that do not match its
interests. Each invocation gets a sink bound to exactly one lint and
location, so a check cannot emit any other lint. The graph and typed configs
are cached for the duration of one pipeline's lint run.

For example, `linter:core-nodes` could flag several batch processors on the
same path:

```rust
// core-nodes/src/linter.rs
static REDUNDANT_BATCH: LinterLint = LinterLint {
    info: LintInfo {
        id: "redundant_batch",
        category: Category::Perf,
        summary: "several batch processors on the same path",
        docs: "...",
        renamed_from: &[],
    },
    check: Check::Pipeline {
        interests: NodeInterests::Types(&[OTAP_BATCH_PROCESSOR_URN]),
        check: check_redundant_batch,
    },
};

#[distributed_slice(LINTER_FACTORIES)]
pub static CORE_NODES_LINTER: LinterFactory = LinterFactory {
    name: "urn:otel:linter:core-nodes",
    lints: &[&REDUNDANT_BATCH],
};

fn check_redundant_batch(cx: &LintContext<'_>, sink: &mut LintSink<'_>) {
    let graph = cx.graph();
    let batches = graph.nodes_of_type(OTAP_BATCH_PROCESSOR_URN);
    // Illustrative: each distinct sequence of batch processors found on a
    // source-to-sink path, omitting sequences contained in another.
    for chain in graph.chains(&batches).filter(|c| c.len() > 1) {
        let mut d = sink.emit(format!("{} batch processors on the same path", chain.len()));
        for node in chain {
            d = d.related(node);
        }
    }
}
```

Built-in linters for now can live in `core-nodes` and `contrib-nodes`, next to
the nodes they lint, so they can use those nodes' URN constants and config types.
A linter that reasons about nodes in another crate refers to them by URN.

A failed `typed_config` (a check asked for a type the config does not
deserialize into) is an internal error in the lint, reported as an event; it
is not a diagnostic and does not affect admission.

### Engine lints

The engine's lints are `LintInfo` statics in the `lint` crate, owned by two
reserved URNs:

```rust
/// Owned by `urn:otel:linter:meta`.
pub static UNKNOWN_LINTS: LintInfo = LintInfo { id: "unknown_lints", /* ... */ };
pub static RENAMED_LINTS: LintInfo = LintInfo { id: "renamed_lints", /* ... */ };

/// Owned by `urn:otel:linter:engine`.
pub static UNCONNECTED_NODE: LintInfo = LintInfo { id: "unconnected_node", /* ... */ };
```

They have no checks. The engine records them, naming the lint, from the code
that already detects each condition, so detection is not duplicated:
`unconnected_node` at the node, and meta lints at the location of the
offending `lints:` block.

### Registry

The controller builds a `LintRegistry` once per process from the lints of
every compiled-in node factory (through a non-generic, `OnceLock`-cached
accessor on `PipelineFactory<PData>`), `LINTER_FACTORIES`, and the engine
lints. It maps full names and `renamed_from` aliases to lints, and each owner
URN to its lints. Level tables are built from it.

`linter` is a new URN kind. `urn:otel:linter:meta` and
`urn:otel:linter:engine` are reserved. Building the registry fails if:

- two lints or aliases share a full name;
- an id is not `[a-z0-9._-]`, is a category name, or a summary is empty; or
- a linter uses a reserved URN.

The same checks run as a unit test in `component-inventory`, which links
every node crate, together with a snapshot test of all lint names so that
renames and removals are deliberate.

### Admission

Linting is added to the existing validation path:

```text
 parse --> validate() --> LINT CONFIG --> validate_engine_components --> LINT STAGE
           structural     level tables,   spec.parse(raw) per node,      config lints,
                          meta lints      typed configs stored           linter checks,
                                                                         unconnected nodes
```

**A. Lint configuration.** After structural validation:

1. **Build level tables** for each location being admitted, from the
   registry and the `lints:` blocks read directly from the spec, applying
   the cap. Unknown selectors match nothing.
2. **Check `lints:` blocks.** Check each admitted block's selectors against
   the registry, emitting `unknown_lints` and `renamed_lints` at that block's
   location. The root block is checked at startup, group blocks at startup
   and group creation, and pipeline and node blocks whenever their pipeline
   is created or replaced.

The scope chain is root, group, pipeline, node; for the observability
pipeline it is root, `engine.observability.pipeline`, node.

**B. Component validation.** `validate_engine_components` calls each node's
`config.parse(raw)` and keeps the typed configs for the rest of admission. A
parse error stops admission as today, so no lint runs on a pipeline that
fails validation.

**C. Lint stage.** For each pipeline being admitted, report unconnected
nodes, run each node's config lints on its stored config (`run_lints`), then
run every linter's pipeline checks, then its node checks.

The result is a `LintReport` per pipeline: its diagnostics and whether any
is an error.

**Unconnected nodes.** Pruning is unchanged: `PipelineFactory::build()`
still removes unconnected nodes. The lint stage finds them with
`PipelineConfig::remove_unconnected_nodes` on a copy of the pipeline and
emits `linter:engine:unconnected_node` for each. Every other lint sees the
pipeline as configured, so every `lints:` entry on every node takes effect.

**Other callers of `validate_config`.** `node_context_declarations` and the
tests in `crates/validation/tests/validate_config_tests.rs` call
`config.parse(raw)` and drop the result.

#### Entry point

One function in the controller, roughly
`validate_and_lint(spec, factory, targets) -> Result<Vec<LintReport>, Error>`,
performs stages A to C for the pipelines selected by `targets`. It replaces
the existing component-validation calls, so validation becomes consistent
across paths (group creation, for example, does not run component
validation today):

| Caller                                | `targets`                     |
|---------------------------------------|-------------------------------|
| `Controller::run_pipelines` (startup) | All pipelines                 |
| `df_engine --validate-and-exit`       | All pipelines                 |
| Pipeline update, `/config/reconcile`  | Pipelines created or replaced |
| Group creation                        | The new group's pipelines     |

Startup linting is in `Controller::run_pipelines`, so every distribution
lints, not only `df_engine`. Reconcile today validates both the desired and
target configs, and pipeline updates validate the whole candidate config;
both call `validate_and_lint` once, on the candidate config, with only the
changed pipelines as targets, so unchanged pipelines are not re-reported.

### Reporting

How diagnostics are reported depends on the path:

| Path                  | Error diagnostics                         | Warning diagnostics                                  |
|-----------------------|-------------------------------------------|------------------------------------------------------|
| Startup               | Engine does not start; in startup error   | Emitted as events once the subscriber is installed   |
| `--validate-and-exit` | Printed to stderr; non-zero exit          | Printed to stderr; zero exit                         |
| Live reconfiguration  | Change rejected; in the rejection message | Emitted as events; change admitted                   |

Startup validation runs before the engine's telemetry subscriber is
installed, so events emitted then would be lost. At startup, warnings are
therefore held in the `LintReport` and emitted after
`init_global_subscriber`, as `emit_topic_mode_reports` already is.

The `lint` crate returns diagnostics as plain values. The controller emits
each reported diagnostic as a `pipeline.lint.diagnostic` event with
`otel_warn!` (`warn`) or `otel_error!` (`deny`). The body is the message.
For example:

```yaml
event_name: pipeline.lint.diagnostic
severity: WARNING
body: "otap format: min_size is 0 and max_size is unset, so requests are never batched"
attributes:
  lint.name: urn:otel:processor:batch:forwards_everything
  lint.level: warn
  lint.location: node
  pipeline.group.id: dev
  pipeline.id: main
  node.id: passthrough
  node.urn: urn:otel:processor:batch
```

| Attribute               | Present                           | Description                                         |
|-------------------------|-----------------------------------|-----------------------------------------------------|
| `lint.name`             | Always                            | Full lint name                                      |
| `lint.level`            | Always                            | Final level after the cap: `warn` or `deny`         |
| `lint.location`         | Always                            | `root`, `group`, `pipeline`, or `node`              |
| `pipeline.group.id`     | Location is group, pipeline, node | Group (`system` for the observability pipeline)     |
| `pipeline.id`           | Location is pipeline or node      | Pipeline                                            |
| `node.id`, `node.urn`   | Location is node                  | Node and its type                                   |
| `lint.related.node.ids` | Pipeline lint with related nodes  | Comma-separated ids of the related nodes            |
| `lint.level.selector`   | Level set by a `lints:` entry     | The selector that set the level, e.g. `correctness` |
| `lint.level.scope`      | Level set by a `lints:` entry     | `root`, `group`, `pipeline`, or `node`              |

Identity uses the canonical entity keys (`crates/engine/src/attributes.rs`)
as record attributes: lints run before a pipeline is built, and a rejected
pipeline is never built, so there is no entity scope to attach. The event is
declared in `semconv/groups/event.pipeline.lint.diagnostic.yaml`, and the
`live-check` run gains a config with an unconnected node to exercise it.

Diagnostics locate problems by config path (e.g.
`groups.dev.pipelines.main.nodes.debug`). Source positions are not
available: `serde_yaml` 0.9 does not retain them, and environment variable
substitution happens before parsing.

### Live changes to lint configuration

Lint configuration shared by several pipelines follows the rule live
reconfiguration already applies to shared policies: it changes only on
restart.

| Lint configuration                        | Changed live?                               |
|-------------------------------------------|---------------------------------------------|
| Root `lints:` block                       | No; restart required                        |
| Group `lints:` block, group has pipelines | No; restart required                        |
| Group `lints:` block on group creation    | Yes (new groups are empty)                  |
| `engine.lint_cap`, `--cap-lints`          | No; restart required                        |
| Pipeline and node `lints:` blocks         | Yes, through pipeline updates and reconcile |

`validate_reconcile_capabilities` gains a check rejecting changes to the
root block and to the block of any group with current or requested
pipelines, with the existing `unsupported_mutation` "restart required"
error; otherwise the new root field would be silently ignored.
`reconcile_target_config` carries the new field, and
`docs/admin/live-reconfiguration.md` gains a row.

Lints do not affect a running pipeline, so
`ResolvedPipelineConfig::runtime_matches` and the node config comparison
ignore `lints:` blocks. A lint-only pipeline change is planned as a `noop`
rollout: the configuration is committed and the pipeline keeps running.

## Rationale and alternatives

- **Lint levels in `policies`.** Policies resolve by replacing a field
  wholesale at the first scope that sets it, while lint configuration merges
  per selector. Policies also do not exist at node scope, where individual
  suppressions are most useful.
- **Extensions as linters, or lints as an extension capability.**
  Extensions and capabilities are runtime components built on every core
  and bound to nodes. Lints are needed at admission without building
  anything, and are consumed by the engine rather than by nodes.
- **Linter instances in the configuration.** A `linters:` section at several
  scopes would allow differently configured instances, but adds a section,
  instance ids, and live-reconfiguration rules. Running every compiled-in
  linter and scoping it with levels covers the common cases with no new
  configuration. We can consider specifying more lints or customizing linters
  via config later.
- **A derive macro for lint sets.** An enum per component deriving `Lints`
  would give doc-comment docs and default ids, but pairs each lint with its
  check by position or through a separate `match`. A `static` per lint
  bundles the two without a proc-macro crate.
- **Naming the lint at emission in config validators.** One validator could
  emit any of the node's lints, clippy-style. Per-lint checks give config
  lints and linters one model, let the engine skip lints at `allow`, and can
  be unit tested in isolation; deserialization still happens once.
- **Config lints run by the validator.** A validator that parses and then
  runs its node's lints can forget to run them. Having the engine own
  parse-then-lint removes that failure, and keeps lint output out of
  admissions that fail validation.
- **Check functions for engine lints.** These would duplicate detection the
  engine already performs.
- **One check per linter.** A single check per linter could not be skipped
  per lint, while linter checks can be expensive.
- **Resolving levels after validation.** Validators could emit into an
  unfiltered buffer resolved afterwards, at the cost of storing diagnostics
  that are then dropped.
- **Linting the pruned pipeline.** Pruning at admission, or linting without
  unconnected nodes, would silently ignore `lints:` entries on removed nodes
  and give config lints and linter lints different views of the pipeline.
- **The full rustc level set in v1.** `expect`, `forbid`, a `warnings`
  selector, and CLI level flags each add resolution rules, meta lints, and
  edge cases. They can be added later without changing the design (see
  [Future possibilities](#future-possibilities)).

## Unresolved questions

- Upgrades. No lint denies by default, but a config that sets a category or
  component to `deny` would start failing when a release adds a lint to it.
  Options include an allow-by-default `nursery` category for new lints, or a
  lint baseline version in the config (e.g. `lints_version`) above which new
  lints are capped at `warn`.
- How should conflicting lints be prevented? One option is a test requiring
  every core lint to provide an example config that passes it and triggers no
  other core lint.

## Future possibilities

- More levels, as in rustc: `expect` (suppress, but report when the lint no
  longer fires), `forbid` (cannot be overridden by inner scopes), a
  `warnings` selector promoting all warnings to errors, and CLI level flags.
- Removed lints: keep a deleted lint's name registered so `lints:` blocks
  naming it get a dedicated meta lint instead of `unknown_lints`.
- Live changes to root and group `lints:` blocks and to the cap, by
  re-linting every affected pipeline and rejecting the change if any fails.
- Returning lint warnings in admin API responses.
- Linter configuration, e.g. `engine.linters.<urn>: {...}`, including
  config-driven node interests.
- Lint parameters beyond a level, and suppression reasons
  (`{ level, reason }`).
- Programmatic linter registration (e.g. `Controller::with_linter(...)`).
- A language for describing lints, such as rego.
- Linting in `dfctl`. Linters depend only on `lint` and `config`; config
  lints and linters using node config types also require the node crates.
- Lints across pipelines connected by topics.
- Documentation generated from `LintInfo`.
- Passing the config parsed at admission to `create`, instead of parsing it
  again on every core.
- Config lints for extensions, and extensions that lint the nodes bound to
  them.
- A connection location for rules about individual edges.
