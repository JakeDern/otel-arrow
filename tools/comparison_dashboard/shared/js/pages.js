// ── Page bootstraps ─────────────────────────────────────────────────────────
// Two named exports, one per page kind:
//   - bootstrapLandingPage()    -- called from landing.html
//   - bootstrapComparisonPage() -- called from comparison.html
// Each HTML's inline <script type="module"> dynamic-imports this file (using
// PAGE_DATA.sharedHref for the correct relative path) and invokes its own
// bootstrap. Both share the chrome assembly via the internal `bootstrap()`
// helper; only the page element they build differs.
//
// Suite data is inlined into PAGE_DATA.suiteData by the build, so there's no
// async data-loading step here -- the bootstrap is fully synchronous.

import "./styles.js";
import "./components/dashboard-site.js";
import "./components/landing-page.js";
import "./components/comparison-page.js";
import { escapeHtml } from "./format.js";

/** Mount the landing page (heading + comparison-section cards). */
export function bootstrapLandingPage() {
    bootstrap((pd) => {
        const el = document.createElement("landing-page");
        el.comparisons = pd.comparisons || [];
        return el;
    });
}

/** Mount the comparison detail page (header + chart + detail panel). */
export function bootstrapComparisonPage() {
    bootstrap((pd) => {
        const el = document.createElement("comparison-page");
        el.compSlug = pd.comparisonSlug;
        el.comparison = pd.comparison;
        return el;
    });
}

/**
 * Shared bootstrap. Sets the document title, mounts <dashboard-site>, then
 * hands the site the page-specific element via site.mountPage(). Always
 * toggles `<html>.ready` at the end so the FOUC-blocker style reveals the
 * page (even on error).
 *
 * @param {(pd: Object) => HTMLElement} buildPageElement
 *        Receives the parsed PAGE_DATA and returns a configured page element.
 */
function bootstrap(buildPageElement) {
    let site = null;
    try {
        const pd = window.PAGE_DATA;
        if (!pd) throw new Error("PAGE_DATA missing; page-data.js did not run before pages.js");
        document.title = pd.title || "Benchmark Dashboard";
        site = mountSite(pd);
        site.mountPage(buildPageElement(pd));
    } catch (err) {
        if (site) site.showError(errorHtml(err));
        else fatal(err);
    } finally {
        document.documentElement.classList.add("ready");
    }
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

function errorHtml(err) {
    return `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
}

/** Last-resort handler when bootstrap throws before the site mounts. */
function fatal(err) {
    const body = document.body;
    if (body) body.innerHTML = errorHtml(err);
    console.error(err);
}
