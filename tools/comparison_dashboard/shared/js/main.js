// ── Entry point ─────────────────────────────────────────────────────────────
// ES module loaded from page-data.js (which sets PAGE_DATA and injects the
// <link>/<script> tags). Mounts <dashboard-shell> + <file-modal>, async-loads
// the per-suite data.js files declared in PAGE_DATA.suiteFiles, then mounts
// the page-specific element based on PAGE_DATA.kind:
//   - "landing":    one <comparison-section> per PAGE_DATA.comparisons[i]
//   - "comparison": one <comparison-page> with PAGE_DATA.comparison

import "./components/dashboard-shell.js";
import "./components/comparison-section.js";
import "./components/comparison-page.js";
import "./components/file-modal.js";
import { escapeHtml } from "./format.js";
import { initLegendBanner, initControlsBar } from "./controls.js";

// Tracks what's mounted in the page-root so the colorblind switch can repaint.
let landingSections = null;
let comparisonPageEl = null;

function main() {
    const pd = window.PAGE_DATA;
    if (!pd) throw new Error("PAGE_DATA missing; page-data.js did not run before main.js");

    document.title = pd.title || "Benchmark Dashboard";

    const shell = document.createElement("dashboard-shell");
    if (pd.bannerText) shell.setAttribute("banner-text", pd.bannerText);
    if (pd.bannerLinkText) shell.setAttribute("banner-link-text", pd.bannerLinkText);
    if (pd.issueUrl) shell.setAttribute("issue-url", pd.issueUrl);
    // Replace the static <div id="app"> placeholder so the shell owns the body
    // layout: banner -> controls -> legend -> .wrap (page-root).
    const app = document.getElementById("app");
    if (app) app.replaceWith(shell);
    else document.body.appendChild(shell);

    document.body.appendChild(document.createElement("file-modal"));

    initLegendBanner();
    initControlsBar(rerenderCurrentPage);

    loadSuiteFiles(pd.suiteFiles || [])
        .then(() => mountPage(shell, pd))
        .catch((err) => showError(shell, err))
        .finally(() => document.documentElement.classList.add("ready"));
}

function mountPage(shell, pd) {
    const root = shell.pageRoot;
    if (pd.kind === "comparison") mountComparisonPage(root, pd);
    else if (pd.kind === "landing") mountLanding(root, pd);
    else throw new Error(`Unknown PAGE_DATA.kind: ${pd.kind}`);
}

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

function mountComparisonPage(root, pd) {
    const el = document.createElement("comparison-page");
    el.compSlug = pd.comparisonSlug;
    el.comparison = pd.comparison;
    root.innerHTML = "";
    root.appendChild(el);
    comparisonPageEl = el;
}

function rerenderCurrentPage() {
    if (comparisonPageEl) comparisonPageEl.render();
    else if (landingSections) for (const s of landingSections) s.refreshPalette();
}

// Append the suite data.js URLs declared in PAGE_DATA.suiteFiles as script
// tags and wait for them all to populate window.SUITE_DATA. URLs are
// relative paths resolved against the current document.
function loadSuiteFiles(urls) {
    return Promise.all(urls.map(loadScript));
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(s);
    });
}

function showError(shell, err) {
    const root = shell.pageRoot || shell;
    root.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
    console.error(err);
}

try { main(); } catch (err) {
    document.documentElement.classList.add("ready");
    const body = document.body;
    if (body) body.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
    console.error(err);
}
