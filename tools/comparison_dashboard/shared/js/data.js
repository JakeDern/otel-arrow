// ── Data loading + suite/test accessors ─────────────────────────────────────
// Suite data is inlined into page-data.js by dashboard.py at build time
// (PAGE_DATA.suiteData = { <slug>: { name, slug, description, meta, env,
// tests: [...] } }). DATA_PATH comes from PAGE_DATA.dataPath, set to the
// relative URL of the per-suite data root (e.g. ../../data/suite). Per-test
// config files (orchestrator YAMLs, etc.) live at ${DATA_PATH}/<slug>/<test>/
// <file> and are fetched lazily by <file-modal>.

export const DATA_PATH = (window.PAGE_DATA || {}).dataPath;
if (!DATA_PATH) {
    console.warn("PAGE_DATA.dataPath not set; file viewer fetches will fail.");
}

export function loadSuiteData() { return (window.PAGE_DATA || {}).suiteData || {}; }

export function getSuiteTests(suiteData, slug) {
    const suite = suiteData[slug];
    return suite ? suite.tests || [] : [];
}

export function getTestByName(suiteData, slug, testName) {
    return getSuiteTests(suiteData, slug).find((t) => t.name === testName) || null;
}

export function getSuiteMeta(suiteData, slug) {
    const suite = suiteData[slug];
    return suite ? suite.meta || {} : {};
}
