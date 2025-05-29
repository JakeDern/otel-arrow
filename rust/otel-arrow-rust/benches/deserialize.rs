//! This crate benchmarks deserialization

use divan::{Bencher, black_box_drop};
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
use prost::Message;

fn main() {
    divan::main();
}

/// Benches
#[divan::bench]
fn decode_logs(b: Bencher) {
    b.bench(|| {
        let logs = create_logs_data();
        let mut buf = vec![];
        logs.encode(&mut buf).unwrap();
        black_box_drop(buf);
        let arrow_records = BatchArrowRecords::decode(&buf).unwrap();
    });
}

fn create_bar() -> BatchArrowRecords {
    let logs_data = create_logs_data();

    let payloads = vec![ArrowPayload {
        schema_id: "todo".into(),
        r#type: ArrowPayloadType::Logs,
        record: logs_data.encode_to_vec(),
    }];

    let bar = BatchArrowRecords {
        batch_id: 1,
        arrow_payloads: vec![],
        headers: vec![],
    };
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
