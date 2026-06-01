// ── Backpressure detection ──────────────────────────────────────────────────
// A test shows backpressure when it dropped too large a fraction of logs, or
// when the backend received rate deviated too far below the offered load.

import { getSuiteTests } from "./data.js";

export const DATA_LOSS_THRESHOLD = 5;
export const RATE_DEVIATION_THRESHOLD = 5;

const RECEIVED_RATE_METRICS = ["logs_received_rate", "metrics_received_rate", "spans_received_rate"];

export function hasBackpressure(metricsArray, loadgenRate) {
  if (!metricsArray) return false;
  const dropped = metricsArray.find((m) => m.name === "dropped_logs_percentage");
  if (dropped && typeof dropped.value === "number" && dropped.value > DATA_LOSS_THRESHOLD) return true;
  if (loadgenRate && loadgenRate > 0) {
    const received = metricsArray.find((m) => RECEIVED_RATE_METRICS.includes(m.name));
    if (received && typeof received.value === "number") {
      if ((loadgenRate - received.value) / loadgenRate * 100 > RATE_DEVIATION_THRESHOLD) return true;
    }
  }
  return false;
}

// Whether any test in a comparison currently shows backpressure. Drives the
// landing-page and detail legends.
export function anyComparisonBackpressure(suiteData, comparison) {
  const tests = comparison.tests || [];
  return (comparison.suites || []).some((r) => {
    const suiteTests = getSuiteTests(suiteData, r.slug);
    return tests.some((ct) => {
      const t = suiteTests.find((x) => x.name === ct.name);
      return t && hasBackpressure(t.metrics, ct.loadgen_rate);
    });
  });
}
