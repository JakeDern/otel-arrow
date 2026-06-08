// ── <file-modal> ─────────────────────────────────────────────────────────────
// Controller over the static #run-detail-modal shell emitted in the page
// template. Native custom element with no own markup: on connect it wires the
// close button / backdrop / Escape key and listens for bubbling `open-file`
// events (dispatched by <detail-panel>), then fetches and syntax-highlights the
// requested config file.

import { DATA_PATH } from "../data.js";
import { highlightFileContent } from "../highlight.js";

export class FileModal extends HTMLElement {
    connectedCallback() {
        this._modal = document.getElementById("run-detail-modal");
        this._body = document.getElementById("run-detail-body");
        this._title = document.getElementById("run-detail-title");

        const closeBtn = document.getElementById("run-detail-close");
        if (closeBtn) closeBtn.onclick = () => this._hide();
        if (this._modal) this._modal.addEventListener("click", (evt) => { if (evt.target === this._modal) this._hide(); });

        this._onKey = (evt) => { if (evt.key === "Escape" && this._modal && !this._modal.hidden) this._hide(); };
        this._onOpen = (evt) => this.open(evt.detail.slug, evt.detail.test, evt.detail.file);
        document.addEventListener("keydown", this._onKey);
        document.addEventListener("open-file", this._onOpen);
    }

    disconnectedCallback() {
        document.removeEventListener("keydown", this._onKey);
        document.removeEventListener("open-file", this._onOpen);
    }

    _hide() { if (this._modal) this._modal.hidden = true; }

    async open(suiteSlug, testName, fileName) {
        if (!this._modal || !this._body || !this._title) return;
        this._title.textContent = fileName;
        this._modal.hidden = false;
        this._body.innerHTML = '<pre class="config-full-code"><code id="file-modal-content">Loading...</code></pre>';
        try {
            const content = await this._load(suiteSlug, testName, fileName);
            const el = document.getElementById("file-modal-content");
            if (el) el.innerHTML = highlightFileContent(fileName, content);
        } catch (e) {
            const el = document.getElementById("file-modal-content");
            if (el) el.textContent = `Error loading file: ${e.message}`;
        }
    }

    async _load(suiteSlug, testName, fileName) {
        const url = `${DATA_PATH}/${encodeURIComponent(suiteSlug)}/${encodeURIComponent(testName)}/${encodeURIComponent(fileName)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to load ${fileName}: ${resp.status}`);
        return resp.text();
    }
}

customElements.define("file-modal", FileModal);
