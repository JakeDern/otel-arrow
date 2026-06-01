// ── File-viewer modal ───────────────────────────────────────────────────────
// Fetches a published config file and shows it syntax-highlighted in a modal.

import { DATA_PATH } from "./data.js";
import { highlightFileContent } from "./highlight.js";

async function loadConfigFile(suiteSlug, testName, fileName) {
  const url = `${DATA_PATH}/${encodeURIComponent(suiteSlug)}/${encodeURIComponent(testName)}/${encodeURIComponent(fileName)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${fileName}: ${resp.status}`);
  return resp.text();
}

export async function openFileModal(suiteSlug, testName, fileName) {
  const modal = document.getElementById("run-detail-modal");
  const body = document.getElementById("run-detail-body");
  const title = document.getElementById("run-detail-title");
  if (!modal || !body || !title) return;
  title.textContent = fileName;
  modal.hidden = false;
  body.innerHTML = '<pre class="config-full-code"><code id="file-modal-content">Loading...</code></pre>';
  try {
    const content = await loadConfigFile(suiteSlug, testName, fileName);
    const el = document.getElementById("file-modal-content");
    if (el) el.innerHTML = highlightFileContent(fileName, content);
  } catch (e) {
    const el = document.getElementById("file-modal-content");
    if (el) el.textContent = `Error loading file: ${e.message}`;
  }
}

export function initModal() {
  const modal = document.getElementById("run-detail-modal");
  const closeBtn = document.getElementById("run-detail-close");
  if (!modal || !closeBtn) return;
  closeBtn.onclick = () => { modal.hidden = true; };
  modal.addEventListener("click", (evt) => { if (evt.target === modal) modal.hidden = true; });
  document.addEventListener("keydown", (evt) => { if (evt.key === "Escape" && !modal.hidden) modal.hidden = true; });
}
