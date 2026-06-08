// ── Page bootstraps ─────────────────────────────────────────────────────────
// Two named exports, one per page kind:
//   - bootstrapLandingPage()    -- called from landing.html
//   - bootstrapComparisonPage() -- called from comparison.html
// Each HTML's inline <script type="module"> dynamic-imports this file (using
// PAGE_DATA.sharedHref for the correct relative path) and invokes its own
// bootstrap. Both share the chrome assembly + async suite-data load via the
// internal `bootstrap()` helper; only the page-element type differs.

import "./styles.js";
import "./components/dashboard-site.js";
import "./components/landing-page.js";
import "./components/comparison-page.js";
import { escapeHtml } from "./format.js";

/** Mount the landing page (heading + comparison-section cards). */
export function bootstrapLandingPage() {
    bootstrap((pageRoot, pd) => {
        const el = document.createElement("landing-page");
        el.comparisons = pd.comparisons || [];
        pageRoot.replaceChildren(el);
        return el;
    });
}

/** Mount the comparison detail page (header + chart + detail panel). */
export function bootstrapComparisonPage() {
    bootstrap((pageRoot, pd) => {
        const el = document.createElement("comparison-page");
        el.compSlug = pd.comparisonSlug;
        el.comparison = pd.comparison;
        pageRoot.replaceChildren(el);
        return el;
    });
}

/**
 * Shared bootstrap. Sets the document title, mounts <dashboard-site>, awaits
 * the suite-data file loads, then hands the site the page-specific element
 * (whose `repaint()` method drives colour-mode refreshes).
 *
 * @param {(pageRoot: HTMLElement, pd: Object) => HTMLElement} mountPage
 */
function bootstrap(mountPage) {
    try { run(mountPage); } catch (err) { fatal(err); }
}

function run(mountPage) {
    const pd = window.PAGE_DATA;
    if (!pd) throw new Error("PAGE_DATA missing; page-data.js did not run before pages.js");

    document.title = pd.title || "Benchmark Dashboard";
    const site = mountSite(pd);

    loadSuiteFiles(pd.suiteFiles || [])
        .then(() => { site.pageElement = mountPage(site.pageRoot, pd); })
        .catch((err) => showError(site, err))
        .finally(() => document.documentElement.classList.add("ready"));
}

/** Create <dashboard-site>, copy banner attributes from PAGE_DATA, swap into #app. */
function mountSite(pd) {
    const site = document.createElement("dashboard-site");
    if (pd.bannerText) site.setAttribute("banner-text", pd.bannerText);
    if (pd.bannerLinkText) site.setAttribute("banner-link-text", pd.bannerLinkText);
    if (pd.issueUrl) site.setAttribute("issue-url", pd.issueUrl);
    const app = document.getElementById("app");
    if (app) app.replaceWith(site);
    else document.body.appendChild(site);
    return site;
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
function showError(site, err) {
    const root = site.pageRoot || site;
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
