// ── Landing page entry ──────────────────────────────────────────────────────
// Loaded by shared/landing.html via the boot block in page-data.js. Mounts a
// single <landing-page> and reports a repaint hook back to the bootstrap so
// the colourblind switch can fan out across the comparison-section cards.

import { bootstrap } from "../bootstrap.js";
import "../components/landing-page.js";

bootstrap((root, pd) => {
    const el = document.createElement("landing-page");
    el.comparisons = pd.comparisons || [];
    root.replaceChildren(el);
    return { repaint: () => el.refreshPalette() };
});
