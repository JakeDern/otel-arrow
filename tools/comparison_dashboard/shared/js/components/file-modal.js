// ── <file-modal> ─────────────────────────────────────────────────────────────
// Renders its own modal scaffolding into light DOM on mount. Listens for
// bubbling `open-file` events (dispatched by <detail-panel>), fetches the
// requested config file, and shows its contents verbatim (no syntax
// highlighting).

import { DATA_PATH } from "../data.js";
import { adopt, tokensSheet } from "../styles.js";

const css = `
.modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--modal-backdrop);
    display: grid;
    place-items: center;
    z-index: 10000;
    padding: 20px;
}
.modal-backdrop[hidden] { display: none !important; }

.modal {
    width: min(980px, 96vw);
    height: 88vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--white);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: 0 18px 48px var(--modal-shadow);
    padding: 14px;
}
.modal-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
}
.modal-title { font-size: 18px; font-weight: 700; }
.modal-close {
    appearance: none;
    border: 1px solid var(--line);
    background: var(--white);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    cursor: pointer;
}
.modal-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: hidden;
    min-height: 0;
    flex: 1;
}

.config-full-code {
    margin: 0;
    padding: 14px;
    overflow: auto;
    background: var(--slate-900);
    color: var(--line);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre;
    border-radius: var(--radius-md);
    height: calc(88vh - 200px);
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

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
            codeEl.textContent = await this._load(suiteSlug, testName, fileName);
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
