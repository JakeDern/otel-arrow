// ============================================================================
// <detail-panel> -- the comparison detail page's "Test Details" section.
//
// Contains: suite "pills", a test <select>, a backpressure badge, a file list,
// an env detail block, scalar metric cards, and a grid of Chart.js time-series
// line charts. Owns the mini line-chart instances.
//
// Renders to the LIGHT DOM via Lit html + unsafeHTML; event wiring and chart
// creation happen imperatively in updated(). Selection (suite index + test
// name) is held as reactive state; changing it re-renders and notifies the
// parent via a "selection-change" CustomEvent so the parent can keep the chart
// click target and the panel in sync.
//
// Inputs (properties):
//   .suiteData    -- window.SUITE_DATA
//   .comparison   -- the FILTERED comparison (suites already filtered; carries
//                    _originalIndices for stable colors)
//   .selSuite     -- selected suite index into comparison.suites
//   .selTest      -- selected test name
// ============================================================================

import { LitElement, html } from "https://esm.run/lit@3";
import { unsafeHTML } from "https://esm.run/lit@3/directives/unsafe-html.js";

import { escapeHtml, formatMetricValue } from "../format.js";
import { getColor } from "../colors.js";
import { getTestByName, hasBackpressure, DATA_LOSS_THRESHOLD_PCT } from "../data.js";
import { TIMESERIES_METRICS, SCALAR_ONLY_METRICS, tmTitle, metricLabel } from "../metrics.js";
import { renderEnvDetail } from "../env.js";
import { createLineChart } from "../charts.js";

export class DetailPanel extends LitElement {
  static properties = {
    suiteData: { attribute: false },
    comparison: { attribute: false },
    selSuite: { attribute: false },
    selTest: { attribute: false },
  };

  constructor() {
    super();
    this.selSuite = 0;
    this.selTest = "";
    this._miniCharts = [];
  }

  createRenderRoot() { return this; }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyMiniCharts();
  }

  _destroyMiniCharts() {
    for (const c of this._miniCharts) c.destroy();
    this._miniCharts = [];
  }

  render() {
    if (!this.comparison) return html``;
    return html`${unsafeHTML(this._markup())}`;
  }

  _markup() {
    const suiteData = this.suiteData || {};
    const comparison = this.comparison;
    const tests = comparison.tests || [];
    const refs = comparison.suites || [];
    const origIdx = comparison._originalIndices || null;

    if (refs.length === 0) {
      return '<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="muted" style="padding:12px 0">No suites match the current filters.</div></div>';
    }

    const ref = refs[this.selSuite];
    const test = ref ? getTestByName(suiteData, ref.slug, this.selTest) : null;
    const metrics = test ? (test.metrics || []) : [];
    const getAgg = (n) => { const m = metrics.find((x) => x.name === n); return m && typeof m.value === "number" && Number.isFinite(m.value) ? m : null; };

    const pillsHtml = refs.map((rf, i) => {
      const ci = origIdx ? origIdx[i] : i;
      return `<button class="detail-pill ${i === this.selSuite ? "active" : ""}" style="--pill-color: ${getColor(ci)}" data-suite-idx="${i}" type="button">${escapeHtml(rf.short || rf.name)}</button>`;
    }).join("");

    const testOptsHtml = tests.map((ct) => `<option value="${escapeHtml(ct.name)}" ${ct.name === this.selTest ? "selected" : ""}>${escapeHtml(ct.label)}</option>`).join("");

    let filesHtml = '<div class="muted">No files available.</div>';
    if (test) {
      const files = [...(test.configFiles || [])].sort();
      if (files.length) filesHtml = `<div class="files-flex">${files.map((f) => `<div class="file-list-item" data-file="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join("")}</div>`;
    }

    const envHtml = ref ? renderEnvDetail(suiteData[ref.slug] ? suiteData[ref.slug].env : null) : "";

    const selTestCfg = tests.find((ct) => ct.name === this.selTest);
    const lr = selTestCfg ? selTestCfg.loadgen_rate : null;
    const bpBadge = hasBackpressure(metrics, lr) ? '<div class="detail-backpressure-badge">⚠ Backpressure detected</div>' : "";

    let scalarsHtml = "";
    if (test && metrics.length) {
      const cards = SCALAR_ONLY_METRICS.map((sm) => { const m = getAgg(sm.name); if (!m) return ""; const bad = sm.name === "dropped_logs_percentage" && m.value > DATA_LOSS_THRESHOLD_PCT;
        return `<div class="metric-scalar-card${bad ? " backpressure" : ""}"><div class="metric-scalar-name">${escapeHtml(metricLabel(sm.name))}</div><div class="metric-scalar-value">${formatMetricValue(m.value, m.unit)}</div></div>`; }).filter(Boolean).join("");
      if (cards) scalarsHtml = `<div class="metric-scalars">${cards}</div>`;
    }

    const ts = test ? (test.timeseries || null) : null;
    let chartsHtml = "";
    if (test) {
      const cards = TIMESERIES_METRICS.map((tm) => {
        const parts = [];
        if (tm.avg) { const m = getAgg(tm.avg); if (m) parts.push(`<span>${tm.max ? "Avg: " : ""}${formatMetricValue(m.value, m.unit || tm.unit)}</span>`); }
        if (tm.max) { const m = getAgg(tm.max); if (m) parts.push(`<span>Max: ${formatMetricValue(m.value, m.unit || tm.unit)}</span>`); }
        if (!parts.length) return "";
        const hasSeries = ts && ts[tm.key] && ts[tm.key].length > 1;
        return `<div class="metric-chart-card" data-ts-key="${escapeHtml(tm.key)}"><div class="metric-chart-header"><div class="metric-chart-name">${escapeHtml(tmTitle(tm))}</div><div class="metric-chart-values">${parts.join("")}</div></div>${hasSeries ? '<div class="metric-chart-body"><canvas></canvas></div>' : '<div class="muted" style="font-size:12px">No time-series data available.</div>'}</div>`;
      }).filter(Boolean).join("");
      if (cards) chartsHtml = `<div class="metric-chart-grid">${cards}</div>`;
    }

    if (!test) {
      return `<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="detail-controls"><div class="detail-pills">${pillsHtml}</div><select class="detail-test-select">${testOptsHtml}</select></div>${envHtml}<div class="muted" style="padding:12px 0">No data available for this selection.</div></div>`;
    }
    return `<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="detail-controls"><div class="detail-pills">${pillsHtml}</div><select class="detail-test-select">${testOptsHtml}</select></div>${bpBadge}<div class="files-section"><div class="detail-pane-title">Files</div>${filesHtml}</div>${envHtml}<div class="detail-pane-title" style="margin-top:16px">Metrics</div>${scalarsHtml}${chartsHtml || '<div class="muted">No metrics available.</div>'}</div>`;
  }

  updated() {
    this._destroyMiniCharts();
    if (!this.comparison) return;
    const suiteData = this.suiteData || {};
    const comparison = this.comparison;
    const refs = comparison.suites || [];
    if (refs.length === 0) return;

    const origIdx = comparison._originalIndices || null;
    const ref = refs[this.selSuite];
    const test = ref ? getTestByName(suiteData, ref.slug, this.selTest) : null;

    for (const pill of this.querySelectorAll(".detail-pill")) {
      pill.onclick = () => this._select(Number(pill.dataset.suiteIdx), this.selTest);
    }
    const sel = this.querySelector(".detail-test-select");
    if (sel) sel.onchange = () => this._select(this.selSuite, sel.value);

    if (test && ref) {
      for (const item of this.querySelectorAll(".file-list-item")) {
        item.onclick = () => this.dispatchEvent(new CustomEvent("open-file", {
          bubbles: true, composed: true,
          detail: { suiteSlug: ref.slug, testName: this.selTest, fileName: item.dataset.file },
        }));
      }
    }

    const ts = test ? (test.timeseries || null) : null;
    if (test && ts) {
      const ci = origIdx ? origIdx[this.selSuite] : this.selSuite;
      const color = getColor(ci);
      for (const card of this.querySelectorAll(".metric-chart-card[data-ts-key]")) {
        const series = ts[card.dataset.tsKey];
        if (!series || series.length < 2) continue;
        const cv = card.querySelector("canvas");
        if (cv) this._miniCharts.push(createLineChart(cv, series, color));
      }
    }
  }

  // Update local selection and notify the parent so the bar-chart click
  // target and panel stay in lockstep.
  _select(suiteIdx, testName) {
    this.selSuite = suiteIdx;
    this.selTest = testName;
    this.dispatchEvent(new CustomEvent("selection-change", {
      bubbles: true, composed: true,
      detail: { suiteIdx, testName },
    }));
  }
}

customElements.define("detail-panel", DetailPanel);
