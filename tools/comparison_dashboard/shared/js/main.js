// ============================================================================
// main.js -- Alpine bootstrap entry point.
//
// Loaded as <script type="module"> after the Alpine CDN script (deferred) and
// the per-suite data.js <script> tags. Registers the component factories and
// the palette store on the `alpine:init` event, which Alpine fires before it
// walks the DOM -- so x-data="comparisonSection(...)" etc. resolve.
//
// Data contract (unchanged): the page sets window.SUITE_DATA (via data.js),
// window.METRICS_META, window.DATA_PATH, and either window.COMPARISONS
// (landing) or window.COMPARISON + window.COMPARISON_SLUG (detail). The
// templates read those globals inline to seed the x-data components.
// ============================================================================

import { registerComponents } from "./components.js";

document.addEventListener("alpine:init", () => {
  // window.Alpine is provided by the deferred CDN build.
  registerComponents(window.Alpine);
});
