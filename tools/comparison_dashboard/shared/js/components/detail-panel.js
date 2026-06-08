// ── <detail-panel> ───────────────────────────────────────────────────────────
// Lower detail pane: suite pills, test <select>, scalar metric cards, per-metric
// time-series line charts, config file list, and the run environment. Native
// custom element. Data comes in via setData(); user-driven selection changes
// emit a bubbling `selection-change` event; file clicks emit a bubbling
// `open-file` event (handled by <file-modal>). A programmatic setSelection()
// (used by the chart's bar-click) re-renders without emitting.

import { getTestByName } from "../data.js";
import { getColor } from "../colors.js";
import { escapeHtml, formatMetricValue, metricLabel } from "../format.js";
import { hasBackpressure, DATA_LOSS_THRESHOLD } from "../backpressure.js";
import { SCALAR_ONLY_METRICS, TIMESERIES_METRICS, tmTitle } from "../metrics.js";
import { renderEnvDetail } from "../env.js";
import { adopt, tokensSheet } from "../styles.js";
import { WARNING_SIGN } from "../icons.js";
import "./line-chart.js";

const css = `
.detail-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
}
.detail-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.detail-pill {
    appearance: none;
    border: 1px solid var(--slate-300);
    background: var(--white);
    color: var(--slate-600);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .04em;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    flex-shrink: 0;
    min-width: 120px;
    white-space: nowrap;
    text-align: center;
}
.detail-pill:hover { background: var(--slate-50); }
.detail-pill.active {
    border-color: var(--pill-color, var(--blue-500));
    background: color-mix(in srgb, var(--pill-color, var(--blue-500)) 10%, white);
    color: color-mix(in srgb, var(--pill-color, var(--blue-500)) 80%, black);
}
.detail-test-select {
    font-size: 0.85rem;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--white);
    color: var(--text);
    min-width: 140px;
}
.detail-pane-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .04em;
    margin-bottom: 8px;
}

.files-section { margin-bottom: 16px; }
.files-flex {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.file-list-item {
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--white);
    font-size: 12px;
    font-family: var(--font-mono);
    cursor: pointer;
    color: var(--accent);
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
}
.file-list-item:hover {
    background: var(--slate-50);
    border-color: var(--blue-200);
}

.metric-scalars {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}
.metric-scalar-card {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    background: var(--white);
}
.metric-scalar-card.backpressure {
    border-color: var(--bad-border);
    background: var(--bad-bg);
}
.metric-scalar-card.backpressure .metric-scalar-name,
.metric-scalar-card.backpressure .metric-scalar-value { color: var(--bad-text); }
.metric-scalar-name {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .04em;
}
.metric-scalar-value {
    font-size: 18px;
    font-weight: 650;
    margin-top: 2px;
}

.metric-chart-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
}
.metric-chart-card {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--white);
}
.metric-chart-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
    gap: 8px;
    flex-wrap: wrap;
}
.metric-chart-name { font-size: 13px; font-weight: 600; }
.metric-chart-values {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    gap: 10px;
}
.metric-chart-values span { white-space: nowrap; }
.metric-chart-body { position: relative; height: 120px; }
@media (max-width: 768px) {
    .metric-chart-grid { grid-template-columns: 1fr; }
}

.detail-backpressure-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--bad-border);
    border-radius: var(--radius-sm);
    background: var(--bad-bg);
    color: var(--bad-text);
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 12px;
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

export class DetailPanel extends HTMLElement {
    setData(suiteData, comparison, tests, suiteIdx, testName) {
        this._suiteData = suiteData;
        this._comparison = comparison;
        this._tests = tests;
        this._selSuite = suiteIdx;
        this._selTest = testName;
        if (this.isConnected) this.render();
    }

    connectedCallback() { if (this._comparison) this.render(); }

    // Programmatic selection (bar click). Re-render but do not emit.
    setSelection(si, tn) { this._selSuite = si; this._selTest = tn; this.render(); }

    // User-driven selection (pill / test select). Emit then re-render.
    _select(si, tn) {
        this._selSuite = si;
        this._selTest = tn;
        this.dispatchEvent(new CustomEvent("selection-change", { detail: { suiteIdx: si, testName: tn }, bubbles: true }));
        this.render();
    }

    render() {
        // Re-rendering via innerHTML removes any prior <line-chart> children
        // from the DOM, triggering their disconnectedCallback -- no explicit
        // chart cleanup is required.
        const suiteData = this._suiteData;
        const comparison = this._comparison;
        const tests = this._tests || [];
        const refs = comparison.suites || [];
        const origIdx = comparison._originalIndices || null;

        if (refs.length === 0) {
            this.innerHTML = '<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="muted" style="padding:12px 0">No suites match the current filters.</div></div>';
            return;
        }

        const ref = refs[this._selSuite];
        const test = ref ? getTestByName(suiteData, ref.slug, this._selTest) : null;
        const metrics = test ? (test.metrics || []) : [];
        const ts = test ? (test.timeseries || null) : null;
        const getAgg = (n) => { const m = metrics.find((x) => x.name === n); return m && typeof m.value === "number" && Number.isFinite(m.value) ? m : null; };

        const pillsHtml = refs.map((r, i) => {
            const ci = origIdx ? origIdx[i] : i;
            return `<button class="detail-pill ${i === this._selSuite ? "active" : ""}" style="--pill-color: ${getColor(ci)}" data-suite-idx="${i}" type="button">${escapeHtml(r.short || r.name)}</button>`;
        }).join("");

        const testOptsHtml = tests.map((ct) => `<option value="${escapeHtml(ct.name)}" ${ct.name === this._selTest ? "selected" : ""}>${escapeHtml(ct.label)}</option>`).join("");

        let filesHtml = '<div class="muted">No files available.</div>';
        if (test) {
            const files = [...(test.configFiles || [])].sort();
            if (files.length) filesHtml = `<div class="files-flex">${files.map((f) => `<div class="file-list-item" data-file="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join("")}</div>`;
        }

        const envHtml = ref ? renderEnvDetail(suiteData[ref.slug] ? suiteData[ref.slug].env : null) : "";

        const selTestCfg = tests.find((ct) => ct.name === this._selTest);
        const lr = selTestCfg ? selTestCfg.loadgen_rate : null;
        const bpBadge = hasBackpressure(metrics, lr) ? `<div class="detail-backpressure-badge">${WARNING_SIGN} Backpressure detected</div>` : "";

        let scalarsHtml = "";
        if (test && metrics.length) {
            const cards = SCALAR_ONLY_METRICS.map((sm) => {
                const m = getAgg(sm.name); if (!m) return ""; const bad = sm.name === "dropped_logs_percentage" && m.value > DATA_LOSS_THRESHOLD;
                return `<div class="metric-scalar-card${bad ? " backpressure" : ""}"><div class="metric-scalar-name">${escapeHtml(metricLabel(sm.name))}</div><div class="metric-scalar-value">${formatMetricValue(m.value, m.unit)}</div></div>`;
            }).filter(Boolean).join("");
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
                return `<div class="metric-chart-card" data-ts-key="${escapeHtml(tm.key)}"><div class="metric-chart-header"><div class="metric-chart-name">${escapeHtml(tmTitle(tm))}</div><div class="metric-chart-values">${parts.join("")}</div></div>${hasSeries ? '<div class="metric-chart-body"><line-chart></line-chart></div>' : '<div class="muted" style="font-size:12px">No time-series data available.</div>'}</div>`;
            }).filter(Boolean).join("");
            if (cards) chartsHtml = `<div class="metric-chart-grid">${cards}</div>`;
        }

        if (!test) {
            this.innerHTML = `<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="detail-controls"><div class="detail-pills">${pillsHtml}</div><select class="detail-test-select">${testOptsHtml}</select></div>${envHtml}<div class="muted" style="padding:12px 0">No data available for this selection.</div></div>`;
        } else {
            this.innerHTML = `<div class="scenario-section"><div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div><div class="detail-controls"><div class="detail-pills">${pillsHtml}</div><select class="detail-test-select">${testOptsHtml}</select></div>${bpBadge}<div class="files-section"><div class="detail-pane-title">Files</div>${filesHtml}</div>${envHtml}<div class="detail-pane-title" style="margin-top:16px">Metrics</div>${scalarsHtml}${chartsHtml || '<div class="muted">No metrics available.</div>'}</div>`;
        }

        for (const pill of this.querySelectorAll(".detail-pill")) pill.onclick = () => this._select(Number(pill.dataset.suiteIdx), this._selTest);
        const ts2 = this.querySelector(".detail-test-select");
        if (ts2) ts2.onchange = () => this._select(this._selSuite, ts2.value);
        if (test && ref) for (const item of this.querySelectorAll(".file-list-item")) item.onclick = () => this.dispatchEvent(new CustomEvent("open-file", { detail: { slug: ref.slug, test: this._selTest, file: item.dataset.file }, bubbles: true }));
        if (test && ts) {
            const ci = origIdx ? origIdx[this._selSuite] : this._selSuite;
            const color = getColor(ci);
            for (const card of this.querySelectorAll(".metric-chart-card[data-ts-key]")) {
                const series = ts[card.dataset.tsKey];
                if (!series || series.length < 2) continue;
                const chart = card.querySelector("line-chart");
                if (chart) chart.setData({ series, color });
            }
        }
    }
}

customElements.define("detail-panel", DetailPanel);
