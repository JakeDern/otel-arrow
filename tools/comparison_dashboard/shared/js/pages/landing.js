// ── Landing page ────────────────────────────────────────────────────────────
// Lists every comparison as a section with a bar chart, metric selector, and
// filters. Charts are tracked in activeCharts so they can be torn down on
// re-render (e.g. colorblind toggle).

import { loadSuiteData } from "../data.js";
import { escapeHtml } from "../format.js";
import { renderColorblindToggle, wireColorblindToggle } from "../colorblind.js";
import {
  collectFilterCategories, getFilterState, filterComparison,
  buildFilterHtml, wireFilters,
} from "../filters.js";
import { findAvailableMetrics, defaultMetric, metricTitle, perComparisonMetrics } from "../metrics.js";
import { anyComparisonBackpressure } from "../backpressure.js";
import { activeCharts, createBarChart } from "../charts/bar.js";

export function renderLandingPage() {
  const app = document.getElementById("app");
  const cardsEl = document.getElementById("comparison-cards");
  if (!app) return;
  const suiteData = loadSuiteData();
  const comparisons = window.COMPARISONS || [];
  app.innerHTML = renderColorblindToggle();
  for (const c of activeCharts.values()) c.destroy();
  activeCharts.clear();
  wireColorblindToggle(app, renderLandingPage);
  if (!comparisons.length) { if (cardsEl) cardsEl.innerHTML = '<div class="muted" style="padding:16px">No comparisons defined.</div>'; return; }
  if (cardsEl) {
    cardsEl.innerHTML = comparisons.map((comp) => renderComparisonSection(suiteData, comp)).join("");
    for (const comp of comparisons) wireComparisonSection(suiteData, comp);
  }
}

function renderComparisonSection(suiteData, comparison) {
  const slug = comparison.slug;
  const categories = collectFilterCategories(suiteData, comparison);
  const filterState = getFilterState(slug, categories);
  const filtered = filterComparison(comparison, suiteData, filterState);
  const metrics = findAvailableMetrics(suiteData, filtered);
  if (!perComparisonMetrics.has(slug)) perComparisonMetrics.set(slug, defaultMetric(comparison, metrics));
  const sel = perComparisonMetrics.get(slug);
  const optsHtml = metrics.map((n) => `<option value="${escapeHtml(n)}" ${n === sel ? "selected" : ""}>${escapeHtml(metricTitle(n, suiteData, filtered))}</option>`).join("");
  const hasFilters = Object.keys(categories).length > 0;
  const filterHtml = hasFilters ? buildFilterHtml(categories, filterState) : "";
  const anyBP = anyComparisonBackpressure(suiteData, filtered);
  const bpHtml = anyBP ? '<div class="chart-backpressure-legend">\u26A0 Backpressure detected</div>' : "";
  const link = `${encodeURIComponent(slug)}/`;
  return `
    <section class="scenario-section" data-comparison-id="${escapeHtml(slug)}">
      <div class="scenario-section-head">
        <a class="scenario-section-title" href="${link}">${escapeHtml(comparison.name || slug)}</a>
        <select class="scenario-metric-select" data-comparison-id="${escapeHtml(slug)}">${optsHtml}</select>
      </div>
      <div class="scenario-section-description">${escapeHtml(comparison.description || "")}</div>
      ${filterHtml}
      <div class="chart-container"><canvas></canvas></div>
      ${bpHtml}
    </section>`;
}

function wireComparisonSection(suiteData, comparison) {
  const slug = comparison.slug;
  const section = document.querySelector(`[data-comparison-id="${slug}"]`);
  if (!section) return;
  const categories = collectFilterCategories(suiteData, comparison);
  const filterState = getFilterState(slug, categories);

  function renderChart() {
    const filtered = filterComparison(comparison, suiteData, filterState);
    const tests = comparison.tests || [];
    const sel = perComparisonMetrics.get(slug);
    if (activeCharts.has(slug)) { activeCharts.get(slug).destroy(); activeCharts.delete(slug); }
    const canvas = section.querySelector("canvas");
    if (canvas && filtered.suites.length > 0) {
      activeCharts.set(slug, createBarChart(canvas, suiteData, filtered, tests, sel));
    }
    const bpEl = section.querySelector(".chart-backpressure-legend");
    if (bpEl) bpEl.style.display = anyComparisonBackpressure(suiteData, filtered) ? "" : "none";
  }

  const fc = section.querySelector(".chart-filters");
  if (fc) wireFilters(fc, slug, categories, renderChart);
  const ms = section.querySelector(".scenario-metric-select");
  if (ms) ms.onchange = () => { perComparisonMetrics.set(slug, ms.value); renderChart(); };
  renderChart();
}
