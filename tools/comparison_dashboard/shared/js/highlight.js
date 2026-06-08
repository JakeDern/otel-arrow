// ── Syntax highlighting for the file-viewer modal ───────────────────────────
// Lightweight line-by-line highlighters for YAML and JSON config files.

import { escapeHtml } from "./format.js";

export function highlightYaml(text) {
    return String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => {
        const ci = line.search(/\s#/);
        const base = ci >= 0 ? line.slice(0, ci) : line;
        const comment = ci >= 0 ? line.slice(ci + 1) : "";
        let html = escapeHtml(base);
        html = html.replace(/^(\s*-\s*)?([A-Za-z0-9_.-]+)(\s*:)/, (_, p = "", k = "", c = "") => `${escapeHtml(p)}<span class="yaml-key">${escapeHtml(k)}</span>${escapeHtml(c)}`);
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
