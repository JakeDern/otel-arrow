// ── Floating cursor tooltip ─────────────────────────────────────────────────
// One singleton tooltip element appended to document.body the first time
// showTooltip() is called. Used by the bar chart (x-axis title / tick labels)
// and by the filter chips (per-value descriptions). Position is anchored to
// the supplied client coordinates with a small offset; the tooltip is clamped
// inside the viewport so it never spills off-screen.
//
// This module owns both the singleton DOM node and its styles. The class
// name `.axis-hover-tooltip` is kept for CSS continuity even though the
// helper is no longer axis-specific.

import { adopt, tokensSheet } from "./styles.js";

const css = `
.axis-hover-tooltip {
    position: fixed;
    pointer-events: none;
    z-index: 1000;
    background: var(--tooltip-bg);
    color: var(--white);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.3;
    max-width: 280px;
    box-shadow: 0 2px 6px var(--switch-shadow);
}
.axis-hover-tooltip[hidden] { display: none; }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

let tooltipEl = null;

/**
 * Show the tooltip at (clientX, clientY) with the given text. Creates the
 * singleton element on first call.
 *
 * @param {number} clientX Viewport-space x coordinate.
 * @param {number} clientY Viewport-space y coordinate.
 * @param {string} text    Plain-text content (HTML is not interpreted).
 */
export function showTooltip(clientX, clientY, text) {
    if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "axis-hover-tooltip";
        tooltipEl.hidden = true;
        document.body.appendChild(tooltipEl);
    }
    tooltipEl.textContent = text;
    tooltipEl.hidden = false;
    const pad = 12;
    const x = Math.min(clientX + pad, window.innerWidth - tooltipEl.offsetWidth - pad);
    const y = Math.min(clientY + pad, window.innerHeight - tooltipEl.offsetHeight - pad);
    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
}

/** Hide the tooltip if it's visible. No-op otherwise. */
export function hideTooltip() {
    if (tooltipEl && !tooltipEl.hidden) tooltipEl.hidden = true;
}
