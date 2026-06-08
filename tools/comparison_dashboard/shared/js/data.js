// ── Data loading + suite/test accessors ─────────────────────────────────────
// Suite data is pre-loaded via <script> tags that populate window.SUITE_DATA
// before any module runs. DATA_PATH is injected per-page by dashboard.py build
// as the relative URL to the per-suite data root (e.g. ../data/suite). Per-test
// files live at ${DATA_PATH}/<slug>/<test>/<file>.

export const DATA_PATH = window.DATA_PATH;
if (!DATA_PATH) {
  console.warn(
    "window.DATA_PATH not set; file viewer fetches will fail. " +
    "This page should be served alongside the build-generated index/stub HTML."
  );
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
