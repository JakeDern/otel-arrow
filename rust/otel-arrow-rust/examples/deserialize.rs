//! Deserialize example
use std::io::Read;

use arrow::array::{
    Array, AsArray, Int16DictionaryArray, Int32Array, PrimitiveArray, RecordBatch,
    UInt16DictionaryArray, downcast_array,
};
use arrow::datatypes::{Int16Type, Int32Type, Int64Type};
use otel_arrow_rust::Consumer;
use otel_arrow_rust::otap::{Logs, OtapBatch, from_record_messages};
use otel_arrow_rust::proto::opentelemetry::arrow::v1::{
    ArrowPayload, ArrowPayloadType, BatchArrowRecords,
};
use otel_arrow_rust::proto::opentelemetry::collector::logs::v1::ExportLogsServiceRequest;
use otel_arrow_rust::proto::opentelemetry::common::v1::*;
use otel_arrow_rust::proto::opentelemetry::common::v1::{AnyValue, InstrumentationScope};
use otel_arrow_rust::proto::opentelemetry::logs::v1::*;
use otel_arrow_rust::proto::opentelemetry::logs::v1::{
    LogRecord, LogRecordFlags, LogsData, ResourceLogs, ScopeLogs, SeverityNumber,
};
use otel_arrow_rust::proto::opentelemetry::resource::v1::Resource;
use prost::bytes::Bytes;
use prost::{Message, bytes};

fn main() {
    let mut bar = create_bar();
    let mut consumer = Consumer::default();
    let messages = consumer.consume_bar(&mut bar).expect("Failed to consume");
    let otap_batch = OtapBatch::Logs(from_record_messages(messages));
    // for batch in otap_batch.get(ArrowPayloadType::Logs) {
    //     println!("Log rows: {}", batch.num_rows());
    //
    //     for field in batch.schema().fields() {
    //         println!("Field: {}", field.name());
    //     }
    //
    //     println!("{:?}", batch.schema());
    //     for column in batch.columns() {
    //         println!("Column type: {:?}", column.data_type().to_string())
    //     }
    // }

    for batch in otap_batch.get(ArrowPayloadType::LogAttrs) {
        println!("Attr rows: {}", batch.num_rows());

        for field in batch.schema().fields() {
            println!("Field: {}", field.name());
        }

        for column in batch.columns() {
            println!("Column type: {:?}", column.data_type().to_string())
        }
    }

    let attrs = otap_batch
        .get(ArrowPayloadType::LogAttrs)
        .expect("No attributes in record batch");
    let int_attrs = attrs.column_by_name("int").expect("No int attrs");
    println!("int col datatype: {}", int_attrs.data_type());
    let int_attrs = int_attrs
        .as_any()
        .downcast_ref::<UInt16DictionaryArray>()
        .expect("Failed to cast attrs");

    // let keys = int_attrs.keys();
    let values = int_attrs
        .values()
        .as_primitive_opt::<Int64Type>()
        .expect("Failed to cast");
    for key in int_attrs.keys() {
        if let Some(k) = key {
            println!("Key: {}", k);
            println!("Value: {}", values.value(k as usize))
        }
    }
}

fn create_bar() -> BatchArrowRecords {
    let path = std::env::var("FILE_PATH").expect("FILE_PATH must be set");
    let metadata = std::fs::metadata(&path).expect("Failed to get file metadata");
    let size = metadata.len();
    let mut reader = std::fs::File::open(path).expect("Failed to open file");
    let mut buf = vec![];
    let _ = reader.read_to_end(&mut buf).expect("Failed to read file");
    let buf = Bytes::from(buf);
    BatchArrowRecords::decode(buf).expect("Failed to decode records")
}
