// ── <comparison-page> ────────────────────────────────────────────────────────
// Detail-page orchestrator: header, env header, page-level filter bar,
// the bar chart, and a child <detail-panel>. Native custom element.
// Owns the bar chart and coordinates it with the panel: a bar click drives the
// panel; the panel's own pill/select changes are recorded but do not move the
// chart (matching the original app behavior).

import { loadSuiteData } from "../data.js";
import { escapeHtml } from "../format.js";
import {
    collectFilterCategories, getFilterState, buildFilterHtml,
    filterComparison, wireFilters,
} from "../filters.js";
import { renderComparisonEnvHeader } from "../env.js";
import { findAvailableMetrics, defaultMetric, metricTitle, perComparisonMetrics } from "../metrics.js";
import { anyComparisonBackpressure } from "../backpressure.js";
import { createBarChart, updateBarChartData } from "../charts/bar.js";
import "./detail-panel.js";

export class ComparisonPage extends HTMLElement {
    set comparison(c) { this._comparison = c; if (this.isConnected) this.render(); }
    set compSlug(s) { this._slug = s; }

    connectedCallback() { this.render(); }
    disconnectedCallback() { this._destroyChart(); }

    _destroyChart() { if (this._chart) { this._chart.destroy(); this._chart = null; } }

    render() {
        const comparison = this._comparison;
        const compSlug = this._slug;
        if (!comparison) { this.innerHTML = '<div class="muted" style="padding:16px">Comparison definition not found.</div>'; return; }
        const suiteData = loadSuiteData();

        const categories = collectFilterCategories(suiteData, comparison);
        const filterState = getFilterState(compSlug, categories);
        const hasFilters = Object.keys(categories).length > 0;
        const filterHtml = hasFilters ? buildFilterHtml(categories, filterState) : "";
        const envHeaderHtml = renderComparisonEnvHeader(suiteData, comparison);

        this.innerHTML = `
      <div class="scenario-header">
        <a class="back-link" href="../">&larr; All Comparisons</a>
        <h1>${escapeHtml(comparison.name || compSlug)}</h1>
        <div class="sub">${escapeHtml(comparison.description || "")}</div>
      </div>
      ${envHeaderHtml}
      ${filterHtml}
      <div id="comparison-chart"></div>
      <detail-panel></detail-panel>`;

        this._detailSuiteIdx = 0;
        this._detailTestName = "";
        this._detail = this.querySelector("detail-panel");
        this._detail.addEventListener("selection-change", (e) => {
            this._detailSuiteIdx = e.detail.suiteIdx;
            this._detailTestName = e.detail.testName;
        });

        const renderAll = () => this._renderAll(suiteData, comparison, filterState);
        const fc = this.querySelector(".chart-filters");
        if (fc) wireFilters(fc, compSlug, categories, renderAll);
        renderAll();
    }

    _renderAll(suiteData, comparison, filterState) {
        const filtered = filterComparison(comparison, suiteData, filterState);
        const tests = comparison.tests || [];
        const testNames = tests.map((t) => t.name);
        if (this._detailSuiteIdx >= filtered.suites.length) this._detailSuiteIdx = 0;
        if (!testNames.includes(this._detailTestName)) this._detailTestName = testNames[0] || "";

        this._detail.setData(suiteData, filtered, tests, this._detailSuiteIdx, this._detailTestName);
        this._renderChart(suiteData, filtered, tests, (si, tn) => {
            this._detailSuiteIdx = si;
            this._detailTestName = tn;
            this._detail.setSelection(si, tn);
        });
    }

    _renderChart(suiteData, comparison, tests, onBarClick) {
        const target = this.querySelector("#comparison-chart");
        if (!target) return;
        const metrics = findAvailableMetrics(suiteData, comparison);
        // Preserve the user's selection across re-renders (e.g. filter changes).
        // Fall back to the comparison's configured default, then the first
        // available metric.
        const compSlug = this._slug;
        const prev = perComparisonMetrics.get(compSlug);
        let sel = prev && metrics.includes(prev) ? prev : defaultMetric(comparison, metrics);
        perComparisonMetrics.set(compSlug, sel);
        const optsHtml = metrics.map((n) => `<option value="${escapeHtml(n)}" ${n === sel ? "selected" : ""}>${escapeHtml(metricTitle(n, suiteData, comparison))}</option>`).join("");

        const onClick = (event, elements) => {
            if (!elements.length) return;
            const { datasetIndex, index } = elements[0];
            const ref = (comparison.suites || [])[datasetIndex];
            const ct = tests[index];
            if (ref && ct) onBarClick(datasetIndex, ct.name);
        };

        const anyBP = anyComparisonBackpressure(suiteData, comparison);
        const bpHtml = anyBP ? '<div class="chart-backpressure-legend">\u26A0 Backpressure detected</div>' : "";

        if (comparison.suites.length === 0) {
            this._destroyChart();
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
        this._destroyChart();
        this._chart = createBarChart(canvas, suiteData, comparison, tests, sel, onClick);
        const ms = target.querySelector("#metric-select");
        if (ms) ms.onchange = () => {
            sel = ms.value;
            perComparisonMetrics.set(compSlug, sel);
            updateBarChartData(this._chart, suiteData, comparison, tests, sel);
            const t = target.querySelector(".scenario-section-title");
            if (t) t.textContent = metricTitle(sel, suiteData, comparison);
        };
    }
}

customElements.define("comparison-page", ComparisonPage);
