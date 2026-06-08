// ── Shared page bootstrap ───────────────────────────────────────────────────
// Each per-page entry script (shared/js/entries/{landing,comparison}.js) calls
// `bootstrap(mountPage)` with a callback that knows how to build the top-level
// custom element for that page. This module does all the cross-page chrome
// work -- title, <dashboard-shell>, <file-modal>, controls/legend, suite-file
// async load, FOUC reveal -- and never has to ask which page it is on.

import "./styles.js";
import "./components/dashboard-shell.js";
import "./components/file-modal.js";
import { escapeHtml } from "./format.js";
import { initLegendBanner, initControlsBar } from "./controls.js";

/**
 * Handle returned by a `mountPage` callback. The single `repaint` method is
 * invoked when the colourblind switch flips so the page can re-render with
 * the new palette.
 *
 * @typedef {Object} MountedPage
 * @property {() => void} repaint
 */

/**
 * Mount the page shell, async-load suite data, then hand off to a
 * page-specific mounter. Catches synchronous and async failures.
 *
 * @param {(root: HTMLElement, pd: Object) => MountedPage} mountPage
 *        Receives the shell's page-root container and the parsed PAGE_DATA;
 *        must mount its top-level element into `root` and return a handle
 *        whose `repaint()` re-renders the page in place.
 */
export function bootstrap(mountPage) {
    try { run(mountPage); } catch (err) { fatal(err); }
}

function run(mountPage) {
    const pd = window.PAGE_DATA;
    if (!pd) throw new Error("PAGE_DATA missing; page-data.js did not run before the entry script");

    document.title = pd.title || "Benchmark Dashboard";
    const shell = mountShell(pd);
    document.body.appendChild(document.createElement("file-modal"));
    initLegendBanner();

    // Closure-captured ref to the currently mounted page element. The
    // colourblind switch repaints by calling its `repaint()` method; no
    // module-scope state and no branching on page kind.
    let mounted = null;
    initControlsBar(() => { if (mounted) mounted.repaint(); });

    loadSuiteFiles(pd.suiteFiles || [])
        .then(() => { mounted = mountPage(shell.pageRoot, pd); })
        .catch((err) => showError(shell, err))
        .finally(() => document.documentElement.classList.add("ready"));
}

/**
 * Create <dashboard-shell>, copy banner attributes from PAGE_DATA, and swap
 * it in for the static `<div id="app">` placeholder.
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
