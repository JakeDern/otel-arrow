// ── Environment summary / detail rendering ──────────────────────────────────
// Renders the hardware/OS fingerprint shown in the comparison header and the
// per-run environment block in the detail panel.

import { escapeHtml } from "./format.js";
import { adopt } from "./styles/adopt.js";
import { tokensSheet } from "./styles/tokens.js";
import { WARNING_EMOJI_HTML } from "./icons.js";

const css = `
.env-summary {
    margin: 12px 0 8px;
    padding: 8px 12px;
    background: var(--slate-100);
    border-left: 3px solid var(--slate-500);
    border-radius: 4px;
    font-size: 13px;
    color: var(--slate-900);
}
.env-summary-label {
    font-weight: 600;
    color: var(--slate-700);
    margin-right: 6px;
}
.env-summary-value {
    font-family: var(--font-mono);
    font-size: 12px;
}
.env-summary-unknown {
    background: #fef3c7;
    border-left-color: #f59e0b;
    color: #78350f;
}

.env-mismatch-banner {
    margin: 12px 0;
    padding: 12px 14px;
    background: var(--bad-bg);
    border: 1px solid var(--bad-border);
    border-left: 4px solid #dc2626;
    border-radius: 6px;
    color: #7f1d1d;
}
.env-mismatch-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
.env-mismatch-reason { font-size: 12px; margin-bottom: 8px; }
.env-mismatch-list {
    margin: 0 0 6px 0;
    padding-left: 18px;
    font-size: 12px;
    font-family: var(--font-mono);
}
.env-mismatch-list li { margin-bottom: 2px; }
.env-mismatch-slug { font-weight: 600; }
.env-mismatch-note {
    font-size: 11px;
    color: var(--bad-text);
    font-style: italic;
}

.env-detail {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin-top: 4px;
    padding: 8px 10px;
    background: var(--slate-50);
    border: 1px solid var(--slate-200);
    border-radius: 4px;
    font-size: 12px;
}
.env-detail-row { display: contents; }
.env-detail-key { color: var(--slate-500); font-weight: 600; }
.env-detail-val {
    color: var(--slate-900);
    font-family: var(--font-mono);
    word-break: break-word;
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
adopt(tokensSheet, sheet);

export function renderComparisonEnvHeader(suiteData, comparison) {
    // If the build flagged a mismatch (only happens with --allow-env-mismatch),
    // surface the warning prominently with a per-suite breakdown.
    if (comparison.envMismatch) return renderEnvMismatchBanner(comparison.envMismatch);

    // No mismatch: every suite that has env data agrees on its fingerprint.
    // Show the fingerprint once. If no suite has env data, say so.
    const refs = comparison.suites || [];
    for (const ref of refs) {
        const suite = suiteData[ref.slug];
        const env = suite && suite.env;
        if (env) return renderEnvSummary(env);
    }
    return '<div class="env-summary env-summary-unknown">Environment: unknown (no run_env.json recorded)</div>';
}

export function renderEnvSummary(env) {
    const line = envFingerprintLine(env);
    return `<div class="env-summary"><span class="env-summary-label">Environment:</span> <span class="env-summary-value">${escapeHtml(line)}</span></div>`;
}

export function renderEnvMismatchBanner(mm) {
    const ref = mm.reference || {};
    const con = mm.conflict || {};
    return `<div class="env-mismatch-banner" role="alert">
    <div class="env-mismatch-title">${WARNING_EMOJI_HTML} Mismatched run environments</div>
    <div class="env-mismatch-reason">This comparison mixes data collected on different hardware. Results are not apples-to-apples.</div>
    <ul class="env-mismatch-list">
      <li><span class="env-mismatch-slug">${escapeHtml(ref.slug || "?")}</span> (reference): ${escapeHtml(ref.fingerprintStr || "no env recorded")}</li>
      <li><span class="env-mismatch-slug">${escapeHtml(con.slug || "?")}</span>: ${escapeHtml(con.fingerprintStr || "no env recorded")}</li>
    </ul>
    <div class="env-mismatch-note">Re-run the conflicting suite on the reference hardware, or omit it from the comparison.</div>
  </div>`;
}

export function renderEnvDetail(env) {
    if (!env) {
        return '<div class="detail-pane-title" style="margin-top:16px">Environment</div><div class="muted" style="padding:4px 0">No environment data recorded for this run.</div>';
    }
    const cpu = env.cpu || {};
    const os = env.os || {};
    const mem = env.memory || {};
    const rows = [
        ["CPU", cpu.model || "unknown"],
        ["Architecture", cpu.architecture || "unknown"],
        ["Cores", `${cpu.physical_cores ?? "?"} physical / ${cpu.logical_cores ?? "?"} logical`],
        ["RAM", mem.total_gib_rounded != null ? `${mem.total_gib_rounded} GiB` : "unknown"],
        ["OS", `${os.system || "unknown"} ${os.release || ""}`.trim()],
    ];
    if (cpu.max_freq_mhz) rows.push(["Max CPU freq", `${cpu.max_freq_mhz.toFixed(0)} MHz`]);
    if (os.distro && os.distro.NAME) {
        const ver = os.distro.VERSION_ID || os.distro.VERSION || "";
        rows.push(["Distro", `${os.distro.NAME} ${ver}`.trim()]);
    }
    if (env.started_at) rows.push(["Started", env.started_at]);
    if (env.ended_at) rows.push(["Ended", env.ended_at]);

    const body = rows.map(([k, v]) =>
        `<div class="env-detail-row"><div class="env-detail-key">${escapeHtml(k)}</div><div class="env-detail-val">${escapeHtml(String(v))}</div></div>`
    ).join("");
    return `<div class="detail-pane-title" style="margin-top:16px">Environment</div><div class="env-detail">${body}</div>`;
}

export function envFingerprintLine(env) {
    if (!env) return "unknown environment";
    const cpu = env.cpu || {};
    const os = env.os || {};
    const mem = env.memory || {};
    const parts = [`${cpu.model || "unknown CPU"} / ${cpu.architecture || "?"}`];
    if (cpu.physical_cores != null) parts.push(`${cpu.physical_cores} cores`);
    if (mem.total_gib_rounded != null) parts.push(`${mem.total_gib_rounded} GiB`);
    // OS portion: prefer "Ubuntu 24.04" over kernel release (kernel is
    // captured but is not part of the comparison-invalidation fingerprint).
    const distro = os.distro || {};
    const distroLabel = [distro.NAME, distro.VERSION_ID || distro.VERSION].filter(Boolean).join(" ");
    if (distroLabel) parts.push(distroLabel);
    else if (os.system) parts.push(String(os.system));
    return parts.join(" / ");
}
