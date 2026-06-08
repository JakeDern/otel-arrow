// ── <bar-chart> ──────────────────────────────────────────────────────────────
// Custom element that wraps the global Chart.js bar chart used on the landing
// and comparison-detail pages. Owns its own <canvas>, the Chart instance, and
// every Chart.js-specific concern (dataset shaping, options, custom value-label
// plugin, x-axis hover tooltip wiring).
//
// Consumers use it like:
//
//     const el = document.createElement("bar-chart");
//     el.setData({ suiteData, comparison, tests, selectedMetric, onClick });
//     parent.appendChild(el);
//
// Subsequent setData() calls reuse the existing Chart instance and call
// chart.update() so the chart animates between data shapes.

import {
    getColor,
    SLATE_200, SLATE_300_TRACK, SLATE_400, SLATE_500, SLATE_600, SLATE_900,
    RED_500, WHITE, TOOLTIP_BG,
} from "../colors.js";
import { getSuiteTests } from "../data.js";
import { formatMetricValue } from "../format.js";
import { hasBackpressure } from "../backpressure.js";
import { showTooltip, hideTooltip } from "../tooltip.js";
import { adopt, tokensSheet } from "../styles.js";
import { WARNING_SIGN } from "../icons.js";

const css = `
bar-chart {
    display: block;
    position: relative;
    min-height: 220px;
}
bar-chart canvas {
    display: block;
    width: 100%;
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

/**
 * Inputs accepted by `<bar-chart>.setData()`.
 *
 * @typedef {Object} BarChartInput
 * @property {Object} suiteData            Suite map loaded from data.js files.
 * @property {Object} comparison           Comparison definition (filtered).
 *                                         May include `_originalIndices` so
 *                                         the colour for a suite is stable
 *                                         across filter changes.
 * @property {Array<Object>} tests         Tests selected for this comparison,
 *                                         each `{ name, label, loadgen_rate }`.
 * @property {string} selectedMetric       The metric.name to plot on y.
 * @property {(event: Event, elements: Array) => void} [onClick]
 *                                         Forwarded to Chart.js as
 *                                         `options.onClick`.
 */

/**
 * Bar-chart custom element. The host element owns and sizes the chart's
 * canvas; setData() lazily creates the Chart on first call and reuses it on
 * subsequent calls.
 */
export class BarChart extends HTMLElement {
    connectedCallback() {
        if (!this._canvas) {
            this._canvas = document.createElement("canvas");
            this.appendChild(this._canvas);
        }
        if (this._pendingInput) {
            const input = this._pendingInput;
            this._pendingInput = null;
            this.setData(input);
        }
    }

    disconnectedCallback() { this._destroy(); }

    /**
     * Provide / replace the chart's data. Defers until the element is in the
     * document if called before connectedCallback.
     *
     * @param {BarChartInput} input
     */
    setData(input) {
        if (!this.isConnected || !this._canvas) {
            this._pendingInput = input;
            return;
        }
        this._lastInput = input;
        if (this._chart) this._update(input);
        else this._create(input);
    }

    _create(input) {
        const { suiteData, comparison, tests, selectedMetric, onClick } = input;
        const xTitle = resolveXAxisTitle(comparison);
        this._chart = new Chart(this._canvas, {
            type: "bar",
            data: buildChartData(suiteData, comparison, tests, selectedMetric),
            options: chartOptions(onClick, xTitle),
            plugins: [barValueLabelsPlugin],
        });
        sizeChartContainer(this._chart, this._canvas);
        attachAxisHoverTooltips(this._chart, this._canvas, comparison, tests);
    }

    _update(input) {
        const { suiteData, comparison, tests, selectedMetric } = input;
        const d = buildChartData(suiteData, comparison, tests, selectedMetric);
        this._chart.data.labels = d.labels;
        for (let i = 0; i < d.datasets.length; i++) {
            const src = d.datasets[i];
            const dst = this._chart.data.datasets[i];
            if (!dst) continue;
            dst.data = src.data;
            dst._hasBackpressure = src._hasBackpressure;
            dst._missing = src._missing;
            dst.backgroundColor = src.backgroundColor;
            dst.borderColor = src.borderColor;
        }
        this._chart.update("none");
    }

    _destroy() {
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
        if (this._canvas) detachAxisHoverTooltips(this._canvas);
    }
}

customElements.define("bar-chart", BarChart);

// ── Chart.js options + data shaping ────────────────────────────────────────

/**
 * Build the Chart.js `{ labels, datasets }` payload for a comparison. Each
 * dataset is one suite; missing data points render as striped sentinel bars
 * (so the legend still has a colour swatch even when a suite has no data).
 *
 * @returns {{ labels: string[], datasets: Object[] }}
 */
function buildChartData(suiteData, comparison, tests, selectedMetric) {
    const refs = comparison.suites || [];
    const origIdx = comparison._originalIndices || null;

    // First pass: find the max real value to compute a sentinel height
    // (3% of max) for "data missing" striped bars.
    let maxVal = 0;
    for (const ref of refs) {
        for (const t of getSuiteTests(suiteData, ref.slug)) {
            if (!t.metrics) continue;
            const m = t.metrics.find((x) => x.name === selectedMetric);
            if (m && typeof m.value === "number" && Number.isFinite(m.value)) {
                maxVal = Math.max(maxVal, Math.abs(m.value));
            }
        }
    }
    const sentinel = Math.max(1, maxVal * 0.03);

    const datasets = refs.map((ref, si) => {
        const colorIdx = origIdx ? origIdx[si] : si;
        const color = getColor(colorIdx);
        const pattern = createDiagonalPattern(color);
        const suiteTests = getSuiteTests(suiteData, ref.slug);
        const data = [], bp = [], missing = [];
        for (const ct of tests) {
            const t = suiteTests.find((x) => x.name === ct.name);
            if (!t || !t.metrics) { data.push(sentinel); bp.push(false); missing.push(true); continue; }
            const m = t.metrics.find((x) => x.name === selectedMetric);
            const val = m && typeof m.value === "number" && Number.isFinite(m.value) ? m.value : null;
            if (val === null) { data.push(sentinel); bp.push(false); missing.push(true); }
            else {
                data.push(val);
                bp.push(hasBackpressure(t.metrics, ct.loadgen_rate));
                missing.push(false);
            }
        }
        // Fall back to a scalar colour when no bars will be drawn (e.g. zero
        // published tests). Chart.js reads index 0 of backgroundColor for the
        // legend swatch; an empty array yields black.
        const bgColor = data.length ? data.map((_, i) => missing[i] ? pattern : color) : color;
        const bdColor = data.length ? data.map((_, i) => missing[i] ? `${color}80` : color) : color;
        return {
            label: ref.short || ref.name, data, _hasBackpressure: bp, _missing: missing,
            backgroundColor: bgColor,
            borderColor: bdColor,
            borderWidth: 1,
            borderRadius: 4, borderSkipped: "bottom",
        };
    });
    return { labels: tests.map((t) => t.label), datasets };
}

/** Chart.js options object. */
function chartOptions(onClick, xTitle) {
    return {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 24 } },
        datasets: { bar: { categoryPercentage: 0.85, barPercentage: 0.9 } },
        scales: {
            x: {
                grid: { display: false }, border: { display: false }, ticks: { font: { size: 12, weight: "600" }, color: SLATE_500 },
                title: axisTitleConfig(xTitle),
            },
            y: {
                beginAtZero: true, border: { display: true, color: SLATE_300_TRACK },
                ticks: { maxTicksLimit: 5, color: SLATE_400, font: { size: 10 }, callback: (v) => formatMetricValue(v, "") },
                grid: { color: SLATE_200 },
            },
        },
        plugins: {
            legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, borderRadius: 2, useBorderRadius: true, padding: 16, font: { size: 13 }, color: SLATE_900 } },
            tooltip: {
                backgroundColor: TOOLTIP_BG, cornerRadius: 6, padding: 10, titleFont: { size: 12 }, bodyFont: { size: 12 },
                callbacks: {
                    label: (ctx) => {
                        const ds = ctx.dataset;
                        if ((ds._missing || [])[ctx.dataIndex]) return `${ds.label}: Data missing`;
                        return `${ds.label}: ${formatMetricValue(ctx.parsed.y, "")}`;
                    },
                },
            },
        },
        onClick: onClick || undefined,
    };
}

function axisTitleConfig(text) {
    if (!text) return { display: false };
    return {
        display: true,
        text,
        color: SLATE_600,
        font: { size: 12, weight: "600" },
    };
}

/**
 * Only the x-axis title is configurable; y is left unlabelled because the
 * metric (with unit) is already shown in the chart's title dropdown.
 */
function resolveXAxisTitle(comparison) {
    const axes = chartAxesConfig(comparison);
    return (axes.x && axes.x.title) ? axes.x.title : null;
}

function chartAxesConfig(comparison) {
    return (comparison && comparison.chart && comparison.chart.axes) || {};
}

/** Match container height to the chart + legend so bars don't visually clip. */
function sizeChartContainer(chart, canvas, baseHeight = 220) {
    const legendHeight = chart.legend?.height || 0;
    canvas.parentElement.style.height = `${baseHeight + legendHeight}px`;
    chart.resize();
}

// ── Custom Chart.js plugin: value labels + backpressure warning glyph ──────

const barValueLabelsPlugin = {
    id: "barValueLabels",
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const font = '10px "SF Pro Text", "Segoe UI", system-ui, sans-serif';
        const iconFont = '20px "SF Pro Text", "Segoe UI", system-ui, sans-serif';
        ctx.save();
        for (let dsIdx = 0; dsIdx < chart.data.datasets.length; dsIdx++) {
            const ds = chart.data.datasets[dsIdx];
            const meta = chart.getDatasetMeta(dsIdx);
            if (meta.hidden) continue;
            const flags = ds._hasBackpressure || [];
            const missing = ds._missing || [];
            for (let i = 0; i < meta.data.length; i++) {
                if (missing[i]) continue;
                const value = ds.data[i];
                if (value == null) continue;
                const el = meta.data[i];
                const label = formatMetricValue(value, "");
                ctx.font = font;
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillStyle = flags[i] ? RED_500 : SLATE_500;
                ctx.fillText(label, el.x, el.y - 4);
                if (flags[i]) {
                    ctx.font = iconFont;
                    ctx.textBaseline = "middle";
                    const cy = (el.y + el.base) / 2;
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = WHITE;
                    ctx.strokeText(WARNING_SIGN, el.x, cy);
                    ctx.fillStyle = RED_500;
                    ctx.fillText(WARNING_SIGN, el.x, cy);
                }
            }
        }
        ctx.restore();
    },
};

// ── X-axis hover tooltips ──────────────────────────────────────────────────
// Hovering the x-axis title reveals chart.axes.x.description; hovering an
// individual tick label reveals a per-tick string derived from each test's
// loadgen_rate. Charts are destroyed/recreated on the same <canvas> when
// filters or metrics change, so previously-attached handlers are detached
// before adding new ones to avoid listener accumulation.

function attachAxisHoverTooltips(chart, canvas, comparison, tests) {
    detachAxisHoverTooltips(canvas);
    const axes = chartAxesConfig(comparison);
    const xDesc = axes.x && typeof axes.x.description === "string" && axes.x.description.trim() ? axes.x.description : null;
    const tickTexts = (tests || []).map(tickHoverText);
    const hasTickHovers = tickTexts.some(Boolean);
    if (!xDesc && !hasTickHovers) return;
    // Text width for the x-axis title is static for the chart's lifetime;
    // measure it once instead of recomputing in xTitleBox on every mousemove.
    const xTitleWidth = xDesc ? measureXAxisTitleWidth(chart, canvas) : 0;
    const PAD = 4;
    const onMove = (ev) => {
        const sx = chart.scales && chart.scales.x;
        if (!sx) { hideTooltip(); return; }
        const rect = canvas.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;

        if (xDesc) {
            const box = xTitleBoxFromWidth(sx, xTitleWidth);
            if (box && px >= box.left - PAD && px <= box.right + PAD
                && py >= box.top - PAD && py <= box.bottom + PAD) {
                showTooltip(ev.clientX, ev.clientY, xDesc);
                return;
            }
        }
        if (hasTickHovers) {
            const xLabelH = tickFontSize(sx) + 4;
            if (py >= sx.top - PAD && py <= sx.top + xLabelH + PAD
                && px >= sx.left - PAD && px <= sx.right + PAD) {
                const i = nearestTickIndex(sx, px);
                const text = i >= 0 ? tickTexts[i] : null;
                if (text) { showTooltip(ev.clientX, ev.clientY, text); return; }
            }
        }
        hideTooltip();
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", hideTooltip);
    canvas._axisHoverHandlers = { onMove, onLeave: hideTooltip };
}

function detachAxisHoverTooltips(canvas) {
    const h = canvas._axisHoverHandlers;
    if (!h) return;
    canvas.removeEventListener("mousemove", h.onMove);
    canvas.removeEventListener("mouseleave", h.onLeave);
    canvas._axisHoverHandlers = null;
}

function tickHoverText(test) {
    const r = test && test.loadgen_rate;
    if (!Number.isFinite(r) || r <= 0) return null;
    return `Load rate: ${Number(r).toLocaleString()} signals/sec`;
}

function measureXAxisTitleWidth(chart, canvas) {
    const sx = chart.scales && chart.scales.x;
    const title = sx && sx.options && sx.options.title;
    if (!title || !title.display || !title.text) return 0;
    const ctx = canvas.getContext("2d");
    const size = (title.font && title.font.size) || 12;
    const weight = (title.font && title.font.weight) || "600";
    ctx.save();
    ctx.font = `${weight} ${size}px "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
    const w = ctx.measureText(title.text).width;
    ctx.restore();
    return w;
}

function xTitleBoxFromWidth(sx, width) {
    if (!width) return null;
    const titleOpts = sx.options && sx.options.title;
    const fontSize = (titleOpts && titleOpts.font && titleOpts.font.size) || 12;
    // Heuristic: Chart.js puts the title below the tick labels with ~4px gap.
    const tickH = tickFontSize(sx) + 4;
    const top = sx.top + tickH + 4;
    const cx = (sx.left + sx.right) / 2;
    return { left: cx - width / 2, right: cx + width / 2, top, bottom: top + fontSize + 2 };
}

function tickFontSize(sx) {
    const tickOpts = sx.options && sx.options.ticks;
    return (tickOpts && tickOpts.font && tickOpts.font.size) || 12;
}

function nearestTickIndex(scale, px) {
    const n = scale.ticks ? scale.ticks.length : 0;
    if (!n) return -1;
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < n; i++) {
        const x = scale.getPixelForTick(i);
        const d = Math.abs(x - px);
        if (d < bestDist) { bestDist = d; best = i; }
    }
    // Cap: only count a hit when within half the inter-tick spacing.
    const halfSpan = n > 1 ? Math.abs(scale.getPixelForTick(1) - scale.getPixelForTick(0)) / 2 : (scale.right - scale.left) / 2;
    return bestDist <= halfSpan ? best : -1;
}

// ── Diagonal stripe pattern for missing-data bars ──────────────────────────
// Patterns are cached per colour. clearPatternCache() is exported so the
// colourblind switch can invalidate them when the palette swaps.

const patternCache = new Map();

/** Drop all cached stripe patterns. Called by <dashboard-site> on palette flip. */
export function clearPatternCache() { patternCache.clear(); }

function createDiagonalPattern(color) {
    if (patternCache.has(color)) return patternCache.get(color);
    const size = 8;
    const cv = document.createElement("canvas");
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.moveTo(-size / 2, size / 2);
    ctx.lineTo(size / 2, -size / 2);
    ctx.moveTo(size / 2, size * 1.5);
    ctx.lineTo(size * 1.5, size / 2);
    ctx.stroke();
    const pattern = document.createElement("canvas").getContext("2d").createPattern(cv, "repeat");
    patternCache.set(color, pattern);
    return pattern;
}
