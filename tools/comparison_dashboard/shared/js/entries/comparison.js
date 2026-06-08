// ── Comparison detail page entry ────────────────────────────────────────────
// Loaded by shared/comparison.html via the boot block in page-data.js. Mounts
// a single <comparison-page> and reports a repaint hook back to the bootstrap
// so the colourblind switch can re-render with the new palette.

import { bootstrap } from "../bootstrap.js";
import "../components/comparison-page.js";

bootstrap((root, pd) => {
    const el = document.createElement("comparison-page");
    el.compSlug = pd.comparisonSlug;
    el.comparison = pd.comparison;
    root.replaceChildren(el);
    return { repaint: () => el.render() };
});
