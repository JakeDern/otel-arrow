// ── <comparison-section> ─────────────────────────────────────────────────────
// Landing-page card for one comparison: metric <select>, filter bar, bar chart,
// and a backpressure legend. Native custom element (no framework). The host
// element IS the section; data comes in via the `comparison` property, set by
// the landing bootstrap before the element is connected.

import { loadSuiteData } from "../data.js";
import { escapeHtml } from "../format.js";
import {
  collectFilterCategories, getFilterState, filterComparison,
  buildFilterHtml, wireFilters,
} from "../filters.js";
import { findAvailableMetrics, defaultMetric, metricTitle, perComparisonMetrics } from "../metrics.js";
import { anyComparisonBackpressure } from "../backpressure.js";
import { createBarChart } from "../charts/bar.js";

export class ComparisonSection extends HTMLElement {
  set comparison(c) { this._comparison = c; if (this.isConnected) this.render(); }
  get comparison() { return this._comparison; }

  connectedCallback() {
    this.classList.add("scenario-section");
    this.render();
  }

  disconnectedCallback() { this._destroyChart(); }

  _destroyChart() { if (this._chart) { this._chart.destroy(); this._chart = null; } }

  // Re-render from scratch (used on first connect and on palette change, where
  // the metric option labels may need to be rebuilt).
  render() {
    const comparison = this._comparison;
    if (!comparison) return;
    const suiteData = loadSuiteData();
    const slug = comparison.slug;
    this.dataset.comparisonId = slug;

    const categories = collectFilterCategories(suiteData, comparison);
    const filterState = getFilterState(slug, categories);
    const filtered = filterComparison(comparison, suiteData, filterState);
    const metrics = findAvailableMetrics(suiteData, filtered);
    if (!perComparisonMetrics.has(slug)) perComparisonMetrics.set(slug, defaultMetric(comparison, metrics));
    const sel = perComparisonMetrics.get(slug);
    const optsHtml = metrics.map((n) => `<option value="${escapeHtml(n)}" ${n === sel ? "selected" : ""}>${escapeHtml(metricTitle(n, suiteData, filtered))}</option>`).join("");
    const hasFilters = Object.keys(categories).length > 0;
    const filterHtml = hasFilters ? buildFilterHtml(categories, filterState) : "";
    const link = `${encodeURIComponent(slug)}/`;

    this.innerHTML = `
      <div class="scenario-section-head">
        <a class="scenario-section-title" href="${link}">${escapeHtml(comparison.name || slug)}</a>
        <select class="scenario-metric-select">${optsHtml}</select>
      </div>
      <div class="scenario-section-description">${escapeHtml(comparison.description || "")}</div>
      ${filterHtml}
      <div class="chart-container"><canvas></canvas></div>
      <div class="chart-backpressure-legend">\u26A0 Backpressure detected</div>`;

    const renderChart = () => this._renderChart(suiteData, comparison, filterState);
    const fc = this.querySelector(".chart-filters");
    if (fc) wireFilters(fc, slug, categories, renderChart);
    const ms = this.querySelector(".scenario-metric-select");
    if (ms) ms.onchange = () => { perComparisonMetrics.set(slug, ms.value); renderChart(); };
    renderChart();
  }

  // Recreate just the chart (used on metric/filter change), leaving the
  // surrounding controls in place.
  _renderChart(suiteData, comparison, filterState) {
    const slug = comparison.slug;
    const filtered = filterComparison(comparison, suiteData, filterState);
    const tests = comparison.tests || [];
    const sel = perComparisonMetrics.get(slug);
    this._destroyChart();
    const canvas = this.querySelector("canvas");
    if (canvas && filtered.suites.length > 0) {
      this._chart = createBarChart(canvas, suiteData, filtered, tests, sel);
    }
    const bpEl = this.querySelector(".chart-backpressure-legend");
    if (bpEl) bpEl.style.display = anyComparisonBackpressure(suiteData, filtered) ? "" : "none";
  }

  // Called by the landing bootstrap when the colorblind palette toggles.
  refreshPalette() { if (this._comparison) this.render(); }
}

customElements.define("comparison-section", ComparisonSection);
