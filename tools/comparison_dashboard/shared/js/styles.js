// ── Shared stylesheets + adopt helper ──────────────────────────────────────
// Two responsibilities:
//   1. The `adopt()` helper that pushes sheets onto document.adoptedStyleSheets
//   2. Self-adopting sheets that don't belong to any single component:
//      - tokensSheet -- :root CSS custom properties built from colors.js
//      - globalSheet -- body / typography / .muted
//      - sectionCardSheet -- .scenario-section card used on both pages
//
// Component modules construct their own sheets and call:
//     adopt(tokensSheet, sheet);
// passing tokens first so design-token rules cascade before component-local
// rules reference them.

import { tokensCss } from "./colors.js";

// ── adopt() helper ──────────────────────────────────────────────────────────
// Idempotently appends sheets to document.adoptedStyleSheets in the given
// order. Mutates the existing FrozenArray via push() rather than assigning a
// fresh array -- per MDN, push is the recommended way:
// https://developer.mozilla.org/en-US/docs/Web/API/Document/adoptedStyleSheets#value

export function adopt(...sheets) {
    const current = document.adoptedStyleSheets;
    for (const sheet of sheets) {
        if (!sheet) continue;
        if (current.includes(sheet)) continue;
        current.push(sheet);
    }
}

// ── Design tokens ──────────────────────────────────────────────────────────
// tokensCss is built from JS constants in colors.js -- adding a new token
// happens there, not here.

export const tokensSheet = new CSSStyleSheet();
tokensSheet.replaceSync(tokensCss);

// ── Global page rules ──────────────────────────────────────────────────────
// Body / typography / utilities. Self-adopts so an `import "./styles.js"`
// from pages.js is enough to wire it up.

const globalCss = `
* { box-sizing: border-box; }

body {
    margin: 0;
    font-family: var(--font-sans);
    color: var(--text);
    background: radial-gradient(circle at top right, var(--blue-50), var(--bg) 44%);
}

h1 {
    margin: 0;
    font-size: 34px;
    line-height: 1.1;
    letter-spacing: -.03em;
}

.sub {
    margin-top: 8px;
    color: var(--muted);
    font-size: 15px;
}

.muted { color: var(--muted); }
`;

const globalSheet = new CSSStyleSheet();
globalSheet.replaceSync(globalCss);
adopt(tokensSheet, globalSheet);

// ── Shared chart-section card styles ───────────────────────────────────────
// `.scenario-section` is a card wrapper used by three places:
//   - <comparison-section> (each landing-page card)
//   - <comparison-page>._renderChart (the bar-chart card on the detail page)
//   - <detail-panel>.render (the "Test Details" card on the detail page)
//
// The metric <select> dropdown and the backpressure legend ship in the same
// sheet because they only appear inside .scenario-section heads.

const sectionCardCss = `
.scenario-section {
    background: var(--card);
    border: 1px solid var(--slate-200);
    border-radius: var(--radius-sm);
    padding: 16px 20px;
    margin-bottom: 16px;
}
.scenario-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 12px;
}
.scenario-section-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--slate-900);
}
.scenario-section-description {
    font-size: 0.85rem;
    color: var(--slate-400);
    margin-bottom: 12px;
}
.scenario-metric-select {
    font-size: 0.85rem;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--slate-200);
    background: var(--card);
    color: var(--slate-900);
}

.chart-backpressure-legend {
    font-size: 11px;
    color: var(--bad-text);
    text-align: center;
    margin-top: 4px;
}
`;

export const sectionCardSheet = new CSSStyleSheet();
sectionCardSheet.replaceSync(sectionCardCss);
adopt(tokensSheet, sectionCardSheet);
