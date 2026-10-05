# Push-based benchmark metrics

The dataflow-engine (dfengine) benchmarks collect loss and throughput from
metrics the engine **pushes** over OTLP, rather than by scraping its Prometheus
admin endpoint. This removes the measurement artifacts that scraping produced
(see issue #2731): negative data loss and throughput quantized to the 1s scrape
cadence.

## Why push

- **Exact whole-run totals.** The engine performs a final metric flush after all
  pipelines drain during graceful shutdown. Summing pushed delta counters over
  the whole test therefore includes the last partial interval, so sent and
  received cover the same set of batches. Loss can no longer go negative from
  timing skew.
- **Engine-assigned timestamps.** Each pushed point carries the engine's own
  interval start/end, so throughput is computed from the engine's clock instead
  of the observer's scrape times.
- **No lost final values.** The admin endpoint becomes unavailable as the engine
  shuts down, so a final settled value cannot be scraped. Push delivers it.

## How it works

1. Each dfengine component (load generator, engine under test, backend) runs an
   `engine.observability.pipeline` that routes `receiver:internal_telemetry`
   metrics to an `exporter:otlp_grpc`. It also sets `engine.telemetry.resource`
   with `service.name` (`load-generator` / `df-engine` / `backend-service`) and
   `test.name` so each pushed point is attributable per component and per test.
   This block is added by the shared partial
   `test_suites/integration/templates/configs/common/push_metrics_engine.yaml.j2`
   and is opt-in via the `push_metrics_endpoint` template variable.
2. The orchestrator runs an embedded OTLP/gRPC receiver for the duration of the
   suite (the `start_otlp_metrics_sink` / `stop_otlp_metrics_sink` suite hooks).
   Containers reach it on the docker host via
   `extra_hosts: {host.docker.internal: host-gateway}`.
3. `sql_report` appends the received points onto the same in-memory `metrics`
   table it builds for every run, keeping the engine's native OTLP metric names
   and attributes. A run uses one collection method, so the table is homogeneous.
4. The `*_push` report configs compute loss from whole-run pushed totals (scoped
   by `resource_attributes.test.name`) and throughput from the pushed deltas
   whose interval ends inside the observation window. Container CPU / memory /
   network still come from the docker monitor and are unchanged.

## What still scrapes

Prometheus scraping (`monitoring/prometheus.py`) is retained for the suites that
cannot push dfengine internal metrics:

- **syslog** suites, which use the Python load generator (no dfengine loadgen);
- the **otel-collector** SUT suites (the collector does not speak the dfengine
  internal-telemetry push);
- the **ClickHouse** suites, whose received count comes from ClickHouse row
  queries rather than a perf exporter;
- the **idle-state** suites, which only observe engine self-metrics.

These keep using the scrape report `integration_report_logs_scrape.yaml` (and the
clickhouse / otelcol-clickhouse reports).

## Known caveat

Small positive loss on OTAP paths reflects a real engine bug: the OTAP exporter
drops batches still queued or in flight when it shuts down (issue #3870). This is
genuine data loss that scraping's +/-5% noise previously masked; it is out of
scope for the benchmark harness.
