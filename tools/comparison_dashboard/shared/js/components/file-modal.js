// ── <file-modal> ─────────────────────────────────────────────────────────────
// Renders its own modal scaffolding into light DOM on mount. Listens for
// bubbling `open-file` events (dispatched by <detail-panel>), then fetches
// and syntax-highlights the requested config file.

import { DATA_PATH } from "../data.js";
import { highlightFileContent } from "../highlight.js";

export class FileModal extends HTMLElement {
    connectedCallback() {
        this.innerHTML = `
            <div class="modal-backdrop" hidden>
                <div class="modal">
                    <div class="modal-head">
                        <div class="modal-title"></div>
                        <button class="modal-close" type="button">Close</button>
                    </div>
                    <div class="modal-body"></div>
                </div>
            </div>
        `;
        this._modal = this.querySelector(".modal-backdrop");
        this._body = this.querySelector(".modal-body");
        this._title = this.querySelector(".modal-title");

        const closeBtn = this.querySelector(".modal-close");
        if (closeBtn) closeBtn.onclick = () => this._hide();
        this._modal.addEventListener("click", (evt) => { if (evt.target === this._modal) this._hide(); });

        this._onKey = (evt) => { if (evt.key === "Escape" && !this._modal.hidden) this._hide(); };
        this._onOpen = (evt) => this.open(evt.detail.slug, evt.detail.test, evt.detail.file);
        document.addEventListener("keydown", this._onKey);
        document.addEventListener("open-file", this._onOpen);
    }

    disconnectedCallback() {
        document.removeEventListener("keydown", this._onKey);
        document.removeEventListener("open-file", this._onOpen);
    }

    _hide() { this._modal.hidden = true; }

    async open(suiteSlug, testName, fileName) {
        this._title.textContent = fileName;
        this._modal.hidden = false;
        this._body.innerHTML = '<pre class="config-full-code"><code class="file-modal-content">Loading...</code></pre>';
        const codeEl = this._body.querySelector(".file-modal-content");
        try {
            const content = await this._load(suiteSlug, testName, fileName);
            codeEl.innerHTML = highlightFileContent(fileName, content);
        } catch (e) {
            codeEl.textContent = `Error loading file: ${e.message}`;
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
