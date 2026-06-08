// ── <comparison-section> ─────────────────────────────────────────────────────
// Landing-page card for one comparison: title link, metric <select>, filter
// bar, a <bar-chart>, and a backpressure legend. Native custom element.
// The host element IS the section; data comes in via the `comparison`
// property, set by the landing bootstrap before the element is connected.

import { loadSuiteData } from "../data.js";
import { escapeHtml } from "../format.js";
import {
    collectFilterCategories, getFilterState, filterComparison,
    buildFilterHtml, wireFilters,
} from "../filters.js";
import { findAvailableMetrics, defaultMetric, metricTitle, perComparisonMetrics } from "../metrics.js";
import { anyComparisonBackpressure } from "../backpressure.js";
import { adopt } from "../styles/adopt.js";
import { tokensSheet } from "../styles/tokens.js";
import { WARNING_SIGN } from "../icons.js";
import "./bar-chart.js";

const css = `
/* Container that holds the landing-page comparison cards. */
#comparison-cards {
    display: grid;
    gap: 16px;
    margin-top: 14px;
}

/* Chart-section card. Also used by <comparison-page> on the detail page. */
.scenario-section {
    background: var(--card);
    border: 1px solid var(--slate-200);
    border-radius: var(--radius-sm);
    padding: 16px 20px;
    margin-bottom: 16px;
}
.scenario-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 12px;
}
.scenario-section-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--slate-900);
}
a.scenario-section-title {
    color: var(--blue-600);
    text-decoration: none;
}
a.scenario-section-title:hover { text-decoration: underline; }
.scenario-section-description {
    font-size: 0.85rem;
    color: var(--slate-400);
    margin-bottom: 12px;
}
.scenario-metric-select {
    font-size: 0.85rem;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--slate-200);
    background: var(--card);
    color: var(--slate-900);
}

.chart-backpressure-legend {
    font-size: 11px;
    color: var(--bad-text);
    text-align: center;
    margin-top: 4px;
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

/**
 * Landing-page comparison card. The element body holds the chart + controls
 * for one comparison; clicking the title navigates to the detail page.
 */
export class ComparisonSection extends HTMLElement {
    /**
     * Comparison definition object. Must be set by the parent before
     * `connectedCallback` fires (or any time after, which triggers a render).
     */
    set comparison(c) { this._comparison = c; if (this.isConnected) this.render(); }
    get comparison() { return this._comparison; }

    connectedCallback() {
        this.classList.add("scenario-section");
        this.render();
    }

    /**
     * Full re-render: rebuilds the controls scaffolding and the bar chart.
     * Called on first connect and on palette change.
     */
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
      <bar-chart></bar-chart>
      <div class="chart-backpressure-legend">${WARNING_SIGN} Backpressure detected</div>`;

        this._bar = this.querySelector("bar-chart");
        const updateChart = () => this._updateChart(suiteData, comparison, filterState);
        const fc = this.querySelector(".chart-filters");
        if (fc) wireFilters(fc, slug, categories, updateChart);
        const ms = this.querySelector(".scenario-metric-select");
        if (ms) ms.onchange = () => { perComparisonMetrics.set(slug, ms.value); updateChart(); };
        updateChart();
    }

    /**
     * Push the current selection (filter state + metric) into the bar-chart
     * and toggle the backpressure legend. Doesn't touch the scaffolding.
     */
    _updateChart(suiteData, comparison, filterState) {
        const slug = comparison.slug;
        const filtered = filterComparison(comparison, suiteData, filterState);
        const tests = comparison.tests || [];
        const selectedMetric = perComparisonMetrics.get(slug);
        if (this._bar) {
            if (filtered.suites.length > 0) {
                this._bar.hidden = false;
                this._bar.setData({ suiteData, comparison: filtered, tests, selectedMetric });
            } else {
                this._bar.hidden = true;
            }
        }
        const bpEl = this.querySelector(".chart-backpressure-legend");
        if (bpEl) bpEl.style.display = anyComparisonBackpressure(suiteData, filtered) ? "" : "none";
    }

    /** Called by the landing bootstrap when the colourblind palette toggles. */
    refreshPalette() { if (this._comparison) this.render(); }
}

customElements.define("comparison-section", ComparisonSection);
