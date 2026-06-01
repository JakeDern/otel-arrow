// ── Comparison page: test detail panel ──────────────────────────────────────
// Renders the lower detail pane: suite pills, test selector, scalar metric
// cards, per-metric time-series line charts, the config file list, and the
// run environment. Returns a setSelection(suiteIdx, testName) callback so the
// chart's bar-click handler can drive the panel.

import { getTestByName } from "./data.js";
import { getColor } from "./charts/colors.js";
import { escapeHtml, formatMetricValue, metricLabel } from "./format.js";
import { hasBackpressure, DATA_LOSS_THRESHOLD } from "./backpressure.js";
import { SCALAR_ONLY_METRICS, TIMESERIES_METRICS, tmTitle } from "./metrics.js";
import { renderEnvDetail } from "./env.js";
import { createLineChart } from "./charts/line.js";
import { openFileModal } from "./modal.js";

export function renderComparisonDetail(suiteData, comparison, tests, initialSuiteIdx, initialTestName, onSelectionChange) {
  const target = document.getElementById("comparison-detail");
  if (!target) return () => {};
  const refs = comparison.suites || [];
  const origIdx = comparison._originalIndices || null;
  let selSuite = initialSuiteIdx, selTest = initialTestName;
  let miniCharts = [];

  function setSelection(si, tn) { selSuite = si; selTest = tn; render(); }

  function render() {
    for (const c of miniCharts) c.destroy();
    miniCharts = [];
    if (refs.length === 0) {
      target.innerHTML = '<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="muted" style="padding:12px 0">No suites match the current filters.</div></div>';
      return;
    }

    const ref = refs[selSuite];
    const test = ref ? getTestByName(suiteData, ref.slug, selTest) : null;
    const metrics = test ? (test.metrics || []) : [];
    const ts = test ? (test.timeseries || null) : null;
    const getAgg = (n) => { const m = metrics.find((x) => x.name === n); return m && typeof m.value === "number" && Number.isFinite(m.value) ? m : null; };

    const pillsHtml = refs.map((r, i) => {
      const ci = origIdx ? origIdx[i] : i;
      return `<button class="detail-pill ${i === selSuite ? "active" : ""}" style="--pill-color: ${getColor(ci)}" data-suite-idx="${i}" type="button">${escapeHtml(r.short || r.name)}</button>`;
    }).join("");

    const testOptsHtml = tests.map((ct) => `<option value="${escapeHtml(ct.name)}" ${ct.name === selTest ? "selected" : ""}>${escapeHtml(ct.label)}</option>`).join("");

    let filesHtml = '<div class="muted">No files available.</div>';
    if (test) {
      const files = [...(test.configFiles || [])].sort();
      if (files.length) filesHtml = `<div class="files-flex">${files.map((f) => `<div class="file-list-item" data-file="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join("")}</div>`;
    }

    const envHtml = ref ? renderEnvDetail(suiteData[ref.slug] ? suiteData[ref.slug].env : null) : "";

    const selTestCfg = tests.find((ct) => ct.name === selTest);
    const lr = selTestCfg ? selTestCfg.loadgen_rate : null;
    const bpBadge = hasBackpressure(metrics, lr) ? '<div class="detail-backpressure-badge">\u26A0 Backpressure detected</div>' : "";

    let scalarsHtml = "";
    if (test && metrics.length) {
      const cards = SCALAR_ONLY_METRICS.map((sm) => { const m = getAgg(sm.name); if (!m) return ""; const bad = sm.name === "dropped_logs_percentage" && m.value > DATA_LOSS_THRESHOLD;
        return `<div class="metric-scalar-card${bad ? " backpressure" : ""}"><div class="metric-scalar-name">${escapeHtml(metricLabel(sm.name))}</div><div class="metric-scalar-value">${formatMetricValue(m.value, m.unit)}</div></div>`; }).filter(Boolean).join("");
      if (cards) scalarsHtml = `<div class="metric-scalars">${cards}</div>`;
    }

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
      target.innerHTML = `<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="detail-controls"><div class="detail-pills">${pillsHtml}</div><select class="detail-test-select">${testOptsHtml}</select></div>${envHtml}<div class="muted" style="padding:12px 0">No data available for this selection.</div></div>`;
    } else {
      target.innerHTML = `<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="detail-controls"><div class="detail-pills">${pillsHtml}</div><select class="detail-test-select">${testOptsHtml}</select></div>${bpBadge}<div class="files-section"><div class="detail-pane-title">Files</div>${filesHtml}</div>${envHtml}<div class="detail-pane-title" style="margin-top:16px">Metrics</div>${scalarsHtml}${chartsHtml || '<div class="muted">No metrics available.</div>'}</div>`;
    }

    for (const pill of target.querySelectorAll(".detail-pill")) pill.onclick = () => { selSuite = Number(pill.dataset.suiteIdx); if (onSelectionChange) onSelectionChange(selSuite, selTest); render(); };
    const ts2 = target.querySelector(".detail-test-select");
    if (ts2) ts2.onchange = () => { selTest = ts2.value; if (onSelectionChange) onSelectionChange(selSuite, selTest); render(); };
    if (test && ref) for (const item of target.querySelectorAll(".file-list-item")) item.onclick = () => openFileModal(ref.slug, selTest, item.dataset.file);
    if (test && ts) {
      const ci = origIdx ? origIdx[selSuite] : selSuite;
      const color = getColor(ci);
      for (const card of target.querySelectorAll(".metric-chart-card[data-ts-key]")) {
        const series = ts[card.dataset.tsKey];
        if (!series || series.length < 2) continue;
        const cv = card.querySelector("canvas");
        if (cv) miniCharts.push(createLineChart(cv, series, color));
      }
    }
  }

  render();
  return setSelection;
}
