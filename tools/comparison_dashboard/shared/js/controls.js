// ── Controls bar + legend banner ───────────────────────────────────────────
// Renders the page-level controls bar (display switches) and the pinned
// glossary banner. Both target placeholders (#controls-bar / #legend-banner)
// rendered by <dashboard-shell>. Switch state is persisted to
// localStorage. Colorblind switch flips the chart palette via shared state
// in charts/colors.js and triggers a rerender of the active page.

import { escapeHtml } from "./format.js";
import { isColorblindMode, toggleColorblindMode } from "./charts/colors.js";
import { clearPatternCache } from "./charts/pattern.js";

const LEGEND_STORAGE_KEY = "legend-banner-expanded";

/**
 * Populate the #legend-banner host (rendered by <dashboard-shell>) with the
 * glossary terms in PAGE_DATA.glossary and restore the user's expand/collapse
 * preference. Hides the banner entirely when no glossary is configured.
 */
export function initLegendBanner() {
    const banner = document.getElementById("legend-banner");
    if (!banner) return;
    const glossary = ((window.PAGE_DATA || {}).glossary) || [];
    if (!Array.isArray(glossary) || glossary.length === 0) {
        banner.hidden = true;
        return;
    }
    const items = glossary.map((g) =>
        `<div class="legend-item"><dt class="legend-term">${escapeHtml(g.term)}</dt><dd class="legend-def">${escapeHtml(g.definition)}</dd></div>`
    ).join("");
    banner.innerHTML = `<dl class="legend-banner-body" id="legend-banner-body">${items}</dl>`;
    const expanded = readBoolPref(LEGEND_STORAGE_KEY, true);
    banner.classList.toggle("collapsed", !expanded);
}

/**
 * Render the page-level display switches into the #controls-bar host.
 * The colourblind switch flips the chart palette and calls back to `rerender`
 * so the active page can repaint with the new colours.
 *
 * @param {() => void} rerender Invoked after the colourblind palette flips.
 */
export function initControlsBar(rerender) {
    const bar = document.getElementById("controls-bar");
    if (!bar) return;
    const glossary = ((window.PAGE_DATA || {}).glossary) || [];
    const hasGlossary = Array.isArray(glossary) && glossary.length > 0;
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
            setLegendVisible(next);
        });
    }
    const cbBtn = bar.querySelector("#switch-colorblind");
    if (cbBtn) {
        cbBtn.addEventListener("click", () => {
            toggleColorblindMode();
            setSwitchState(cbBtn, isColorblindMode());
            clearPatternCache();
            if (typeof rerender === "function") rerender();
        });
    }
}

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

function setLegendVisible(visible) {
    const banner = document.getElementById("legend-banner");
    if (banner) banner.classList.toggle("collapsed", !visible);
    writeBoolPref(LEGEND_STORAGE_KEY, visible);
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
