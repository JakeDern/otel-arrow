// ── Entry point ─────────────────────────────────────────────────────────────
// ES module loaded from page-data.js (which sets window.PAGE_DATA and injects
// the <script> tag for this file). Mounts <dashboard-shell> + <file-modal>,
// async-loads the per-suite data.js files declared in PAGE_DATA.suiteFiles,
// then mounts the page-specific element based on PAGE_DATA.kind:
//   - "landing":    one <comparison-section> per PAGE_DATA.comparisons[i]
//   - "comparison": one <comparison-page> with PAGE_DATA.comparison
//
// Stylesheets adopt themselves onto document.adoptedStyleSheets at the time
// each module loads (see shared/js/styles/{tokens,global}.js and each
// component's `adopt(tokensSheet, sheet)` call). No <link rel="stylesheet">
// in the static HTML.

import "./styles/global.js";
import "./components/dashboard-shell.js";
import "./components/comparison-section.js";
import "./components/comparison-page.js";
import "./components/file-modal.js";
import { escapeHtml } from "./format.js";
import { initLegendBanner, initControlsBar } from "./controls.js";

// Refs to the currently mounted page-specific elements so the colourblind
// switch can repaint without re-running the whole bootstrap. Declared before
// main() is called so the `let` bindings are out of TDZ when assigned inside
// mountLanding / mountComparisonPage.
let landingSections = null;
let comparisonPageEl = null;

try { main(); } catch (err) { fatal(err); }

/** Bootstrap entry: chrome, then async suite-data load, then page mount. */
function main() {
    const pd = window.PAGE_DATA;
    if (!pd) throw new Error("PAGE_DATA missing; page-data.js did not run before main.js");

    document.title = pd.title || "Benchmark Dashboard";
    const shell = mountShell(pd);

    document.body.appendChild(document.createElement("file-modal"));
    initLegendBanner();
    initControlsBar(rerenderCurrentPage);

    loadSuiteFiles(pd.suiteFiles || [])
        .then(() => mountPage(shell, pd))
        .catch((err) => showError(shell, err))
        .finally(() => document.documentElement.classList.add("ready"));
}

/**
 * Create the <dashboard-shell>, pass through banner attributes from PAGE_DATA,
 * and swap it in for the static `<div id="app">` placeholder.
 */
function mountShell(pd) {
    const shell = document.createElement("dashboard-shell");
    if (pd.bannerText) shell.setAttribute("banner-text", pd.bannerText);
    if (pd.bannerLinkText) shell.setAttribute("banner-link-text", pd.bannerLinkText);
    if (pd.issueUrl) shell.setAttribute("issue-url", pd.issueUrl);
    const app = document.getElementById("app");
    if (app) app.replaceWith(shell);
    else document.body.appendChild(shell);
    return shell;
}

/**
 * Branch on PAGE_DATA.kind and mount the page-specific element into the
 * shell's page-root.
 */
function mountPage(shell, pd) {
    const root = shell.pageRoot;
    if (pd.kind === "comparison") mountComparisonPage(root, pd);
    else if (pd.kind === "landing") mountLanding(root, pd);
    else throw new Error(`Unknown PAGE_DATA.kind: ${pd.kind}`);
}

/** Render the landing page: heading + one <comparison-section> per entry. */
function mountLanding(root, pd) {
    root.innerHTML = `
        <h1>Telemetry Engine Benchmark Dashboard</h1>
        <div class="sub">Compare telemetry engines across a variety of use-cases and protocols.</div>
        <div id="comparison-cards"></div>`;
    const cards = root.querySelector("#comparison-cards");
    const comparisons = pd.comparisons || [];
    if (!comparisons.length) {
        cards.innerHTML = '<div class="muted" style="padding:16px">No comparisons defined.</div>';
        landingSections = [];
        return;
    }
    const sections = [];
    for (const comp of comparisons) {
        const el = document.createElement("comparison-section");
        el.comparison = comp;
        cards.appendChild(el);
        sections.push(el);
    }
    landingSections = sections;
}

/** Render the comparison detail page. */
function mountComparisonPage(root, pd) {
    const el = document.createElement("comparison-page");
    el.compSlug = pd.comparisonSlug;
    el.comparison = pd.comparison;
    root.innerHTML = "";
    root.appendChild(el);
    comparisonPageEl = el;
}

/**
 * Hook passed to initControlsBar so the colourblind switch can repaint the
 * mounted page. Landing repaints all sections (so chart palettes refresh);
 * detail re-renders the whole page (same reason, plus the bar-chart inside).
 */
function rerenderCurrentPage() {
    if (comparisonPageEl) comparisonPageEl.render();
    else if (landingSections) for (const s of landingSections) s.refreshPalette();
}

/**
 * Append each suite-data <script> tag and resolve when they've all loaded.
 * The data.js files set entries on `window.SUITE_DATA[slug]`.
 */
function loadSuiteFiles(urls) { return Promise.all(urls.map(loadScript)); }

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(s);
    });
}

/** Recoverable failure during page mount: replace the page-root with a notice. */
function showError(shell, err) {
    const root = shell.pageRoot || shell;
    root.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
    console.error(err);
}

/** Last-resort handler when even bootstrap throws synchronously. */
function fatal(err) {
    document.documentElement.classList.add("ready");
    const body = document.body;
    if (body) body.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
    console.error(err);
}
