---
Proposal Name: entity-reporting
Start Date: 2026-11-12
RFC PR: open-telemetry/otel-arrow#0000
Tracking Issue: open-telemetry/otel-arrow#0000
---

# RFC 0012: Entity Reporting

## Summary

The Dataflow Engine (DFE) has a well-defined entity model and hierarchy. The goal
of this RFC is to formalize that hierarchy in terms of OpenTelemetry Entities and
outline how the DFE will communicate it using OpenTelemetry signals.

## Motivation

The Dataflow Engine is made up of entities. These entities have valuable state and
status information available via the `/api/v1/status` admin endpoint, but
not exported via the Internal Telemetry System (ITS).

OpenTelemetry is in the process of formalizing Entities, including more than one
way for how they're communicated over signals. 

Why are we doing this? What use cases does it support? What is the expected
outcome? What problem in `otap-dataflow` does it solve, and for whom?

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

## Unresolved questions

- What parts of the design do you expect to resolve through the RFC process
  before merge?
- What related issues are out of scope for this RFC and could be addressed
  independently later?

## Future possibilities

What natural extensions or follow-ups does this enable? This is a place to
record ideas that are out of scope now but worth remembering.
