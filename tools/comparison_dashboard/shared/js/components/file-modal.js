// ============================================================================
// <file-modal> -- config file viewer.
//
// The modal shell markup (#run-detail-modal, #run-detail-body, etc.) is
// emitted statically by base.html.j2 and lives in the light DOM. This element
// is a controller: it owns open/close behavior, the fetch + syntax-highlight
// pipeline, and the Escape/backdrop dismiss handlers. It renders nothing of
// its own (createRenderRoot returns this, and render() returns nothing).
//
// Other components request a file view by dispatching a bubbling
// "open-file" CustomEvent { suiteSlug, testName, fileName }, or by calling the
// element's open() method directly. main.js wires the event to this element.
// ============================================================================

import { LitElement } from "https://esm.run/lit@3";
import { highlightFileContent } from "../highlight.js";

// DATA_PATH is injected by dashboard.py build into each page. It is the
// relative URL from the current page to the per-suite data root. Per-suite
// test files live at `${DATA_PATH}/<slug>/<test>/<file>`.
function dataPath() {
  const p = window.DATA_PATH;
  if (!p) {
    console.warn(
      "window.DATA_PATH not set; file viewer fetches will fail. " +
      "This page should be served alongside the build-generated index/stub HTML."
    );
  }
  return p;
}

export class FileModal extends LitElement {
  // Render to the light DOM so the global styles.css and the static modal
  // markup keep working.
  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._initModalShell();
  }

  // Wire the static modal shell's close button, backdrop click, and the
  // document-level Escape handler. No-op if the shell is absent.
  _initModalShell() {
    const modal = document.getElementById("run-detail-modal");
    const closeBtn = document.getElementById("run-detail-close");
    if (!modal || !closeBtn) return;
    closeBtn.onclick = () => { modal.hidden = true; };
    modal.addEventListener("click", (evt) => { if (evt.target === modal) modal.hidden = true; });
    this._onKeydown = (evt) => { if (evt.key === "Escape" && !modal.hidden) modal.hidden = true; };
    document.addEventListener("keydown", this._onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._onKeydown) document.removeEventListener("keydown", this._onKeydown);
  }

  async open(suiteSlug, testName, fileName) {
    const modal = document.getElementById("run-detail-modal");
    const body = document.getElementById("run-detail-body");
    const title = document.getElementById("run-detail-title");
    if (!modal || !body || !title) return;
    title.textContent = fileName;
    modal.hidden = false;
    body.innerHTML = '<pre class="config-full-code"><code id="file-modal-content">Loading...</code></pre>';
    try {
      const content = await this._loadConfigFile(suiteSlug, testName, fileName);
      const el = document.getElementById("file-modal-content");
      if (el) el.innerHTML = highlightFileContent(fileName, content);
    } catch (e) {
      const el = document.getElementById("file-modal-content");
      if (el) el.textContent = `Error loading file: ${e.message}`;
    }
  }

  async _loadConfigFile(suiteSlug, testName, fileName) {
    const url = `${dataPath()}/${encodeURIComponent(suiteSlug)}/${encodeURIComponent(testName)}/${encodeURIComponent(fileName)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${fileName}: ${resp.status}`);
    return resp.text();
  }

  render() { return null; }
}

customElements.define("file-modal", FileModal);
