// ── Shared stylesheets + adopt helper ──────────────────────────────────────
// Everything every component module needs to wire CSS lives here:
//   - design tokens (--bg / --slate-* / --blue-* / --radius-* / --font-*)
//   - global page rules (body, .wrap, .muted, yaml-highlight spans)
//   - shared chart-section card styles (.scenario-section + descendants)
//   - the `adopt()` helper that pushes sheets onto document.adoptedStyleSheets
//
// Component modules construct their own sheets, then call:
//
//     adopt(tokensSheet, sheet);
//
// passing tokens first so design-token rules cascade before component-local
// rules read them. Shared sheets exported below (`sectionCardSheet`) self-adopt
// at module load.

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
// Add a primitive here when the same hex appears in multiple component sheets.
// Component-specific one-off colours stay inline in their component sheet.

const tokensCss = `
:root {
    /* Surface + text */
    --bg: #f6f8fb;
    --card: #ffffff;
    --text: #111827;
    --muted: #6b7280;
    --line: #e5e7eb;
    --accent: #2563eb;

    /* Status palettes (used by env-mismatch / metric-scalar-card.backpressure) */
    --good-bg: #dcfce7;
    --good-border: #86efac;
    --good-text: #166534;
    --bad-bg: #fee2e2;
    --bad-border: #fca5a5;
    --bad-text: #991b1b;
    --neutral-bg: #f3f4f6;
    --neutral-border: #d1d5db;
    --neutral-text: #4b5563;

    /* Slate ramp -- used heavily across env / detail / metric panels */
    --slate-50: #f8fafc;
    --slate-100: #f1f5f9;
    --slate-200: #e2e8f0;
    --slate-300: #dbe3ef;
    --slate-400: #94a3b8;
    --slate-500: #64748b;
    --slate-600: #475569;
    --slate-700: #334155;
    --slate-900: #0f172a;

    /* Accent ramp -- buttons, focus rings, chart highlights */
    --blue-50: #eff6ff;
    --blue-200: #bfdbfe;
    --blue-300: #93c5fd;
    --blue-500: #3b82f6;
    --blue-600: #2563eb;

    /* Layout */
    --wrap-max: 1540px;
    --radius-sm: 8px;
    --radius-md: 10px;
    --radius-lg: 14px;

    /* Typography */
    --font-sans: "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;

export const tokensSheet = new CSSStyleSheet();
tokensSheet.replaceSync(tokensCss);

// ── Global page rules ──────────────────────────────────────────────────────
// Body / typography / utilities / yaml-highlight spans. Self-adopts so an
// `import "./styles.js"` from bootstrap.js is enough to wire it up.

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

/* yaml-* spans come from highlight.js inside the file modal pre/code. */
.yaml-key { color: var(--blue-300); }
.yaml-string { color: var(--good-border); }
.yaml-number { color: #fcd34d; }
.yaml-bool { color: #f9a8d4; }
.yaml-comment { color: var(--slate-400); }
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
