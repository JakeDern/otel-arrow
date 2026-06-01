// ============================================================================
// Palette + colorblind state + diagonal-stripe pattern for missing-data bars.
//
// colorblindMode is a module-global mirrored in localStorage, exactly as the
// original app.js. Components that toggle it must call setColorblindMode and
// then re-render; toggling clears the pattern cache (patterns are color-keyed).
// ============================================================================

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

export function setColorblindMode(on) {
  colorblindMode = !!on;
  localStorage.setItem("colorblindMode", String(colorblindMode));
  patternCache.clear();
}

function getActivePalette() {
  return colorblindMode ? COLORBLIND_COLORS : AUTO_COLORS;
}

export function getColor(index) { const p = getActivePalette(); return p[index % p.length]; }

// Diagonal stripe pattern for missing-data bars. Keyed by color so the cache
// must be cleared when the palette changes (see setColorblindMode).
const patternCache = new Map();

export function createDiagonalPattern(color) {
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
