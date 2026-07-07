const MAX_CITIES = 5;
const COLORS = ["#1d1d1f", "#424245", "#6e6e73", "#86868b", "#2c2c2e", "#515154", "#98989d"];
const CHART_TEXT = "#1d1d1f";
const CHART_MUTED = "#6e6e73";
const CHART_GRID = "#e8e8ed";
const TEMP_COLD = "#5b9bd5";
const TEMP_HOT = "#e05d5d";
const CHART_VIEWS = new Set(["timeline", "yoy-month", "yoy-pct"]);
const DISPLAY_MODES = new Set(["charts", "knowledge-graph"]);

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const state = {
  graph: null,
  citiesConfig: null,
  selected: new Set(),
  metric: "uv",
  tempUnit: "F",
  displayMode: "charts",
  chartView: "timeline",
  calendarMonth: 7,
  periodStart: "1993-11",
  periodEnd: "2025-12",
  periodMax: "2025-12",
  sortKey: "name",
  sortAsc: true,
  attestationUrl: null,
  kgFocus: null,
};

let mainChart = null;
let yoyChart = null;
let kgModel = null;

async function loadData() {
  const [graphRes, citiesRes, attestRes] = await Promise.all([
    fetch("data/knowledge_graph.json"),
    fetch("data/cities.json"),
    fetch("data/attestation.json").catch(() => null),
  ]);

  state.graph = await graphRes.json();
  state.citiesConfig = await citiesRes.json();

  if (attestRes?.ok) {
    const attest = await attestRes.json();
    state.attestationUrl = attest?.verify_url;
  }

  const defaultId = state.graph.metadata.default_city;
  state.selected.add(defaultId);

  const period = state.graph.metadata.period || {};
  state.periodStart = period.start || "1993-11";
  state.periodEnd = period.end || "2025-12";
  state.periodMax = period.latest_nasa || period.end || "2025-12";

  applyUrlParams();
  initUI();
  renderAll();
}

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const cities = params.get("cities");
  const metric = params.get("metric");
  const view = params.get("view");
  const display = params.get("display");
  const month = params.get("month");
  const start = params.get("start");
  const end = params.get("end");

  if (cities) {
    state.selected.clear();
    const validIds = new Set(state.citiesConfig.cities.map((c) => c.id));
    cities.split(",").slice(0, MAX_CITIES).forEach((id) => {
      const trimmed = id.trim();
      if (validIds.has(trimmed)) state.selected.add(trimmed);
    });
    if (state.selected.size === 0) state.selected.add(state.graph.metadata.default_city);
  }
  if (metric && (metric === "uv" || metric === "temperature")) state.metric = metric;
  if (view === "knowledge-graph") {
    state.displayMode = "knowledge-graph";
  } else if (view && CHART_VIEWS.has(view)) {
    state.chartView = view;
  }
  if (display === "kg" || display === "knowledge-graph") state.displayMode = "knowledge-graph";
  if (display === "charts") state.displayMode = "charts";
  const unit = params.get("unit");
  if (unit === "F" || unit === "C") state.tempUnit = unit;
  if (month) state.calendarMonth = parseInt(month, 10);
  if (start && /^\d{4}-\d{2}$/.test(start)) state.periodStart = start;
  if (end && /^\d{4}-\d{2}$/.test(end)) state.periodEnd = end;
}

function updateUrl() {
  const params = new URLSearchParams();
  params.set("cities", [...state.selected].join(","));
  params.set("metric", state.metric);
  params.set("display", state.displayMode === "knowledge-graph" ? "kg" : "charts");
  params.set("view", state.chartView);
  if (state.metric === "temperature") params.set("unit", state.tempUnit);
  params.set("start", state.periodStart);
  params.set("end", state.periodEnd);
  if (state.chartView === "yoy-month") params.set("month", state.calendarMonth);
  history.replaceState(null, "", `?${params}`);
}

function initUI() {
  renderCityList();
  initMonthSelect();
  bindControls();
  renderAttestation();
}

function renderCityList() {
  const container = document.getElementById("city-list");
  container.innerHTML = "";

  for (const city of state.citiesConfig.cities) {
    container.appendChild(createCityCheckbox(city.id, `${city.name}, ${city.region}`));
  }
}

function createCityCheckbox(id, label) {
  const div = document.createElement("div");
  div.className = "city-item";
  const checked = state.selected.has(id) ? "checked" : "";
  const disabled = !state.selected.has(id) && state.selected.size >= MAX_CITIES ? "disabled" : "";
  div.innerHTML = `
    <input type="checkbox" id="city-${id}" value="${id}" ${checked} ${disabled}>
    <label for="city-${id}">${label}</label>
  `;
  div.querySelector("input").addEventListener("change", onCityToggle);
  return div;
}

function initMonthSelect() {
  const select = document.getElementById("calendar-month");
  select.innerHTML = MONTHS.map((m, i) =>
    `<option value="${i + 1}" ${i + 1 === state.calendarMonth ? "selected" : ""}>${m}</option>`
  ).join("");
}

function metricLabel(metric = state.metric) {
  if (metric === "uv") return "UV Index (all-sky)";
  return state.tempUnit === "F" ? "Temperature (°F)" : "Temperature (°C)";
}

function convertTempValue(celsius) {
  if (celsius == null || Number.isNaN(celsius)) return null;
  return state.tempUnit === "F" ? celsius * 9 / 5 + 32 : celsius;
}

function formatMetricValue(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const v = state.metric === "temperature" ? convertTempValue(value) : value;
  return Number(v).toFixed(2);
}

function updateTempUnitVisibility() {
  document.getElementById("temp-unit-toggle").classList.toggle(
    "hidden",
    state.metric !== "temperature"
  );
}

function updateViewVisibility() {
  const isKg = state.displayMode === "knowledge-graph";
  document.getElementById("charts-view").classList.toggle("hidden", isKg);
  document.getElementById("kg-panel").classList.toggle("hidden", !isKg);
  document.getElementById("month-filter").classList.toggle("hidden", state.chartView !== "yoy-month");
  document.getElementById("yoy-panel").classList.toggle("hidden", isKg || state.chartView === "yoy-pct");
}

function bindControls() {
  document.querySelectorAll('input[name="metric"]').forEach((el) => {
    el.checked = el.value === state.metric;
    el.addEventListener("change", () => {
      if (el.checked) {
        state.metric = el.value;
        updateTempUnitVisibility();
        renderAll();
      }
    });
  });

  document.querySelectorAll('input[name="temp-unit"]').forEach((el) => {
    el.checked = el.value === state.tempUnit;
    el.addEventListener("change", () => {
      if (el.checked) {
        state.tempUnit = el.value;
        renderAll();
      }
    });
  });
  updateTempUnitVisibility();

  document.querySelectorAll('input[name="display-mode"]').forEach((el) => {
    el.checked = el.value === state.displayMode;
    el.addEventListener("change", () => {
      if (el.checked) {
        state.displayMode = el.value;
        updateViewVisibility();
        renderAll();
      }
    });
  });

  document.querySelectorAll('input[name="chart-view"]').forEach((el) => {
    el.checked = el.value === state.chartView;
    el.addEventListener("change", () => {
      if (el.checked) {
        state.chartView = el.value;
        updateViewVisibility();
        renderAll();
      }
    });
  });
  updateViewVisibility();

  document.getElementById("calendar-month").addEventListener("change", (e) => {
    state.calendarMonth = parseInt(e.target.value, 10);
    renderAll();
  });

  const periodStart = document.getElementById("period-start");
  const periodEnd = document.getElementById("period-end");
  periodStart.value = state.periodStart;
  periodEnd.value = state.periodEnd;
  periodStart.min = "1993-11";
  periodStart.max = state.periodMax;
  periodEnd.min = "1993-11";
  periodEnd.max = state.periodMax;

  document.getElementById("date-range-hint").textContent =
    `Available: Nov 1993 – ${state.periodMax} (NASA POWER latest)`;

  periodStart.addEventListener("change", () => {
    state.periodStart = periodStart.value;
    if (state.periodStart > state.periodEnd) {
      state.periodEnd = state.periodStart;
      periodEnd.value = state.periodEnd;
    }
    renderAll();
  });
  periodEnd.addEventListener("change", () => {
    state.periodEnd = periodEnd.value;
    if (state.periodEnd < state.periodStart) {
      state.periodStart = state.periodEnd;
      periodStart.value = state.periodStart;
    }
    renderAll();
  });
}

function onCityToggle(e) {
  const id = e.target.value;
  if (e.target.checked) {
    if (state.selected.size >= MAX_CITIES) {
      e.target.checked = false;
      return;
    }
    state.selected.add(id);
  } else {
    state.selected.delete(id);
  }
  renderCityList();
  renderAll();
}

function getCityData(cityId) {
  return state.graph.cities[cityId];
}

function getCityLabel(cityId) {
  const data = getCityData(cityId);
  return data?.name || cityId;
}

function getSeries(cityId, metric) {
  const data = getCityData(cityId);
  if (!data?.series?.[metric]) return [];
  return data.series[metric].filter((p) =>
    p.date >= state.periodStart && p.date <= state.periodEnd
  );
}

function renderAll() {
  updateUrl();
  updateViewVisibility();
  renderInsights();
  if (state.displayMode === "knowledge-graph") {
    renderKnowledgeGraph();
    return;
  }
  renderMainChart();
  renderYoyChart();
  renderComparisonTable();
}

function metricValue(value) {
  return state.metric === "temperature" ? convertTempValue(value) : value;
}

function tempGradientColor(value, min, max, alpha = 0.92) {
  const t = max === min ? 0.5 : (value - min) / (max - min);
  const r = Math.round(91 + t * (224 - 91));
  const g = Math.round(187 + t * (93 - 187));
  const b = Math.round(213 + t * (93 - 213));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getGlobalValueRange() {
  let min = Infinity;
  let max = -Infinity;
  for (const cityId of state.selected) {
    const series = getViewSeries(cityId);
    for (const point of series) {
      const value = state.chartView === "yoy-pct" ? point.yoy_pct : metricValue(point.value);
      if (value == null || Number.isNaN(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  if (min === Infinity) return { min: 0, max: 1 };
  return { min, max };
}

function buildTempPointStyles(values, globalMin, globalMax) {
  return values.map((value) => {
    const isMin = value === globalMin;
    const isMax = value === globalMax;
    return {
      backgroundColor: isMin ? TEMP_COLD : isMax ? TEMP_HOT : tempGradientColor(value, globalMin, globalMax),
      borderColor: isMin ? TEMP_COLD : isMax ? TEMP_HOT : tempGradientColor(value, globalMin, globalMax, 1),
      radius: isMin || isMax ? 6 : 3,
      borderWidth: isMin || isMax ? 2 : 1,
    };
  });
}

function showTempLegend(show) {
  document.getElementById("temp-legend").classList.toggle("hidden", !show);
}

function renderMainChart() {
  const ctx = document.getElementById("main-chart");
  const datasets = [];
  let colorIdx = 0;
  const useTempGradient = state.metric === "temperature" && state.chartView !== "yoy-pct";
  const globalRange = useTempGradient ? getGlobalValueRange() : null;

  showTempLegend(useTempGradient);

  for (const cityId of state.selected) {
    const series = getSeries(cityId, state.metric);
    if (!series.length) continue;

    if (state.chartView === "yoy-month") {
      const monthStr = state.calendarMonth.toString().padStart(2, "0");
      const filtered = series.filter((p) => p.date.endsWith(`-${monthStr}`));
      const values = filtered.map((p) => metricValue(p.value));
      const styles = useTempGradient
        ? buildTempPointStyles(values, globalRange.min, globalRange.max)
        : null;
      datasets.push({
        label: getCityLabel(cityId),
        data: filtered.map((p) => ({ x: p.date.slice(0, 4), y: metricValue(p.value) })),
        borderColor: useTempGradient ? "transparent" : COLORS[colorIdx % COLORS.length],
        backgroundColor: useTempGradient
          ? styles.map((s) => s.backgroundColor)
          : COLORS[colorIdx % COLORS.length] + "88",
        borderWidth: useTempGradient ? 0 : 1,
        tension: 0.2,
      });
    } else if (state.chartView === "yoy-pct") {
      datasets.push({
        label: getCityLabel(cityId),
        data: series.filter((p) => p.yoy_pct != null).map((p) => ({ x: p.date, y: p.yoy_pct })),
        borderColor: COLORS[colorIdx % COLORS.length],
        tension: 0.2,
      });
    } else {
      const values = series.map((p) => metricValue(p.value));
      const styles = useTempGradient
        ? buildTempPointStyles(values, globalRange.min, globalRange.max)
        : null;
      datasets.push({
        label: getCityLabel(cityId),
        data: series.map((p) => ({ x: p.date, y: metricValue(p.value) })),
        borderColor: useTempGradient ? "rgba(29,29,31,0.25)" : COLORS[colorIdx % COLORS.length],
        backgroundColor: useTempGradient ? "transparent" : COLORS[colorIdx % COLORS.length] + "22",
        pointBackgroundColor: useTempGradient ? styles.map((s) => s.backgroundColor) : COLORS[colorIdx % COLORS.length],
        pointBorderColor: useTempGradient ? styles.map((s) => s.borderColor) : COLORS[colorIdx % COLORS.length],
        pointRadius: useTempGradient ? styles.map((s) => s.radius) : 2,
        pointBorderWidth: useTempGradient ? styles.map((s) => s.borderWidth) : 1,
        pointHoverRadius: useTempGradient ? styles.map((s) => s.radius + 2) : 4,
        fill: false,
        tension: 0.2,
      });
    }
    colorIdx++;
  }

  if (mainChart) mainChart.destroy();
  mainChart = new Chart(ctx, {
    type: state.chartView === "yoy-month" ? "bar" : "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: chartTitle(), color: CHART_TEXT },
        legend: { labels: { color: CHART_TEXT } },
      },
      scales: {
        x: { ticks: { color: CHART_MUTED, maxTicksLimit: 24 }, grid: { color: CHART_GRID } },
        y: {
          title: { display: true, text: yAxisLabel(), color: CHART_MUTED },
          ticks: { color: CHART_MUTED },
          grid: { color: CHART_GRID },
        },
      },
    },
  });
}

function renderYoyChart() {
  const panel = document.getElementById("yoy-panel");
  if (state.chartView === "yoy-pct") {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const ctx = document.getElementById("yoy-chart");
  const datasets = [];
  let colorIdx = 0;

  for (const cityId of state.selected) {
    const series = getSeries(cityId, state.metric).filter((p) => p.yoy_pct != null);
    if (!series.length) continue;
    datasets.push({
      label: getCityLabel(cityId),
      data: series.map((p) => ({ x: p.date, y: p.yoy_pct })),
      borderColor: COLORS[colorIdx % COLORS.length],
      borderDash: [4, 2],
      tension: 0.2,
    });
    colorIdx++;
  }

  if (yoyChart) yoyChart.destroy();
  yoyChart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: "Year-over-year % change", color: CHART_TEXT },
        legend: { labels: { color: CHART_TEXT } },
      },
      scales: {
        x: { ticks: { color: CHART_MUTED, maxTicksLimit: 24 }, grid: { color: CHART_GRID } },
        y: {
          title: { display: true, text: "YoY %", color: CHART_MUTED },
          ticks: { color: CHART_MUTED },
          grid: { color: CHART_GRID },
        },
      },
    },
  });
}

function chartTitle() {
  if (state.chartView === "yoy-month") return `${metricLabel()} — ${MONTHS[state.calendarMonth - 1]} by year`;
  if (state.chartView === "yoy-pct") return `YoY % change — ${metricLabel()}`;
  return metricLabel();
}

function yAxisLabel() {
  if (state.chartView === "yoy-pct") return "YoY %";
  if (state.metric === "temperature") return state.tempUnit === "F" ? "°F" : "°C";
  return "UV Index";
}

function getViewSeries(cityId, metric = state.metric) {
  let series = getSeries(cityId, metric);
  if (state.chartView === "yoy-month") {
    const monthStr = state.calendarMonth.toString().padStart(2, "0");
    series = series.filter((p) => p.date.endsWith(`-${monthStr}`));
  }
  return series;
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function pctChange(start, end) {
  if (start == null || end == null || start === 0) return null;
  return ((end - start) / start) * 100;
}

function summaryContextLabel() {
  const range = `${state.periodStart} – ${state.periodEnd}`;
  if (state.chartView === "yoy-month") {
    return `${MONTHS[state.calendarMonth - 1]} across years · ${range}`;
  }
  if (state.chartView === "yoy-pct") {
    return `Year-over-year % change · ${range}`;
  }
  return `Month-by-month · ${range}`;
}

function computeViewSummary(cityId) {
  const series = getViewSeries(cityId);
  if (!series.length) return { empty: true };

  if (state.chartView === "yoy-pct") {
    const yoyPoints = series.filter((p) => p.yoy_pct != null);
    const yoyValues = yoyPoints.map((p) => p.yoy_pct);
    if (!yoyValues.length) return { empty: true };
    const first = yoyValues[0];
    const last = yoyValues[yoyValues.length - 1];
    return {
      empty: false,
      avg_yoy_pct: avg(yoyValues),
      latest_yoy_pct: last,
      min: Math.min(...yoyValues),
      max: Math.max(...yoyValues),
      change_pct: pctChange(first, last),
      latest_date: yoyPoints[yoyPoints.length - 1]?.date,
      count: yoyValues.length,
    };
  }

  const withMom = series.map((point, i) => {
    let mom_pct = null;
    if (state.chartView === "timeline" && i > 0) {
      const prev = series[i - 1].value;
      if (prev != null && prev !== 0) {
        mom_pct = ((point.value - prev) / prev) * 100;
      }
    }
    return { ...point, mom_pct };
  });

  const yoyValues = series.map((p) => p.yoy_pct).filter((v) => v != null);
  const momValues = withMom.map((p) => p.mom_pct).filter((v) => v != null);
  const values = series.map((p) => p.value);
  const first = values[0];
  const last = values[values.length - 1];

  const summary = {
    empty: false,
    avg_yoy_pct: avg(yoyValues),
    latest_yoy_pct: series[series.length - 1]?.yoy_pct ?? null,
    change_pct: pctChange(first, last),
    min: Math.min(...values),
    max: Math.max(...values),
    latest_value: last,
    latest_date: series[series.length - 1]?.date,
    min_date: series[values.indexOf(Math.min(...values))]?.date,
    max_date: series[values.indexOf(Math.max(...values))]?.date,
    count: series.length,
  };

  if (state.chartView === "timeline") {
    summary.avg_mom_pct = avg(momValues);
    summary.latest_mom_pct = withMom[withMom.length - 1]?.mom_pct ?? null;
  }

  return summary;
}

function comparisonColumns() {
  const unitSuffix = state.metric === "temperature" ? ` (${state.tempUnit})` : "";
  if (state.chartView === "yoy-pct") {
    return [
      { key: "name", label: "City", sortable: true },
      { key: "avg_yoy_pct", label: "Avg YoY %", sortable: true },
      { key: "latest_yoy_pct", label: "Latest YoY %", sortable: true },
      { key: "min", label: "Min YoY %", sortable: true },
      { key: "max", label: "Max YoY %", sortable: true },
    ];
  }
  if (state.chartView === "yoy-month") {
    return [
      { key: "name", label: "City", sortable: true },
      { key: "avg_yoy_pct", label: "Avg YoY %", sortable: true },
      { key: "latest_yoy_pct", label: "Latest YoY %", sortable: true },
      { key: "change_pct", label: "Change %", sortable: true },
      { key: "min", label: `Min${unitSuffix}`, sortable: true },
      { key: "max", label: `Max${unitSuffix}`, sortable: true },
    ];
  }
  return [
    { key: "name", label: "City", sortable: true },
    { key: "avg_yoy_pct", label: "Avg YoY %", sortable: true },
    { key: "avg_mom_pct", label: "Avg MoM %", sortable: true },
    { key: "change_pct", label: "Change %", sortable: true },
    { key: "min", label: `Min${unitSuffix}`, sortable: true },
    { key: "max", label: `Max${unitSuffix}`, sortable: true },
  ];
}

function formatComparisonValue(key, value) {
  if (key === "name") return value;
  if (value == null || Number.isNaN(value)) return "—";
  if (key === "min" || key === "max") {
    return state.chartView === "yoy-pct" ? fmt(value) : formatMetricValue(value);
  }
  return `${fmt(value)}%`;
}

function renderSummary() {
  document.getElementById("summary-context").textContent = summaryContextLabel();
  const el = document.getElementById("summary-table");
  const unit = state.metric === "temperature" ? ` ${state.tempUnit}` : "";

  const rows = [...state.selected].map((cityId) => {
    const s = computeViewSummary(cityId);
    if (s.empty) {
      return `
        <div class="summary-row">
          <strong>${getCityLabel(cityId)}</strong>
          <p class="hint">No data for the current view and date range.</p>
        </div>
      `;
    }

    if (state.chartView === "yoy-pct") {
      return `
        <div class="summary-row">
          <strong>${getCityLabel(cityId)}</strong>
          <p>Avg YoY: ${fmt(s.avg_yoy_pct)}% · Latest YoY: ${fmt(s.latest_yoy_pct)}% (${s.latest_date || "—"})</p>
          <p>Change in YoY rate: ${fmt(s.change_pct)}% · Range: ${fmt(s.min)}% – ${fmt(s.max)}%</p>
        </div>
      `;
    }

    if (state.chartView === "yoy-month") {
      const month = MONTHS[state.calendarMonth - 1];
      return `
        <div class="summary-row">
          <strong>${getCityLabel(cityId)}</strong>
          <p>Avg YoY (${month}): ${fmt(s.avg_yoy_pct)}% · Latest YoY: ${fmt(s.latest_yoy_pct)}% (${s.latest_date || "—"})</p>
          <p>Change (${month}): ${fmt(s.change_pct)}% · Range: ${formatMetricValue(s.min)} – ${formatMetricValue(s.max)}${unit}</p>
        </div>
      `;
    }

    return `
      <div class="summary-row">
        <strong>${getCityLabel(cityId)}</strong>
        <p>Avg YoY: ${fmt(s.avg_yoy_pct)}% · Avg MoM: ${fmt(s.avg_mom_pct)}%</p>
        <p>Latest YoY: ${fmt(s.latest_yoy_pct)}% · Latest MoM: ${fmt(s.latest_mom_pct)}% (${s.latest_date || "—"})</p>
        <p>Change: ${fmt(s.change_pct)}% · Range: ${formatMetricValue(s.min)} – ${formatMetricValue(s.max)}${unit}</p>
      </div>
    `;
  });

  el.innerHTML = rows.join("") || "<p class='hint'>Select a city to see summary.</p>";
}

function renderComparisonTable() {
  const table = document.getElementById("comparison-table");
  const columns = comparisonColumns();
  const colKeys = new Set(columns.map((col) => col.key));
  if (!colKeys.has(state.sortKey)) {
    state.sortKey = "name";
    state.sortAsc = true;
  }

  const thead = table.querySelector("thead tr");
  thead.innerHTML = columns.map((col) =>
    `<th data-sort="${col.key}"${col.sortable ? "" : ""}>${col.label}</th>`
  ).join("");

  thead.querySelectorAll("th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = true; }
      renderComparisonTable();
    });
  });

  const tbody = table.querySelector("tbody");
  const rows = [...state.selected].map((cityId) => {
    const s = computeViewSummary(cityId);
    return {
      name: getCityLabel(cityId),
      avg_yoy_pct: s.empty ? null : s.avg_yoy_pct,
      avg_mom_pct: s.empty ? null : s.avg_mom_pct,
      latest_yoy_pct: s.empty ? null : s.latest_yoy_pct,
      change_pct: s.empty ? null : s.change_pct,
      min: s.empty ? null : s.min,
      max: s.empty ? null : s.max,
    };
  });

  rows.sort((a, b) => {
    const av = a[state.sortKey] ?? a.name;
    const bv = b[state.sortKey] ?? b.name;
    if (av < bv) return state.sortAsc ? -1 : 1;
    if (av > bv) return state.sortAsc ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = rows.map((row) => `
    <tr>
      ${columns.map((col) => `<td>${formatComparisonValue(col.key, row[col.key])}</td>`).join("")}
    </tr>
  `).join("");
}

function nodeLabel(nodeId) {
  if (nodeId === "view:context") return chartViewLabel();
  const node = state.graph.nodes?.find((n) => n.id === nodeId);
  if (node?.label) return node.label;
  if (nodeId.startsWith("metric:")) return metricLabel(nodeId.replace("metric:", ""));
  if (nodeId === "source:nasa_power") return "NASA POWER";
  return nodeId.replace(/^(loc|metric|period|source):/, "");
}

function chartViewLabel() {
  if (state.chartView === "yoy-month") return `${MONTHS[state.calendarMonth - 1]} across years`;
  if (state.chartView === "yoy-pct") return "Year-over-year % change";
  return "Month-by-month timeline";
}

function buildKnowledgeGraphModel() {
  const selected = [...state.selected];
  const metric = state.metric;
  const metricId = `metric:${metric}`;
  const source = state.graph.metadata.sources?.[0];
  const sourceId = source ? `source:${source.id}` : "source:nasa_power";
  const viewId = "view:context";
  const viewLabel = `${chartViewLabel()}\n${summaryContextLabel()}`;

  const nodes = [
    { id: sourceId, label: source?.name || "NASA POWER", type: "Source" },
    { id: viewId, label: viewLabel, type: "View" },
    { id: metricId, label: metricLabel(), type: "Metric" },
  ];

  for (const cityId of selected) {
    const place = state.graph.nodes?.find((n) => n.id === `loc:${cityId}`);
    nodes.push({
      id: `loc:${cityId}`,
      label: place?.label || getCityLabel(cityId),
      type: "Place",
    });
  }

  const edges = [
    { from: sourceId, to: metricId, type: "provides", detail: source?.role || "uv_and_temperature" },
    { from: viewId, to: metricId, type: "scopes", detail: chartViewLabel() },
    { from: sourceId, to: viewId, type: "filteredBy", detail: `${state.periodStart} – ${state.periodEnd}` },
  ];

  const summaries = new Map();
  for (const cityId of selected) {
    const summary = computeViewSummary(cityId);
    summaries.set(cityId, summary);
    if (summary.empty) continue;

    const unit = state.metric === "temperature" ? ` ${state.tempUnit}` : "";
    let valueDetail = `latest ${formatMetricValue(summary.latest_value)}${unit} (${summary.latest_date || "—"})`;
    if (state.chartView === "yoy-pct") {
      valueDetail = `latest YoY ${fmt(summary.latest_yoy_pct)}% (${summary.latest_date || "—"})`;
    }

    edges.push({
      from: `loc:${cityId}`,
      to: viewId,
      type: "analyzedIn",
      detail: chartViewLabel(),
    });
    edges.push({
      from: `loc:${cityId}`,
      to: metricId,
      type: "hasValue",
      detail: valueDetail,
    });

    if (summary.latest_yoy_pct != null) {
      edges.push({
        from: `loc:${cityId}`,
        to: metricId,
        type: "yoyChange",
        detail: `YoY ${fmt(summary.latest_yoy_pct)}%`,
        dashed: true,
      });
    }

    if (state.chartView === "timeline" && summary.latest_mom_pct != null) {
      edges.push({
        from: `loc:${cityId}`,
        to: metricId,
        type: "momChange",
        detail: `MoM ${fmt(summary.latest_mom_pct)}%`,
        dashed: true,
      });
    }
  }

  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const a = summaries.get(selected[i]);
      const b = summaries.get(selected[j]);
      if (!a || !b || a.empty || b.empty) continue;

      let delta = null;
      if (state.chartView === "yoy-pct") {
        if (a.avg_yoy_pct != null && b.avg_yoy_pct != null) delta = a.avg_yoy_pct - b.avg_yoy_pct;
      } else if (a.change_pct != null && b.change_pct != null) {
        delta = a.change_pct - b.change_pct;
      }

      if (delta != null) {
        edges.push({
          from: `loc:${selected[i]}`,
          to: `loc:${selected[j]}`,
          type: "comparedWith",
          detail: `Δ ${state.chartView === "yoy-pct" ? "avg YoY" : "change"}: ${fmt(delta)}%`,
          dashed: true,
        });
      }
    }
  }

  return { nodes, edges };
}

function layoutKnowledgeGraph(nodes, width) {
  const height = 480;
  const positions = new Map();
  const source = nodes.find((n) => n.type === "Source");
  const view = nodes.find((n) => n.type === "View");
  const metric = nodes.find((n) => n.type === "Metric");
  const places = nodes.filter((n) => n.type === "Place");

  if (source) positions.set(source.id, { x: width / 2, y: 48 });
  if (view) positions.set(view.id, { x: width / 2, y: 132 });
  if (metric) positions.set(metric.id, { x: width / 2, y: 228 });

  const placeY = 380;
  const placeSpacing = Math.min(180, (width - 120) / Math.max(places.length, 1));
  const placeStart = width / 2 - ((places.length - 1) * placeSpacing) / 2;
  places.forEach((node, i) => {
    positions.set(node.id, { x: placeStart + i * placeSpacing, y: placeY });
  });

  return { positions, width, height };
}

function measureNode(label) {
  const lines = label.split("\n");
  const longest = Math.max(...lines.map((line) => line.length));
  return { width: Math.max(96, longest * 7 + 24), height: 20 + lines.length * 16 };
}

function renderKnowledgeGraph() {
  const container = document.getElementById("kg-graph");
  const tbody = document.querySelector("#kg-table tbody");
  const { nodes, edges } = buildKnowledgeGraphModel();
  const width = Math.max(640, container.clientWidth || 900);
  const { positions, height } = layoutKnowledgeGraph(nodes, width);

  const nodeSizes = new Map();
  for (const node of nodes) {
    nodeSizes.set(node.id, measureNode(node.label));
  }

  const edgePaths = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return "";
    const fromSize = nodeSizes.get(edge.from);
    const toSize = nodeSizes.get(edge.to);
    let x1 = from.x;
    let y1 = from.y;
    let x2 = to.x;
    let y2 = to.y;

    if (Math.abs(from.y - to.y) < 8) {
      x1 = from.x + (from.x < to.x ? fromSize.width / 2 : -fromSize.width / 2);
      x2 = to.x + (from.x < to.x ? -toSize.width / 2 : toSize.width / 2);
      y1 = y2 = from.y;
    } else {
      y1 = from.y + fromSize.height / 2;
      y2 = to.y - toSize.height / 2;
    }

    const cls = edge.dashed ? "kg-edge dashed" : "kg-edge";
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const label = edge.type;
    return `
      <line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
      <text class="kg-edge-label" x="${midX}" y="${midY - 4}" text-anchor="middle">${label}</text>
    `;
  }).join("");

  const nodeMarkup = nodes.map((node) => {
    const pos = positions.get(node.id);
    const size = nodeSizes.get(node.id);
    const x = pos.x - size.width / 2;
    const y = pos.y - size.height / 2;
    const lines = node.label.split("\n");
    const textY = pos.y - ((lines.length - 1) * 8);
    const active = node.type === "Metric" ? " active" : "";
    const tspans = lines.map((line, i) =>
      `<tspan x="${pos.x}" dy="${i === 0 ? 0 : 16}">${line}</tspan>`
    ).join("");
    return `
      <g class="kg-node${active}">
        <rect x="${x}" y="${y}" width="${size.width}" height="${size.height}" />
        <text x="${pos.x}" y="${textY}" text-anchor="middle" dominant-baseline="middle">${tspans}</text>
      </g>
    `;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Knowledge graph">
      ${edgePaths}
      ${nodeMarkup}
    </svg>
  `;

  document.getElementById("kg-hint").textContent =
    `${metricLabel()} knowledge graph · ${chartViewLabel()} · ${state.periodStart} – ${state.periodEnd}`;

  tbody.innerHTML = edges.map((edge) => `
    <tr>
      <td>${nodeLabel(edge.from)}</td>
      <td>${edge.type}</td>
      <td>${nodeLabel(edge.to)}</td>
      <td>${edge.detail || "—"}</td>
    </tr>
  `).join("");
}

function renderKgSummary() {
  document.getElementById("kg-summary-context").textContent = summaryContextLabel();
  const el = document.getElementById("kg-summary-table");
  const unit = state.metric === "temperature" ? ` ${state.tempUnit}` : "";

  const rows = [...state.selected].map((cityId) => {
    const s = computeViewSummary(cityId);
    if (s.empty) {
      return `
        <div class="summary-row">
          <strong>${getCityLabel(cityId)}</strong>
          <p class="hint">No data for the current view and date range.</p>
        </div>
      `;
    }

    if (state.chartView === "yoy-pct") {
      return `
        <div class="summary-row">
          <strong>${getCityLabel(cityId)}</strong>
          <p>Avg YoY: ${fmt(s.avg_yoy_pct)}% · Latest YoY: ${fmt(s.latest_yoy_pct)}% (${s.latest_date || "—"})</p>
          <p>Change in YoY rate: ${fmt(s.change_pct)}% · Range: ${fmt(s.min)}% – ${fmt(s.max)}%</p>
        </div>
      `;
    }

    if (state.chartView === "yoy-month") {
      const month = MONTHS[state.calendarMonth - 1];
      return `
        <div class="summary-row">
          <strong>${getCityLabel(cityId)}</strong>
          <p>Avg YoY (${month}): ${fmt(s.avg_yoy_pct)}% · Latest YoY: ${fmt(s.latest_yoy_pct)}% (${s.latest_date || "—"})</p>
          <p>Change (${month}): ${fmt(s.change_pct)}% · Range: ${formatMetricValue(s.min)} – ${formatMetricValue(s.max)}${unit}</p>
        </div>
      `;
    }

    return `
      <div class="summary-row">
        <strong>${getCityLabel(cityId)}</strong>
        <p>Avg YoY: ${fmt(s.avg_yoy_pct)}% · Avg MoM: ${fmt(s.avg_mom_pct)}%</p>
        <p>Latest YoY: ${fmt(s.latest_yoy_pct)}% · Latest MoM: ${fmt(s.latest_mom_pct)}% (${s.latest_date || "—"})</p>
        <p>Change: ${fmt(s.change_pct)}% · Range: ${formatMetricValue(s.min)} – ${formatMetricValue(s.max)}${unit}</p>
      </div>
    `;
  });

  el.innerHTML = rows.join("") || "<p class='hint'>Select a city to see summary.</p>";
}

function renderAttestation() {
  const el = document.getElementById("attestation-line");
  if (state.attestationUrl) {
    el.innerHTML = `Attestation: <a href="${state.attestationUrl}" target="_blank" rel="noopener">Verify data provenance (Cursor + Auto)</a>`;
  }
}

function fmt(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(2);
}

loadData().catch((err) => {
  document.body.innerHTML = `<p style="padding:2rem;color:#000000">Failed to load data: ${err.message}. Run build_data.py first.</p>`;
});
