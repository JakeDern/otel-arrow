// ── Metric metadata + selection helpers ─────────────────────────────────────
// Drives the metric dropdowns and the detail-panel metric cards. Display
// labels come from PAGE_DATA.metricsMeta (via metricLabel); units come from each
// per-test metric record's `unit` field in the published JSON.

import { getSuiteTests } from "./data.js";
import { metricLabel } from "./format.js";

export const TIMESERIES_METRICS = [
    { key: "cpu_percentage_normalized", label: "CPU Normalized", unit: "%", avg: "cpu_percentage_normalized_avg", max: "cpu_percentage_normalized_max" },
    { key: "ram_mib", label: "RAM", unit: "MiB", avg: "ram_mib_avg", max: "ram_mib_max" },
    { key: "network_tx_bytes_rate", label: "Network TX Rate", unit: "bytes/sec", avg: "network_tx_bytes_rate_avg" },
    { key: "network_rx_bytes_rate", label: "Network RX Rate", unit: "bytes/sec", avg: "network_rx_bytes_rate_avg" },
    { key: "logs_produced_rate", label: "Offered Load Rate", unit: "logs/sec", avg: "logs_produced_rate" },
    { key: "logs_received_rate", label: "Backend Received Rate", unit: "logs/sec", avg: "logs_received_rate" },
    { key: "metrics_produced_rate", label: "Offered Load Rate", unit: "metrics/sec", avg: "metrics_produced_rate" },
    { key: "metrics_received_rate", label: "Backend Received Rate", unit: "metrics/sec", avg: "metrics_received_rate" },
    { key: "spans_produced_rate", label: "Offered Load Rate", unit: "spans/sec", avg: "spans_produced_rate" },
    { key: "spans_received_rate", label: "Backend Received Rate", unit: "spans/sec", avg: "spans_received_rate" },
];

export const SCALAR_ONLY_METRICS = [
    { name: "dropped_logs_percentage" },
    { name: "test_duration" },
];

// Selected metric per comparison slug; shared between the landing sections and
// the comparison detail page so the choice persists across re-renders.
export const perComparisonMetrics = new Map();

export function tmTitle(tm) { return tm.unit ? `${tm.label} (${tm.unit})` : tm.label; }

export function chartMetricsConfig(comparison) {
    return (comparison.chart && comparison.chart.metrics) || {};
}

export function findAvailableMetrics(suiteData, comparison) {
    const allowed = chartMetricsConfig(comparison).allowed;
    const candidates = allowed && allowed.length
        ? allowed
        : Object.keys((window.PAGE_DATA || {}).metricsMeta || {});
    return candidates.filter((mn) =>
        (comparison.suites || []).some((ref) =>
            getSuiteTests(suiteData, ref.slug).some((t) =>
                t.metrics && t.metrics.some((m) => m.name === mn && m.value != null))));
}

// Resolve the default metric for a comparison: prefer the configured
// chart.metrics.default if it is available; otherwise fall back to the
// first available metric.
export function defaultMetric(comparison, availableMetrics) {
    const configured = chartMetricsConfig(comparison).default;
    if (configured && availableMetrics.includes(configured)) return configured;
    return availableMetrics[0] || null;
}

export function lookupMetricUnit(suiteData, comparison, name) {
    for (const ref of comparison.suites || []) {
        for (const t of getSuiteTests(suiteData, ref.slug)) {
            if (!t.metrics) continue;
            const m = t.metrics.find((x) => x.name === name);
            if (m && m.unit) return m.unit;
        }
    }
    return null;
}

export function metricTitle(name, suiteData, comparison) {
    const label = metricLabel(name);
    const unit = suiteData && comparison ? lookupMetricUnit(suiteData, comparison, name) : null;
    return unit ? `${label} (${unit})` : label;
}
