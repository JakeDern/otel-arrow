// ============================================================================
// env.js -- pure environment fingerprint + detail helpers.
//
// Returns plain data (strings, row arrays) rather than HTML so the Alpine
// templates can bind to it. Logic ported verbatim from app.js.
// ============================================================================

// Single-line fingerprint, e.g. "Intel ... / x86_64 / 8 cores / 32 GiB / Ubuntu 24.04".
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

// Key/value rows for the per-suite environment detail block. Returns
// [[key, value], ...] or null when there is no env data.
export function envDetailRows(env) {
  if (!env) return null;
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
  return rows;
}

// Header model for a comparison. One of:
//   { kind: "mismatch", mismatch }   -> mismatched-hardware banner
//   { kind: "summary", line }        -> single fingerprint line
//   { kind: "unknown" }              -> no env recorded
export function comparisonEnvHeader(suiteData, comparison) {
  if (comparison.envMismatch) return { kind: "mismatch", mismatch: comparison.envMismatch };
  for (const ref of comparison.suites || []) {
    const suite = suiteData[ref.slug];
    const env = suite && suite.env;
    if (env) return { kind: "summary", line: envFingerprintLine(env) };
  }
  return { kind: "unknown" };
}
