// ── <dashboard-site> ────────────────────────────────────────────────────────
// Top-level page container. Owns the chrome (wip-banner, controls bar with
// display switches, glossary banner, page-root, file-modal) and drives the
// colour-mode refresh via the `pageElement` property set by the entry script
// after the page child is mounted into pageRoot.
//
// Colour mode lives in colors.js (module-scoped + localStorage); glossary
// expand state lives in localStorage. The site reads / writes both directly
// in its switch handlers -- no separate controls module.

import { escapeHtml } from "../format.js";
import { adopt, tokensSheet } from "../styles.js";
import { WARNING_EMOJI_HTML } from "../icons.js";
import { isColorblindMode, toggleColorblindMode } from "../colors.js";
import { clearPatternCache } from "./bar-chart.js";
import "./file-modal.js";

const LEGEND_STORAGE_KEY = "legend-banner-expanded";

const css = `
.wrap {
    max-width: var(--wrap-max);
    margin: 0 auto;
    padding: 20px 16px 32px;
}

/* WIP warning banner */
.wip-banner {
    position: sticky;
    top: 0;
    z-index: 100;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin: 0;
    padding: 12px 18px;
    background: var(--amber-50);
    border-bottom: 2px solid var(--amber-500);
    color: var(--amber-900);
    font-weight: 700;
    font-size: 15px;
    line-height: 1.3;
    box-shadow: 0 2px 8px var(--wip-shadow);
}
.wip-banner .wip-icon { flex: 0 0 auto; font-size: 22px; line-height: 1; }
.wip-banner .wip-text { flex: 0 1 auto; text-align: center; }
.wip-banner .wip-link { color: var(--amber-900); text-decoration: underline; }
.wip-banner .wip-link:hover { color: var(--amber-700); }

/* Controls bar (display switches) -- sits below the wip banner. */
.controls-bar {
    position: sticky;
    top: 48px;
    z-index: 99;
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    align-items: center;
    padding: 8px 18px;
    background: var(--slate-50);
    border-bottom: 1px solid var(--slate-200);
    font-size: 13px;
    color: var(--slate-800);
}
.controls-bar:empty { display: none; }

.switch-control {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
}
.switch-label { font-weight: 600; color: var(--slate-700); }
.switch {
    appearance: none;
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
    display: inline-block;
}
.switch-track {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 18px;
    background: var(--slate-300-track);
    border-radius: 999px;
    transition: background 140ms ease;
}
.switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--white);
    border-radius: 50%;
    box-shadow: 0 1px 2px var(--switch-shadow);
    transition: left 140ms ease;
}
.switch.on .switch-track { background: var(--blue-600); }
.switch.on .switch-thumb { left: 16px; }

/* Glossary legend banner -- sits below wip banner + controls bar. */
.legend-banner {
    position: sticky;
    top: 84px;
    z-index: 98;
    width: 100%;
    margin: 0;
    padding: 10px 18px;
    background: var(--blue-50);
    border-bottom: 1px solid var(--blue-200);
    color: var(--blue-900);
    font-size: 13px;
    line-height: 1.4;
    box-shadow: 0 2px 6px var(--legend-shadow);
}
.legend-banner.collapsed { display: none; }
.legend-banner-body {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px 24px;
    margin: 0;
    padding: 0;
}
.legend-item { display: block; min-width: 0; }
.legend-term {
    display: inline;
    font-weight: 700;
    color: var(--blue-900);
    margin: 0;
}
.legend-term::after { content: ": "; }
.legend-def { display: inline; color: var(--blue-900); margin: 0; }

@media (max-width: 900px) {
    .legend-banner-body { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
    .legend-banner-body { grid-template-columns: 1fr; }
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

/**
 * Top-level site container. Renders the page chrome in light DOM, wires up
 * the controls / legend / file-modal subsystems, and exposes a `pageRoot`
 * slot where the entry script appends its page-specific element.
 *
 * Lifecycle:
 *   1. Entry script creates `<dashboard-site banner-text="..." ...>` and
 *      appends it to the document. connectedCallback renders the chrome and
 *      initializes the controls bar + legend banner.
 *   2. Entry script calls `site.mountPage(pageEl)` once suite-data has loaded.
 *      mountPage inserts the element into the page slot AND registers it for
 *      colour-mode refresh callbacks in one atomic operation.
 */
export class DashboardSite extends HTMLElement {
    /**
     * Insert `el` into the page slot and register it for colour-mode refresh
     * callbacks. Single entry point for mounting a page child -- the slot
     * insertion and the refreshPalette ref must stay in sync, so they're
     * driven together here.
     */
    mountPage(el) {
        const root = this.querySelector("#page-root");
        if (!root) throw new Error("dashboard-site: page-root not present (connectedCallback hasn't run yet?)");
        root.replaceChildren(el);
        this._pageEl = el;
    }

    /**
     * Replace the page slot's content with an error notice. The chrome
     * (banner / controls / glossary) stays visible. Used by pages.js when
     * suite-data load fails.
     */
    showError(errorHtml) {
        const root = this.querySelector("#page-root");
        if (root) root.innerHTML = errorHtml;
        this._pageEl = null;
    }

    connectedCallback() {
        const bannerText = this.getAttribute("banner-text") || "";
        const bannerLinkText = this.getAttribute("banner-link-text") || "";
        const issueUrl = this.getAttribute("issue-url") || "#";
        this.innerHTML = `
            <div class="wip-banner" role="alert">
                <span class="wip-icon" aria-hidden="true">${WARNING_EMOJI_HTML}</span>
                <span class="wip-text">${escapeHtml(bannerText)} <a class="wip-link" href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener">${escapeHtml(bannerLinkText)}</a></span>
                <span class="wip-icon" aria-hidden="true">${WARNING_EMOJI_HTML}</span>
            </div>
            <div class="controls-bar" aria-label="Display controls"></div>
            <div class="legend-banner" aria-label="Glossary"></div>
            <div class="wrap" id="page-root"></div>
            <file-modal></file-modal>
        `;
        this._initLegendBanner();
        this._initControlsBar();
    }

    /**
     * Populate the legend banner with the glossary terms from PAGE_DATA and
     * restore the user's expand/collapse preference. Hides the banner
     * entirely when no glossary is configured.
     */
    _initLegendBanner() {
        const banner = this.querySelector(".legend-banner");
        const glossary = ((window.PAGE_DATA || {}).glossary) || [];
        if (!Array.isArray(glossary) || glossary.length === 0) {
            banner.hidden = true;
            return;
        }
        const items = glossary.map((g) =>
            `<div class="legend-item"><dt class="legend-term">${escapeHtml(g.term)}</dt><dd class="legend-def">${escapeHtml(g.definition)}</dd></div>`
        ).join("");
        banner.innerHTML = `<dl class="legend-banner-body">${items}</dl>`;
        banner.classList.toggle("collapsed", !readBoolPref(LEGEND_STORAGE_KEY, true));
    }

    /**
     * Render the page-level display switches (Glossary + Colorblind) into the
     * controls bar and wire their click handlers.
     */
    _initControlsBar() {
        const bar = this.querySelector(".controls-bar");
        const banner = this.querySelector(".legend-banner");
        const hasGlossary = !banner.hidden;
        const legendOn = readBoolPref(LEGEND_STORAGE_KEY, true);

        const parts = [];
        if (hasGlossary) parts.push(renderSwitch("switch-glossary", "Glossary", legendOn));
        parts.push(renderSwitch("switch-colorblind", "Colorblind mode", isColorblindMode()));
        bar.innerHTML = parts.join("");

        const glossaryBtn = bar.querySelector("#switch-glossary");
        if (glossaryBtn) {
            glossaryBtn.addEventListener("click", () => {
                const next = !glossaryBtn.classList.contains("on");
                setSwitchState(glossaryBtn, next);
                banner.classList.toggle("collapsed", !next);
                writeBoolPref(LEGEND_STORAGE_KEY, next);
            });
        }
        const cbBtn = bar.querySelector("#switch-colorblind");
        cbBtn.addEventListener("click", () => {
            toggleColorblindMode();
            setSwitchState(cbBtn, isColorblindMode());
            clearPatternCache();
            if (this._pageEl && this._pageEl.refreshPalette) this._pageEl.refreshPalette();
        });
    }
}

customElements.define("dashboard-site", DashboardSite);

function renderSwitch(id, label, checked) {
    return `
    <label class="switch-control" for="${id}">
      <span class="switch-label">${escapeHtml(label)}</span>
      <button id="${id}" class="switch${checked ? " on" : ""}" type="button" role="switch" aria-checked="${checked ? "true" : "false"}">
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </button>
    </label>`;
}

function setSwitchState(btn, on) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
}

function readBoolPref(key, defaultValue) {
    try {
        const v = window.localStorage.getItem(key);
        if (v === null) return defaultValue;
        return v === "1" || v === "true";
    } catch { return defaultValue; }
}

function writeBoolPref(key, value) {
    try { window.localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ }
}
