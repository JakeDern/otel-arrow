// TEMPORARY: compression investigation, do not commit.
#![cfg(test)]

use super::compression_ratio_tests::load_semconv_registry;
use super::semconv_signal::{semconv_otlp_logs, semconv_otlp_metrics, semconv_otlp_traces};
use otel_arrow_dfe_pdata::OtlpProtoBytes;
use otel_arrow_dfe_pdata::otap::OtapArrowRecords;
use otel_arrow_dfe_pdata::proto::opentelemetry::collector::logs::v1::ExportLogsServiceRequest;
use otel_arrow_dfe_pdata::proto::opentelemetry::collector::metrics::v1::ExportMetricsServiceRequest;
use otel_arrow_dfe_pdata::proto::opentelemetry::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;

const N: usize = 10;
const BATCH: usize = 1000;

/// Dumps DFE-encoded payloads and checks they decode to the same message as
/// the prost (canonical) encoding, i.e. reordering is semantically lossless.
#[test]
#[ignore]
fn dump_payloads() {
    let out = std::env::var("DUMP_DIR").expect("DUMP_DIR");
    let tag = std::env::var("DUMP_TAG").unwrap_or_else(|_| "dfe".into());
    let registry = load_semconv_registry();
    for i in 0..N {
        for sig in ["logs", "traces", "metrics"] {
            // REUSE=1 reads previously dumped prost inputs so encoder variants see identical bytes.
            let prost_path = format!("{out}/{sig}_prost_{i}.pb");
            let prost_bytes: prost::bytes::Bytes = if std::env::var("REUSE").is_ok() {
                std::fs::read(&prost_path).unwrap().into()
            } else {
                let b = match sig {
                    "logs" => semconv_otlp_logs(BATCH, &registry).encode_to_vec(),
                    "traces" => semconv_otlp_traces(BATCH, &registry).encode_to_vec(),
                    _ => semconv_otlp_metrics(BATCH, &registry).encode_to_vec(),
                };
                std::fs::write(&prost_path, &b).unwrap();
                b.into()
            };
            let prost_otlp = match sig {
                "logs" => OtlpProtoBytes::ExportLogsRequest(prost_bytes.clone()),
                "traces" => OtlpProtoBytes::ExportTracesRequest(prost_bytes.clone()),
                _ => OtlpProtoBytes::ExportMetricsRequest(prost_bytes.clone()),
            };
            // Force the engine re-encode path: OTLP bytes -> OTAP records -> OTLP bytes.
            let records: OtapArrowRecords =
                otel_arrow_dfe_pdata::TryIntoWithOptions::try_into_with_default(prost_otlp)
                    .expect("to otap");
            let otlp: OtlpProtoBytes =
                otel_arrow_dfe_pdata::TryIntoWithOptions::try_into_with_default(records)
                    .expect("to otlp");
            let (dfe, canonical) = match otlp {
                OtlpProtoBytes::ExportLogsRequest(b) => {
                    let p = ExportLogsServiceRequest::decode(b.as_ref()).unwrap().encode_to_vec();
                    (b, p)
                }
                OtlpProtoBytes::ExportTracesRequest(b) => {
                    let p = ExportTraceServiceRequest::decode(b.as_ref()).unwrap().encode_to_vec();
                    (b, p)
                }
                OtlpProtoBytes::ExportMetricsRequest(b) => {
                    let p = ExportMetricsServiceRequest::decode(b.as_ref()).unwrap().encode_to_vec();
                    (b, p)
                }
            };
            
            std::fs::write(format!("{out}/{sig}_{tag}_{i}.pb"), &dfe).unwrap();
            println!("{sig} {i}: {tag}={} canonical(decode+prost)={} prost_orig={} identical_to_canonical={}", dfe.len(), canonical.len(), prost_bytes.len(), dfe.as_ref() == canonical.as_slice());
        }
    }
}
