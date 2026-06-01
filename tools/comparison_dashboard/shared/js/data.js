// ============================================================================
// data.js -- pure data access, metric metadata, filter + backpressure logic.
//
// Reads the build-injected globals (window.SUITE_DATA, window.METRICS_META).
// No DOM, no event wiring. Ported from app.js so behavior is identical.
// ============================================================================

export const AUTO_COLORS = [
  "#1F77B4", "#AEC7E8", "#FF7F0E", "#FFBB78",
  "#2CA02C", "#98DF8A", "#D62728", "#FF9896",
  "#9467BD", "#C5B0D5", "#8C564B", "#C49C94",
  "#E377C2", "#F7B6D2", "#7F7F7F", "#C7C7C7",
  "#BCBD22", "#DBDB8D", "#17BECF", "#9EDAE5",
];

export const COLORBLIND_COLORS = [
  "#0072b2", "#e69f00", "#009e73", "#cc79a7",
  "#56b4e9", "#d55e00", "#f0e442", "#000000",
  "#0099cc", "#994f00", "#006d5b", "#ad5c85",
  "#3a9bd9", "#aa4400", "#c4b832", "#444444",
  "#882e72", "#b178a6", "#117733", "#88ccaa",
];

export const DATA_LOSS_THRESHOLD = 5;
export const RATE_DEVIATION_THRESHOLD = 5;

export const FILTER_LABELS = {
  protocols: "Protocol",
  compression: "Compression",
  binary: "Binary",
  signals: "Signal",
};

export const RECEIVED_RATE_METRICS = ["logs_received_rate", "metrics_received_rate", "spans_received_rate"];

// ── Data loading ───────────────────────────────────────────────────────────

export function loadSuiteData() { return window.SUITE_DATA || {}; }

export function getSuiteTests(suiteData, slug) {
  const suite = suiteData[slug];
  return suite ? suite.tests || [] : [];
}

export function getTestByName(suiteData, slug, testName) {
  return getSuiteTests(suiteData, slug).find((t) => t.name === testName) || null;
}

export function getSuiteMeta(suiteData, slug) {
  const suite = suiteData[slug];
  return suite ? suite.meta || {} : {};
}

// ── Filter infrastructure ──────────────────────────────────────────────────

export function collectFilterCategories(suiteData, comparison) {
  const cats = {};
  for (const ref of comparison.suites || []) {
    const meta = getSuiteMeta(suiteData, ref.slug);
    for (const [key, val] of Object.entries(meta)) {
      if (!cats[key]) cats[key] = new Set();
      if (Array.isArray(val)) { for (const v of val) cats[key].add(String(v)); }
      else { cats[key].add(String(val)); }
    }
  }
  const result = {};
  for (const [key, vals] of Object.entries(cats)) {
    if (vals.size > 1) result[key] = [...vals].sort();
  }
  return result;
}

// Whether suite `slug` passes the current filter state. `filterState` is a
// plain object: { category -> array-of-checked-values }. (app.js used a
// Map<string,Set>; we use plain objects/arrays so Alpine can hold the state
// reactively.)
export function suiteMatchesFilters(suiteData, slug, filterState) {
  const meta = getSuiteMeta(suiteData, slug);
  for (const [cat, checked] of Object.entries(filterState)) {
    if (!checked || checked.length === 0) return false;
    const val = meta[cat];
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      if (!val.some((v) => checked.includes(String(v)))) return false;
    } else {
      if (!checked.includes(String(val))) return false;
    }
  }
  return true;
}

// Returns a shallow copy of `comparison` with its suites narrowed to those
// matching the filter state, plus `_originalIndices` mapping each kept suite
// back to its original index (used for stable palette colors).
export function filterComparison(comparison, suiteData, filterState) {
  const suites = [];
  const indices = [];
  for (let i = 0; i < (comparison.suites || []).length; i++) {
    if (suiteMatchesFilters(suiteData, comparison.suites[i].slug, filterState)) {
      suites.push(comparison.suites[i]);
      indices.push(i);
    }
  }
  return { ...comparison, suites, _originalIndices: indices };
}

// Build the initial filter state: every value checked. Plain object form.
export function initialFilterState(categories) {
  const state = {};
  for (const [cat, vals] of Object.entries(categories)) state[cat] = [...vals];
  return state;
}

export function filterLabel(cat) {
  return FILTER_LABELS[cat] || cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Metric metadata ──────────────────────────────────────────────────────

export function metricLabel(name) {
  const meta = (window.METRICS_META || {})[name];
  if (meta && meta.label) return meta.label;
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

export function chartMetricsConfig(comparison) {
  return (comparison.chart && comparison.chart.metrics) || {};
}

export function findAvailableMetrics(suiteData, comparison) {
  const allowed = chartMetricsConfig(comparison).allowed;
  const candidates = allowed && allowed.length
    ? allowed
    : Object.keys(window.METRICS_META || {});
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

// ── Backpressure logic ─────────────────────────────────────────────────────

export function hasBackpressure(metricsArray, loadgenRate) {
  if (!metricsArray) return false;
  const dropped = metricsArray.find((m) => m.name === "dropped_logs_percentage");
  if (dropped && typeof dropped.value === "number" && dropped.value > DATA_LOSS_THRESHOLD) return true;
  if (loadgenRate && loadgenRate > 0) {
    const received = metricsArray.find((m) => RECEIVED_RATE_METRICS.includes(m.name));
    if (received && typeof received.value === "number") {
      if ((loadgenRate - received.value) / loadgenRate * 100 > RATE_DEVIATION_THRESHOLD) return true;
    }
  }
  return false;
}

// Determines whether any test in a comparison currently shows backpressure.
// Drives both the landing-page legend and the detail-page badge.
export function anyComparisonBackpressure(suiteData, comparison) {
  const tests = comparison.tests || [];
  return (comparison.suites || []).some((r) => {
    const suiteTests = getSuiteTests(suiteData, r.slug);
    return tests.some((ct) => {
      const t = suiteTests.find((x) => x.name === ct.name);
      return t && hasBackpressure(t.metrics, ct.loadgen_rate);
    });
  });
}

export function chartAxesConfig(comparison) {
  return (comparison && comparison.chart && comparison.chart.axes) || {};
}
