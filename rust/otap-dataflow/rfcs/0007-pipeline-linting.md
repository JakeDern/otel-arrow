---
Proposal Name: pipeline-linting
Start Date: 2026-10-20
RFC PR: open-telemetry/otel-arrow#0000
Tracking Issue: open-telemetry/otel-arrow#0000
---

# RFC NNNN: Pipeline Linting

## Summary

The goal of this RFC is to describe how pipeline linting should be incorporated
into the Dataflow Engine. This RFC covers what usecases pipeline linting is meant
mean to address.

- Common crate for defining pipeline linting rules and evaluating them against
a pipeline specification/configuration
    - Dealing with lints that depend on a particular configuration not changing.
    - Should nodes define their own lints?
- How and when linting can be run against a static file
- Integration of pipeline linting into dfctl
- Integration of pipeline linting into the engine's live reconfiguration
- Assignment of stable error codes to lints
    - Reserved namespace for project wide lints
    - Extension of user defined lints/custom lints
    - Testing strategy (golden file, snapshot tests)
        - To make sure we don't change
        - Automatically making sure we don't overlap codes
- Lint classifications
    - Errors
    - Warnings
    - Other???
- Configuring lints in DFE
    - Block new pipelines that don't pass lints
    - Treat warnings as errors
    - Enabling/disabling lints per pipeline or per pipeline group
- Types of lints:
    - Configuration guidance
    - Node placement
        - Core nodes can reference each other, and contrib can reference core
- Handling of circular/contradictory/conflicting codes
    - Every core lint should be able to define an example config that passes the
      lint AND no other core lint should trigger on that config

## Motivation

In the Dataflow Engine, we design nodes under the philosophy of composability. Each
node offers simple and unique behaviors that can be composed together into a pipeline
to express more complicated functions. 

This is not unlike programming languages which expose simple constructs like
sum/product types, conditionals, or loops that can be composed into a program.
A pipeline is basically a program written in the language of nodes.


While nodes have been designed with useful behaviors in mind, this RFC is an acknowledgement
that the flexibility of the system allows for just as many bad behaviors in the same way
that

fact the number of bad behaviors is 

The number of possible topologies f


(a pipeline) can serve 

that each should be single 
purpose with highly composable behaviors.
with the philosophy that nodes 
This philosophy
lends itself to Designing telemetry pipelines is hard. 

## Guide-level explanation

Explain the proposal as if it were already implemented and you were teaching it
to another contributor. That generally means:

- Introducing new named concepts.
- Explaining the feature mainly through examples.
- Explaining how contributors should *think* about the feature and how it
  changes the way they work in the repo.
- If applicable, sample error messages, deprecation warnings, or migration
  guidance.

## Reference-level explanation

The technical portion of the RFC. Explain the design in enough detail that:

- Its interaction with existing features (crates, macros, factories, the
  engine, xtask, CI) is clear.
- It is reasonably clear how the feature would be implemented, and in which
  crates.
- Corner cases are covered by example.

Return to the examples from the guide-level section and show how the detailed
design makes them work.

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

- TODO: Cargo clippy


## Unresolved questions

- What parts of the design do you expect to resolve through the RFC process
  before merge?
- What related issues are out of scope for this RFC and could be addressed
  independently later?

## Future possibilities

What natural extensions or follow-ups does this enable? This is a place to
record ideas that are out of scope now but worth remembering.
