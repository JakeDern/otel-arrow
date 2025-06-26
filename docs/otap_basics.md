# Open Telemetry Arrow Protocol (OTAP) Introduction

This document is meant to be an introduction to the Open Telemetry Arrow 
Protocol (OTAP). It is not a full technical specification, but enumerates the
major requirements of clients and servers communicating over OTAP along with some
mechanical details that are not completely obvious. If you are inexperienced 
with the OTAP and looking to familiarize yourself with the major components 
and mechanisms, then this is a good place to start.

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

### Data model

Like its predecessor [OTLP](https://opentelemetry.io/docs/specs/otlp/), OTAP is
concerned with the transport of Logs, Metrics, and Traces _signals_
that we know and love over the wire from a Client to a Server. The semantic 
model and meaning of these signals is independent of the format of the data, 
and OTAP makes a few different choices from OTLP with respect to how it is 
is represented.

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

### Transport

To transmit this data model, OTAP is defined in terms of a 
[gRPC service](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L49C1-L63C1).
Clients establish a persistent, stateful connection to a server and send a stream
of [BatchArrowRecords](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L66C1-L76C1).
The stateful nature of this communication will be described in more details in
later sections.

Each `BatchArrowRecords` contains a complete set of telemetry data for one 
particular signal in the form of multiple [ArrowPayloads](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L66C1-L76C1)s.
For exmaple a batch of logs would contain four payloads representing the four tables
of Logs, Log Attributes, Resource Attributes, and Scope Attributes.

> Note: If any of the tables are empty i.e. in the case there are no Scope
Attributes set, the ArrowPayload for that table can be omitted.

As the name suggests, within each ArrowPayload is a serialized 
[Encapsulated Arrow IPC](https://arrow.apache.org/docs/format/Columnar.html#encapsulated-message-format)
 located in the [bytes field](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L135).
This is where the table data resides. Which table is represented by each Arrow Payload
is indicated by the 
[ArrowPayloadType](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L79C1-L80C1).

> Note: There may be more than one Encapsulated Arrow IPC message within the 
`bytes` of an Arrow Payload. More details below!

## Apache Arrow Primer

Before getting into the gritty details we omitted before, there are some key
aspects of Apache Arrow to be aware of.

Apache Arrow offers a language agnostic way to represent data such that it can
be shared between different systems without copying. The data is represented
in a columnar format which groups all of the values for a particular column in
memory next to each other. [This article](https://arrow.apache.org/blog/2023/04/11/our-journey-at-f5-with-apache-arrow-part-1/)
from F5 has a great diagram comparing row and columnar data.

One of the key features of Arrow is that the same columnar data can be encoded 
in different ways to optimize its size. For example, a column could be _dictionary_
encoded. In a dictionary encoding, instead of writing out every value we can write
an integer key that is used to look up the value in a dictionary. This can be
highly effective in data that has lots of repeated values i.e. a column that
represents an enum.

The thing to highlight is such a column _could_ be encoded as a dictionary,
it doesn't _have_ to be encoded that way. And furthermore there can be different
dictionary encodings for the same data. You can imagine some data with lower
cardinality can make use of 8-bit integer keys, while some data with higher
cardinality might need 16-bit integer keys to avoid overflow. There are multipl 
valid encodings for the same data and which to use is highly dependent on the 
characteristics of the data being transported. 
[This article](https://arrow.apache.org/blog/2023/04/11/our-journey-at-f5-with-apache-arrow-part-1/)
 from F5 has more details on considerations for picking an encoding.

Because Telemetry data varies wildly between domains, it's impossible to pick
a near optimal encoding that will work for the entire world. OTAP aims to provide 
the flexibility required to find and use the near optimal encoding for _any_ 
system.

## OTAP 
