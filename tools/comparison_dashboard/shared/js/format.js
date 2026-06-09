// ── Formatting + escaping utilities ─────────────────────────────────────────
// Pure helpers with no dependencies on other dashboard modules. Metric display
// labels come from PAGE_DATA.metricsMeta (emitted by dashboard.py from manifest).

export function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

export function formatMetricValue(value, unit) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
    const v = Number(value);
    if (unit === "%") return `${v.toFixed(1)}%`;
    if (unit === "MiB") return `${v.toFixed(1)} MiB`;
    if (unit === "bytes/sec" || unit === "bytes/s") return formatBytes(v) + "/s";
    if (unit === "logs/sec" || unit === "logs/s") return formatCompactInteger(v) + "/s";
    if (unit === "seconds" || unit === "s") return `${v.toFixed(1)}s`;
    if (unit === "ms") return `${v.toFixed(1)}ms`;
    if (Math.abs(v) >= 1000) return formatCompactInteger(v);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
}

export function formatCompactInteger(v) {
    v = Number(v); if (!Number.isFinite(v)) return "-";
    if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
}

export function formatBytes(v) {
    v = Number(v); if (!Number.isFinite(v)) return "-";
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
    return `${Math.round(v)} B`;
}

export function metricLabel(name) {
    if (!name) return "";
    const meta = ((window.PAGE_DATA || {}).metricsMeta || {})[name];
    if (meta && meta.label) return meta.label;
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
