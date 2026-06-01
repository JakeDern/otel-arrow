// ── Entry point ─────────────────────────────────────────────────────────────
// ES module loaded by every generated page. Two modes, selected by which
// globals dashboard.py embedded:
//   - Comparison detail page: window.COMPARISON_SLUG set
//   - Landing page:           window.COMPARISONS set
// Suite data is pre-loaded via <script> tags that populate window.SUITE_DATA.

import { escapeHtml } from "./format.js";
import { initModal } from "./modal.js";
import { renderLandingPage } from "./pages/landing.js";
import { renderComparisonPage } from "./pages/comparison.js";

function main() {
  initModal();
  if (window.COMPARISON_SLUG) renderComparisonPage(window.COMPARISON_SLUG);
  else if (window.COMPARISONS) renderLandingPage();
  else { const app = document.getElementById("app"); if (app) app.innerHTML = '<div class="muted" style="padding:16px">No data loaded. Run build.py to generate dashboard data.</div>'; }
}

try { main(); } catch (err) {
  const app = document.getElementById("app");
  if (app) app.innerHTML = `<pre style="padding:16px;color:red">Failed to load dashboard: ${escapeHtml(String(err))}</pre>`;
  console.error(err);
}
