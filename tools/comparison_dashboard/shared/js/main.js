// ============================================================================
// Lit bootstrap entry module (ENTRY_SCRIPT in dashboard.py).
//
// Loaded as <script type="module"> by every generated page after Chart.js,
// the per-suite data.js scripts, and the window.* globals. It registers the
// custom elements (via their imports) and wires the page:
//   - Landing page (window.COMPARISONS): a colorblind toggle in #app and one
//     <comparison-section> per comparison in #comparison-cards.
//   - Detail page (window.COMPARISON_SLUG): one <comparison-page> in #app.
//
// A single <file-modal> controller is mounted on every page; "open-file"
// CustomEvents bubbling from the detail panel are routed to it.
//
// Data flows in by setting element PROPERTIES (not attributes): the bootstrap
// reads the window.* globals once and assigns .suiteData / .comparison(s) /
// .compSlug. The globals themselves are the unchanged data contract emitted by
// dashboard.py's generate_suite_data_js / templates.
// ============================================================================

import { loadSuiteData } from "./data.js";
import { isColorblindMode, setColorblindMode } from "./colors.js";
import "./components/comparison-section.js";
import "./components/comparison-page.js";
import { FileModal } from "./components/file-modal.js";

function mountFileModal() {
  let modal = document.querySelector("file-modal");
  if (!modal) {
    modal = document.createElement("file-modal");
    document.body.appendChild(modal);
  }
  // Route bubbling open-file events from the detail panel to the modal.
  document.addEventListener("open-file", (e) => {
    const { suiteSlug, testName, fileName } = e.detail || {};
    if (modal instanceof FileModal) modal.open(suiteSlug, testName, fileName);
  });
  return modal;
}

function renderLandingPage() {
  const app = document.getElementById("app");
  const cardsEl = document.getElementById("comparison-cards");
  if (!app) return;
  const suiteData = loadSuiteData();
  const comparisons = window.COMPARISONS || [];

  renderColorblindToggle(app, renderLandingPage);

  if (!cardsEl) return;
  if (!comparisons.length) {
    cardsEl.innerHTML = '<div class="muted" style="padding:16px">No comparisons defined.</div>';
    return;
  }

  // Rebuild sections each render (e.g. after a palette toggle). Each section
  // owns its own chart lifecycle.
  cardsEl.innerHTML = "";
  for (const comp of comparisons) {
    const section = document.createElement("comparison-section");
    section.suiteData = suiteData;
    section.comparison = comp;
    cardsEl.appendChild(section);
  }
}

// The landing-page colorblind toggle lives in #app and repaints the whole
// landing page (every section's chart) on click, matching app.js.
function renderColorblindToggle(app, rerender) {
  const label = isColorblindMode() ? "Standard Colors" : "Colorblind Mode";
  const active = isColorblindMode() ? " active" : "";
  app.innerHTML = `<button class="colorblind-toggle${active}" type="button" title="Toggle colorblind-friendly palette">${label}</button>`;
  const btn = app.querySelector(".colorblind-toggle");
  if (btn) btn.onclick = () => { setColorblindMode(!isColorblindMode()); rerender(); };
}

function renderComparisonPage(compSlug) {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = "";
  const page = document.createElement("comparison-page");
  page.suiteData = loadSuiteData();
  page.comparison = window.COMPARISON || null;
  page.compSlug = compSlug;
  app.appendChild(page);
}

function main() {
  mountFileModal();
  if (window.COMPARISON_SLUG) { renderComparisonPage(window.COMPARISON_SLUG); return; }
  if (window.COMPARISONS) { renderLandingPage(); return; }
  const app = document.getElementById("app");
  if (app) app.innerHTML = '<div class="muted" style="padding:16px">No data loaded. Run build.py to generate dashboard data.</div>';
}

try { main(); } catch (err) {
  const app = document.getElementById("app");
  if (app) app.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${String(err)}</pre>`;
  console.error(err);
}
