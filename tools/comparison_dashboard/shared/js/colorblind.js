// ── Colorblind palette toggle (UI) ──────────────────────────────────────────

import { isColorblindMode, toggleColorblindMode } from "./charts/colors.js";
import { clearPatternCache } from "./charts/pattern.js";

export function renderColorblindToggle() {
    const label = isColorblindMode() ? "Standard Colors" : "Colorblind Mode";
    return `<button class="colorblind-toggle${isColorblindMode() ? " active" : ""}" type="button" title="Toggle colorblind-friendly palette">${label}</button>`;
}

export function wireColorblindToggle(container, rerender) {
    const btn = container.querySelector(".colorblind-toggle");
    if (!btn) return;
    btn.onclick = () => {
        toggleColorblindMode();
        clearPatternCache();
        rerender();
    };
}
