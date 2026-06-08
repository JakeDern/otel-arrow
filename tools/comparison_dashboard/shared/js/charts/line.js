// ── Time-series line chart ──────────────────────────────────────────────────
// Small per-metric sparkline used in the detail panel. `Chart` is the global
// from the Chart.js UMD bundle loaded via <script>.

import { formatMetricValue } from "../format.js";

export function createLineChart(canvas, dataPoints, color) {
    return new Chart(canvas, {
        type: "line",
        data: { labels: dataPoints.map((p) => p.t), datasets: [{ data: dataPoints.map((p) => p.value), borderColor: color, borderWidth: 2, pointRadius: 2.5, pointHitRadius: 6, tension: 0.3, fill: false }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            layout: { padding: { top: 4, right: 4 } },
            scales: {
                x: { type: "linear", grid: { display: false }, border: { display: true, color: "#e2e8f0" }, ticks: { maxTicksLimit: 5, color: "#94a3b8", font: { size: 9 }, callback: (v) => `${Math.round(v)}s` } },
                y: { beginAtZero: false, grid: { color: "#f1f5f9" }, border: { display: false }, ticks: { maxTicksLimit: 4, color: "#94a3b8", font: { size: 9 }, callback: (v) => formatMetricValue(v, "") } },
            },
            plugins: { legend: { display: false }, tooltip: { backgroundColor: "rgba(15,23,42,0.9)", cornerRadius: 4, padding: 8, titleFont: { size: 11 }, bodyFont: { size: 11 }, callbacks: { title: (items) => `${Math.round(items[0].parsed.x)}s`, label: (ctx) => formatMetricValue(ctx.parsed.y, "") } } },
        },
    });
}
