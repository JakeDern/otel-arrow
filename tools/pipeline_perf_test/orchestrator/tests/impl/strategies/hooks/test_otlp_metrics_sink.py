from unittest.mock import MagicMock

import duckdb
import grpc
import pandas as pd
from opentelemetry.proto.collector.metrics.v1 import (
    metrics_service_pb2,
    metrics_service_pb2_grpc,
)
from opentelemetry.proto.common.v1.common_pb2 import (
    AnyValue,
    InstrumentationScope,
    KeyValue,
)
from opentelemetry.proto.metrics.v1 import metrics_pb2
from opentelemetry.proto.resource.v1.resource_pb2 import Resource

from lib.impl.strategies.hooks.otlp_metrics_sink import (
    OTLP_METRICS_SINK_RUNTIME,
    OtlpMetricsSink,
    StartOtlpMetricsSinkConfig,
    StartOtlpMetricsSinkHook,
    StopOtlpMetricsSinkConfig,
    StopOtlpMetricsSinkHook,
    flatten_export_request,
)
from lib.impl.strategies.hooks.reporting.sql_report import (
    QueryConfig,
    SQLReportConfig,
    SQLReportDetails,
    SQLReportHook,
)


def _kv(key, value):
    if isinstance(value, str):
        return KeyValue(key=key, value=AnyValue(string_value=value))
    return KeyValue(key=key, value=AnyValue(int_value=value))


def _delta_request(service, test, scope_name, scope_attrs, name, points):
    """Build an export request with one delta monotonic sum.

    points: list of (start_ns, end_ns, value, attrs_dict)
    """
    data_points = [
        metrics_pb2.NumberDataPoint(
            start_time_unix_nano=start,
            time_unix_nano=end,
            as_int=value,
            attributes=[_kv(k, v) for k, v in attrs.items()],
        )
        for start, end, value, attrs in points
    ]
    return metrics_service_pb2.ExportMetricsServiceRequest(
        resource_metrics=[
            metrics_pb2.ResourceMetrics(
                resource=Resource(
                    attributes=[_kv("service.name", service), _kv("test.name", test)]
                ),
                scope_metrics=[
                    metrics_pb2.ScopeMetrics(
                        scope=InstrumentationScope(
                            name=scope_name,
                            attributes=[_kv(k, v) for k, v in scope_attrs.items()],
                        ),
                        metrics=[
                            metrics_pb2.Metric(
                                name=name,
                                sum=metrics_pb2.Sum(
                                    aggregation_temporality=metrics_pb2.AGGREGATION_TEMPORALITY_DELTA,
                                    is_monotonic=True,
                                    data_points=data_points,
                                ),
                            )
                        ],
                    )
                ],
            )
        ]
    )


# Scenario: An OTLP export request containing a delta monotonic sum with
#   resource, scope, and data point attributes is flattened.
# Guarantees: One row per data point is produced carrying the metric name,
#   scope name, delta temporality, engine-assigned start/end timestamps, the
#   numeric value, and all three attribute levels as plain dicts.
def test_flatten_export_request_delta_sum():
    request = _delta_request(
        "backend-service",
        "T1",
        "node.input",
        {"node.id": "perf"},
        "node.input.items",
        [(1_000, 2_000, 5, {"signal": "logs", "outcome": "success"})],
    )
    received_at = pd.Timestamp.now(tz="UTC")

    rows = flatten_export_request(request, received_at)

    assert len(rows) == 1
    row = rows[0]
    assert row["metric_name"] == "node.input.items"
    assert row["scope_name"] == "node.input"
    assert row["metric_type"] == "sum"
    assert row["temporality"] == "delta"
    assert row["is_monotonic"] is True
    assert row["value"] == 5.0
    assert row["start_time"] == pd.Timestamp(1_000, unit="ns", tz="UTC")
    assert row["time"] == pd.Timestamp(2_000, unit="ns", tz="UTC")
    assert row["received_at"] == received_at
    assert row["resource_attributes"] == {
        "service.name": "backend-service",
        "test.name": "T1",
    }
    assert row["scope_attributes"] == {"node.id": "perf"}
    assert row["metric_attributes"] == {"signal": "logs", "outcome": "success"}


# Scenario: A real OTLP/gRPC client exports several delta batches to a running
#   OtlpMetricsSink bound to an ephemeral port.
# Guarantees: Every data point from every request is retained and the sum of
#   the delta values equals the total exported, which is the property the
#   push-based loss calculation relies on.
def test_sink_receives_grpc_exports_and_preserves_delta_totals():
    sink = OtlpMetricsSink(endpoint="127.0.0.1:0")
    port = sink.start()
    try:
        with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = metrics_service_pb2_grpc.MetricsServiceStub(channel)
            for i in range(3):
                stub.Export(
                    _delta_request(
                        "load-generator",
                        "T1",
                        "receiver.traffic_generator",
                        {"node.id": "receiver"},
                        "logs.produced",
                        [(i * 10, (i + 1) * 10, 100 + i, {})],
                    ),
                    timeout=5,
                )
    finally:
        sink.stop()

    df = sink.to_dataframe()
    assert sink.row_count() == 3
    assert df["value"].sum() == 100 + 101 + 102
    assert set(df["metric_name"]) == {"logs.produced"}


# Scenario: A second sink tries to bind the port of an already running sink
#   (e.g. a stale orchestrator process left running).
# Guarantees: The second bind fails loudly instead of silently sharing the
#   port via SO_REUSEPORT, which would split pushed data between processes
#   and corrupt whole-run totals.
def test_sink_refuses_to_share_port():
    first = OtlpMetricsSink(endpoint="127.0.0.1:0")
    port = first.start()
    try:
        second = OtlpMetricsSink(endpoint=f"127.0.0.1:{port}")
        try:
            second.start()
            raised = False
        except RuntimeError:
            raised = True
        finally:
            second.stop()
        assert raised
    finally:
        first.stop()


# Scenario: The start/stop hooks are executed against a suite context.
# Guarantees: The start hook stores a running sink on the suite runtime under
#   OTLP_METRICS_SINK_RUNTIME, a second start is a no-op that keeps the same
#   sink, and the stop hook shuts it down without error.
def test_start_stop_hooks_manage_suite_runtime():
    runtime = {}
    suite = MagicMock()
    suite.get_runtime.side_effect = runtime.get
    suite.set_runtime_data.side_effect = runtime.__setitem__
    ctx = MagicMock()
    ctx.get_suite.return_value = suite

    StartOtlpMetricsSinkHook(
        StartOtlpMetricsSinkConfig(endpoint="127.0.0.1:0")
    ).execute(ctx)
    sink = runtime[OTLP_METRICS_SINK_RUNTIME]
    assert isinstance(sink, OtlpMetricsSink)
    assert sink.port

    StartOtlpMetricsSinkHook(
        StartOtlpMetricsSinkConfig(endpoint="127.0.0.1:0")
    ).execute(ctx)
    assert runtime[OTLP_METRICS_SINK_RUNTIME] is sink

    StopOtlpMetricsSinkHook(StopOtlpMetricsSinkConfig()).execute(ctx)
    assert sink._server is None


# Scenario: sql_report registers the pushed metrics table both when a sink with
#   data exists and when no sink was started for the suite.
# Guarantees: A 'pushed_metrics' table is always queryable; attribute dicts are
#   flattened into '<level>_attributes.<key>' columns so report SQL can filter
#   by service.name / test.name / node.id; with no sink the table is empty.
def test_sql_report_registers_pushed_metrics_table():
    sink = OtlpMetricsSink(endpoint="127.0.0.1:0")
    sink.ingest(
        _delta_request(
            "backend-service",
            "T1",
            "node.input",
            {"node.id": "perf"},
            "node.input.items",
            [(1, 2, 7, {"signal": "logs"}), (2, 3, 8, {"signal": "logs"})],
        )
    )
    hook = SQLReportHook(
        SQLReportConfig(
            name="t",
            report_config=SQLReportDetails(
                queries=[QueryConfig(name="q", sql="SELECT 1")]
            ),
        )
    )

    def ctx_with(s):
        suite = MagicMock()
        suite.get_runtime.side_effect = lambda ns: (
            s if ns == OTLP_METRICS_SINK_RUNTIME else None
        )
        ctx = MagicMock()
        ctx.get_suite.return_value = suite
        return ctx

    hook.conn = duckdb.connect()
    hook._register_pushed_metrics_table(ctx_with(sink))
    total = hook.conn.execute(
        """
        SELECT SUM(value) FROM pushed_metrics
        WHERE "resource_attributes.service.name" = 'backend-service'
          AND "resource_attributes.test.name" = 'T1'
          AND "scope_attributes.node.id" = 'perf'
          AND "metric_attributes.signal" = 'logs'
        """
    ).fetchone()[0]
    assert total == 15

    hook.conn = duckdb.connect()
    hook._register_pushed_metrics_table(ctx_with(None))
    assert hook.conn.execute("SELECT COUNT(*) FROM pushed_metrics").fetchone()[0] == 0
