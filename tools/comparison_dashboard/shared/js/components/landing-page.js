// ── <landing-page> ───────────────────────────────────────────────────────────
// Top-level element for the landing page: heading, sub-heading, and one
// <comparison-section> per entry in the `comparisons` property. Mounted by
// shared/js/entries/landing.js. Repaints its children when the colourblind
// switch flips (handled centrally by bootstrap.js + initControlsBar).

import { adopt, tokensSheet } from "../styles.js";
import "./comparison-section.js";

const css = `
landing-page { display: block; }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

/**
 * Custom element wrapping the landing page. Set `comparisons` (an array of
 * comparison definition objects) before mounting; the element renders its
 * own scaffolding on connect.
 */
export class LandingPage extends HTMLElement {
    /** Comparison definition list. Triggers a render when set. */
    set comparisons(c) { this._comparisons = c || []; if (this.isConnected) this.render(); }
    get comparisons() { return this._comparisons || []; }

    connectedCallback() { this.render(); }

    /**
     * Rebuild the heading + #comparison-cards grid. Each comparison gets a
     * <comparison-section> child. References to those children are kept on
     * `this._sections` so refreshPalette() can fan out to them.
     */
    render() {
        this.innerHTML = `
            <h1>Telemetry Engine Benchmark Dashboard</h1>
            <div class="sub">Compare telemetry engines across a variety of use-cases and protocols.</div>
            <div id="comparison-cards"></div>`;
        const cards = this.querySelector("#comparison-cards");
        this._sections = [];
        if (!this._comparisons || !this._comparisons.length) {
            cards.innerHTML = '<div class="muted" style="padding:16px">No comparisons defined.</div>';
            return;
        }
        for (const comp of this._comparisons) {
            const el = document.createElement("comparison-section");
            el.comparison = comp;
            cards.appendChild(el);
            this._sections.push(el);
        }
    }

    /**
     * Repaint each child <comparison-section> in place. Called by bootstrap
     * after the colourblind switch toggles.
     */
    refreshPalette() {
        if (!this._sections) return;
        for (const s of this._sections) s.refreshPalette();
    }
}

customElements.define("landing-page", LandingPage);
