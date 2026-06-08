// ── Constructable stylesheet adoption helper ────────────────────────────────
// Idempotently appends sheets to document.adoptedStyleSheets in the given
// order. Components call this with their own sheet plus any shared sheets
// (tokens, etc.) at module-load time, so styles are present before any
// custom-element instances render.

export function adopt(...sheets) {
    const current = document.adoptedStyleSheets;
    const additions = sheets.filter((s) => s && !current.includes(s));
    if (!additions.length) return;
    document.adoptedStyleSheets = [...current, ...additions];
}
