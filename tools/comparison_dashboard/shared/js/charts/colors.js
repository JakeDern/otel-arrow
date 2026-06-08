// ── Chart color palettes ────────────────────────────────────────────────────
// Two palettes; the active one is toggled by the colorblind switch and
// persisted in localStorage. Module-local mutable state is the single source
// of truth; consumers read it through getActivePalette/getColor.

const AUTO_COLORS = [
    "#1F77B4", "#AEC7E8", "#FF7F0E", "#FFBB78",
    "#2CA02C", "#98DF8A", "#D62728", "#FF9896",
    "#9467BD", "#C5B0D5", "#8C564B", "#C49C94",
    "#E377C2", "#F7B6D2", "#7F7F7F", "#C7C7C7",
    "#BCBD22", "#DBDB8D", "#17BECF", "#9EDAE5",
];

const COLORBLIND_COLORS = [
    "#0072b2", "#e69f00", "#009e73", "#cc79a7",
    "#56b4e9", "#d55e00", "#f0e442", "#000000",
    "#0099cc", "#994f00", "#006d5b", "#ad5c85",
    "#3a9bd9", "#aa4400", "#c4b832", "#444444",
    "#882e72", "#b178a6", "#117733", "#88ccaa",
];

let colorblindMode = localStorage.getItem("colorblindMode") === "true";

export function isColorblindMode() { return colorblindMode; }

// Flip the palette, persist the choice, and return the new value.
export function toggleColorblindMode() {
    colorblindMode = !colorblindMode;
    localStorage.setItem("colorblindMode", String(colorblindMode));
    return colorblindMode;
}

export function getActivePalette() {
    return colorblindMode ? COLORBLIND_COLORS : AUTO_COLORS;
}

export function getColor(index) { const p = getActivePalette(); return p[index % p.length]; }
