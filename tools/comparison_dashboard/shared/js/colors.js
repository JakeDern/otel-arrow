// ── Colour constants ────────────────────────────────────────────────────────
// Single source of truth for every colour used in the dashboard:
//   - JS-side named exports for code that talks to Chart.js (which wants
//     literal hex / rgba strings)
//   - the `tokensCss` string consumed by styles.js to build the :root sheet
//     that CSS in every component references via var(--name)
//
// Chart palettes for the colourblind / standard modes live in the manifest
// (`palettes.standard` / `palettes.colorblind`) and flow in via
// window.PAGE_DATA.palettes.
//
// Adding a new colour: add a constant below, add a `--name: ${CONST}` entry
// to `tokensCss`, and reference it via `var(--name)` (CSS) or
// `import { CONST }` (JS).

// ── Neutral / surface ──────────────────────────────────────────────────────
export const WHITE = "#ffffff";

// Slate ramp -- text, borders, surfaces.
export const SLATE_50 = "#f8fafc";
export const SLATE_100 = "#f1f5f9";
export const SLATE_200 = "#e2e8f0";
export const SLATE_300 = "#dbe3ef";       // Custom tint (lighter than Tailwind slate-300)
export const SLATE_300_TRACK = "#cbd5e1"; // Switch-off track / chart y-axis border
export const SLATE_400 = "#94a3b8";
export const SLATE_500 = "#64748b";
export const SLATE_600 = "#475569";
export const SLATE_700 = "#334155";
export const SLATE_800 = "#1e293b";
export const SLATE_900 = "#0f172a";

// Blue ramp -- accents, links, focus.
export const BLUE_50 = "#eff6ff";
export const BLUE_200 = "#bfdbfe";
export const BLUE_300 = "#93c5fd";
export const BLUE_500 = "#3b82f6";
export const BLUE_600 = "#2563eb";
export const BLUE_900 = "#1e3a8a";

// Surface + text aliases used across the page chrome.
export const BG = "#f6f8fb";
export const TEXT = "#111827";
export const MUTED = "#6b7280";
export const LINE = "#e5e7eb";

// ── Status palettes ────────────────────────────────────────────────────────
export const GOOD_BG = "#dcfce7";
export const GOOD_BORDER = "#86efac";
export const GOOD_TEXT = "#166534";
export const BAD_BG = "#fee2e2";
export const BAD_BORDER = "#fca5a5";
export const BAD_TEXT = "#991b1b";
export const NEUTRAL_BG = "#f3f4f6";
export const NEUTRAL_BORDER = "#d1d5db";
export const NEUTRAL_TEXT = "#4b5563";

// Red ramp -- chart backpressure markers + env-mismatch banner.
export const RED_500 = "#ef4444";
export const RED_600 = "#dc2626";
export const RED_900 = "#7f1d1d";

// Amber ramp -- WIP banner.
export const AMBER_50 = "#fef3c7";
export const AMBER_500 = "#f59e0b";
export const AMBER_700 = "#92400e";
export const AMBER_900 = "#78350f";

// ── Compound (rgba) ────────────────────────────────────────────────────────
export const TOOLTIP_BG = "rgba(15, 23, 42, 0.9)";
export const MODAL_BACKDROP = "rgba(15, 23, 42, 0.46)";
export const MODAL_SHADOW = "rgba(15, 23, 42, 0.2)";
export const SWITCH_SHADOW = "rgba(0, 0, 0, 0.2)";
export const WIP_SHADOW = "rgba(245, 158, 11, 0.18)";
export const LEGEND_SHADOW = "rgba(30, 64, 175, 0.08)";

// ── CSS-token sheet ────────────────────────────────────────────────────────
// styles.js builds a CSSStyleSheet from this string and adopts it as the
// first sheet on document.adoptedStyleSheets. Every component sheet then
// references these tokens via var(--name).

export const tokensCss = `
:root {
    /* Surface + text */
    --bg: ${BG};
    --card: ${WHITE};
    --text: ${TEXT};
    --muted: ${MUTED};
    --line: ${LINE};
    --accent: ${BLUE_600};
    --white: ${WHITE};

    /* Status */
    --good-bg: ${GOOD_BG};
    --good-border: ${GOOD_BORDER};
    --good-text: ${GOOD_TEXT};
    --bad-bg: ${BAD_BG};
    --bad-border: ${BAD_BORDER};
    --bad-text: ${BAD_TEXT};
    --neutral-bg: ${NEUTRAL_BG};
    --neutral-border: ${NEUTRAL_BORDER};
    --neutral-text: ${NEUTRAL_TEXT};

    /* Slate ramp */
    --slate-50: ${SLATE_50};
    --slate-100: ${SLATE_100};
    --slate-200: ${SLATE_200};
    --slate-300: ${SLATE_300};
    --slate-300-track: ${SLATE_300_TRACK};
    --slate-400: ${SLATE_400};
    --slate-500: ${SLATE_500};
    --slate-600: ${SLATE_600};
    --slate-700: ${SLATE_700};
    --slate-800: ${SLATE_800};
    --slate-900: ${SLATE_900};

    /* Blue ramp */
    --blue-50: ${BLUE_50};
    --blue-200: ${BLUE_200};
    --blue-300: ${BLUE_300};
    --blue-500: ${BLUE_500};
    --blue-600: ${BLUE_600};
    --blue-900: ${BLUE_900};

    /* Red ramp */
    --red-500: ${RED_500};
    --red-600: ${RED_600};
    --red-900: ${RED_900};

    /* Amber ramp */
    --amber-50: ${AMBER_50};
    --amber-500: ${AMBER_500};
    --amber-700: ${AMBER_700};
    --amber-900: ${AMBER_900};

    /* Compounds */
    --tooltip-bg: ${TOOLTIP_BG};
    --modal-backdrop: ${MODAL_BACKDROP};
    --modal-shadow: ${MODAL_SHADOW};
    --switch-shadow: ${SWITCH_SHADOW};
    --wip-shadow: ${WIP_SHADOW};
    --legend-shadow: ${LEGEND_SHADOW};

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

// ── Palette runtime ────────────────────────────────────────────────────────
// The active chart palette toggles between PAGE_DATA.palettes.standard and
// PAGE_DATA.palettes.colorblind; persisted to localStorage. Both calls are
// guarded -- accessing localStorage throws SecurityError in some private /
// disabled-storage configurations, and setItem additionally throws
// QuotaExceededError when storage is full. We swallow both: the in-memory
// `colorblindMode` flip is the source of truth for the active session, and
// failing to persist it just means the choice doesn't survive a reload.

let colorblindMode = readColorblindMode();

function readColorblindMode() {
    try { return localStorage.getItem("colorblindMode") === "true"; }
    catch { return false; }
}

export function isColorblindMode() { return colorblindMode; }

/** Flip the palette, persist the choice, and return the new value. */
export function toggleColorblindMode() {
    colorblindMode = !colorblindMode;
    try { localStorage.setItem("colorblindMode", String(colorblindMode)); }
    catch { /* private mode / quota: keep in-memory flip, drop persistence */ }
    return colorblindMode;
}

export function getActivePalette() {
    const palettes = ((window.PAGE_DATA || {}).palettes) || {};
    return colorblindMode ? (palettes.colorblind || []) : (palettes.standard || []);
}

export function getColor(index) {
    const p = getActivePalette();
    if (!p.length) return "#000000";
    return p[index % p.length];
}
