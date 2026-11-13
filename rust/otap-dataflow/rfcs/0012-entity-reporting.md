---
Proposal Name: entity-reporting
Start Date: 2026-11-12
RFC PR: open-telemetry/otel-arrow#0000
Tracking Issue: open-telemetry/otel-arrow#0000
---

# RFC 0012: Entity Reporting

## Summary

The Dataflow Engine (DFE) has a well-defined entity model. The goal of this RFC is
to formalize that hierarchy in OpenTelemetry terms and outline how the DFE will 
communicate it using OpenTelemetry signals.

For the sake of completeness, this RFC consolidates some information already
present about entities in the following documents:

- TODO link to relevant ITS/Entity documents

## Motivation

Dataflow Engine entities have status information that is valuable for monitoring
and troubleshooting. Entity status is available via the `/api/v1/status` admin
endpoint, but it's in a bespoke format. This data is also not exported via the
Internal Telemetry System (ITS).

We want entity information to be readily available for DFE users like any other
internal telemetry. This includes:

- Status of existing entities and their types
- Lifecycle events including deletion
- Relationships between entities

The natural thing to do is to align ourselves with OpenTelemetry Entities, which
are in the process of being defined. To that end we place the following
restrictions on ourselves:

- DFE Entities are defined according to the abstract notion of OpenTelemetry
entities e.g. type, identifying attributes, and descriptive attributes.
- 

There are also certain problems with the existing entity model in the engine:

- Can't dismbiguate between a pipeline/node that was deleted and recreated :( 

## Guide-level explanation

### Entity modeling

- TODO: Explain entity types
- TODO: Explain that all entities inside the engine are assigned a UUID V7 as
their sole identifying attribute
- TODO: Explain that remaining attributes are descriptive and mention the signal
modeling section

### Entity Containment Chain

- TODO explain the boundary between Resources and Entities that enclose the DFE
and are injected via resource/entity detectors and entities that are owned and
operated by the DFE
  - TODO: Need words to describe entities above and below this boundary
- TODO: introduce the concept of entity containment within the DFE and how descriptive
- TODO: Need a word to describe entities 

### Signal modeling and Entity Refs

- TODO: Explain how entities above the boundary and the engine itself are unioned
up into the resource
- TODO: Explain how entity refs are only used for resources above the boundary
- TODO: Explain how entities internal to the engine are represented via scope
- TODO: Explain how descriptive and identifying attributes for internal entities
are unioned into each scope
- TODO: Explain how logs and metrics are attached to explicit entities based on
the narrowest containing entity in the scope

### Entity Events

- TODO: Explain how entity events are used to communicate internal entities below
the boundary
- TODO: Explain how entities are emitted as entity status events
- TODO: Describe entity relationships
  - TODO: This might need it's own section before this similar to entity containment
  chain or embedded therein. Trying to describe NUMA nodes and cores is probably 
  going to be a doozy here
- TODO: Explain deletion entity events
- TODO: Address periodic emission, probably introduce ITS settings for entity
event emission rates

### api/v1/metrics

- TODO: Explain how we're going to represent status. Should we change the shape
of engine status to be aligned to the entity model more explicitly?

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

- TODO: Describe why we're not using EntityRefs for

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
