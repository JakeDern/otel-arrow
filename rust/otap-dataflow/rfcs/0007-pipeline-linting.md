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
correctness, security, or other reasons.

The rules are many and it is unreasonable for any human (or agent),
experienced or not, to be aware of the constantly evolving set of nodes and
configurations nor the accumulated wisdom in how best to use them (let
alone, consistently and perfectly apply these rules in practice).

Programming languages have addressed this problem through configurable linting
systems. This is a proposal for a similar system for Dataflow Engine pipelines.

## Guide-level explanation

### What is a lint?

A lint is a special diagnostic, indicating one opinion about how pipelines or 
nodes should generally be configured. A lint is distinct from a validation or
type-checking error which are hard errors for configurations that don't describe
a valid pipeline at all.

For example, telling an otap receiver to bind its listener to 0.0.0.0 has uses,
but is a security concern worth warning about in a lint. Setting the otap
receiver to `foobar: baz` on the other hand is nonsense and a hard error.

Lints therefore are checked after validation:

```text
 parse --> validate() --> validate_engine_components --> LINT STAGE   -->   pipeline admission
           structural     validate_config per node       unconnected nodes,
                                                         binding to 0.0.0.0
```

### Linting levels and categories

Every lint belongs to one of a predefined set of categories based on type of concern.

| Category      | Meaning                                                                                                  |
|---------------|----------------------------------------------------------------------------------------------------------|
| `security`    | A security concern, e.g. the pipeline exposes data or endpoints to unauthorized access or interception.  |
| `correctness` | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | A general categor for things are probably a mistake, but there are legitimate uses.                      |
| `perf`        | Correct, but probably negatively impacts CPU, memory, or throughput.                                     |
| `style`       | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

Each category of lint also has a level that determines the engine's behavior when the lint is
detected. The default level of all categories is `warn`.

| Level   | Effect                |
|---------|-----------------------|
| `allow` | Not reported          |
| `warn`  | Reported as a warning |
| `deny`  | Reported as an error  |

Errors generally stop whatever process is happening when detected. For example if an
engine detects a linting error in a pipeline at startup, the engine will stop and exit 1,
but lint warnings are simply logged.

### Configuring lints

Lints are configured with a `lints` entry inside the existing `policies` sections
at the engine (root), pipeline group, and pipeline scopes. Each key is either a
category or `default`, and each value is a level:

| Key             | Applies to                                                     |
|-----------------|----------------------------------------------------------------|
| `<category>`    | All lints in that category                                     |
| `default`       | All lints whose category is not set at the same scope          |

```yaml
version: otel_dataflow/v1
policies: # engine
  lints:
    security: deny
    correctness: deny
groups:
  dev:
    policies: # group
      lints:
        default: allow
        security: warn
    pipelines:
      main:
        policies: # pipeline
          lints:
            perf: warn
        nodes:
          # ...
```

Unknown keys and levels are configuration errors, as for every other policy.

A lint's level in a pipeline is found by searching the scopes from the pipeline
outwards (pipeline, group, engine). At each scope:

1. if the lint's category is set, that level is used;
2. otherwise, if `default` is set, that level is used;
3. otherwise, the search continues at the next scope.

If not configured at any scope, the lint is `warn`. In the example above, for
pipeline `dev/main`:

| Category      | Level   | Decided by                        |
|---------------|---------|-----------------------------------|
| `perf`        | `warn`  | pipeline `perf`                   |
| `security`    | `warn`  | group `security`                  |
| `correctness` | `allow` | group `default`                   |
| `suspicious`  | `allow` | group `default`                   |
| `style`       | `allow` | group `default`                   |


### Where lints come from

All lints are provided by **lint packs**. A lint pack is a component that
only carries lints. Every lint pack compiled into the engine runs on every
pipeline and is controlled through [levels](#configuring-lints). The engine
will initially ship two packs: `lints:core-nodes` (lints about core nodes and
pipelines containing them) and `lints:contrib-nodes` (similar for contrib
nodes).

The engine additionally reports one lint itself, `engine:unconnected_node`,
for nodes that are not connected to the rest of the pipeline. It lives in the
reserved `urn:otel:engine` namespace and is configured like any other lint.

### Lint names

Every lint is named after the pack that provides it followed by the lint's
id. Names follow the shortcut rules of component URNs (see
[URN format](../docs/urns.md)); the short form is only valid for the `otel`
namespace.

```text
urn:otel:lints:core-nodes:redundant_batch     built-in pack, canonical form
lints:core-nodes:redundant_batch              built-in pack, otel shortcut form
engine:unconnected_node                       lint reported by the engine
urn:acme:lints:prod_policy:no_debug_exporters third-party pack
```

Names identify a lint in diagnostics and documentation. They are not used in
configuration, which only refers to categories (see
[Configuring lints](#configuring-lints)).

### Locations

Every diagnostic has a **location**, either a node or a pipeline.

- A **node lint** is located at the node it is about.
- A **pipeline lint** is located at the pipeline. A pipeline lint that
  concerns specific nodes (for example, node ordering) lists them as
  related nodes, like rustc's secondary spans.

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
**category**, which is the unit at which lints are configured:

| Category      | Meaning                                                                                                  |
|---------------|----------------------------------------------------------------------------------------------------------|
| `security`    | A security concern, e.g. the pipeline exposes data or endpoints to unauthorized access or interception.  |
| `correctness` | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | Probably a mistake, but there are legitimate uses.                                                       |
| `perf`        | Correct, but wastes CPU, memory, or throughput.                                                          |
| `style`       | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

### Configuring lints

Lints are configured with a `lints` entry inside the existing `policies`
sections at the engine (root), pipeline group, and pipeline scopes. Each key
is either a category or `default`, and each value is a level:

| Key             | Applies to                                                     |
|-----------------|----------------------------------------------------------------|
| `<category>`    | All lints in that category                                     |
| `default`       | All lints whose category is not set at the same scope          |

```yaml
version: otel_dataflow/v1
policies: # engine
  lints:
    security: deny
    correctness: deny
groups:
  dev:
    policies: # group
      lints:
        default: allow
        security: warn
    pipelines:
      main:
        policies: # pipeline
          lints:
            perf: warn
        nodes:
          # ...
```

Unknown keys and levels are configuration errors, as for every other
policy.

A lint's level in a pipeline is found by searching the scopes from the
pipeline outwards (pipeline, group, engine). At each scope:

1. if the lint's category is set, that level is used;
2. otherwise, if `default` is set, that level is used;
3. otherwise, the search continues at the next scope.

If no scope decides, the lint is `warn`. In the example above, for pipeline
`dev/main`:

| Category      | Level   | Decided by                        |
|---------------|---------|-----------------------------------|
| `perf`        | `warn`  | pipeline `perf`                   |
| `security`    | `warn`  | group `security`                  |
| `correctness` | `allow` | group `default`                   |
| `suspicious`  | `allow` | group `default`                   |
| `style`       | `allow` | group `default`                   |

Note that the group's `default: allow` takes precedence over the engine's
`correctness: deny`: the closest scope that has an opinion wins.

Unlike other policy families, which are replaced wholesale by the narrowest
scope that sets them, `lints` is resolved per key as described above.
Setting `lints.perf` on a pipeline does not discard the engine's
`lints.security`.

Levels apply to whole pipelines. There is no way to allow a lint for one
node of a pipeline but not another, or to configure a single lint or pack.
A node that intentionally violates a lint can be moved to its own pipeline
with its own `lints` policy.

## Reference-level explanation

### Authoring lints

Lints are registered into the engine in packs via a `lints` component type. Lints 
have a urn like any other component. For example `urn:otel:lints:engine` is a group
of lints called `engine` in the `otel` namespace. A specific lint in this pack would
be `urn:otel:lints:engine:unconnected_nodes`.

Code in this section is illustrative only, but here's an example of how lints
can be roughly declared:


```rust
// lint crate
pub struct LintPack {
    /// The pack's URN, e.g. `urn:otel:lints:core-nodes`.
    pub name: &'static str,
    pub lints: &'static [&'static Lint],
}

pub struct Lint {
    pub info: LintInfo,
    pub check: Check,
}

/// Lints can be node or pipeline scoped based on what they want to check
pub enum Check {
    /// A node lint, run once per node of type `node_type`. Can only see a
    /// single node.
    Node {
        /// Node type URN.
        node_type: &'static str,
        check: fn(&LintContext<'_>, NodeRef<'_>, &mut LintSink<'_>),
    },
    /// A pipeline lint that can check any part of a pipeline's configuration.
    Pipeline {
        interests: PipelineInterests,
        check: fn(&LintContext<'_>, &mut LintSink<'_>),
    },
}

/// Since lints could have expensive graph traversals, lints can declare the nodes
/// they're interested in and are only invoked against pipelines with those nodes
pub enum PipelineInterests {
    /// Every pipeline.
    All,
    /// Pipelines containing at least one node of one of these type URNs.
    Types(&'static [&'static str]),
}

impl<'a> LintContext<'a> {
    /// The pipeline being linted, with resolved policies.
    pub fn pipeline(&self) -> &'a ResolvedPipelineConfig;
    /// A node's config as submitted.
    pub fn raw_config(&self, node: &NodeId) -> &'a serde_json::Value;
    /// Connectivity queries (upstream, downstream, paths between nodes).
    pub fn graph(&self) -> &PipelineGraph;
}

impl LintSink<'_> {
    /// Emit a diagnostic for the lint being checked, at the location being
    /// checked. Returns a builder for related nodes (pipeline lints only).
    pub fn emit(&mut self, message: impl Into<String>) -> DiagnosticBuilder<'_>;
}

/// A sample node-scoped batch processor lint
static FORWARDS_EVERYTHING: Lint = Lint {
    info: LintInfo {
        id: "forwards_everything",
        category: Category::Suspicious,
        summary: "batch processor forwards every request without batching",
        docs: "With min_size 0 and no max_size, every request is forwarded as \
               it arrives. Set min_size, or remove the processor.",
    },
    check: Check::Node {
        node_type: OTAP_BATCH_PROCESSOR_URN,
        check: check_forwards_everything,
    },
};

fn check_forwards_everything(cx: &LintContext<'_>, node: NodeRef<'_>, sink: &mut LintSink<'_>) {
    let config = cx.raw_config(node.id());
    for (format, settings) in format_settings(config) {
        // `min_size` and `max_size` are read with the processor's defaults
        // applied by hand.
        if forwards_everything(settings) {
            sink.emit(format!(
                "{format} format: min_size is 0 and max_size is unset, so requests are never batched"
            ));
        }
    }
}

/// A sample pipeline-scoped lint with an interest in the batch processor
static REDUNDANT_BATCH: Lint = Lint {
    info: LintInfo {
        id: "redundant_batch",
        category: Category::Perf,
        summary: "several batch processors on the same path",
        docs: "...",
    },
    check: Check::Pipeline {
        interests: PipelineInterests::Types(&[OTAP_BATCH_PROCESSOR_URN]),
        check: check_redundant_batch,
    },
};

#[distributed_slice(LINT_PACKS)]
pub static CORE_NODES_LINTS: LintPack = LintPack {
    name: "urn:otel:lints:core-nodes",
    lints: &[&FORWARDS_EVERYTHING, &REDUNDANT_BATCH],
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

A few notes:

Checks can be expensive, so the engine skips a check whose category
resolves to `allow` for the pipeline, and at pipelines or nodes that do not
match its interests. Each invocation gets a sink bound to exactly one lint
and location, so a check cannot emit any other lint. The graph is built once
per pipeline's lint run.

Lints see node configs only as `serde_json::Value`, exactly as submitted.
The framework does not deserialize them into the node's config type, and
fields left to their defaults are absent. A lint that relies on a default
must account for it. A pack is free to deserialize a `Value` into a type it
has access to. See [Typed configuration](#typed-configuration) for the
tradeoffs.

Each check is a plain function and is unit tested by calling it with a
pipeline config and a recording sink.

Where the built-in packs live is an
[unresolved question](#unresolved-questions).

### Engine lints

`unconnected_node` is a `LintInfo` static in the `lint` crate, owned by the
reserved `urn:otel:engine` namespace. It has no check: the engine reports it
from the code that already detects unconnected nodes, at each such node.
Pruning is unchanged: `PipelineFactory::build()` still removes unconnected
nodes, and every other lint sees the pipeline as configured.

### Registry

The lint stage reads `LINT_PACKS` directly; there is no runtime registry. A
unit test in `component-inventory`, which links every node crate, checks
that:

- no two lints share a full name;
- every id is `[a-z0-9._-]` and every summary is non-empty; and
- no pack uses the reserved `urn:otel:engine` namespace.

### Admission

Linting runs after validation:

```text
 parse --> validate() --> validate_engine_components --> resolve() --> LINT STAGE
           structural     validate_config per node        levels        unconnected nodes,
                                                                        node and pipeline checks
```

A validation error stops admission as today, and no lints are run. For each
pipeline being admitted, the lint stage reports unconnected nodes, then runs
every pack's pipeline checks, then its node checks, each at the level
resolved from that pipeline's policies. The result is a `LintReport` per
pipeline: its diagnostics and whether any is an error. A pipeline with an
error is not admitted.

#### Entry point

One function in the controller, roughly
`validate_and_lint(spec, factory, targets) -> Result<Vec<LintReport>, Error>`,
performs validation and the lint stage for the pipelines selected by
`targets`. It replaces the existing component-validation calls, so
validation becomes consistent across paths (group creation, for example,
does not run component validation today):

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
  lint.name: urn:otel:lints:core-nodes:forwards_everything
  lint.category: suspicious
  lint.level: warn
  lint.location: node
  pipeline.group.id: dev
  pipeline.id: main
  node.id: passthrough
  node.urn: urn:otel:processor:batch
```

| Attribute               | Present                          | Description                                         |
|-------------------------|----------------------------------|-----------------------------------------------------|
| `lint.name`             | Always                           | Full lint name                                      |
| `lint.category`         | Always                           | The lint's category                                 |
| `lint.level`            | Always                           | `warn` or `deny`                                    |
| `lint.location`         | Always                           | `pipeline` or `node`                                |
| `pipeline.group.id`     | Always                           | Group (`system` for the observability pipeline)     |
| `pipeline.id`           | Always                           | Pipeline                                            |
| `node.id`, `node.urn`   | Location is node                 | Node and its type                                   |
| `lint.related.node.ids` | Pipeline lint with related nodes | Comma-separated ids of the related nodes            |
| `lint.level.scope`      | Level set by a `lints` policy    | `engine`, `group`, or `pipeline`                    |

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

`lints` follows the rules live reconfiguration already applies to shared
policies:

| Lint configuration                          | Changed live?                               |
|---------------------------------------------|---------------------------------------------|
| Engine `policies.lints`                     | No; restart required                        |
| Group `policies.lints`, group has pipelines | No; restart required                        |
| Group `policies.lints` on group creation    | Yes (new groups are empty)                  |
| Pipeline `policies.lints`                   | Yes, through pipeline updates and reconcile |

The engine and group restrictions are enforced by the existing
`validate_live_shared_policies_unchanged` check without changes.

Every pipeline update or reconcile that creates or replaces a pipeline runs
the lint stage on the whole submitted pipeline, under the levels resolved
from the candidate configuration, and rejects the change if any diagnostic
is an error. This applies equally when only the pipeline's `lints` policy
changed: tightening a level to `deny` is rejected if the running pipeline
violates it.

Lints do not affect a running pipeline, so `ResolvedPolicies` comparison in
`ResolvedPipelineConfig::runtime_matches` ignores `lints`. A change that
only touches `lints` and passes the lint stage is planned as a `noop`
rollout: the configuration is committed and no nodes are rolled.
`docs/admin/live-reconfiguration.md` gains a row.

## Rationale and alternatives

### Lints in `policies`

A previous draft of this RFC rejected placing lint levels in `policies`,
because policy families are replaced wholesale at the first scope that sets
them, while lint configuration needs to merge, and because policies do not
exist at node scope. This RFC resolves `lints` per key instead (as
`resources` already resolves per sub-field), and drops node-scope levels.
In exchange, lints reuse the existing scopes, validation, and live
reconfiguration rules with no new top-level section.

### Configuring individual lints or packs

Selectors naming a single lint (`lints:core-nodes:redundant_batch`), a pack,
or a pack and category would allow fine-grained control. They require every
lint to have a stable, unique name that is part of the configuration
contract; aliases for renamed lints; rules for which selector wins when
several match; meta lints for unknown or renamed selectors; and a registry
to resolve them. Category-only configuration needs none of this, and lint
names are free to change. Finer selectors can be added later on top of
categories (see [Future possibilities](#future-possibilities)).

### Node-scope levels

Allowing lints per node is where suppressions are most precise: one
intentional `0.0.0.0` receiver should not silence every other security
finding in its pipeline. Without it, the only options are to lower the
category for the whole pipeline, or to move the node into its own pipeline.
Node-scope levels require a `lints` block on nodes (where `policies` does
not exist), a location model that distinguishes node and pipeline lints in
resolution, and validation that node blocks do not name pipeline lints. We
accept the coarser control for now.

### Config lints on node factories

Nodes could declare lints over their own typed config, run from their
`validate_config` functions, sharing the deserialization. This changes every
node factory and validator signature, fuses linting with validation, and
gives lints two different models. Every lint is instead a pack lint, and
node-specific lints are node lints for that node's type.

### Typed configuration

Lints see node configs only as `serde_json::Value`. The alternative is for
the framework to deserialize each node's config into its config type and
share it with lints (`cx.typed_config::<T>(node)`).

Benefits of typed configuration:

- **Correct defaults.** Serde defaults are applied, so a lint sees the
  configuration the node will actually run with. With `Value`, a lint must
  restate the node's defaults, which can drift from the node.
- **Type safety.** Field renames and type changes in a config struct break
  the lint at compile time rather than silently making it miss.
- **Shared work.** A config is deserialized once, rather than by validation
  and again by each lint that reads it. This only costs at admission, and
  configs are small, so it is not expected to matter.

Costs of typed configuration:

- **Linting outside the engine.** A tool like `dfctl` that lints a
  configuration must link every config type its lints use. Today those
  types live in the node crates, alongside their runtime implementations,
  `PData` types, and dependencies. To lint without them, each node family
  would need to move its config structs into a separate config-only crate,
  splitting every node across two crates, and those crates would need to
  stay free of runtime dependencies as nodes evolve.
- **Coupling.** A lint pack that names a node's config type depends on the
  crate that defines it, so third-party packs about core nodes depend on
  core node crates.
- **Framework complexity.** Sharing typed configs requires type-erased,
  per-run caching keyed by node and type, and a policy for a lint that asks
  for the wrong type.

With `Value`, a pack that can see a node's config type may still
deserialize into it itself. The framework does not depend on it, and a pack
that avoids it remains linkable anywhere.

### Lint cap

A previous draft had an operator-only cap (`engine.lint_cap`,
`--cap-lints`) lowering every level, as a break-glass for admitting
pipelines despite lint errors. Operators can lower levels at engine scope,
but this does not override narrower scopes that set `deny`. We drop the cap
to keep the configuration surface small; it can be added later.

### Fusing linting with validation

Running lints during validation could share work with validators, but
requires validators to carry lint state. Running lints after validation
leaves validation unchanged and means lints only see valid configurations.

### Other alternatives

- **Extensions as lint packs, or lints as an extension capability.**
  Extensions and capabilities are runtime components built on every core
  and bound to nodes. Lints are needed at admission without building
  anything, and are consumed by the engine rather than by nodes.
- **Lint pack instances in the configuration.** A section listing packs
  would allow differently configured instances, but adds instance ids and
  live-reconfiguration rules. Running every compiled-in pack and scoping it
  with levels covers the common cases with no new configuration.
- **One check per pack.** A single check per pack could not be skipped per
  category, while checks can be expensive.
- **Check functions for engine lints.** These would duplicate detection the
  engine already performs.
- **The full rustc level set.** `expect`, `forbid`, and CLI level flags each
  add resolution rules and edge cases. They can be added later without
  changing the design.

## Unresolved questions

- **Upgrades.** No lint denies by default, but a config that sets a
  category to `deny` would start failing when a release adds a lint to it.
  Category-only configuration makes this more likely, as there is no way to
  deny only known lints. Options include an allow-by-default `nursery`
  category for new lints, or a lint baseline version in the config (e.g.
  `lints_version`) above which new lints are capped at `warn`.
- **Conflicting lints.** One option is a test requiring every core lint to
  provide an example config that passes it and triggers no other core lint.
- **Where built-in packs live.** Packs could live next to the nodes they
  lint (`core-nodes`, `contrib-nodes`), close to the code and its URN
  constants. Or they could live in separate crates (e.g. `core-lints`)
  depending only on `lint` and `config`, so tools like `dfctl` can link
  them without the node runtimes.
- **Observability pipeline levels.** Should
  `engine.observability.pipeline.policies` accept `lints` (adding it to
  `EngineObservabilityPolicies`), or should the observability pipeline
  always use the engine-scope `lints`?

## Future possibilities

- Configuring individual lints or packs, e.g. by lint name or pack URN, as
  a more specific key alongside categories.
- Configuring lint levels at node scope.
- Reducing repeated deserialization of node configs across lints.
- Resolving the full configuration for lints, including defaults, before
  running them.
- A node lint interest matching all nodes, or all nodes of a kind.
- A lint cap for operators.
- More levels, as in rustc: `expect` and `forbid`, and CLI level flags.
- Returning lint warnings in admin API responses.
- Live changes to engine and group `lints`, by re-linting every affected
  pipeline and rejecting the change if any fails.
- Lint pack configuration, including config-driven interests.
- Programmatic lint pack registration (e.g. `Controller::with_lint_pack(...)`).
- A language for describing lints, such as rego.
- Linting in `dfctl`.
- Lints across pipelines connected by topics.
- Documentation generated from `LintInfo`.
- A connection location for rules about individual edges.
