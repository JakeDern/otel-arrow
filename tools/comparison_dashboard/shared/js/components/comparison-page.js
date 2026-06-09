// ── <comparison-page> ────────────────────────────────────────────────────────
// Detail-page orchestrator: header, env header, page-level filter bar, the
// bar chart, and a child <detail-panel>. Native custom element. Owns the bar
// chart and coordinates it with the panel: a bar click drives the panel; the
// panel's own pill/select changes are recorded but do not move the chart
// (matching the original app behaviour).

import { loadSuiteData } from "../data.js";
import { escapeHtml } from "../format.js";
import {
    collectFilterCategories, getFilterState, buildFilterHtml,
    filterComparison, wireFilters,
} from "../filters.js";
import { renderComparisonEnvHeader } from "../env.js";
import { findAvailableMetrics, defaultMetric, metricTitle, perComparisonMetrics } from "../metrics.js";
import { anyComparisonBackpressure } from "../backpressure.js";
import { adopt, tokensSheet } from "../styles.js";
import { WARNING_SIGN } from "../icons.js";
import "./bar-chart.js";
import "./detail-panel.js";

const css = `
.scenario-header { margin-bottom: 16px; }
.scenario-header h1 { font-size: 24px; margin: 0 0 4px; }
.scenario-header .sub { margin-top: 0; }

.back-link {
    display: inline-block;
    font-size: 13px;
    color: var(--accent);
    text-decoration: none;
    margin-bottom: 12px;
}
.back-link:hover { text-decoration: underline; }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

/**
 * Detail page for a single comparison. Hosts the chart, filter bar, and
 * <detail-panel>; coordinates user interactions across them.
 */
export class ComparisonPage extends HTMLElement {
    /** Comparison definition object. Triggers a render when set. */
    set comparison(c) { this._comparison = c; if (this.isConnected) this.render(); }
    /** URL slug for this comparison. Used for per-page metric memory. */
    set compSlug(s) { this._slug = s; }

    connectedCallback() { this.render(); }

    /**
     * Fast palette refresh: ask the existing <bar-chart> and <detail-panel>
     * to redraw with fresh colours in place. Called by <dashboard-site>
     * after the colourblind switch flips. (Full re-renders go through
     * `render()` for other reasons -- data, slug change, etc.)
     */
    refreshPalette() {
        const bar = this.querySelector("bar-chart");
        if (bar && bar.refreshPalette) bar.refreshPalette();
        if (this._detail && this._detail.refreshPalette) this._detail.refreshPalette();
    }

    /**
     * Top-level render. Rebuilds the page scaffolding (header, env header,
     * filter bar, chart container, detail panel) and wires interactions.
     */
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

    /**
     * Re-render the chart + sync the detail panel to the current filter state.
     * Called on filter changes.
     */
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

    /**
     * Rebuild the chart section's controls + <bar-chart>. When the user picks
     * a different metric the host only updates the chart data (via setData),
     * not the section scaffolding.
     */
    _renderChart(suiteData, comparison, tests, onBarClick) {
        const target = this.querySelector("#comparison-chart");
        if (!target) return;
        const metrics = findAvailableMetrics(suiteData, comparison);
        // Preserve the user's selection across re-renders (e.g. filter
        // changes). Fall back to the comparison's configured default, then
        // the first available metric.
        const compSlug = this._slug;
        const prev = perComparisonMetrics.get(compSlug);
        let sel = prev && metrics.includes(prev) ? prev : defaultMetric(comparison, metrics);
        perComparisonMetrics.set(compSlug, sel);
        const optsHtml = metrics.map((n) => `<option value="${escapeHtml(n)}" ${n === sel ? "selected" : ""}>${escapeHtml(metricTitle(n, suiteData, comparison))}</option>`).join("");

        const onClick = (_, elements) => {
            if (!elements.length) return;
            const { datasetIndex, index } = elements[0];
            const ref = (comparison.suites || [])[datasetIndex];
            const ct = tests[index];
            if (ref && ct) onBarClick(datasetIndex, ct.name);
        };

        const anyBP = anyComparisonBackpressure(suiteData, comparison);
        const bpHtml = anyBP ? `<div class="chart-backpressure-legend">${WARNING_SIGN} Backpressure detected</div>` : "";

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
        <bar-chart></bar-chart>
        ${bpHtml}
      </div>`;

        const bar = target.querySelector("bar-chart");
        bar.setData({ suiteData, comparison, tests, selectedMetric: sel, onClick });
        const ms = target.querySelector("#metric-select");
        if (ms) ms.onchange = () => {
            sel = ms.value;
            perComparisonMetrics.set(compSlug, sel);
            bar.setData({ suiteData, comparison, tests, selectedMetric: sel, onClick });
            const t = target.querySelector(".scenario-section-title");
            if (t) t.textContent = metricTitle(sel, suiteData, comparison);
        };
    }
}

customElements.define("comparison-page", ComparisonPage);
