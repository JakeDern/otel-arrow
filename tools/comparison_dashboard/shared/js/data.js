// ── Data loading + suite/test accessors ─────────────────────────────────────
// Suite data is loaded by bootstrap.js (async <script> insertion driven by
// PAGE_DATA.suiteFiles) and ends up on window.SUITE_DATA before any rendering
// runs. DATA_PATH comes from PAGE_DATA.dataPath, set by dashboard.py to the
// relative URL of the per-suite data root (e.g. ../../data/suite). Per-test
// files live at ${DATA_PATH}/<slug>/<test>/<file>.

export const DATA_PATH = (window.PAGE_DATA || {}).dataPath;
if (!DATA_PATH) {
    console.warn("PAGE_DATA.dataPath not set; file viewer fetches will fail.");
}

export function loadSuiteData() { return window.SUITE_DATA || {}; }

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
