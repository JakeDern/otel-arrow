// ============================================================================
// components.js -- Alpine.js component factories + global store.
//
// Declarative state (selectedMetric, filterState, detailSuiteIdx,
// detailTestName, colorblind) lives in Alpine x-data / a store. Chart.js
// instances are kept in plain closure variables inside each factory -- never
// as reactive x-data properties -- because Alpine's proxy wrapping breaks a
// Chart's internal references. Charts are created in x-init and refreshed by
// $watch handlers that call the imperative helpers in charts.js.
// ============================================================================

import {
  AUTO_COLORS, COLORBLIND_COLORS, DATA_LOSS_THRESHOLD,
  loadSuiteData, getSuiteTests, getTestByName, getSuiteMeta,
  collectFilterCategories, filterComparison, initialFilterState, filterLabel,
  metricLabel, metricTitle, findAvailableMetrics, defaultMetric,
  hasBackpressure, anyComparisonBackpressure,
} from "./data.js";
import { formatMetricValue } from "./format.js";
import { envFingerprintLine, envDetailRows, comparisonEnvHeader } from "./env.js";
import {
  createBarChart, updateBarChartData, createLineChart, clearPatternCache,
  TIMESERIES_METRICS, SCALAR_ONLY_METRICS, tmTitle,
} from "./charts.js";
import { fetchHighlighted } from "./file_modal.js";

export function registerComponents(Alpine) {
  // ── Global palette store (colorblind toggle) ────────────────────────────
  // Held in a store so every section + the detail page share one flag and a
  // single localStorage-backed source of truth.
  Alpine.store("palette", {
    colorblind: localStorage.getItem("colorblindMode") === "true",
    colors() { return this.colorblind ? COLORBLIND_COLORS : AUTO_COLORS; },
    colorAt(i) { const c = this.colors(); return c[i % c.length]; },
    toggle() {
      this.colorblind = !this.colorblind;
      localStorage.setItem("colorblindMode", String(this.colorblind));
      // Stripe patterns are keyed by color; drop them so missing-data bars
      // repaint in the new palette.
      clearPatternCache();
    },
    get label() { return this.colorblind ? "Standard Colors" : "Colorblind Mode"; },
  });

  Alpine.data("comparisonSection", comparisonSection);
  Alpine.data("comparisonDetailPage", comparisonDetailPage);
  Alpine.data("fileModal", fileModal);
}

// ── Landing-page comparison section ─────────────────────────────────────────
// One per comparison. Owns a single bar chart (closure var `chart`).

function comparisonSection(comparison) {
  return {
    comparison,
    slug: comparison.slug,
    categories: {},
    filterState: {},
    metrics: [],
    selectedMetric: null,
    showBackpressure: false,

    init() {
      const suiteData = loadSuiteData();
      this.categories = collectFilterCategories(suiteData, this.comparison);
      this.filterState = initialFilterState(this.categories);
      const filtered = this.filtered();
      this.metrics = findAvailableMetrics(suiteData, filtered);
      this.selectedMetric = defaultMetric(this.comparison, this.metrics);

      // The Chart instance must stay outside Alpine's reactive proxy. We hold
      // it on a closure-scoped variable captured by the helper closures below,
      // not on a reactive property.
      let chart = null;
      const canvas = this.$refs.canvas;

      this.renderChart = () => {
        const fc = this.filtered();
        this.showBackpressure = anyComparisonBackpressure(suiteData, fc);
        if (chart) { chart.destroy(); chart = null; }
        if (canvas && fc.suites.length > 0 && this.selectedMetric) {
          chart = createBarChart(
            canvas, suiteData, fc, this.comparison.tests || [],
            this.selectedMetric, Alpine.store("palette").colors(),
          );
        }
      };

      this.renderChart();
      this.$watch("selectedMetric", () => this.renderChart());
      // filterState is mutated in place (checkbox arrays); watch deeply.
      this.$watch("filterState", () => this.refresh());
      // Repaint when the shared palette flips.
      this.$watch("$store.palette.colorblind", () => this.renderChart());
    },

    // Recompute available metrics for the current filter set, then redraw.
    refresh() {
      const suiteData = loadSuiteData();
      const fc = this.filtered();
      this.metrics = findAvailableMetrics(suiteData, fc);
      if (!this.metrics.includes(this.selectedMetric)) {
        this.selectedMetric = defaultMetric(this.comparison, this.metrics);
      }
      this.renderChart();
    },

    filtered() {
      return filterComparison(this.comparison, loadSuiteData(), this.filterState);
    },

    hasFilters() { return Object.keys(this.categories).length > 0; },
    filterGroups() {
      return Object.entries(this.categories).map(([cat, vals]) => ({ cat, label: filterLabel(cat), values: vals }));
    },
    resetFilters() { this.filterState = initialFilterState(this.categories); },

    metricOptions() {
      const suiteData = loadSuiteData();
      const fc = this.filtered();
      return this.metrics.map((n) => ({ value: n, label: metricTitle(n, suiteData, fc) }));
    },

    link() { return `${encodeURIComponent(this.slug)}/`; },
    titleText() { return this.comparison.name || this.slug; },
    descriptionText() { return this.comparison.description || ""; },
  };
}

// ── Comparison detail page ──────────────────────────────────────────────────
// Owns the overview bar chart + per-metric time-series mini charts.

function comparisonDetailPage(comparison, slug) {
  return {
    comparison,
    slug,
    categories: {},
    filterState: {},
    metrics: [],
    selectedMetric: null,
    showBackpressure: false,
    detailSuiteIdx: 0,
    detailTestName: "",
    envHeader: { kind: "unknown" },

    init() {
      const suiteData = loadSuiteData();
      this.categories = collectFilterCategories(suiteData, this.comparison);
      this.filterState = initialFilterState(this.categories);
      this.envHeader = comparisonEnvHeader(suiteData, this.comparison);
      const tests = this.comparison.tests || [];
      this.detailTestName = tests.length ? tests[0].name : "";

      const fc = this.filtered();
      this.metrics = findAvailableMetrics(suiteData, fc);
      this.selectedMetric = defaultMetric(this.comparison, this.metrics);

      // Bar chart instance: closure var, NOT reactive (see comparisonSection).
      let chart = null;
      const canvas = this.$refs.barCanvas;

      this.renderBarChart = () => {
        const f = this.filtered();
        this.showBackpressure = anyComparisonBackpressure(suiteData, f);
        if (chart) { chart.destroy(); chart = null; }
        if (!canvas || f.suites.length === 0 || !this.selectedMetric) return;
        const onClick = (event, elements) => {
          if (!elements.length) return;
          const { datasetIndex, index } = elements[0];
          const ref = (f.suites || [])[datasetIndex];
          const ct = (this.comparison.tests || [])[index];
          if (ref && ct) {
            // datasetIndex is into the FILTERED suite list; the pills + detail
            // also index the filtered list, so use it directly.
            this.detailSuiteIdx = datasetIndex;
            this.detailTestName = ct.name;
          }
        };
        chart = createBarChart(
          canvas, suiteData, f, this.comparison.tests || [],
          this.selectedMetric, Alpine.store("palette").colors(), onClick,
        );
      };

      // Time-series mini charts live in a closure array, NOT reactive state
      // (proxying a Chart breaks it). $nextTick lets the x-for canvases mount
      // before we draw.
      let miniCharts = [];
      this.renderMiniCharts = () => {
        this.$nextTick(() => {
          for (const c of miniCharts) c.destroy();
          miniCharts = [];
          const t = this.selectedTest();
          if (!t || !t.timeseries) return;
          const oi = this.origIndices();
          const ci = oi ? oi[this.detailSuiteIdx] : this.detailSuiteIdx;
          const color = Alpine.store("palette").colorAt(ci);
          const cards = this.$root.querySelectorAll(".metric-chart-card[data-ts-key]");
          for (const card of cards) {
            const series = t.timeseries[card.dataset.tsKey];
            if (!series || series.length < 2) continue;
            const cv = card.querySelector("canvas");
            if (cv) miniCharts.push(createLineChart(cv, series, color));
          }
        });
      };

      this.renderBarChart();
      this.renderMiniCharts();

      this.$watch("selectedMetric", () => this.renderBarChart());
      this.$watch("filterState", () => this.refresh());
      this.$watch("$store.palette.colorblind", () => { this.renderBarChart(); this.renderMiniCharts(); });
      this.$watch("detailSuiteIdx", () => this.renderMiniCharts());
      this.$watch("detailTestName", () => this.renderMiniCharts());
    },

    refresh() {
      const suiteData = loadSuiteData();
      const fc = this.filtered();
      this.metrics = findAvailableMetrics(suiteData, fc);
      if (!this.metrics.includes(this.selectedMetric)) {
        this.selectedMetric = defaultMetric(this.comparison, this.metrics);
      }
      // Clamp detail selection to the filtered suite list.
      if (this.detailSuiteIdx >= fc.suites.length) this.detailSuiteIdx = 0;
      const testNames = (this.comparison.tests || []).map((t) => t.name);
      if (!testNames.includes(this.detailTestName)) this.detailTestName = testNames[0] || "";
      this.renderBarChart();
      this.renderMiniCharts();
    },

    filtered() {
      return filterComparison(this.comparison, loadSuiteData(), this.filterState);
    },

    hasFilters() { return Object.keys(this.categories).length > 0; },
    filterGroups() {
      return Object.entries(this.categories).map(([cat, vals]) => ({ cat, label: filterLabel(cat), values: vals }));
    },
    resetFilters() { this.filterState = initialFilterState(this.categories); },

    metricOptions() {
      const suiteData = loadSuiteData();
      const fc = this.filtered();
      return this.metrics.map((n) => ({ value: n, label: metricTitle(n, suiteData, fc) }));
    },
    selectedMetricTitle() {
      return metricTitle(this.selectedMetric, loadSuiteData(), this.filtered());
    },

    titleText() { return this.comparison.name || this.slug; },
    descriptionText() { return this.comparison.description || ""; },

    // ── Detail panel view models ──────────────────────────────────────────
    refs() { return this.filtered().suites || []; },
    origIndices() { return this.filtered()._originalIndices || null; },
    noSuites() { return this.refs().length === 0; },

    pillColor(i) {
      const oi = this.origIndices();
      return Alpine.store("palette").colorAt(oi ? oi[i] : i);
    },
    pillLabel(ref) { return ref.short || ref.name; },
    selectSuite(i) { this.detailSuiteIdx = i; },

    testOptions() {
      return (this.comparison.tests || []).map((ct) => ({ value: ct.name, label: ct.label }));
    },

    selectedRef() { return this.refs()[this.detailSuiteIdx] || null; },
    selectedTest() {
      const ref = this.selectedRef();
      return ref ? getTestByName(loadSuiteData(), ref.slug, this.detailTestName) : null;
    },
    selectedMetricsArr() { const t = this.selectedTest(); return t ? (t.metrics || []) : []; },

    aggMetric(name) {
      const m = this.selectedMetricsArr().find((x) => x.name === name);
      return m && typeof m.value === "number" && Number.isFinite(m.value) ? m : null;
    },

    detailBackpressure() {
      const ct = (this.comparison.tests || []).find((x) => x.name === this.detailTestName);
      const lr = ct ? ct.loadgen_rate : null;
      return hasBackpressure(this.selectedMetricsArr(), lr);
    },

    files() {
      const t = this.selectedTest();
      if (!t) return [];
      return [...(t.configFiles || [])].sort();
    },

    envRows() {
      const ref = this.selectedRef();
      const suite = ref ? loadSuiteData()[ref.slug] : null;
      return envDetailRows(suite ? suite.env : null);
    },

    // Scalar metric cards (dropped %, duration).
    scalarCards() {
      if (!this.selectedTest() || !this.selectedMetricsArr().length) return [];
      const cards = [];
      for (const sm of SCALAR_ONLY_METRICS) {
        const m = this.aggMetric(sm.name);
        if (!m) continue;
        const bad = sm.name === "dropped_logs_percentage" && m.value > DATA_LOSS_THRESHOLD;
        cards.push({ name: metricLabel(sm.name), value: formatMetricValue(m.value, m.unit), bad });
      }
      return cards;
    },

    // Time-series cards. Each: { key, title, parts:[str], hasSeries }.
    timeseriesCards() {
      const t = this.selectedTest();
      if (!t) return [];
      const ts = t.timeseries || null;
      const cards = [];
      for (const tm of TIMESERIES_METRICS) {
        const parts = [];
        if (tm.avg) { const m = this.aggMetric(tm.avg); if (m) parts.push(`${tm.max ? "Avg: " : ""}${formatMetricValue(m.value, m.unit || tm.unit)}`); }
        if (tm.max) { const m = this.aggMetric(tm.max); if (m) parts.push(`Max: ${formatMetricValue(m.value, m.unit || tm.unit)}`); }
        if (!parts.length) continue;
        const hasSeries = !!(ts && ts[tm.key] && ts[tm.key].length > 1);
        cards.push({ key: tm.key, title: tmTitle(tm), parts, hasSeries });
      }
      return cards;
    },

    // renderMiniCharts is assigned in init() so its Chart array stays in a
    // closure variable, never on the reactive `this`.

    // Open the file viewer for a config file in the selected suite/test.
    openFile(fileName) {
      const ref = this.selectedRef();
      if (!ref) return;
      this.$dispatch("open-file", { slug: ref.slug, test: this.detailTestName, file: fileName });
    },
  };
}

// ── File viewer modal ───────────────────────────────────────────────────────
// Listens for an `open-file` window event (dispatched by detail-panel file
// items). Fetch + highlight reuse the shared helpers.

function fileModal() {
  return {
    open: false,
    title: "",
    bodyHtml: "Loading...",

    init() {
      window.addEventListener("open-file", (e) => {
        const { slug, test, file } = e.detail || {};
        this.show(slug, test, file);
      });
    },

    async show(slug, test, file) {
      this.title = file;
      this.bodyHtml = "Loading...";
      this.open = true;
      const res = await fetchHighlighted(slug, test, file);
      this.bodyHtml = res.error ? escapeText(res.error) : res.html;
    },

    close() { this.open = false; },
  };
}

function escapeText(s) {
  const div = document.createElement("div");
  div.textContent = String(s ?? "");
  return div.innerHTML;
}
