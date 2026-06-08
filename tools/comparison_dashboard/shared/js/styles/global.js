// ── Global stylesheet ───────────────────────────────────────────────────────
// Page-level rules that aren't owned by a single component: base typography,
// the .wrap layout, the .muted utility, the axis-hover tooltip (which lives
// on document.body, not inside a component), and the yaml-highlight color
// classes emitted by highlight.js into the file modal body.

import { adopt } from "./adopt.js";
import { tokensSheet } from "./tokens.js";

const css = `
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

/* Axis / filter-chip tooltip, created on document.body by charts/axis-hover.js. */
.axis-hover-tooltip {
    position: fixed;
    pointer-events: none;
    z-index: 1000;
    background: rgba(15, 23, 42, 0.9);
    color: #fff;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.3;
    max-width: 280px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}
.axis-hover-tooltip[hidden] { display: none; }

/* yaml-* spans come from highlight.js inside the file modal pre/code. */
.yaml-key { color: var(--blue-300); }
.yaml-string { color: var(--good-border); }
.yaml-number { color: #fcd34d; }
.yaml-bool { color: #f9a8d4; }
.yaml-comment { color: var(--slate-400); }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);

// Adopt tokens first, then global. Component sheets adopt themselves later;
// adopt() is idempotent and order-preserving.
adopt(tokensSheet, sheet);
