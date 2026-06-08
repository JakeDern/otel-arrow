// ── <dashboard-shell> ───────────────────────────────────────────────────────
// Page shell rendered into light DOM (matching this codebase's no-shadow-DOM
// convention). Owns the wip-banner, the controls-bar host, the legend-banner
// host, and a `.wrap` container that holds the page-specific content element.
// Banner copy and link come in as attributes from bootstrap.js (sourced from
// PAGE_DATA), so the static index.html never needs to know about them.

import { escapeHtml } from "../format.js";
import { adopt, tokensSheet } from "../styles.js";
import { WARNING_EMOJI_HTML } from "../icons.js";

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
    background: #fef3c7;
    border-bottom: 2px solid #f59e0b;
    color: #78350f;
    font-weight: 700;
    font-size: 15px;
    line-height: 1.3;
    box-shadow: 0 2px 8px rgba(245, 158, 11, 0.18);
}
.wip-banner .wip-icon { flex: 0 0 auto; font-size: 22px; line-height: 1; }
.wip-banner .wip-text { flex: 0 1 auto; text-align: center; }
.wip-banner .wip-link { color: #78350f; text-decoration: underline; }
.wip-banner .wip-link:hover { color: #92400e; }

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
    color: #1e293b;
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
    background: #cbd5e1;
    border-radius: 999px;
    transition: background 140ms ease;
}
.switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
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
    color: #1e3a8a;
    font-size: 13px;
    line-height: 1.4;
    box-shadow: 0 2px 6px rgba(30, 64, 175, 0.08);
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
    color: #1e3a8a;
    margin: 0;
}
.legend-term::after { content: ": "; }
.legend-def { display: inline; color: #1e3a8a; margin: 0; }

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

export class DashboardShell extends HTMLElement {
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
            <div class="controls-bar" id="controls-bar" aria-label="Display controls"></div>
            <div class="legend-banner" id="legend-banner" aria-label="Glossary"></div>
            <div class="wrap" id="page-root"></div>
        `;
    }

    // Page mount target. The bootstrap hands this node to each page's
    // mountPage callback, which appends its top-level element here.
    get pageRoot() { return this.querySelector("#page-root"); }
}

customElements.define("dashboard-shell", DashboardShell);
