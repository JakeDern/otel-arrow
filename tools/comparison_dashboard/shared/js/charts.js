// ============================================================================
// Chart.js wiring: the bar-value-labels plugin, bar/line chart factories,
// option builders, container sizing, and axis-hover tooltips. Framework
// agnostic; consumers own the Chart instances and their lifecycle.
//
// Chart.js itself is loaded globally from a CDN <script> in base.html.j2, so
// `Chart` is referenced as a global here (no import).
// ============================================================================

import { formatMetricValue } from "./format.js";
import { buildComparisonChartData } from "./data.js";

// ── Bar value labels plugin ───────────────────────────────────────────────────

export const barValueLabelsPlugin = {
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
          ctx.strokeText("⚠", el.x, cy);
          ctx.fillStyle = "#ef4444";
          ctx.fillText("⚠", el.x, cy);
        }
      }
    }
    ctx.restore();
  },
};

// ── Bar chart ──────────────────────────────────────────────────────────────

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
      x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 12, weight: "600" }, color: "#64748b" },
        title: axisTitleConfig(xTitle) },
      y: { beginAtZero: true, border: { display: true, color: "#cbd5e1" },
        ticks: { maxTicksLimit: 5, color: "#94a3b8", font: { size: 10 }, callback: (v) => formatMetricValue(v, "") },
        grid: { color: "#e2e8f0" } },
    },
    plugins: {
      legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, borderRadius: 2, useBorderRadius: true, padding: 16, font: { size: 13 }, color: "#0f172a" } },
      tooltip: { backgroundColor: "rgba(15,23,42,0.9)", cornerRadius: 6, padding: 10, titleFont: { size: 12 }, bodyFont: { size: 12 },
        callbacks: { label: (ctx) => {
          const ds = ctx.dataset;
          if ((ds._missing || [])[ctx.dataIndex]) return `${ds.label}: Data missing`;
          return `${ds.label}: ${formatMetricValue(ctx.parsed.y, "")}`;
        } } },
    },
    onClick: onClick || undefined,
  };
}

export function createBarChart(canvas, suiteData, comparison, tests, selectedMetric, onClick) {
  const xTitle = resolveXAxisTitle(comparison);
  const chart = new Chart(canvas, { type: "bar", data: buildComparisonChartData(suiteData, comparison, tests, selectedMetric), options: chartOptions(onClick, xTitle), plugins: [barValueLabelsPlugin] });
  sizeChartContainer(chart, canvas);
  attachAxisHoverTooltips(chart, canvas, comparison, tests);
  return chart;
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

// Only the x-axis title is configurable; the y-axis is left unlabeled
// because the metric (with unit) is already shown in the chart's title
// dropdown.
function resolveXAxisTitle(comparison) {
  const axes = chartAxesConfig(comparison);
  return (axes.x && axes.x.title) ? axes.x.title : null;
}

function chartAxesConfig(comparison) {
  return (comparison && comparison.chart && comparison.chart.axes) || {};
}

function sizeChartContainer(chart, canvas, baseHeight = 220) {
  const legendHeight = chart.legend?.height || 0;
  canvas.parentElement.style.height = `${baseHeight + legendHeight}px`;
  chart.resize();
}

// ── Line chart (detail-panel time series) ─────────────────────────────────────

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

// ── Axis hover tooltips ───────────────────────────────────────────────────────

// Wire mousemove on the chart canvas so hovering over the x-axis title or
// an individual tick label reveals a floating tooltip. Axis title hover
// shows chart.axes.x.description. Tick label hover shows a per-tick string
// (currently derived from each test's loadgen_rate). No-op when there is
// nothing to show.
//
// Charts are destroyed and recreated on the same <canvas> when filters or
// metrics change -> detach any previously-attached handlers before adding
// new ones so listeners don't accumulate on the reused canvas element.
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
    if (!sx) { hideAxisHoverTooltip(); return; }
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;

    if (xDesc) {
      const box = xTitleBoxFromWidth(sx, xTitleWidth);
      if (box && px >= box.left - PAD && px <= box.right + PAD
              && py >= box.top - PAD && py <= box.bottom + PAD) {
        showAxisHoverTooltip(ev.clientX, ev.clientY, xDesc);
        return;
      }
    }

    if (hasTickHovers) {
      const xLabelH = tickFontSize(sx) + 4;
      if (py >= sx.top - PAD && py <= sx.top + xLabelH + PAD
          && px >= sx.left - PAD && px <= sx.right + PAD) {
        const i = nearestTickIndex(sx, px);
        const text = i >= 0 ? tickTexts[i] : null;
        if (text) { showAxisHoverTooltip(ev.clientX, ev.clientY, text); return; }
      }
    }

    hideAxisHoverTooltip();
  };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", hideAxisHoverTooltip);
  canvas._axisHoverHandlers = { onMove, onLeave: hideAxisHoverTooltip };
}

function detachAxisHoverTooltips(canvas) {
  const h = canvas._axisHoverHandlers;
  if (!h) return;
  canvas.removeEventListener("mousemove", h.onMove);
  canvas.removeEventListener("mouseleave", h.onLeave);
  canvas._axisHoverHandlers = null;
}

function tickHoverText(test) {
  if (!test) return null;
  if (typeof test.description === "string" && test.description.trim()) return test.description;
  if (typeof test.loadgen_rate === "number" && Number.isFinite(test.loadgen_rate)) {
    return `${test.loadgen_rate.toLocaleString()}/sec`;
  }
  return null;
}

function tickFontSize(scale) {
  return (scale.options && scale.options.ticks && scale.options.ticks.font && scale.options.ticks.font.size) || 12;
}

function measureXAxisTitleWidth(chart, canvas) {
  const sx = chart.scales && chart.scales.x;
  const t = sx && sx.options && sx.options.title;
  if (!t || !t.display || !t.text) return 0;
  const fs = (t.font && t.font.size) || 12;
  const weight = (t.font && t.font.weight) || "normal";
  return measureCanvasText(canvas, t.text, fs, weight);
}

// Bounding box for the x-axis title text, in canvas-relative pixels. Title
// is rendered centered horizontally at the bottom of the scale. Width is
// precomputed (see measureXAxisTitleWidth) so this is cheap to call per
// mousemove.
function xTitleBoxFromWidth(scale, textW) {
  const t = scale.options && scale.options.title;
  if (!t || !t.display || !t.text || !textW) return null;
  const fs = (t.font && t.font.size) || 12;
  const centerX = (scale.left + scale.right) / 2;
  return {
    left: centerX - textW / 2,
    right: centerX + textW / 2,
    top: scale.bottom - fs - 2,
    bottom: scale.bottom,
  };
}

function measureCanvasText(canvas, text, fontSize, fontWeight) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return text.length * fontSize * 0.6;
  ctx.save();
  ctx.font = `${fontWeight} ${fontSize}px "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

function nearestTickIndex(scale, px) {
  const n = (scale.ticks || []).length;
  if (!n) return -1;
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const tx = scale.getPixelForTick ? scale.getPixelForTick(i) : scale.getPixelForValue(i);
    const d = Math.abs(px - tx);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  // Cap: only count a hit when within half the inter-tick spacing.
  const halfSpan = n > 1 ? Math.abs(scale.getPixelForTick(1) - scale.getPixelForTick(0)) / 2 : (scale.right - scale.left) / 2;
  return bestDist <= halfSpan ? best : -1;
}

let axisHoverTooltipEl = null;
function showAxisHoverTooltip(clientX, clientY, text) {
  if (!axisHoverTooltipEl) {
    axisHoverTooltipEl = document.createElement("div");
    axisHoverTooltipEl.className = "axis-hover-tooltip";
    axisHoverTooltipEl.hidden = true;
    document.body.appendChild(axisHoverTooltipEl);
  }
  axisHoverTooltipEl.textContent = text;
  axisHoverTooltipEl.hidden = false;
  // Offset from cursor; keep within viewport on the right edge.
  const pad = 12;
  const x = Math.min(clientX + pad, window.innerWidth - axisHoverTooltipEl.offsetWidth - pad);
  const y = Math.min(clientY + pad, window.innerHeight - axisHoverTooltipEl.offsetHeight - pad);
  axisHoverTooltipEl.style.left = `${x}px`;
  axisHoverTooltipEl.style.top = `${y}px`;
}

function hideAxisHoverTooltip() {
  if (axisHoverTooltipEl && !axisHoverTooltipEl.hidden) axisHoverTooltipEl.hidden = true;
}
