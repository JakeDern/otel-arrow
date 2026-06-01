// ============================================================================
// <comparison-section> -- landing-page wrapper around one <comparison-chart>
// (in "section" mode) for a single comparison. Thin: it forwards its inputs
// to the child chart and exposes a rerender() that the colorblind toggle
// calls to repaint all sections.
//
// Renders to the LIGHT DOM so styles.css applies to the child markup.
//
// Inputs (properties):
//   .suiteData   -- window.SUITE_DATA
//   .comparison  -- a single comparison definition
// ============================================================================

import { LitElement, html } from "https://esm.run/lit@3";
import "./comparison-chart.js";

export class ComparisonSection extends LitElement {
  static properties = {
    suiteData: { attribute: false },
    comparison: { attribute: false },
  };

  createRenderRoot() { return this; }

  updated() {
    const chart = this.querySelector("comparison-chart");
    if (!chart) return;
    chart.mode = "section";
    chart.suiteData = this.suiteData;
    chart.comparison = this.comparison;
    chart.compSlug = this.comparison ? this.comparison.slug : null;
  }

  // Repaint the child chart (e.g. after a palette change). The chart rebuilds
  // its markup and Chart.js datasets from current state.
  rerender() {
    const chart = this.querySelector("comparison-chart");
    if (chart) chart.rerender();
  }

  render() {
    // Lit owns the child element; its imperative properties (mode, data,
    // slug) are pushed in updated() after each render.
    return html`<comparison-chart></comparison-chart>`;
  }
}

customElements.define("comparison-section", ComparisonSection);
