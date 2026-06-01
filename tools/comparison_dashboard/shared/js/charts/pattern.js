// ── Diagonal stripe pattern for missing-data bars ───────────────────────────
// Patterns are cached per color. The cache is cleared when the palette
// changes (see colorblind toggle) so stripes pick up the new colors.

const patternCache = new Map();

export function clearPatternCache() { patternCache.clear(); }

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
