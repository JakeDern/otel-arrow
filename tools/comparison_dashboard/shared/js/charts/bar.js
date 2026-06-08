// ── Comparison bar chart ────────────────────────────────────────────────────
// One grouped bar chart per comparison: x = test (load rate), series = suite,
// y = selected metric. Missing data points render as striped sentinel bars;
// backpressured points get a warning marker (see barValueLabelsPlugin).
// `Chart` is the global from the Chart.js UMD bundle loaded via <script>.

import { getColor } from "./colors.js";
import { createDiagonalPattern } from "./pattern.js";
import { getSuiteTests } from "../data.js";
import { formatMetricValue } from "../format.js";
import { hasBackpressure } from "../backpressure.js";
import { attachAxisHoverTooltips, chartAxesConfig } from "./axis-hover.js";

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
                ctx.fillStyle = flags[i] ? "#ef4444" : "#64748b";
                ctx.fillText(label, el.x, el.y - 4);
                if (flags[i]) {
                    ctx.font = iconFont;
                    ctx.textBaseline = "middle";
                    const cy = (el.y + el.base) / 2;
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = "#ffffff";
                    ctx.strokeText("\u26A0", el.x, cy);
                    ctx.fillStyle = "#ef4444";
                    ctx.fillText("\u26A0", el.x, cy);
                }
            }
        }
        ctx.restore();
    },
};

export function buildComparisonChartData(suiteData, comparison, tests, selectedMetric) {
    const refs = comparison.suites || [];
    const origIdx = comparison._originalIndices || null;

    // First pass: find the max real value to compute a sentinel height
    let maxVal = 0;
    for (const ref of refs) {
        for (const t of getSuiteTests(suiteData, ref.slug)) {
            if (!t.metrics) continue;
            const m = t.metrics.find((x) => x.name === selectedMetric);
            if (m && typeof m.value === "number" && Number.isFinite(m.value)) maxVal = Math.max(maxVal, Math.abs(m.value));
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
        // Fall back to a scalar color when no bars will be drawn (e.g. the
        // comparison has zero published tests). Chart.js reads index 0 of
        // backgroundColor for the legend swatch; an empty array yields black.
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

function axisTitleConfig(text) {
    if (!text) return { display: false };
    return {
        display: true,
        text,
        color: "#475569",
        font: { size: 12, weight: "600" },
    };
}

function chartOptions(onClick, xTitle) {
    return {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 24 } },
        datasets: { bar: { categoryPercentage: 0.85, barPercentage: 0.9 } },
        scales: {
            x: {
                grid: { display: false }, border: { display: false }, ticks: { font: { size: 12, weight: "600" }, color: "#64748b" },
                title: axisTitleConfig(xTitle)
            },
            y: {
                beginAtZero: true, border: { display: true, color: "#cbd5e1" },
                ticks: { maxTicksLimit: 5, color: "#94a3b8", font: { size: 10 }, callback: (v) => formatMetricValue(v, "") },
                grid: { color: "#e2e8f0" }
            },
        },
        plugins: {
            legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, borderRadius: 2, useBorderRadius: true, padding: 16, font: { size: 13 }, color: "#0f172a" } },
            tooltip: {
                backgroundColor: "rgba(15,23,42,0.9)", cornerRadius: 6, padding: 10, titleFont: { size: 12 }, bodyFont: { size: 12 },
                callbacks: {
                    label: (ctx) => {
                        const ds = ctx.dataset;
                        if ((ds._missing || [])[ctx.dataIndex]) return `${ds.label}: Data missing`;
                        return `${ds.label}: ${formatMetricValue(ctx.parsed.y, "")}`;
                    }
                }
            },
        },
        onClick: onClick || undefined,
    };
}

export const activeCharts = new Map();

export function createBarChart(canvas, suiteData, comparison, tests, selectedMetric, onClick) {
    const xTitle = resolveXAxisTitle(comparison);
    const chart = new Chart(canvas, { type: "bar", data: buildComparisonChartData(suiteData, comparison, tests, selectedMetric), options: chartOptions(onClick, xTitle), plugins: [barValueLabelsPlugin] });
    sizeChartContainer(chart, canvas);
    attachAxisHoverTooltips(chart, canvas, comparison, tests);
    return chart;
}

// Only the x-axis title is configurable; the y-axis is left unlabeled
// because the metric (with unit) is already shown in the chart's title
// dropdown.
function resolveXAxisTitle(comparison) {
    const axes = chartAxesConfig(comparison);
    return (axes.x && axes.x.title) ? axes.x.title : null;
}

function sizeChartContainer(chart, canvas, baseHeight = 220) {
    const legendHeight = chart.legend?.height || 0;
    canvas.parentElement.style.height = `${baseHeight + legendHeight}px`;
    chart.resize();
}

export function updateBarChartData(chart, suiteData, comparison, tests, selectedMetric) {
    const d = buildComparisonChartData(suiteData, comparison, tests, selectedMetric);
    chart.data.labels = d.labels;
    for (let i = 0; i < d.datasets.length; i++) {
        if (chart.data.datasets[i]) {
            const src = d.datasets[i], dst = chart.data.datasets[i];
            dst.data = src.data;
            dst._hasBackpressure = src._hasBackpressure;
            dst._missing = src._missing;
            dst.backgroundColor = src.backgroundColor;
            dst.borderColor = src.borderColor;
        }
    }
    chart.update("none");
}
