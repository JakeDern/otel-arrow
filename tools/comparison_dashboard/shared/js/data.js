// ============================================================================
// Data access, filter infrastructure, backpressure detection, and bar-chart
// dataset building. All framework-agnostic. Filter state is held per
// comparison slug in module-global maps, exactly as the original app.js, so
// selections survive component re-renders.
// ============================================================================

import { getColor, createDiagonalPattern } from "./colors.js";
import { escapeHtml } from "./format.js";

const DATA_LOSS_THRESHOLD = 5;
const RATE_DEVIATION_THRESHOLD = 5;

export const FILTER_LABELS = {
  protocols: "Protocol",
  compression: "Compression",
  binary: "Binary",
  signals: "Signal",
};

// ── Suite data access ───────────────────────────────────────────────────────

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

// ── Filter infrastructure ────────────────────────────────────────────────────

const perComparisonFilters = new Map();

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

export function getFilterState(compSlug, categories) {
  if (!perComparisonFilters.has(compSlug)) {
    const state = new Map();
    for (const [cat, vals] of Object.entries(categories)) {
      state.set(cat, new Set(vals));
    }
    perComparisonFilters.set(compSlug, state);
  }
  return perComparisonFilters.get(compSlug);
}

function suiteMatchesFilters(suiteData, slug, filterState) {
  const meta = getSuiteMeta(suiteData, slug);
  for (const [cat, checked] of filterState) {
    if (checked.size === 0) return false;
    const val = meta[cat];
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      if (!val.some((v) => checked.has(String(v)))) return false;
    } else {
      if (!checked.has(String(val))) return false;
    }
  }
  return true;
}

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

// ── Filter markup + wiring ────────────────────────────────────────────────────

export function buildFilterHtml(categories, filterState) {
  const groups = Object.entries(categories).map(([cat, vals]) => {
    const checked = filterState.get(cat) || new Set();
    const opts = vals.map((v) =>
      `<label class="chart-filter-option"><input type="checkbox" data-filter-category="${escapeHtml(cat)}" data-filter-value="${escapeHtml(v)}" ${checked.has(v) ? "checked" : ""}> ${escapeHtml(v)}</label>`
    ).join("");
    const label = FILTER_LABELS[cat] || cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `<div class="chart-filter-group"><span class="chart-filter-label">${escapeHtml(label)}:</span>${opts}</div>`;
  }).join("");
  return `<div class="chart-filters">${groups}<button class="filter-reset chart-filter-reset" type="button">Reset</button></div>`;
}

export function wireFilters(container, compSlug, categories, onChange) {
  const fs = getFilterState(compSlug, categories);
  if (!fs) return;
  for (const cb of container.querySelectorAll("input[data-filter-category]")) {
    cb.onchange = () => {
      const s = fs.get(cb.dataset.filterCategory);
      if (!s) return;
      cb.checked ? s.add(cb.dataset.filterValue) : s.delete(cb.dataset.filterValue);
      onChange();
    };
  }
  const resetBtn = container.querySelector(".chart-filter-reset");
  if (resetBtn) {
    resetBtn.onclick = () => {
      for (const [cat, vals] of Object.entries(categories)) fs.set(cat, new Set(vals));
      for (const cb of container.querySelectorAll("input[data-filter-category]")) cb.checked = true;
      onChange();
    };
  }
}

// ── Backpressure detection ────────────────────────────────────────────────────

export const DATA_LOSS_THRESHOLD_PCT = DATA_LOSS_THRESHOLD;

const RECEIVED_RATE_METRICS = ["logs_received_rate", "metrics_received_rate", "spans_received_rate"];

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
// Drives the landing-page legend and the detail-page badge.
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

// ── Bar-chart dataset building ───────────────────────────────────────────────

export function buildComparisonChartData(suiteData, comparison, tests, selectedMetric) {
  const refs = comparison.suites || [];
  const origIdx = comparison._originalIndices || null;

  // First pass: find the max real value to compute a sentinel height
  let maxVal = 0;
  for (const ref of refs) {
    for (const t of getSuiteTests(suiteData, ref.slug)) {
      if (!t.metrics) continue;
      const m = t.metrics.find((x) => x.name === selectedMetric);
      if (m && typeof m.value === "number" && Number.isFinite(m.value)) maxVal = Math.max(maxVal, Math.abs(m.value));
    }
  }
  const sentinel = Math.max(1, maxVal * 0.03);

  const datasets = refs.map((ref, si) => {
    const colorIdx = origIdx ? origIdx[si] : si;
    const color = getColor(colorIdx);
    const pattern = createDiagonalPattern(color);
    const suiteTests = getSuiteTests(suiteData, ref.slug);
    const data = [], bp = [], missing = [];
    for (const ct of tests) {
      const t = suiteTests.find((x) => x.name === ct.name);
      if (!t || !t.metrics) { data.push(sentinel); bp.push(false); missing.push(true); continue; }
      const m = t.metrics.find((x) => x.name === selectedMetric);
      const val = m && typeof m.value === "number" && Number.isFinite(m.value) ? m.value : null;
      if (val === null) { data.push(sentinel); bp.push(false); missing.push(true); }
      else {
        data.push(val);
        bp.push(hasBackpressure(t.metrics, ct.loadgen_rate));
        missing.push(false);
      }
    }
    // Fall back to a scalar color when no bars will be drawn (e.g. the
    // comparison has zero published tests). Chart.js reads index 0 of
    // backgroundColor for the legend swatch; an empty array yields black.
    const bgColor = data.length ? data.map((_, i) => missing[i] ? pattern : color) : color;
    const bdColor = data.length ? data.map((_, i) => missing[i] ? `${color}80` : color) : color;
    return {
      label: ref.short || ref.name, data, _hasBackpressure: bp, _missing: missing,
      backgroundColor: bgColor,
      borderColor: bdColor,
      borderWidth: 1,
      borderRadius: 4, borderSkipped: "bottom",
    };
  });
  return { labels: tests.map((t) => t.label), datasets };
}
