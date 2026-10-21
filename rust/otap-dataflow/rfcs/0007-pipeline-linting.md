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
question "does this pipeline/node even compile?". Validation failures are hard errors
that cannot be suppressed. Lints on the other hand say "this pipeline can run, but 
it probably shouldn't look like this" and are fully configurable. Lints only run on
configurations that have some level of sanity and already passed validation, just 
as clippy only runs on code that type-checks.

The basic pipeline for linting:

```text
 YAML --> parse --> validate --------------> lint ----------------> admit / reject
          (serde)   hard errors:             only runs on configs
                    cycles, unknown URNs,    that validated; the
                    bad ports, ...           resolved levels decide
                    never suppressible       the outcome
```

### Lint names

Lint names are referred to by their names only; there are no numeric codes. There 
are two categories of lints - Engine lints and Component lints.

**Engine lints** are defined by the engine itself, are not tied to any component,
and therefore have no prefix, like rustc's built-in lints:

```text
unconnected_node
unknown_lints
```

**Component lints** are defined by a node or an extension and are named by
appending a lint id to the component's URN (see [URN format](../docs/urns.md)).
The vast majority of lints are in this category:

```text
<component urn>:<lint_id>

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
  cannot contain `:`. Because canonical URNs always have four segments and
  shortcut URNs always have two, a lint name is unambiguous to parse.
- The category names (`correctness`, `suspicious`, `perf`, `style`) and
  `warnings` are reserved and may not be used as lint ids, so that they
  remain unambiguous as [selectors](#selectors).
- Lint names are stable. A lint that is renamed keeps its old name as an
  alias, and using the alias triggers `renamed_and_removed_lints`.
- Defining the same fully qualified lint name twice is a hard error when the
  engine starts.

### Lint scope

For now, lints operate on a single pipeline at a time. A lint may inspect any node,
connection, or setting within that pipeline (including the settings it
inherits from its group and the root). In the future we may extend lints to operate
across pipelines, including those connected by a topic.

Each diagnostic has exactly one **primary location**, which is the root,
a group, a pipeline, or a node. A diagnostic that concerns several nodes
(for example, a rule about node ordering) picks one of them as its primary
location and lists the others as related locations, similar to rustc's
secondary spans. The primary location determines which `lints:` blocks
apply when resolving the diagnostic's level.

### Levels

| Level    | Reported?                                   | Pipeline admitted? | Can inner scopes change it? |
|----------|---------------------------------------------|--------------------|-----------------------------|
| `allow`  | No                                          | Yes                | Yes                         |
| `expect` | No, but reports if the lint does *not* fire | Yes                | Yes                         |
| `warn`   | Yes, as a warning                           | Yes                | Yes                         |
| `deny`   | Yes, as an error                            | **No**             | Yes                         |
| `forbid` | Yes, as an error                            | **No**             | **No**                      |

### Categories

Every lint belongs to exactly one of a fixed set of categories based on their natures.
The initial proposed set of categories is:

| Category      | Meaning                                                                                                  |
|---------------|----------------------------------------------------------------------------------------------------------|
| `correctness` | The pipeline almost certainly does not do what its author intended (data dropped, misrouted, corrupted). |
| `suspicious`  | Probably a mistake, but there are legitimate uses.                                                       |
| `perf`        | Correct, but wastes CPU, memory, or throughput.                                                          |
| `style`       | Correct and efficient, but redundant, deprecated, or unidiomatic.                                        |

A useful test when classifying a lint: *is there any configuration where
this is what the author wanted?* If not, it is `correctness`. If rarely, it
is `suspicious`. If it is fine but costly, it is `perf`. If it is fine but
untidy, it is `style`.

The default enforcement level of each category is not yet decided (see
[Unresolved questions](#unresolved-questions)).

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
| `warnings`           | `warnings`                  | Special: changes how `warn` is treated (see [Treating warnings as errors](#treating-warnings-as-errors)) |

FIXME(jakedern): Look at this last warnings/warnings entry in the table 

Engine lints are selected by their bare name (e.g. `unconnected_node`).
Because category names are reserved lint ids, a component + category
selector can never be confused with a lint name.

FIXME(jakedern): Re-evaluate the above paragraph

### Configuring lints

Lints are configured with a `lints:` block, which can appear at four scopes:
the root of the config, a pipeline group, a pipeline, and a node. Each entry
maps a selector to either a level or a `{ level, reason }` object.

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
              unconnected_node:
                level: expect
                reason: "connected by a follow-up reconfiguration"
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
also do not exist at node scope, which is where individual suppressions are most
useful.

### Resolving a lint's level

The level of a diagnostic is resolved from its primary location outwards.
Command-line flags (`-A`, `-W`, `-D`, `-F`) act as an outermost scope that
encloses the root, as they do for rustc.

```text
 CLI flags                    (outermost)   ^
   root        lints:                       |  search from the innermost
     group       lints:                     |  scope outwards; the first
       pipeline    lints:                   |  scope with a matching entry
         node        lints:   (innermost)   |  wins
              ^
              diagnostic's primary location
```

For each diagnostic:

1. **Find the configured level.** Walk from the innermost scope outwards.
   In the first scope that has any entry matching the lint, take the most
   specific matching entry. If no scope matches, use the lint's default
   level.
2. **Apply `warnings`.** If the level is `warn` and the `warnings` selector
   resolves to `deny` or `forbid` at this location, the level becomes `deny`.
3. **Apply the cap.** If `lint_cap` is set, the level is lowered to at most
   the cap.
4. **Act on the level.** `allow` drops the diagnostic. `expect` marks the
   expectation as fulfilled and drops the diagnostic. `warn` reports it.
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

This is how an operator locks down rules that pipeline authors must not
turn off. The only thing that can lower the severity of a forbidden lint is
the operator-only [cap](#capping-lint-levels).

### Treating warnings as errors

`warnings: deny` promotes every diagnostic whose resolved level is `warn` to
`deny`, equivalent to `-D warnings`. `warnings` is resolved like any other
selector, so it can be set at any scope, and the promotion happens after the
lint's own level is resolved. A pipeline that sets an individual lint to
`warn` underneath a root `warnings: deny` therefore still gets an error. To
opt a scope out of the promotion, set `warnings: warn` in that scope.

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

Any entry may carry a `reason`, which is shown in diagnostics and lint
reports. We recommend giving a reason for every suppression.

`expect` is a self-cleaning `allow`: the diagnostic is suppressed, but if the
expected lint stops firing at that location, the
`unfulfilled_lint_expectations` lint is reported instead. This keeps
suppressions from outliving the problem they were added for.

### Reading a diagnostic

Each diagnostic shows the lint name, its primary location as a config path
(plus file, line, and column when linting a YAML file), and where its level
came from. The level notes matter because a level can be influenced by four
config scopes, CLI flags, and the cap.

```text
error[unconnected_node]: node `debug` has no connections and will be removed
  --> groups.dev.pipelines.main.nodes.debug
   = note: `warn` by default (category: suspicious)
   = note: promoted to `deny` by `warnings: deny` at <root>
   = help: connect the node or remove it
   = docs: <generated lint documentation link>
```

### Meta lints

A few engine lints report problems with the lint configuration itself. They
are ordinary lints and can be configured like any other.

| Lint                            | Category     | Fires when                                                                     |
|---------------------------------|--------------|--------------------------------------------------------------------------------|
| `unknown_lints`                 | `suspicious` | A `lints:` block names a lint, component, or category the engine does not know |
| `renamed_and_removed_lints`     | `suspicious` | A `lints:` block uses a renamed or removed lint name                           |
| `unfulfilled_lint_expectations` | `suspicious` | An `expect` entry's lint did not fire                                          |

### Where lints come from

There are three sources of lints:

- **The engine** defines engine lints, including the meta lints.
- **Nodes** define lints about their own use, for example rules about their
  configuration or their position in a pipeline. A node lint may inspect the
  rest of the pipeline and other node types.
- **Extensions** can define lints. This is how organisations add their own
  rules, for example forbidding a particular node or configuration, without
  writing a node. Such lints are namespaced by the extension's URN.

All lint *definitions* are compiled into the engine, so the full set of lint
names is always known, whether or not a given node or extension is used.
Naming a lint whose definition is compiled in never triggers
`unknown_lints`; only typos and lints from components that are not compiled
in do. Which lints are *active* for a given pipeline depends on the
pipeline:

| Source    | Active in                                                                                                                             | Initial level |
|-----------|---------------------------------------------------------------------------------------------------------------------------------------|---------------|
| Engine    | Every pipeline                                                                                                                        | Its default   |
| Node      | Pipelines that contain at least one node of that type                                                                                 | Its default   |
| Extension | The scope where the extension is declared (every pipeline for an engine-level extension, one pipeline for a pipeline-level extension) | Its default   |

```text
 1. names known     all engine, node, and extension lint names (compiled in)
 2. validate        config validation, including extension configs
 3. activate        per pipeline: engine lints
                                + lints of node types used in the pipeline
                                + lints of extensions declared in scope
 4. resolve         levels resolved from lints: blocks; forbid checked
 5. run             active lints run; diagnostics reported or pipeline rejected
```

`lints:` entries apply on top of these defaults in the usual way. In
particular, an extension's defaults never override a `forbid` from an
enclosing scope.

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
  file without starting any pipelines. This gains rustc-style `-A`, `-W`,
  `-D`, `-F`, and `--cap-lints` flags, so CI can run, for example,
  `df_engine --validate-and-exit -c pipeline.yaml -D warnings`.
- **With `dfctl`.** `dfctl` can lint a config against a running engine.
  This is done on the server, because lints defined by nodes and extensions
  only exist in the engine binary they were compiled into.

## Reference-level explanation

- Introduction of a new linting crate which contains
  - Type system definitions of a lint
  - Traits for executing lint passes (definitely needs research)
  - Utilities for executing common lints like node before/after constraints
- Automatic documentation generation
- Integration into the engine
  - Live reconfiguration
  - Initial configuration
- Node defined lints i.e. lints that are declared/defined by some node
  - Can operate on either config or entire pipelines/engine configurations
  - Can be aware of other node types/urns 
- Testing strategies
    - Handling of circular/contradictory/conflicting codes. Every core lint should be
      able to define an example config that passes the lint AND no other core lint should
      trigger on that config
    - Testing that there are no conflicting lint codes
    - Testing that lint codes remain stable

- TODO: Lint extension interface, including how an extension registers the
  lints it defines
- TODO: Ordering of lint activation when extensions are declared at
  different scopes, and how this interacts with `forbid` and live
  reconfiguration
- TODO: Component-level aliasing, so that renaming a component's URN renames
  every lint it defines
- TODO: Warning-level events in the observed state, and warnings in admin
  API responses

TODO: Figure out how to make lints efficient

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

- TODO: Cargo clippy. See the comparison table in the
  [guide-level explanation](#pipeline-lints-by-analogy-to-clippy).


## Unresolved questions

- How should configuration related lints and config validation be reconciled?
  - Should we make a lot of config validations that emit warnings just emit
    lints instead?
- TODO: Who owns which lint settings? Unlike Rust, where the code author
  configures lints, the engine operator and the pipeline author may be
  different people submitting different configuration changes.
- Can the root `lints:` block be changed live (e.g. through
  `/config/reconcile`), or does changing it require a restart?
- Default levels for each category. In particular, should `correctness`
  default to `deny` (as in clippy) or `warn`?
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
- Lint parameters. Should lints accept configuration beyond `level` and
  `reason`, like clippy's `disallowed_methods` configured in `clippy.toml`?
  - If so, how do parameter values merge across scopes (replace or extend)?
- Should engine lints keep using bare names, or have their own URN (e.g.
  `urn:otel:engine:core:<lint_id>`) so that every lint is named the same way?
- What happens when multiple instances of the same extension type, each
  defining the same lints, are declared in one scope?
- Should configuring a lint in a scope where it can never be active (e.g. a
  root entry for a lint whose extension is declared in only one pipeline) be
  reported by a lint?

## Future possibilities

- Serializing lints to/from a file
- Lints across pipelines connected by topics. Lints are currently limited to
  a single pipeline, which avoids a change to one pipeline causing a lint
  failure in another.
- Changing lint configuration at runtime (see
  [Unresolved questions](#unresolved-questions))
