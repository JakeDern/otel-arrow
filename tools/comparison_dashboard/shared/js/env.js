// ── Environment summary / detail rendering ──────────────────────────────────
// Renders the hardware/OS fingerprint shown in the comparison header and the
// per-run environment block in the detail panel.

import { escapeHtml } from "./format.js";

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
    <div class="env-mismatch-title">&#9888;&#65039; Mismatched run environments</div>
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
