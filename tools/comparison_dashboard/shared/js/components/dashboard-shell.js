// ── <dashboard-shell> ───────────────────────────────────────────────────────
// Page shell rendered into light DOM (matching this codebase's no-shadow-DOM
// convention). Owns the wip-banner, the controls-bar host, the legend-banner
// host, and a `.wrap` container that holds the page-specific content element.
// Banner copy and link come in as attributes from main.js (sourced from
// PAGE_DATA), so the static index.html never needs to know about them.

import { escapeHtml } from "../format.js";

export class DashboardShell extends HTMLElement {
    connectedCallback() {
        const bannerText = this.getAttribute("banner-text") || "";
        const bannerLinkText = this.getAttribute("banner-link-text") || "";
        const issueUrl = this.getAttribute("issue-url") || "#";
        this.innerHTML = `
            <div class="wip-banner" role="alert">
                <span class="wip-icon" aria-hidden="true">&#9888;&#65039;</span>
                <span class="wip-text">${escapeHtml(bannerText)} <a class="wip-link" href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener">${escapeHtml(bannerLinkText)}</a></span>
                <span class="wip-icon" aria-hidden="true">&#9888;&#65039;</span>
            </div>
            <div class="controls-bar" id="controls-bar" aria-label="Display controls"></div>
            <div class="legend-banner" id="legend-banner" aria-label="Glossary"></div>
            <div class="wrap" id="page-root"></div>
        `;
    }

    // Page mount target. `main.js` appends comparison-section / comparison-page
    // children here after the shell is in the document.
    get pageRoot() { return this.querySelector("#page-root"); }
}

customElements.define("dashboard-shell", DashboardShell);
