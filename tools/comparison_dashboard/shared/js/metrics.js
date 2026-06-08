// ── Metric metadata + selection helpers ─────────────────────────────────────
// Drives the metric dropdowns (landing + detail page bar charts) and the
// detail-panel scalar cards. Display labels come from PAGE_DATA.metricsMeta
// (via metricLabel); units come from each per-test metric record's `unit`
// field in the published JSON. Timeseries chart cards in <detail-panel> are
// data-driven -- the timeseries object's keys + companion `<key>_avg` /
// `<key>_max` scalars in test.metrics are all the metadata needed.

import { getSuiteTests } from "./data.js";
import { metricLabel } from "./format.js";

// Scalar-only metrics rendered as standalone cards in <detail-panel>. These
// are the curated handful of "key health indicators" -- everything else either
// lives inside a chart card's Avg/Max annotation or is a bar-chart dropdown
// option only.
export const SCALAR_ONLY_METRICS = [
    { name: "dropped_logs_percentage" },
    { name: "test_duration" },
];

// Selected metric per comparison slug; shared between the landing sections and
// the comparison detail page so the choice persists across re-renders.
export const perComparisonMetrics = new Map();

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
