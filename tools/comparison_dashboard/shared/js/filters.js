// ── Filter infrastructure ───────────────────────────────────────────────────
// Per-comparison filter state (which meta values are checked) lives in a Map
// keyed by comparison slug so it persists across re-renders.

import { getSuiteMeta } from "./data.js";
import { escapeHtml } from "./format.js";

const FILTER_LABELS = {
    protocols: "Protocol",
    compression: "Compression",
    binary: "Binary",
    signals: "Signal",
};

const perComparisonFilters = new Map();

export function collectFilterCategories(suiteData, comparison) {
    const cats = {};
    for (const ref of comparison.suites || []) {
        const meta = getSuiteMeta(suiteData, ref.slug);
        for (const [key, val] of Object.entries(meta)) {
            if (!cats[key]) cats[key] = new Set();
            if (Array.isArray(val)) { for (const v of val) cats[key].add(String(v)); }
            else { cats[key].add(String(val)); }
        }
    }
    const result = {};
    for (const [key, vals] of Object.entries(cats)) {
        if (vals.size > 1) result[key] = [...vals].sort();
    }
    return result;
}

export function getFilterState(compSlug, categories) {
    if (!perComparisonFilters.has(compSlug)) {
        const state = new Map();
        for (const [cat, vals] of Object.entries(categories)) {
            state.set(cat, new Set(vals));
        }
        perComparisonFilters.set(compSlug, state);
    }
    return perComparisonFilters.get(compSlug);
}

export function suiteMatchesFilters(suiteData, slug, filterState) {
    const meta = getSuiteMeta(suiteData, slug);
    for (const [cat, checked] of filterState) {
        if (checked.size === 0) return false;
        const val = meta[cat];
        if (val === undefined) continue;
        if (Array.isArray(val)) {
            if (!val.some((v) => checked.has(String(v)))) return false;
        } else {
            if (!checked.has(String(val))) return false;
        }
    }
    return true;
}

export function filterComparison(comparison, suiteData, filterState) {
    const suites = [];
    const indices = [];
    for (let i = 0; i < (comparison.suites || []).length; i++) {
        if (suiteMatchesFilters(suiteData, comparison.suites[i].slug, filterState)) {
            suites.push(comparison.suites[i]);
            indices.push(i);
        }
    }
    return { ...comparison, suites, _originalIndices: indices };
}

export function buildFilterHtml(categories, filterState) {
    const groups = Object.entries(categories).map(([cat, vals]) => {
        const checked = filterState.get(cat) || new Set();
        const opts = vals.map((v) =>
            `<label class="chart-filter-option"><input type="checkbox" data-filter-category="${escapeHtml(cat)}" data-filter-value="${escapeHtml(v)}" ${checked.has(v) ? "checked" : ""}> ${escapeHtml(v)}</label>`
        ).join("");
        const label = FILTER_LABELS[cat] || cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        return `<div class="chart-filter-group"><span class="chart-filter-label">${escapeHtml(label)}:</span>${opts}</div>`;
    }).join("");
    return `<div class="chart-filters">${groups}<button class="filter-reset chart-filter-reset" type="button">Reset</button></div>`;
}

export function wireFilters(container, compSlug, categories, onChange) {
    const fs = perComparisonFilters.get(compSlug);
    if (!fs) return;
    for (const cb of container.querySelectorAll("input[data-filter-category]")) {
        cb.onchange = () => {
            const s = fs.get(cb.dataset.filterCategory);
            if (!s) return;
            cb.checked ? s.add(cb.dataset.filterValue) : s.delete(cb.dataset.filterValue);
            onChange();
        };
    }
    const resetBtn = container.querySelector(".chart-filter-reset");
    if (resetBtn) {
        resetBtn.onclick = () => {
            for (const [cat, vals] of Object.entries(categories)) fs.set(cat, new Set(vals));
            for (const cb of container.querySelectorAll("input[data-filter-category]")) cb.checked = true;
            onChange();
        };
    }
}
