// ============================================================================
// file_modal.js -- config-file fetch + highlight for the viewer modal.
//
// Pure data fetch; the modal's open/close state lives in the Alpine
// `fileModal` component (components.js). DATA_PATH is the build-injected
// relative URL to the per-suite data root.
// ============================================================================

import { highlightFileContent } from "./format.js";

const DATA_PATH = window.DATA_PATH;
if (!DATA_PATH) {
  console.warn(
    "window.DATA_PATH not set; file viewer fetches will fail. " +
    "This page should be served alongside the build-generated index/stub HTML."
  );
}

export async function loadConfigFile(suiteSlug, testName, fileName) {
  const url = `${DATA_PATH}/${encodeURIComponent(suiteSlug)}/${encodeURIComponent(testName)}/${encodeURIComponent(fileName)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${fileName}: ${resp.status}`);
  return resp.text();
}

// Fetch a file and return highlighted HTML, or an error message string.
// Returns { html } on success or { error } on failure.
export async function fetchHighlighted(suiteSlug, testName, fileName) {
  try {
    const content = await loadConfigFile(suiteSlug, testName, fileName);
    return { html: highlightFileContent(fileName, content) };
  } catch (e) {
    return { error: `Error loading file: ${e.message}` };
  }
}
