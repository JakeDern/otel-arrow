// ============================================================================
// format.js -- pure formatting + escaping + syntax-highlighting helpers.
//
// Framework-agnostic. No DOM mutation beyond a throwaway element used for HTML
// escaping. Ported verbatim from app.js so behavior is identical.
// ============================================================================

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
  if (Math.abs(v) >= 1e9) return `${(v/1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function formatBytes(v) {
  v = Number(v); if (!Number.isFinite(v)) return "-";
  if (v >= 1e9) return `${(v/1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v/1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v/1e3).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}

// ── Syntax highlighting ──────────────────────────────────────────────────

export function highlightYaml(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => {
    const ci = line.search(/\s#/);
    const base = ci >= 0 ? line.slice(0, ci) : line;
    const comment = ci >= 0 ? line.slice(ci + 1) : "";
    let html = escapeHtml(base);
    html = html.replace(/^(\s*-\s*)?([A-Za-z0-9_.-]+)(\s*:)/, (_, p="", k="", c="") => `${escapeHtml(p)}<span class="yaml-key">${escapeHtml(k)}</span>${escapeHtml(c)}`);
    html = html.replace(/(&quot;[^&]*&quot;|'[^']*')/g, '<span class="yaml-string">$1</span>');
    html = html.replace(/\b(true|false|null)\b/g, '<span class="yaml-bool">$1</span>');
    html = html.replace(/(^|[^\w.-])(-?\d+(?:\.\d+)?)(?=$|[^\w.-])/g, (_, p, n) => `${p}<span class="yaml-number">${n}</span>`);
    if (comment) html += `<span class="yaml-comment">${escapeHtml(`#${comment}`)}</span>`;
    return html || "&nbsp;";
  }).join("\n");
}

export function highlightJson(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => {
    let html = escapeHtml(line);
    html = html.replace(/^(\s*)(&quot;)((?:[^&]|&(?!quot;))*)(&quot;)(\s*:)/, (_, i, q1, k, q2, c) => `${i}<span class="yaml-key">${q1}${k}${q2}</span>${c}`);
    html = html.replace(/(:\s*|^\s*-?\s*)(&quot;)((?:[^&]|&(?!quot;))*)(&quot;)/g, (m, p, q1, s, q2) => p.includes(":") || p.trim().startsWith("-") ? `${p}<span class="yaml-string">${q1}${s}${q2}</span>` : m);
    html = html.replace(/\b(true|false|null)\b/g, '<span class="yaml-bool">$1</span>');
    html = html.replace(/(:\s*|^\s*-?\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*[,\]]?\s*$)/g, (_, p, n, s) => `${p}<span class="yaml-number">${n}</span>${s}`);
    return html || "&nbsp;";
  }).join("\n");
}

export function highlightFileContent(name, content) {
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return highlightYaml(content);
  if (name.endsWith(".json")) return highlightJson(content);
  return escapeHtml(content);
}
