// ── Entry point ─────────────────────────────────────────────────────────────
// ES module loaded by every generated page. Registers the custom elements
// (side-effect imports), mounts the file-modal controller, and bootstraps the
// page by reading the globals dashboard.py embedded:
//   - Comparison detail page: window.COMPARISON_SLUG set
//   - Landing page:           window.COMPARISONS set
// Suite data is pre-loaded via <script> tags that populate window.SUITE_DATA.
// Data is passed to elements as JS properties (objects cannot go through HTML
// attributes), set before append so connectedCallback renders with data present.

import "./components/comparison-section.js";
import "./components/comparison-page.js";
import "./components/file-modal.js";
import { escapeHtml } from "./format.js";
import { initLegendBanner, initControlsBar } from "./controls.js";

function mountFileModal() {
    if (!document.querySelector("file-modal")) {
        document.body.appendChild(document.createElement("file-modal"));
    }
}

// Refs to the mounted page so the controls bar can repaint after a
// colorblind toggle. Populated by mountLanding / mountComparisonPage.
let landingSections = null;
let comparisonPageEl = null;

function mountLanding() {
    const app = document.getElementById("app");
    const cards = document.getElementById("comparison-cards");
    if (!app || !cards) return;
    const comparisons = window.COMPARISONS || [];
    app.innerHTML = "";
    if (!comparisons.length) {
        cards.innerHTML = '<div class="muted" style="padding:16px">No comparisons defined.</div>';
        landingSections = [];
        return;
    }
    cards.innerHTML = "";
    const sections = [];
    for (const comp of comparisons) {
        const el = document.createElement("comparison-section");
        el.comparison = comp;
        cards.appendChild(el);
        sections.push(el);
    }
    landingSections = sections;
}

function mountComparisonPage() {
    const app = document.getElementById("app");
    if (!app) return;
    const el = document.createElement("comparison-page");
    el.compSlug = window.COMPARISON_SLUG;
    el.comparison = window.COMPARISON;
    app.innerHTML = "";
    app.appendChild(el);
    comparisonPageEl = el;
}

function rerenderCurrentPage() {
    if (comparisonPageEl) comparisonPageEl.render();
    else if (landingSections) for (const s of landingSections) s.refreshPalette();
}

function main() {
    initLegendBanner();
    initControlsBar(rerenderCurrentPage);
    mountFileModal();
    if (window.COMPARISON_SLUG) mountComparisonPage();
    else if (window.COMPARISONS) mountLanding();
    else { const app = document.getElementById("app"); if (app) app.innerHTML = '<div class="muted" style="padding:16px">No data loaded. Run build.py to generate dashboard data.</div>'; }
}

try { main(); } catch (err) {
    const app = document.getElementById("app");
    if (app) app.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
    console.error(err);
}
