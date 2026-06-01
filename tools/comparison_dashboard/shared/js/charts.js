// ============================================================================
// charts.js -- all Chart.js infrastructure.
//
// Chart instances created here are plain objects held by the caller in
// non-reactive closure variables (NEVER inside an Alpine x-data proxy:
// proxying a Chart breaks its internal references). Alpine components call
// these helpers imperatively from x-init / $watch handlers.
//
// Ported from app.js with the palette + metric-config now injected so this
// module stays free of global colorblind state (that lives in the Alpine
// store).
// ============================================================================

import { formatMetricValue } from "./format.js";
import {
  getSuiteTests, hasBackpressure, chartAxesConfig,
} from "./data.js";

// ── Diagonal stripe pattern for missing-data bars ──────────────────────────

const patternCache = new Map();

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
          ctx.strokeText("⚠", el.x, cy);
          ctx.fillStyle = "#ef4444";
          ctx.fillText("⚠", el.x, cy);
        }
      }
    }
    ctx.restore();
  },
};

// `palette` is the active color array (standard or colorblind), passed in so
// this module holds no global palette state.
function colorAt(palette, index) { return palette[index % palette.length]; }

// ── Bar chart (comparison overview) ─────────────────────────────────────────

function buildComparisonChartData(suiteData, comparison, tests, selectedMetric, palette) {
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
    const color = colorAt(palette, colorIdx);
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

export function createBarChart(canvas, suiteData, comparison, tests, selectedMetric, palette, onClick) {
  const xTitle = resolveXAxisTitle(comparison);
  const chart = new Chart(canvas, { type: "bar", data: buildComparisonChartData(suiteData, comparison, tests, selectedMetric, palette), options: chartOptions(onClick, xTitle), plugins: [barValueLabelsPlugin] });
  sizeChartContainer(chart, canvas);
  attachAxisHoverTooltips(chart, canvas, comparison, tests);
  return chart;
}

export function updateBarChartData(chart, suiteData, comparison, tests, selectedMetric, palette) {
  const d = buildComparisonChartData(suiteData, comparison, tests, selectedMetric, palette);
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

function sizeChartContainer(chart, canvas, baseHeight = 220) {
  const legendHeight = chart.legend?.height || 0;
  canvas.parentElement.style.height = `${baseHeight + legendHeight}px`;
  chart.resize();
}

// ── Axis hover tooltips ─────────────────────────────────────────────────────
//
// Charts are destroyed and recreated on the same <canvas> when filters or
// metrics change -> detach any previously-attached handlers before adding new
// ones so listeners don't accumulate on the reused canvas element.

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

// ── Time-series line charts (detail panel) ──────────────────────────────────

export const TIMESERIES_METRICS = [
  { key: "cpu_percentage_normalized", label: "CPU Normalized", unit: "%", avg: "cpu_percentage_normalized_avg", max: "cpu_percentage_normalized_max" },
  { key: "ram_mib", label: "RAM", unit: "MiB", avg: "ram_mib_avg", max: "ram_mib_max" },
  { key: "network_tx_bytes_rate", label: "Network TX Rate", unit: "bytes/sec", avg: "network_tx_bytes_rate_avg" },
  { key: "network_rx_bytes_rate", label: "Network RX Rate", unit: "bytes/sec", avg: "network_rx_bytes_rate_avg" },
  { key: "logs_produced_rate", label: "Offered Load Rate", unit: "logs/sec", avg: "logs_produced_rate" },
  { key: "logs_received_rate", label: "Backend Received Rate", unit: "logs/sec", avg: "logs_received_rate" },
  { key: "metrics_produced_rate", label: "Offered Load Rate", unit: "metrics/sec", avg: "metrics_produced_rate" },
  { key: "metrics_received_rate", label: "Backend Received Rate", unit: "metrics/sec", avg: "metrics_received_rate" },
  { key: "spans_produced_rate", label: "Offered Load Rate", unit: "spans/sec", avg: "spans_produced_rate" },
  { key: "spans_received_rate", label: "Backend Received Rate", unit: "spans/sec", avg: "spans_received_rate" },
];

export const SCALAR_ONLY_METRICS = [
  { name: "dropped_logs_percentage" },
  { name: "test_duration" },
];

export function tmTitle(tm) { return tm.unit ? `${tm.label} (${tm.unit})` : tm.label; }

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
