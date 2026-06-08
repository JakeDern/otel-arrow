// ── Shared icon characters ─────────────────────────────────────────────────
// Named constants for the Unicode glyphs sprinkled across the UI. Centralize
// them so a future redesign (swap to inline SVG, swap to a different glyph)
// touches one file. The HTML_* forms are the entity-escaped pairings used
// inside template literals that render via .innerHTML; the raw forms are
// suitable for canvas drawing or textContent assignment.

/**
 * U+26A0 WARNING SIGN. Renders as the yellow triangle on most platforms
 * when paired with the emoji variation selector (see VARIATION_SELECTOR_EMOJI).
 */
export const WARNING_SIGN = "⚠";

/**
 * U+FE0F VARIATION SELECTOR-16. Forces the preceding character to render as
 * an emoji glyph (color) rather than text. Pair after WARNING_SIGN to get
 * the colorful triangle on platforms that distinguish presentations.
 */
export const VARIATION_SELECTOR_EMOJI = "️";

/**
 * WARNING_SIGN + VARIATION_SELECTOR_EMOJI, ready to drop into a string.
 */
export const WARNING_EMOJI = WARNING_SIGN + VARIATION_SELECTOR_EMOJI;

/**
 * HTML entity form of WARNING_EMOJI for use inside template literals that
 * render via element.innerHTML. Identical visual result; the entity form
 * is purely a readability choice for inline markup.
 */
export const WARNING_EMOJI_HTML = "&#9888;&#65039;";
