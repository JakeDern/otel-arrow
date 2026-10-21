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

Programming languages have solved this problem through static program linters like clippy.
We can do the same for Dataflow Engine pipelines.

## Guide-level explanation

Pipeline lints overview:

- Represent a single rule about how pipelines or nodes should generally be
constructed
- Are assigned stable numbers
- Present themselves via warnings when the dataflow engine creates/modifies a
pipeline or node

Different severity classifications:

- Warnings: Result in warning level events in the engine
- Errors: Block the creation of pipelines by default

Configuring lints:

- Treating warnings as errors
- Allowing pipelines even with errors 
- Enabling or disabling specific lints
- Applying configuration to specific scopes i.e. engine, pipeline group, or pipeline level

Extending existing lints:

- Namespaces for lints (system/engine vs user defined)
- Adding user defined lints for pipelines
- Installing additional lints from some source?

Running lints against some static config using the engine

- Engine should have a dry-run command or similar that can validate a static yaml file
- dfctl should be able to do the same thing

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

- TODO: Cargo clippy.



## Unresolved questions

- How should configuration related lints and config validation be reconciled?
    - Should we make a lot of config validations that emit warnings just emit
      lints instead?

## Future possibilities

- Serializing lints to/from a file
- Lints that operate on connected pipelines 
