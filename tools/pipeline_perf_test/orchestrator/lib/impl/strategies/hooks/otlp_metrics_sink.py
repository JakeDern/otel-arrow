"""
Embedded OTLP/gRPC metrics sink for engine-pushed telemetry.

Components under test (e.g. the dataflow engine) can push their internal
metrics over OTLP instead of being scraped. This module provides:

- 'OtlpMetricsSink': A small gRPC server implementing the OTLP
  MetricsService. Each received data point is flattened into a row and kept
  in memory for later querying (e.g. by 'sql_report').
- 'StartOtlpMetricsSinkHook' ('start_otlp_metrics_sink'): Starts a sink and
  stores it on the suite runtime. Intended for suite-level 'run.pre' hooks.
- 'StopOtlpMetricsSinkHook' ('stop_otlp_metrics_sink'): Stops the sink.
  Intended for suite-level 'run.post' hooks.

Why push instead of scrape:
    Scraped counters are sampled at times chosen by the observer, so sent and
    received counters from different processes are never sampled over the same
    span, and the final values are lost once the engine shuts down. Pushed
    metrics carry engine-assigned timestamps and the engine performs a final
    flush during graceful shutdown, so summing pushed deltas yields exact
    whole-run totals.

Row schema (see 'PUSHED_METRIC_COLUMNS'):
    received_at       - pd.Timestamp (UTC) when the sink received the request
    start_time        - pd.Timestamp (UTC) data point start_time_unix_nano (NaT if 0)
    time              - pd.Timestamp (UTC) data point time_unix_nano
    metric_name       - OTLP metric name (e.g. 'node.input.items')
    metric_type       - 'sum' | 'gauge' | 'histogram' | 'exponential_histogram' | 'summary'
    temporality       - 'delta' | 'cumulative' | None
    is_monotonic      - bool | None
    value             - float (sum/gauge value; histogram/summary sum)
    count             - float | None (histogram/summary count)
    scope_name        - instrumentation scope name (e.g. 'node.input')
    resource_attributes, scope_attributes, metric_attributes - dicts
"""

import threading
from concurrent import futures
from typing import Any, Dict, List, Optional

import grpc
import pandas as pd
from opentelemetry.proto.collector.metrics.v1 import (
    metrics_service_pb2,
    metrics_service_pb2_grpc,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.metrics.v1 import metrics_pb2

from ....core.context.base import BaseContext
from ....core.context import FrameworkElementHookContext
from ....core.strategies.hook_strategy import HookStrategy, HookStrategyConfig
from ....runner.registry import hook_registry, PluginMeta

START_HOOK_NAME = "start_otlp_metrics_sink"
STOP_HOOK_NAME = "stop_otlp_metrics_sink"

# Namespace used to store the sink on the suite runtime.
OTLP_METRICS_SINK_RUNTIME = "otlp_metrics_sink"

PUSHED_METRIC_COLUMNS = [
    "received_at",
    "start_time",
    "time",
    "metric_name",
    "metric_type",
    "temporality",
    "is_monotonic",
    "value",
    "count",
    "scope_name",
    "resource_attributes",
    "scope_attributes",
    "metric_attributes",
]

_TEMPORALITY = {
    metrics_pb2.AGGREGATION_TEMPORALITY_DELTA: "delta",
    metrics_pb2.AGGREGATION_TEMPORALITY_CUMULATIVE: "cumulative",
}


def any_value_to_python(value: AnyValue) -> Any:
    """Convert an OTLP AnyValue into a plain python value."""
    kind = value.WhichOneof("value")
    if kind is None:
        return None
    if kind == "array_value":
        return [any_value_to_python(v) for v in value.array_value.values]
    if kind == "kvlist_value":
        return attributes_to_dict(value.kvlist_value.values)
    return getattr(value, kind)


def attributes_to_dict(attributes: List[KeyValue]) -> Dict[str, Any]:
    """Convert a repeated OTLP KeyValue field into a dict."""
    return {kv.key: any_value_to_python(kv.value) for kv in attributes}


def _ts(nanos: int) -> Optional[pd.Timestamp]:
    if not nanos:
        return None
    return pd.Timestamp(nanos, unit="ns", tz="UTC")


def flatten_export_request(
    request: metrics_service_pb2.ExportMetricsServiceRequest,
    received_at: pd.Timestamp,
) -> List[Dict[str, Any]]:
    """Flatten an OTLP metrics export request into one row per data point."""
    rows: List[Dict[str, Any]] = []
    for resource_metrics in request.resource_metrics:
        resource_attrs = attributes_to_dict(resource_metrics.resource.attributes)
        for scope_metrics in resource_metrics.scope_metrics:
            scope = scope_metrics.scope
            scope_attrs = attributes_to_dict(scope.attributes)
            for metric in scope_metrics.metrics:
                base = {
                    "received_at": received_at,
                    "metric_name": metric.name,
                    "scope_name": scope.name,
                    "resource_attributes": resource_attrs,
                    "scope_attributes": scope_attrs,
                }
                data_kind = metric.WhichOneof("data")
                if data_kind == "sum":
                    data = metric.sum
                    for dp in data.data_points:
                        rows.append(
                            {
                                **base,
                                "metric_type": "sum",
                                "temporality": _TEMPORALITY.get(
                                    data.aggregation_temporality
                                ),
                                "is_monotonic": data.is_monotonic,
                                **_number_point(dp),
                            }
                        )
                elif data_kind == "gauge":
                    for dp in metric.gauge.data_points:
                        rows.append(
                            {
                                **base,
                                "metric_type": "gauge",
                                "temporality": None,
                                "is_monotonic": None,
                                **_number_point(dp),
                            }
                        )
                elif data_kind in ("histogram", "exponential_histogram"):
                    data = getattr(metric, data_kind)
                    for dp in data.data_points:
                        rows.append(
                            {
                                **base,
                                "metric_type": data_kind,
                                "temporality": _TEMPORALITY.get(
                                    data.aggregation_temporality
                                ),
                                "is_monotonic": None,
                                **_distribution_point(dp),
                            }
                        )
                elif data_kind == "summary":
                    for dp in metric.summary.data_points:
                        rows.append(
                            {
                                **base,
                                "metric_type": "summary",
                                "temporality": None,
                                "is_monotonic": None,
                                **_distribution_point(dp),
                            }
                        )
    return rows


def _number_point(dp: metrics_pb2.NumberDataPoint) -> Dict[str, Any]:
    kind = dp.WhichOneof("value")
    value = float(getattr(dp, kind)) if kind else None
    return {
        "start_time": _ts(dp.start_time_unix_nano),
        "time": _ts(dp.time_unix_nano),
        "value": value,
        "count": None,
        "metric_attributes": attributes_to_dict(dp.attributes),
    }


def _distribution_point(dp) -> Dict[str, Any]:
    return {
        "start_time": _ts(dp.start_time_unix_nano),
        "time": _ts(dp.time_unix_nano),
        "value": float(dp.sum),
        "count": float(dp.count),
        "metric_attributes": attributes_to_dict(dp.attributes),
    }


class _MetricsServicer(metrics_service_pb2_grpc.MetricsServiceServicer):
    def __init__(self, sink: "OtlpMetricsSink"):
        self._sink = sink

    def Export(self, request, context):  # noqa: N802 (grpc naming)
        self._sink.ingest(request)
        return metrics_service_pb2.ExportMetricsServiceResponse()


class OtlpMetricsSink:
    """In-memory OTLP/gRPC metrics receiver."""

    def __init__(self, endpoint: str = "0.0.0.0:14317", max_workers: int = 4):
        self.endpoint = endpoint
        self._max_workers = max_workers
        self._rows: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._server: Optional[grpc.Server] = None
        self.port: Optional[int] = None

    def start(self) -> int:
        """Start serving. Returns the bound port."""
        if self._server is not None:
            return self.port
        server = grpc.server(
            futures.ThreadPoolExecutor(max_workers=self._max_workers),
            options=[
                ("grpc.max_receive_message_length", 64 * 1024 * 1024),
                # grpcio enables SO_REUSEPORT by default, which would let a
                # second sink (e.g. a stale orchestrator) silently share the
                # port and split the pushed data. Fail to bind instead.
                ("grpc.so_reuseport", 0),
            ],
        )
        metrics_service_pb2_grpc.add_MetricsServiceServicer_to_server(
            _MetricsServicer(self), server
        )
        try:
            port = server.add_insecure_port(self.endpoint)
        except RuntimeError as e:
            raise RuntimeError(
                f"Failed to bind OTLP metrics sink to {self.endpoint}: {e}"
            ) from e
        if port == 0:
            raise RuntimeError(f"Failed to bind OTLP metrics sink to {self.endpoint}")
        server.start()
        self._server = server
        self.port = port
        return port

    def stop(self, grace: float = 2.0) -> None:
        """Stop serving, waiting up to 'grace' seconds for in-flight requests."""
        if self._server is None:
            return
        self._server.stop(grace).wait()
        self._server = None

    def ingest(self, request: metrics_service_pb2.ExportMetricsServiceRequest):
        """Flatten and store an export request."""
        rows = flatten_export_request(request, pd.Timestamp.now(tz="UTC"))
        with self._lock:
            self._rows.extend(rows)

    def row_count(self) -> int:
        with self._lock:
            return len(self._rows)

    def to_dataframe(self) -> pd.DataFrame:
        """Return a snapshot of all received data points."""
        with self._lock:
            rows = list(self._rows)
        return pd.DataFrame(rows, columns=PUSHED_METRIC_COLUMNS)


def get_otlp_metrics_sink(ctx: BaseContext) -> Optional[OtlpMetricsSink]:
    """Return the suite's OTLP metrics sink if one was started."""
    suite = ctx.get_suite()
    if suite is None:
        return None
    return suite.get_runtime(OTLP_METRICS_SINK_RUNTIME)


@hook_registry.register_config(START_HOOK_NAME)
class StartOtlpMetricsSinkConfig(HookStrategyConfig):
    """
    Configuration for the 'start_otlp_metrics_sink' hook.

    Attributes:
        endpoint: host:port to bind the OTLP/gRPC server to. Containers on a
            docker bridge network can reach it via 'host.docker.internal' when
            the container is started with
            'extra_hosts: {host.docker.internal: host-gateway}'.
    """

    endpoint: str = "0.0.0.0:14317"


@hook_registry.register_class(START_HOOK_NAME)
class StartOtlpMetricsSinkHook(HookStrategy):
    """Start an embedded OTLP/gRPC metrics sink and attach it to the suite."""

    PLUGIN_META = PluginMeta(
        supported_contexts=[FrameworkElementHookContext.__name__],
        installs_hooks=[],
        yaml_example="""
hooks:
  run:
    pre:
      - start_otlp_metrics_sink:
          endpoint: 0.0.0.0:14317
    post:
      - stop_otlp_metrics_sink: {}
""",
    )

    def __init__(self, config: StartOtlpMetricsSinkConfig):
        self.config = config

    def execute(self, ctx: BaseContext):
        logger = ctx.get_logger(__name__)
        suite = ctx.get_suite()
        existing = suite.get_runtime(OTLP_METRICS_SINK_RUNTIME)
        if existing is not None:
            logger.info("OTLP metrics sink already running on %s", existing.endpoint)
            return
        sink = OtlpMetricsSink(endpoint=self.config.endpoint)
        port = sink.start()
        suite.set_runtime_data(OTLP_METRICS_SINK_RUNTIME, sink)
        logger.info(
            "OTLP metrics sink listening on %s (port %s)", self.config.endpoint, port
        )


@hook_registry.register_config(STOP_HOOK_NAME)
class StopOtlpMetricsSinkConfig(HookStrategyConfig):
    """Configuration for the 'stop_otlp_metrics_sink' hook."""

    grace_seconds: float = 2.0


@hook_registry.register_class(STOP_HOOK_NAME)
class StopOtlpMetricsSinkHook(HookStrategy):
    """Stop the suite's embedded OTLP/gRPC metrics sink."""

    PLUGIN_META = PluginMeta(
        supported_contexts=[FrameworkElementHookContext.__name__],
        installs_hooks=[],
        yaml_example="""
hooks:
  run:
    post:
      - stop_otlp_metrics_sink: {}
""",
    )

    def __init__(self, config: StopOtlpMetricsSinkConfig):
        self.config = config

    def execute(self, ctx: BaseContext):
        sink = get_otlp_metrics_sink(ctx)
        if sink is None:
            return
        sink.stop(self.config.grace_seconds)
        ctx.get_logger(__name__).info(
            "OTLP metrics sink stopped after receiving %d data points",
            sink.row_count(),
        )
