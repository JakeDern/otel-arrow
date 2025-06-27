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
Arrow in detail. For that information, the following may be helpful:

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
concerned with the transport of the Logs, Metrics, and Traces _signals_
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

This is how we will think of Logs, Metrics, and Traces for the remainder of this
document.

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

> Note: If any of the tables are empty, for example if there are no Scope
Attributes set, the ArrowPayload for that table can be omitted.

As the name suggests, within each ArrowPayload is some Arrow data - A serialized 
[Encapsulated Arrow IPC Messages](https://arrow.apache.org/docs/format/Columnar.html#encapsulated-message-format)
 located in the [bytes field](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L135).
This is where the table data resides. Which table is represented by each Arrow Payload
is indicated by the 
[ArrowPayloadType](https://github.com/open-telemetry/otel-arrow/blob/5b0da3dab952ad7e8196ffab00d59b27655fce76/proto/opentelemetry/proto/experimental/arrow/v1/arrow_service.proto#L79C1-L80C1).

> Note: There may be more than one Encapsulated Arrow IPC message within the 
`bytes` of an Arrow Payload. More details below!

## Apache Arrow Primer

OTAP is a sort of "protocol on top of a protocol". The inner protocol here is
Apache Arrow Interprocess communication (Arrow IPC).

Before getting into the gritty details we omitted before, there are some key
aspects of Apache Arrow to be aware of that we'll discuss in this section.

Arrow is a deep topic in itself, you can refer to the [full manual](https://arrow.apache.org/docs/format/Intro.html)
on Apache Arrow for more details.

### Basics

Apache Arrow offers a language agnostic way to represent data such that it can
be shared between different systems without copying. Languages receive a byte
array that contains data formatted according to some Schema and rather than 
deserializing to a language specific struct/object equivalent type, the data can 
be read and operated on in-place.

Something different about the way that Arrow represents data compared to a 
typical struct or object is that the data is in a columnar format. This type
of format groups all of the values for a particular column in memory next to each 
other. [This article](https://arrow.apache.org/blog/2023/04/11/our-journey-at-f5-with-apache-arrow-part-1/)
from F5 has a great diagram comparing row and columnar data.

Typically data laid out in this way is beneficial for compression and also for
operation with SIMD instruction sets.

### Schemas and Encodings

In order for one machine to do anything interesting with those Arrow byte arrays 
coming from another machine, they need to know the Schema of that data. The Schema
defines the fields of the data, their types, and the order in which they appear.
This is strictly defined within Arrow such that there is enough information in
the Schema to process any row or column within the byte array.

One of the key features of Arrow is that the same data can be encoded in 
different ways to optimize its size. For example, a column could be _dictionary_
encoded. In a dictionary encoding, instead of writing out every value we can write
an integer key that is used to look up the value in a seprate dictionary. This 
can be highly effective in data that has lots of repeated values e.g. a column 
whose values come from an enum.

The thing to highlight is such a column _could_ be encoded as a dictionary,
it doesn't _have_ to be encoded that way. And furthermore there can be different
dictionary encodings for the same data. You can imagine some data with lower
cardinality can make use of 8-bit integer keys, while some data with higher
cardinality might need 16-bit integer keys to avoid overflow. There are multiple
valid encodings for the same data and which to use is highly dependent on the 
characteristics of the data being transported. 
[This article](https://arrow.apache.org/blog/2023/04/11/our-journey-at-f5-with-apache-arrow-part-1/)
 from F5 has more details on considerations for picking an encoding.

Because Telemetry data varies wildly between domains, it's impossible to pick
a single encoding that will be near optimal for the entire world. OTAP provides
the flexibility required to find and use the near optimal encoding for 
_any_ system. Once again, more on that later 🙂.

### Interprocess Communication (IPC)

Unlike with protobuf, another advantage of the Arrow format is that clients and 
servers do not have to be aware ahead of time of the schema of the data being 
transmitted. How these schemas are negotiated (and updated) for the lifetime of 
the connection is defined via the [Apache Arrow IPC Streaming format](https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format).

This format, is modeled as a one way stream of messages from Client to Server.
The types of messages that Clients can send and the order in which they are 
allowed to send them ensure that the Server has the information it needs to process 
the data. There are three kinds of so called 
[Encapsulated Messages](https://arrow.apache.org/docs/format/Columnar.html#encapsulated-message-format)
that can appear in this stream:

- Schema - Contains the schema of the messages that will follow
- Record Batch - Contains a shard of data (e.g. 100 rows) that follow the Schema
- Dictionary Batch - Contains dictionaries that can be used to interpret data
passed in the Record Batch

These messages must come in a particular order, the rules are:

- Schema must come first and only once
- Dictionary Batches are optional, but if dictionaries are used then they must
be transmitted before any Record Batches that need them are transmitted.
- Record Batches can come as needed and be interleaved with Dictionary Batches

Why are dictionaries not a part of the schema, and why can we interleave them
with Record Batches? Efficiency.

Once a dictionary encoding for some column is agreed upon, the server can simply
remember that dictionary and the client never has to send it again. That means
a string column containing what could be many bytes of data can be completely 
reduced to a column of (potentially very small) integers from that point on, 
yielding massive savings on network bandwidth.

In some cases, a Client will not know the full set of values that a column can
have at the outset. You can imagine a scraper that is collecting Kubernetes pod
logs and passes along the name of the pod as a resource attribute. Suppose a
dictionary encoding was chosen because the cardinality of these pod names is 
relatively small.

When new pods come online, we don't have entries for them in the dictionary. We
could re-create our connection to the server and re-transmit the full schema and
dictionary with the new set of values, but this is wasteful and could happen
quite often. Instead we can communicate to the server that there are some new 
values for it to be aware of. These arrive in new Dictionary Batches that contain 
so called _Delta Dictionaries_ with just the new entries to be aware of.

### Summary 

Apache Arrow allows systems to communicate structured data without knowing schemas
ahead of time. It allows for efficient encoding of that data via dictionaries
which can be updated on the fly as needed. The
[Apache Arrow IPC Streaming format](https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format)
defines the mechanics of how this process works including the types of messages
that can be sent and the order that they must appear. This is inherently a
stateful process, and persistent connections are used to transmit many batches
of data between a client and a server efficiently.

## OTAP Clients 

This section is going to walk through a client request end to end 

## OTAP Servers

