# Open Telemetry Arrow Protocol (OTAP) Introduction

This document is meant to be an introduction to the Open Telemetry Arrow 
Protocol (OTAP). It is not a full technical specification, but enumerates the
major requirements of clients and servers communicating over OTAP. If you are 
inexperienced with the protocol and looking to familiarize yourself with the 
major components and mechanisms, then this is a good place to start.

It may also be helpful to consult the reference implementation of the protocol
while reading this document or vice versa.

- TODO: Reference implementation

This document does not revisit the motivations of technology choices like Apache
Arrow. For those details, the following may be helpful:

- TODO: OTel Arrow Phase 2
- TODO: F5 Parts 1&2
- TODO: Original OTAP design spec

This document also assumes basic familiarity with the OpenTelemetry Data model
and OpenTelemetry Protocol (OTLP).

- TODO: OpenTelemetry Data Model
- TODO: OTLP

## Basic Description

Like its predecessor [OTLP](https://opentelemetry.io/docs/specs/otlp/), OTAP is
concerned with the _transport_ of Logs, Metrics, and Traces telemetry _signals_
over the wire from a Client to a Server. The semantic model and meaning of
these signals is independent of the over the wire transport, and OTAP makes
a few different choices from OTLP with respect to how this data is represented.

OTAP opts for a normalized representation which spreads an OTLP signal across
multiple tables. These tables are described in the [data_model](./data_model).
Logs, for example, are split into four tables:

1. A primary Logs table that roughly corresponds to an OTLP 
[LogRecord](https://github.com/open-telemetry/opentelemetry-proto/blob/189b2648d29aa6039aeb262c0417ae56572e738d/opentelemetry/proto/logs/v1/logs.proto#L136C1-L137C1)
1. A Log Attributes table that corresponds to the 
[LogRecord attributes](https://github.com/open-telemetry/opentelemetry-proto/blob/189b2648d29aa6039aeb262c0417ae56572e738d/opentelemetry/proto/logs/v1/logs.proto#L177C3-L177C66)
1. A Resource Attributes table that corresponds to the 
[ResourceLogs resource attributes](https://github.com/open-telemetry/opentelemetry-proto/blob/189b2648d29aa6039aeb262c0417ae56572e738d/opentelemetry/proto/logs/v1/logs.proto#L53C3-L53C57)
1. A Scope Attributes table that corresponds to the 
[ScopeLogs scope attributes](https://github.com/open-telemetry/opentelemetry-proto/blob/189b2648d29aa6039aeb262c0417ae56572e738d/opentelemetry/proto/logs/v1/logs.proto#L72C3-L72C59)

The primary Logs table has foreign keys to each of the other three tables that
allows them to be joined together to reconstruct a complete Logs signal. Metrics
and Traces are similarly represented, though with more tables.

OTAP, like OTLP, uses protobuf as the message payload. One of each table that
makes up a complete dataset are grouped together and sent in a  _batch_ via a 
[BatchArrowRecords](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L66C1-L76C1) 
construct. The payloads within these batches each contains a table that is formatted as an 
[Apache Arrow IPC message](https://arrow.apache.org/docs/format/Columnar.html#serialization-and-interprocess-communication-ipc). 
This will be described in more detail in further sections.

One last thing to note is that the protocol is stateful.

<!-- However, unlike OTLP, the protobuf messages are just an envelope containing -->
<!-- protocol level metadata. This makes the protobuf definition compact enough to  -->
<!-- easily fit in a single [couple hundred line file](https://github.com/open-telemetry/otel-arrow/blob/main/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto). -->
<!---->
<!-- Clients send a series of [BatchArrowRecords](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L66C1-L76C1) to a server. These batches contain one or  -->
<!-- more [ArrowPayloads](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L119C1-L136C2) that carry our _signal_ data within a  -->
<!-- `record` byte array. -->
<!---->
<!-- This `record` contains one or more [Encapsulated Arrow IPC](https://arrow.apache.org/docs/format/Columnar.html#encapsulated-message-format) `messages`. -->
<!---->
<!---->
<!---->
<!-- The OTLP represents _signals_ in a hierarchical schema. For example  -->
<!---->
<!-- Where OTLP chooses a [protobuf](https://github.com/open-telemetry/opentelemetry-proto) -->
<!-- representation to serialize its payloads -->
<!---->


