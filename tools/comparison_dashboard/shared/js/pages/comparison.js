// ── Comparison detail page ──────────────────────────────────────────────────
// Top: bar chart + metric select + filters. Bottom: the test detail panel.
// Clicking a bar drives the detail panel selection.

import { loadSuiteData } from "../data.js";
import { escapeHtml } from "../format.js";
import { renderColorblindToggle, wireColorblindToggle } from "../colorblind.js";
import {
  collectFilterCategories, getFilterState, buildFilterHtml,
  filterComparison, wireFilters,
} from "../filters.js";
import { renderComparisonEnvHeader } from "../env.js";
import { findAvailableMetrics, defaultMetric, metricTitle, perComparisonMetrics } from "../metrics.js";
import { anyComparisonBackpressure } from "../backpressure.js";
import { createBarChart, updateBarChartData } from "../charts/bar.js";
import { renderComparisonDetail } from "../detail.js";

export function renderComparisonPage(compSlug) {
  const app = document.getElementById("app");
  if (!app) return;
  const suiteData = loadSuiteData();
  const comparison = window.COMPARISON;
  if (!comparison) { app.innerHTML = '<div class="muted" style="padding:16px">Comparison definition not found.</div>'; return; }

  const categories = collectFilterCategories(suiteData, comparison);
  const filterState = getFilterState(compSlug, categories);
  const hasFilters = Object.keys(categories).length > 0;
  const filterHtml = hasFilters ? buildFilterHtml(categories, filterState) : "";
  const envHeaderHtml = renderComparisonEnvHeader(suiteData, comparison);

  app.innerHTML = `
    <div class="scenario-header">
      <a class="back-link" href="../">&larr; All Comparisons</a>
      <h1>${escapeHtml(comparison.name || compSlug)}</h1>
      <div class="sub">${escapeHtml(comparison.description || "")}</div>
    </div>
    ${envHeaderHtml}
    ${renderColorblindToggle()}
    ${filterHtml}
    <div id="comparison-chart"></div>
    <div id="comparison-detail"></div>`;

  let detailSuiteIdx = 0, detailTestName = "";

  function renderAll() {
    const filtered = filterComparison(comparison, suiteData, filterState);
    const tests = comparison.tests || [];
    const testNames = tests.map((t) => t.name);
    if (detailSuiteIdx >= filtered.suites.length) detailSuiteIdx = 0;
    if (!testNames.includes(detailTestName)) detailTestName = testNames[0] || "";

    const setDetail = renderComparisonDetail(suiteData, filtered, tests, detailSuiteIdx, detailTestName, (si, tn) => { detailSuiteIdx = si; detailTestName = tn; });
    renderComparisonChart(suiteData, filtered, tests, (si, tn) => { detailSuiteIdx = si; detailTestName = tn; setDetail(si, tn); });
  }

  wireColorblindToggle(app, () => renderComparisonPage(compSlug));
  const fc = app.querySelector(".chart-filters");
  if (fc) wireFilters(fc, compSlug, categories, renderAll);
  renderAll();
}

function renderComparisonChart(suiteData, comparison, tests, onBarClick) {
  const target = document.getElementById("comparison-chart");
  if (!target) return;
  const metrics = findAvailableMetrics(suiteData, comparison);
  // Preserve the user's selection across re-renders (e.g. filter changes).
  // Fall back to the comparison's configured default, then the first
  // available metric.
  const compSlug = window.COMPARISON_SLUG;
  const prev = perComparisonMetrics.get(compSlug);
  let sel = prev && metrics.includes(prev) ? prev : defaultMetric(comparison, metrics);
  perComparisonMetrics.set(compSlug, sel);
  const optsHtml = metrics.map((n) => `<option value="${escapeHtml(n)}" ${n === sel ? "selected" : ""}>${escapeHtml(metricTitle(n, suiteData, comparison))}</option>`).join("");

  const onClick = onBarClick ? (event, elements) => {
    if (!elements.length) return;
    const { datasetIndex, index } = elements[0];
    const ref = (comparison.suites || [])[datasetIndex];
    const ct = tests[index];
    if (ref && ct) onBarClick(datasetIndex, ct.name);
  } : null;

  const anyBP = anyComparisonBackpressure(suiteData, comparison);
  const bpHtml = anyBP ? '<div class="chart-backpressure-legend">\u26A0 Backpressure detected</div>' : "";

  if (comparison.suites.length === 0) {
    target.innerHTML = '<div class="scenario-section"><div class="muted" style="padding:16px">No suites match the current filters.</div></div>';
    return;
  }

  target.innerHTML = `
    <div class="scenario-section">
      <div class="scenario-section-head">
        <div class="scenario-section-title">${escapeHtml(metricTitle(sel, suiteData, comparison))}</div>
        <select id="metric-select" class="scenario-metric-select">${optsHtml}</select>
      </div>
      <div class="chart-container"><canvas></canvas></div>
      ${bpHtml}
    </div>`;

  const canvas = target.querySelector("canvas");
  let chart = createBarChart(canvas, suiteData, comparison, tests, sel, onClick);
  const ms = document.getElementById("metric-select");
  if (ms) ms.onchange = () => {
    sel = ms.value;
    perComparisonMetrics.set(compSlug, sel);
    updateBarChartData(chart, suiteData, comparison, tests, sel);
    const t = target.querySelector(".scenario-section-title");
    if (t) t.textContent = metricTitle(sel, suiteData, comparison);
  };
}
