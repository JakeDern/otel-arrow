// ── <line-chart> ────────────────────────────────────────────────────────────
// Custom element wrapping a Chart.js line chart -- used by <detail-panel> for
// the per-metric sparklines. Owns its own <canvas>, the Chart instance, and
// every Chart.js-specific option.
//
// Consumers use it like:
//
//     const el = document.createElement("line-chart");
//     el.setData({ series, color });
//     parent.appendChild(el);
//
// Subsequent setData() calls reuse the existing Chart instance and call
// chart.update("none") so a colour / series swap is in-place.

import { formatMetricValue } from "../format.js";
import { adopt, tokensSheet } from "../styles.js";
import { SLATE_100, SLATE_200, SLATE_400, TOOLTIP_BG } from "../colors.js";

const css = `
/* Fill the parent's box -- typically .metric-chart-body in <detail-panel>,
 * which sets the actual height. Chart.js with maintainAspectRatio: false
 * reads dimensions from the canvas's immediate parent (this element), so
 * if we don't take up the parent's box the canvas can't size itself. */
line-chart {
    display: block;
    position: relative;
    width: 100%;
    height: 100%;
}
line-chart canvas {
    display: block;
    width: 100%;
    height: 100%;
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

/**
 * Inputs accepted by `<line-chart>.setData()`.
 *
 * @typedef {Object} LineChartInput
 * @property {Array<{t: number, value: number}>} series Time-series points.
 * @property {string} color Stroke colour for the line.
 */

/**
 * Line-chart custom element. Lazily creates the Chart on first setData() and
 * reuses it on subsequent calls. Destroyed automatically on disconnect (so
 * parents that re-render via innerHTML don't have to track instances).
 */
export class LineChart extends HTMLElement {
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
     * @param {LineChartInput} input
     */
    setData(input) {
        if (!this.isConnected || !this._canvas) {
            this._pendingInput = input;
            return;
        }
        if (this._chart) this._update(input);
        else this._create(input);
    }

    _create({ series, color }) {
        this._chart = new Chart(this._canvas, {
            type: "line",
            data: {
                labels: series.map((p) => p.t),
                datasets: [{
                    data: series.map((p) => p.value),
                    borderColor: color,
                    // Point fill defaults to the dataset's backgroundColor;
                    // without this, Chart.js falls back to its built-in blue.
                    backgroundColor: color,
                    borderWidth: 2,
                    pointRadius: 2.5,
                    pointHitRadius: 6,
                    tension: 0.3,
                    fill: false,
                }],
            },
            options: chartOptions(),
        });
    }

    _update({ series, color }) {
        const ch = this._chart;
        ch.data.labels = series.map((p) => p.t);
        const ds = ch.data.datasets[0];
        ds.data = series.map((p) => p.value);
        ds.borderColor = color;
        ds.backgroundColor = color;
        ch.update("none");
    }

    _destroy() {
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
    }

    /**
     * Swap the line's stroke colour in place without rebuilding the chart.
     * Caller derives the new colour from the page's palette state (the
     * line chart has no own palette state -- the colour is passed in).
     */
    refreshPalette(color) {
        if (!this._chart) return;
        const ds = this._chart.data.datasets[0];
        if (ds) { ds.borderColor = color; ds.backgroundColor = color; }
        this._chart.update("none");
    }
}

customElements.define("line-chart", LineChart);

function chartOptions() {
    return {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 4, right: 4 } },
        scales: {
            x: {
                type: "linear",
                grid: { display: false },
                border: { display: true, color: SLATE_200 },
                ticks: {
                    maxTicksLimit: 5, color: SLATE_400, font: { size: 9 },
                    callback: (v) => `${Math.round(v)}s`,
                },
            },
            y: {
                beginAtZero: false,
                grid: { color: SLATE_100 },
                border: { display: false },
                ticks: {
                    maxTicksLimit: 4, color: SLATE_400, font: { size: 9 },
                    callback: (v) => formatMetricValue(v, ""),
                },
            },
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: TOOLTIP_BG, cornerRadius: 4, padding: 8,
                titleFont: { size: 11 }, bodyFont: { size: 11 },
                callbacks: {
                    title: (items) => `${Math.round(items[0].parsed.x)}s`,
                    label: (ctx) => formatMetricValue(ctx.parsed.y, ""),
                },
            },
        },
    };
}
