// ============================================================================
// <comparison-chart> -- a bar chart with a metric <select>, an optional filter
// bar, and an optional backpressure legend. Owns one Chart.js bar chart.
//
// Used in two modes (set via the `mode` property):
//   - "section" (landing page): title is a link to the detail page; metric
//     changes destroy+recreate the chart. No bar-click handler. Renders its
//     own filter bar.
//   - "detail"  (comparison page): title is plain text; metric changes update
//     the existing chart in place; bars are clickable and emit a "select-test"
//     CustomEvent { suiteIdx, testName }. The filter bar is owned by the
//     parent <comparison-page>, not rendered here.
//
// Renders to the LIGHT DOM (createRenderRoot returns this) so the global
// styles.css and Chart.js canvas measurement keep working. The markup is
// produced via Lit's html + unsafeHTML (so Lit owns the DOM and there are no
// marker conflicts); event wiring and Chart.js creation happen imperatively in
// updated() against that DOM. The Chart instance is a plain field, not a
// reactive property.
//
// Inputs (properties, set by the parent / bootstrap):
//   .suiteData   -- window.SUITE_DATA
//   .comparison  -- the (unfiltered) comparison definition
//   .compSlug    -- slug used to key shared filter/metric state
//   .mode        -- "section" | "detail"
// ============================================================================

import { LitElement, html } from "https://esm.run/lit@3";
import { unsafeHTML } from "https://esm.run/lit@3/directives/unsafe-html.js";

import { escapeHtml } from "../format.js";
import {
  collectFilterCategories, getFilterState, filterComparison,
  anyComparisonBackpressure, buildFilterHtml, wireFilters,
} from "../data.js";
import {
  findAvailableMetrics, defaultMetric, metricTitle,
} from "../metrics.js";
import {
  createBarChart, updateBarChartData,
} from "../charts.js";

// Shared per-comparison metric selection, mirroring the original app.js
// module-global so the choice survives re-renders and is shared between the
// landing section and the detail page for the same slug.
const perComparisonMetrics = new Map();

export class ComparisonChart extends LitElement {
  static properties = {
    suiteData: { attribute: false },
    comparison: { attribute: false },
    compSlug: { attribute: false },
    mode: { type: String },
  };

  constructor() {
    super();
    this.mode = "section";
    this._chart = null;
  }

  createRenderRoot() { return this; }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyChart();
  }

  _destroyChart() {
    if (this._chart) { this._chart.destroy(); this._chart = null; }
  }

  // Expose a re-render entry point for parents (e.g. the colorblind toggle).
  rerender() { this.requestUpdate(); }

  // Resolve the filtered comparison + selected metric for the current state.
  _resolve() {
    const suiteData = this.suiteData || {};
    const comparison = this.comparison;
    const slug = this.compSlug || (comparison && comparison.slug);
    const categories = collectFilterCategories(suiteData, comparison || {});
    const filterState = getFilterState(slug, categories);
    const filtered = filterComparison(comparison, suiteData, filterState);
    const metrics = findAvailableMetrics(suiteData, filtered);
    const prev = perComparisonMetrics.get(slug);
    const sel = prev && metrics.includes(prev) ? prev : defaultMetric(comparison, metrics);
    perComparisonMetrics.set(slug, sel);
    return { suiteData, comparison, slug, categories, filterState, filtered, metrics, sel };
  }

  render() {
    if (!this.comparison) return html``;
    const r = this._resolve();
    const optsHtml = r.metrics.map((n) =>
      `<option value="${escapeHtml(n)}" ${n === r.sel ? "selected" : ""}>${escapeHtml(metricTitle(n, r.suiteData, r.filtered))}</option>`
    ).join("");
    const anyBP = anyComparisonBackpressure(r.suiteData, r.filtered);
    const bpHtml = anyBP ? '<div class="chart-backpressure-legend">⚠ Backpressure detected</div>' : "";

    if (this.mode === "detail") return this._detailMarkup(r, optsHtml, bpHtml);
    return this._sectionMarkup(r, optsHtml, bpHtml);
  }

  // Landing-page section markup (title is a link; includes the filter bar).
  _sectionMarkup(r, optsHtml, bpHtml) {
    const hasFilters = Object.keys(r.categories).length > 0;
    const filterHtml = hasFilters ? buildFilterHtml(r.categories, r.filterState) : "";
    const link = `${encodeURIComponent(r.slug)}/`;
    return html`${unsafeHTML(`
      <section class="scenario-section" data-comparison-id="${escapeHtml(r.slug)}">
        <div class="scenario-section-head">
          <a class="scenario-section-title" href="${link}">${escapeHtml(r.comparison.name || r.slug)}</a>
          <select class="scenario-metric-select" data-comparison-id="${escapeHtml(r.slug)}">${optsHtml}</select>
        </div>
        <div class="scenario-section-description">${escapeHtml(r.comparison.description || "")}</div>
        ${filterHtml}
        <div class="chart-container"><canvas></canvas></div>
        ${bpHtml}
      </section>`)}`;
  }

  // Detail-page chart markup (plain-text title; no filter bar).
  _detailMarkup(r, optsHtml, bpHtml) {
    if (r.filtered.suites.length === 0) {
      return html`${unsafeHTML('<div class="scenario-section"><div class="muted" style="padding:16px">No suites match the current filters.</div></div>')}`;
    }
    return html`${unsafeHTML(`
      <div class="scenario-section">
        <div class="scenario-section-head">
          <div class="scenario-section-title">${escapeHtml(metricTitle(r.sel, r.suiteData, r.filtered))}</div>
          <select id="metric-select" class="scenario-metric-select">${optsHtml}</select>
        </div>
        <div class="chart-container"><canvas></canvas></div>
        ${bpHtml}
      </div>`)}`;
  }

  updated() {
    if (!this.comparison) { this._destroyChart(); return; }
    if (this.mode === "detail") { this._wireDetail(); return; }
    this._wireSection();
  }

  _wireSection() {
    const r = this._resolve();
    const tests = r.comparison.tests || [];

    const renderChart = () => {
      const f = filterComparison(r.comparison, r.suiteData, r.filterState);
      const s = perComparisonMetrics.get(r.slug);
      this._destroyChart();
      const canvas = this.querySelector("canvas");
      if (canvas && f.suites.length > 0) {
        this._chart = createBarChart(canvas, r.suiteData, f, tests, s);
      }
      const bpEl = this.querySelector(".chart-backpressure-legend");
      if (bpEl) bpEl.style.display = anyComparisonBackpressure(r.suiteData, f) ? "" : "none";
    };

    const fc = this.querySelector(".chart-filters");
    // A filter change can drop/add suites and toggle the legend, but the
    // section's metric options/title don't change, so a chart-only re-render
    // is sufficient here (matches the original landing-page behavior).
    if (fc) wireFilters(fc, r.slug, r.categories, renderChart);
    const ms = this.querySelector(".scenario-metric-select");
    if (ms) ms.onchange = () => { perComparisonMetrics.set(r.slug, ms.value); renderChart(); };
    renderChart();
  }

  _wireDetail() {
    const r = this._resolve();
    const tests = r.comparison.tests || [];
    this._destroyChart();
    if (r.filtered.suites.length === 0) return;

    const canvas = this.querySelector("canvas");
    if (!canvas) return;

    const onClick = (event, elements) => {
      if (!elements.length) return;
      const { datasetIndex, index } = elements[0];
      const ref = (r.filtered.suites || [])[datasetIndex];
      const ct = tests[index];
      if (ref && ct) {
        this.dispatchEvent(new CustomEvent("select-test", {
          bubbles: true, composed: true,
          detail: { suiteIdx: datasetIndex, testName: ct.name },
        }));
      }
    };

    this._chart = createBarChart(canvas, r.suiteData, r.filtered, tests, r.sel, onClick);

    const ms = this.querySelector("#metric-select");
    if (ms) ms.onchange = () => {
      const s = ms.value;
      perComparisonMetrics.set(r.slug, s);
      updateBarChartData(this._chart, r.suiteData, r.filtered, tests, s);
      const t = this.querySelector(".scenario-section-title");
      if (t) t.textContent = metricTitle(s, r.suiteData, r.filtered);
    };
  }
}

customElements.define("comparison-chart", ComparisonChart);
