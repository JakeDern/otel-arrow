// ── Axis hover tooltips ─────────────────────────────────────────────────────
// Hovering the x-axis title reveals chart.axes.x.description; hovering an
// individual tick label reveals a per-tick string (derived from each test's
// loadgen_rate). Charts are destroyed/recreated on the same <canvas> when
// filters or metrics change, so previously-attached handlers are detached
// before adding new ones to avoid listener accumulation.

export function chartAxesConfig(comparison) {
  return (comparison && comparison.chart && comparison.chart.axes) || {};
}

export function attachAxisHoverTooltips(chart, canvas, comparison, tests) {
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

export function detachAxisHoverTooltips(canvas) {
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
