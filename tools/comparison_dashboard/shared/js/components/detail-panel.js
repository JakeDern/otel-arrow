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
import { SCALAR_ONLY_METRICS } from "../metrics.js";
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
    setSelection(si, tn) {
        this._selSuite = si;
        this._selTest = tn;
        this._syncSelection();
    }

    // User-driven selection (pill / test select). Emit then re-render.
    _select(si, tn) {
        this._selSuite = si;
        this._selTest = tn;
        this.dispatchEvent(new CustomEvent("selection-change", { detail: { suiteIdx: si, testName: tn }, bubbles: true }));
        this._syncSelection();
    }

    /**
     * Surgical update for selection-only changes (pill / test-select / bar
     * click). Updates the dynamic regions in place and reuses the existing
     * `<line-chart>` Chart.js instances via setData(), avoiding the destroy +
     * recreate cycle on every interaction. Falls back to full render() when
     * the scaffold doesn't match the new selection (chart key list differs,
     * pill count differs, or scaffold doesn't exist yet).
     */
    _syncSelection() {
        const pillsContainer = this.querySelector(".detail-pills");
        if (!pillsContainer) { this.render(); return; }

        const refs = (this._comparison && this._comparison.suites) || [];
        const existingPills = pillsContainer.querySelectorAll(".detail-pill");
        if (existingPills.length !== refs.length) { this.render(); return; }

        const ref = refs[this._selSuite];
        const test = ref ? getTestByName(this._suiteData, ref.slug, this._selTest) : null;

        // If the chart key list differs between the prior and new selection,
        // the chart card grid has to be rebuilt -- bail to full render.
        const newKeys = computeChartKeys(test);
        const currentKeys = [...this.querySelectorAll(".metric-chart-card[data-ts-key]")].map((c) => c.dataset.tsKey);
        if (!arraysEqual(newKeys, currentKeys)) { this.render(); return; }

        // From here on: surgical updates to existing DOM nodes.
        for (const pill of existingPills) {
            const i = Number(pill.dataset.suiteIdx);
            pill.classList.toggle("active", i === this._selSuite);
        }
        const testSelect = this.querySelector(".detail-test-select");
        if (testSelect) testSelect.value = this._selTest;

        const metrics = test ? (test.metrics || []) : [];
        const ts = test ? (test.timeseries || null) : null;
        const getAgg = makeGetAgg(metrics);
        const selTestCfg = (this._tests || []).find((ct) => ct.name === this._selTest);
        const lr = selTestCfg ? selTestCfg.loadgen_rate : null;

        this.querySelector("[data-slot=bp]").innerHTML = buildBpBadgeHtml(metrics, lr);
        this.querySelector("[data-slot=files-body]").innerHTML = buildFilesBodyHtml(test);
        this.querySelector("[data-slot=env]").innerHTML = buildEnvHtml(ref, this._suiteData);
        this.querySelector("[data-slot=scalars]").innerHTML = buildScalarsHtml(test, getAgg);
        // The "Metrics" head + "No metrics available" fallback live in the
        // metrics-empty slot; only one of (scalars / charts / fallback) is
        // populated. Toggle the fallback visibility based on actual content.
        const hasAnyMetric = !!(test && (newKeys.length || hasAnyScalar(getAgg)));
        const fallback = this.querySelector("[data-slot=metrics-fallback]");
        if (fallback) fallback.innerHTML = hasAnyMetric ? "" : '<div class="muted">No metrics available.</div>';

        // Chart cards: update headers in place, then re-wire data on each
        // existing <line-chart>. The line-chart elements stay mounted, so
        // Chart.js destroy/create is avoided.
        const origIdx = this._comparison._originalIndices || null;
        const activeCi = origIdx ? origIdx[this._selSuite] : this._selSuite;
        const color = getColor(activeCi);
        for (const card of this.querySelectorAll(".metric-chart-card[data-ts-key]")) {
            const key = card.dataset.tsKey;
            const titleEl = card.querySelector(".metric-chart-name");
            const valuesEl = card.querySelector(".metric-chart-values");
            if (titleEl) titleEl.textContent = chartCardTitle(key, getAgg);
            if (valuesEl) valuesEl.innerHTML = chartCardValuesHtml(key, getAgg);
            const series = ts && ts[key];
            const chart = card.querySelector("line-chart");
            if (chart && series && series.length > 1) chart.setData({ series, color });
        }

        // Files-list click handlers are re-wired because the file list itself
        // was rebuilt by buildFilesBodyHtml above.
        this._wireFileClicks(ref);
    }

    /**
     * Repaint pills + line-chart strokes with the active palette without
     * rebuilding the panel. Drives both the `--pill-color` CSS variable on
     * each `.detail-pill` and the active suite's colour into each
     * `<line-chart>` child via its own refreshPalette().
     */
    refreshPalette() {
        const comparison = this._comparison;
        if (!comparison) return;
        const origIdx = comparison._originalIndices || null;

        for (const pill of this.querySelectorAll(".detail-pill")) {
            const i = Number(pill.dataset.suiteIdx);
            const ci = origIdx ? origIdx[i] : i;
            pill.style.setProperty("--pill-color", getColor(ci));
        }

        const activeCi = origIdx ? origIdx[this._selSuite] : this._selSuite;
        const color = getColor(activeCi);
        for (const chart of this.querySelectorAll("line-chart")) {
            chart.refreshPalette(color);
        }
    }

    /**
     * Full scaffold rebuild. Called on first connect, on setData (comparison
     * / tests changed), and as a fall-back from _syncSelection when the
     * scaffold can't be reused. Re-rendering via innerHTML removes any
     * prior <line-chart> children, triggering their disconnectedCallback --
     * no explicit chart cleanup is required.
     */
    render() {
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
        const getAgg = makeGetAgg(metrics);
        const selTestCfg = tests.find((ct) => ct.name === this._selTest);
        const lr = selTestCfg ? selTestCfg.loadgen_rate : null;

        const pillsHtml = buildPillsHtml(refs, this._selSuite, origIdx);
        const testOptsHtml = buildTestOptsHtml(tests, this._selTest);
        const bpHtml = buildBpBadgeHtml(metrics, lr);
        const filesBodyHtml = buildFilesBodyHtml(test);
        const envHtml = buildEnvHtml(ref, suiteData);
        const scalarsHtml = buildScalarsHtml(test, getAgg);
        const chartKeys = computeChartKeys(test);
        const chartsHtml = chartKeys.length
            ? `<div class="metric-chart-grid">${chartKeys.map((k) => buildChartCard(k, getAgg)).join("")}</div>`
            : "";
        const metricsFallback = !chartKeys.length && !hasAnyScalar(getAgg)
            ? '<div class="muted">No metrics available.</div>'
            : "";

        if (!test) {
            this.innerHTML = `<div class="scenario-section">
                <div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div>
                <div class="detail-controls">
                    <div class="detail-pills">${pillsHtml}</div>
                    <select class="detail-test-select">${testOptsHtml}</select>
                </div>
                <div data-slot="env">${envHtml}</div>
                <div class="muted" style="padding:12px 0">No data available for this selection.</div>
            </div>`;
        } else {
            this.innerHTML = `<div class="scenario-section">
                <div class="scenario-section-head"><div class="scenario-section-title">Test Details</div></div>
                <div class="detail-controls">
                    <div class="detail-pills">${pillsHtml}</div>
                    <select class="detail-test-select">${testOptsHtml}</select>
                </div>
                <div data-slot="bp">${bpHtml}</div>
                <div class="files-section">
                    <div class="detail-pane-title">Files</div>
                    <div data-slot="files-body">${filesBodyHtml}</div>
                </div>
                <div data-slot="env">${envHtml}</div>
                <div class="detail-pane-title" style="margin-top:16px">Metrics</div>
                <div data-slot="scalars">${scalarsHtml}</div>
                <div data-slot="charts">${chartsHtml}</div>
                <div data-slot="metrics-fallback">${metricsFallback}</div>
            </div>`;
        }

        for (const pill of this.querySelectorAll(".detail-pill")) {
            pill.onclick = () => this._select(Number(pill.dataset.suiteIdx), this._selTest);
        }
        const ts2 = this.querySelector(".detail-test-select");
        if (ts2) ts2.onchange = () => this._select(this._selSuite, ts2.value);
        this._wireFileClicks(ref);
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

    /** Re-wire `open-file` event dispatch from the (possibly rebuilt) file list. */
    _wireFileClicks(ref) {
        if (!ref) return;
        for (const item of this.querySelectorAll(".file-list-item")) {
            item.onclick = () => this.dispatchEvent(new CustomEvent("open-file", {
                detail: { slug: ref.slug, test: this._selTest, file: item.dataset.file },
                bubbles: true,
            }));
        }
    }
}

customElements.define("detail-panel", DetailPanel);

/**
 * Build one chart-card HTML for a timeseries key. Looks up scalar companions
 * (`<key>_avg`, `<key>_max`, then bare `<key>`) in the test's metric records
 * for the Avg:/Max: annotation values. Title + unit come from the same metric
 * records via metricTitle().
 *
 *   - Both _avg and _max present  -> "Avg: X | Max: Y"
 *   - Only _avg present           -> just the value, no prefix
 *   - Only _max present           -> "Max: X"
 *   - Bare `<key>` only           -> just the value, no prefix
 *   - Nothing                     -> still render the card (with empty
 *                                    annotation row) since the timeseries
 *                                    itself is the primary data.
 *
 * Unit on the annotation comes from the matching metric record; unit on the
 * card title is whatever metricTitle() resolves (which walks the suite data
 * to find any record carrying a unit for that name).
 *
 * @param {string} key                 Timeseries lookup key.
 * @param {(name: string) => Object | null} getAgg
 *        Looks up a scalar metric record by name in the current test's
 *        metric records; returns null if missing or non-finite.
 */
function buildChartCard(key, getAgg) {
    return `<div class="metric-chart-card" data-ts-key="${escapeHtml(key)}">`
        + `<div class="metric-chart-header">`
        + `<div class="metric-chart-name">${escapeHtml(chartCardTitle(key, getAgg))}</div>`
        + `<div class="metric-chart-values">${chartCardValuesHtml(key, getAgg)}</div>`
        + `</div>`
        + `<div class="metric-chart-body"><line-chart></line-chart></div>`
        + `</div>`;
}

function chartCardTitle(key, getAgg) {
    const avgM = getAgg(`${key}_avg`) || getAgg(key);
    const maxM = getAgg(`${key}_max`);
    const unit = (avgM && avgM.unit) || (maxM && maxM.unit) || "";
    const label = metricLabel(key);
    return unit ? `${label} (${unit})` : label;
}

function chartCardValuesHtml(key, getAgg) {
    const avgM = getAgg(`${key}_avg`) || getAgg(key);
    const maxM = getAgg(`${key}_max`);
    const parts = [];
    if (avgM && maxM) {
        parts.push(`<span>Avg: ${formatMetricValue(avgM.value, avgM.unit)}</span>`);
        parts.push(`<span>Max: ${formatMetricValue(maxM.value, maxM.unit)}</span>`);
    } else if (avgM) {
        parts.push(`<span>${formatMetricValue(avgM.value, avgM.unit)}</span>`);
    } else if (maxM) {
        parts.push(`<span>Max: ${formatMetricValue(maxM.value, maxM.unit)}</span>`);
    }
    return parts.join("");
}

// ── Section builders ───────────────────────────────────────────────────────
// Pure HTML producers shared by both render() (full scaffold) and
// _syncSelection() (in-place updates). Keeping them as plain functions
// instead of methods lets the surgical path target individual slots without
// rebuilding the rest.

function buildPillsHtml(refs, selSuite, origIdx) {
    return refs.map((r, i) => {
        const ci = origIdx ? origIdx[i] : i;
        return `<button class="detail-pill ${i === selSuite ? "active" : ""}" style="--pill-color: ${getColor(ci)}" data-suite-idx="${i}" type="button">${escapeHtml(r.short || r.name)}</button>`;
    }).join("");
}

function buildTestOptsHtml(tests, selTest) {
    return tests.map((ct) =>
        `<option value="${escapeHtml(ct.name)}" ${ct.name === selTest ? "selected" : ""}>${escapeHtml(ct.label)}</option>`
    ).join("");
}

function buildBpBadgeHtml(metrics, lr) {
    return hasBackpressure(metrics, lr)
        ? `<div class="detail-backpressure-badge">${WARNING_SIGN} Backpressure detected</div>`
        : "";
}

function buildFilesBodyHtml(test) {
    if (!test) return '<div class="muted">No files available.</div>';
    const files = [...(test.configFiles || [])].sort();
    if (!files.length) return '<div class="muted">No files available.</div>';
    return `<div class="files-flex">${files.map((f) =>
        `<div class="file-list-item" data-file="${escapeHtml(f)}">${escapeHtml(f)}</div>`
    ).join("")}</div>`;
}

function buildEnvHtml(ref, suiteData) {
    if (!ref) return "";
    return renderEnvDetail(suiteData[ref.slug] ? suiteData[ref.slug].env : null);
}

function buildScalarsHtml(test, getAgg) {
    if (!test) return "";
    const cards = SCALAR_ONLY_METRICS.map((sm) => {
        const m = getAgg(sm.name);
        if (!m) return "";
        const bad = sm.name === "dropped_logs_percentage" && m.value > DATA_LOSS_THRESHOLD;
        return `<div class="metric-scalar-card${bad ? " backpressure" : ""}"><div class="metric-scalar-name">${escapeHtml(metricLabel(sm.name))}</div><div class="metric-scalar-value">${formatMetricValue(m.value, m.unit)}</div></div>`;
    }).filter(Boolean).join("");
    return cards ? `<div class="metric-scalars">${cards}</div>` : "";
}

function hasAnyScalar(getAgg) {
    return SCALAR_ONLY_METRICS.some((sm) => getAgg(sm.name));
}

/**
 * The chart-card list for a test: timeseries keys with at least 2 points,
 * sorted by manifest.metrics order (so layout stays stable when keys differ
 * between tests).
 */
function computeChartKeys(test) {
    const ts = test && test.timeseries;
    if (!ts) return [];
    const orderedNames = Object.keys((window.PAGE_DATA || {}).metricsMeta || {});
    const position = new Map(orderedNames.map((n, i) => [n, i]));
    const keys = Object.keys(ts).filter((k) => ts[k] && ts[k].length > 1);
    keys.sort((a, b) => {
        const ia = position.has(a) ? position.get(a) : Infinity;
        const ib = position.has(b) ? position.get(b) : Infinity;
        if (ia === Infinity && ib === Infinity) return a.localeCompare(b);
        return ia - ib;
    });
    return keys;
}

function makeGetAgg(metrics) {
    return (name) => {
        const m = metrics.find((x) => x.name === name);
        return m && typeof m.value === "number" && Number.isFinite(m.value) ? m : null;
    };
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
