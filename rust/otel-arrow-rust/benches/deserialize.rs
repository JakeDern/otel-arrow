//! This crate benchmarks deserialization

use std::io::Read;

use divan::{Bencher, black_box_drop};
use otel_arrow_rust::Consumer;
use otel_arrow_rust::otap::{OtapBatch, from_record_messages};
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
use prost::{Message, bytes};

fn main() {
    divan::main();
}

/// Benches
#[divan::bench]
fn decode_logs(b: Bencher) {
    b.bench(|| {
        let mut bar = create_bar();
        let mut consumer = Consumer::default();
        let messages = consumer.consume_bar(&mut bar).expect("Failed to consume");
        let otap_batch = OtapBatch::Logs(from_record_messages(messages));
    });
}

fn create_bar() -> BatchArrowRecords {
    let path = std::env::var("FILE_PATH").expect("FILE_PATH must be set");
    let metadata = std::fs::metadata(&path).expect("Failed to get file metadata");
    let size = metadata.len();
    let mut reader = std::fs::File::open(path).expect("Failed to open file");
    let mut buf = vec![];
    let _ = reader.read_to_end(&mut buf).expect("Failed to read file");
    let buf = bytes::Bytes::from(buf);
    BatchArrowRecords::decode(buf).expect("Failed to decode records")
}

fn create_logs_data() -> LogsData {
    let kvs = vec![
        KeyValue::new("k1", AnyValue::new_string("v1")),
        KeyValue::new("k2", AnyValue::new_string("v2")),
    ];
    let res = Resource::new(kvs.clone());

    let is1 = InstrumentationScope::new("library");

    let lr1 = LogRecord::build(2_000_000_000u64, SeverityNumber::Info, "event1")
        .attributes(kvs.clone())
        .finish();
    let lr2 = LogRecord::build(3_000_000_000u64, SeverityNumber::Info2, "event2")
        .attributes(kvs.clone())
        .body(AnyValue::new_string("message text"))
        .severity_text("not on fire")
        .flags(LogRecordFlags::TraceFlagsMask)
        .finish();
    let lr3 = LogRecord::build(3_000_000_000u64, SeverityNumber::Info2, "event3")
        .attributes(kvs.clone())
        .body(AnyValue::new_string("here we go to 2us"))
        .flags(LogRecordFlags::TraceFlagsMask)
        .finish();
    let lrs = vec![lr1, lr2, lr3];

    let sl1 = ScopeLogs::build(is1.clone())
        .log_records(lrs.clone())
        .schema_url("http://schema.opentelemetry.io")
        .finish();
    let sl2 = sl1.clone();
    let sls = vec![sl1, sl2];

    LogsData::new(vec![ResourceLogs::build(res).scope_logs(sls).finish()])
}
