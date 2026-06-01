// ============================================================================
// <comparison-page> -- the comparison detail page orchestrator.
//
// Owns the page header, the environment header, the colorblind toggle, the
// (page-level) filter bar, the <comparison-chart mode="detail">, and the
// <detail-panel>. Coordinates filter changes (re-render chart + panel) and
// test selection (bar click <-> panel pills/select stay in lockstep), exactly
// as the original app.js renderComparisonPage did.
//
// Renders to the LIGHT DOM. The static shell (header/env/toggle/filters) is
// produced via Lit html + unsafeHTML; the two child custom elements are
// declared in the Lit template and fed properties in updated().
//
// Inputs (properties):
//   .suiteData   -- window.SUITE_DATA
//   .comparison  -- the (unfiltered) comparison definition
//   .compSlug    -- comparison slug
// ============================================================================

import { LitElement, html } from "https://esm.run/lit@3";
import { unsafeHTML } from "https://esm.run/lit@3/directives/unsafe-html.js";

import { escapeHtml } from "../format.js";
import {
  collectFilterCategories, getFilterState, filterComparison,
  buildFilterHtml, wireFilters,
} from "../data.js";
import { renderComparisonEnvHeader } from "../env.js";
import { isColorblindMode, setColorblindMode } from "../colors.js";
import "./comparison-chart.js";
import "./detail-panel.js";

export class ComparisonPage extends LitElement {
  static properties = {
    suiteData: { attribute: false },
    comparison: { attribute: false },
    compSlug: { attribute: false },
  };

  constructor() {
    super();
    // Selection is plain (non-reactive) state: a bar click or a panel
    // pill/select must update only the detail panel, NOT rebuild the bar
    // chart (matching the original app.js, which re-rendered just the detail
    // on bar click). Filter/palette changes go through requestUpdate().
    this._selSuite = 0;
    this._selTest = "";
  }

  createRenderRoot() { return this; }

  render() {
    const suiteData = this.suiteData || {};
    const comparison = this.comparison;
    const slug = this.compSlug;
    if (!comparison) {
      return html`${unsafeHTML('<div class="muted" style="padding:16px">Comparison definition not found.</div>')}`;
    }

    const categories = collectFilterCategories(suiteData, comparison);
    const filterState = getFilterState(slug, categories);
    const filtered = filterComparison(comparison, suiteData, filterState);

    // Clamp selection against the current filtered set / test list.
    const tests = comparison.tests || [];
    const testNames = tests.map((t) => t.name);
    if (this._selSuite >= filtered.suites.length) this._selSuite = 0;
    if (!testNames.includes(this._selTest)) this._selTest = testNames[0] || "";

    const hasFilters = Object.keys(categories).length > 0;
    const filterHtml = hasFilters ? buildFilterHtml(categories, filterState) : "";
    const envHeaderHtml = renderComparisonEnvHeader(suiteData, comparison);
    const cbLabel = isColorblindMode() ? "Standard Colors" : "Colorblind Mode";
    const cbActive = isColorblindMode() ? " active" : "";

    const shell = `
      <div class="scenario-header">
        <a class="back-link" href="../">&larr; All Comparisons</a>
        <h1>${escapeHtml(comparison.name || slug)}</h1>
        <div class="sub">${escapeHtml(comparison.description || "")}</div>
      </div>
      ${envHeaderHtml}
      <button class="colorblind-toggle${cbActive}" type="button" title="Toggle colorblind-friendly palette">${escapeHtml(cbLabel)}</button>
      ${filterHtml}`;

    return html`
      ${unsafeHTML(shell)}
      <comparison-chart></comparison-chart>
      <detail-panel></detail-panel>`;
  }

  updated() {
    const suiteData = this.suiteData || {};
    const comparison = this.comparison;
    if (!comparison) return;
    const slug = this.compSlug;
    const categories = collectFilterCategories(suiteData, comparison);
    const filterState = getFilterState(slug, categories);
    const filtered = filterComparison(comparison, suiteData, filterState);

    // Feed the bar chart (filtered comparison, detail mode).
    const chart = this.querySelector("comparison-chart");
    if (chart) {
      chart.mode = "detail";
      chart.compSlug = slug;
      chart.suiteData = suiteData;
      chart.comparison = comparison;
    }

    // Feed the detail panel the filtered comparison + current selection.
    const panel = this.querySelector("detail-panel");
    if (panel) {
      panel.suiteData = suiteData;
      panel.comparison = filtered;
      panel.selSuite = this._selSuite;
      panel.selTest = this._selTest;
    }

    // Colorblind toggle: flip palette, clear pattern cache, re-render.
    const cb = this.querySelector(".colorblind-toggle");
    if (cb) cb.onclick = () => { setColorblindMode(!isColorblindMode()); this.requestUpdate(); };

    // Page-level filter bar drives both the chart and the panel.
    const fc = this.querySelector(".chart-filters");
    if (fc) wireFilters(fc, slug, categories, () => this.requestUpdate());
  }

  connectedCallback() {
    super.connectedCallback();
    // Bar click and panel pill/select both funnel selection back here. Update
    // only the detail panel's properties so the bar chart is not rebuilt.
    this.addEventListener("select-test", (e) => this._applySelection(e.detail));
    this.addEventListener("selection-change", (e) => this._applySelection(e.detail));
  }

  _applySelection({ suiteIdx, testName }) {
    this._selSuite = suiteIdx;
    this._selTest = testName;
    const panel = this.querySelector("detail-panel");
    if (panel) { panel.selSuite = suiteIdx; panel.selTest = testName; }
  }
}

customElements.define("comparison-page", ComparisonPage);
