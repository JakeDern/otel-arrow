// ── Design tokens ───────────────────────────────────────────────────────────
// Exports a CSSStyleSheet that declares all shared design tokens on :root.
// Adopted onto document.adoptedStyleSheets first (via adopt.js), so every
// component sheet that uses these custom properties can rely on them.
//
// Add a primitive here when the same hex appears in multiple component sheets.
// Component-specific one-off colors stay inline in their component sheet.

const css = `
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
tokensSheet.replaceSync(css);
