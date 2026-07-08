import { generateSummary, buildInstantSummary } from "./summary.js";
import {
  initCityAdd,
  mergeCustomCities,
  removeCity,
  getVisibleCities,
  ensureCityDataLoaded,
  setBuiltInCityIds,
} from "./cityAdd.js";

const MAX_CITIES = 5;
const CITY_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];
const COLORS = CITY_COLORS;
const CHART_TEXT = "#1d1d1f";
const CHART_MUTED = "#6e6e73";
const CHART_GRID = "#e8e8ed";
const TEMP_COLD = "#5b9bd5";
const TEMP_HOT = "#e05d5d";
const CHART_VIEWS = new Set(["timeline", "yoy-month", "yoy-pct"]);

function usesYoyDelta(metric = state.metric) {
  return metric === "temperature";
}

function hasYoyData(point, metric = state.metric) {
  if (usesYoyDelta(metric)) return point.yoy_delta != null && !Number.isNaN(point.yoy_delta);
  return point.yoy_pct != null && !Number.isNaN(point.yoy_pct);
}

function yoySeriesValue(point, metric = state.metric) {
  if (usesYoyDelta(metric)) {
    if (point.yoy_delta == null || Number.isNaN(point.yoy_delta)) return null;
    return convertTempValue(point.yoy_delta);
  }
  return point.yoy_pct;
}

function yoyStatsFromSeries(series, metric = state.metric) {
  const points = series.filter((p) => hasYoyData(p, metric));
  const values = points.map((p) => yoySeriesValue(p, metric)).filter((v) => v != null);
  if (!values.length) return { empty: true };
  return {
    empty: false,
    avg_yoy_pct: avg(values),
    latest_yoy_pct: yoySeriesValue(points[points.length - 1], metric),
    min: Math.min(...values),
    max: Math.max(...values),
    latest_date: points[points.length - 1].date,
    count: values.length,
  };
}

function yoyUnitSuffix() {
  return usesYoyDelta() ? `°${state.tempUnit}` : "%";
}

function formatYoyStat(value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (usesYoyDelta()) return `${Number(value).toFixed(2)}°${state.tempUnit}`;
  return `${fmt(value)}%`;
}

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
  chartView: "timeline",
  calendarMonth: 7,
  periodStart: null,
  periodEnd: null,
  periodMin: null,
  periodMax: null,
  sortKey: "name",
  sortAsc: true,
  sortBound: false,
  attestationUrl: null,
  summaryRequestId: 0,
  loadedCities: new Set(),
  loadingCities: new Set(),
  builtInCityIds: new Set(),
};

let mainChart = null;
let yoyChart = null;
let toastTimer = null;

function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

const UV_WHO_BANDS = [
  { max: 2, label: "Low", class: "uv-badge-low" },
  { max: 5, label: "Moderate", class: "uv-badge-moderate" },
  { max: 7, label: "High", class: "uv-badge-high" },
  { max: 10, label: "Very High", class: "uv-badge-very-high" },
  { max: Infinity, label: "Extreme", class: "uv-badge-extreme" },
];

function uvWhoCategory(value) {
  if (value == null || Number.isNaN(value)) return null;
  const v = Number(value);
  return UV_WHO_BANDS.find((band) => v <= band.max) || UV_WHO_BANDS[UV_WHO_BANDS.length - 1];
}

async function loadData() {
  const [metaRes, citiesRes, attestRes] = await Promise.all([
    fetch("data/graph-meta.json"),
    fetch("data/cities.json"),
    fetch("data/attestation.json").catch(() => null),
  ]);

  if (!metaRes.ok) {
    throw new Error(`Could not load graph metadata (${metaRes.status}). Run: python3 build_data.py`);
  }
  if (!citiesRes.ok) {
    throw new Error(`Could not load cities list (${citiesRes.status}). Run: python3 build_data.py`);
  }

  const meta = await metaRes.json();
  state.citiesConfig = await citiesRes.json();
  state.graph = {
    metadata: meta.metadata,
    nodes: meta.nodes || [],
    edges: meta.edges || [],
    cities: {},
  };
  state.builtInCityIds = new Set(meta.city_ids || state.citiesConfig.cities.map((c) => c.id));
  setBuiltInCityIds([...state.builtInCityIds]);
  mergeCustomCities(state);

  if (attestRes?.ok) {
    const attest = await attestRes.json();
    state.attestationUrl = attest?.verify_url;
  }

  const defaultId = state.graph.metadata.default_city;
  state.selected.add(defaultId);

  const period = state.graph.metadata.period || {};
  state.periodMin = period.earliest_temperature || period.start || "1981-01";
  state.periodMax = period.end || period.latest_nasa || "2025-12";
  state.periodStart = period.default_start || period.start || state.periodMin;

  applyUrlParams();
  if (!window.location.search.includes("start=")) {
    state.periodStart = period.default_start || period.start || state.periodMin;
  } else if (state.periodStart < state.periodMin) {
    state.periodStart = state.periodMin;
  }
  if (!window.location.search.includes("end=")) {
    state.periodEnd = state.periodMax;
  } else if (state.periodEnd > state.periodMax) {
    state.periodEnd = state.periodMax;
  }
  if (state.periodStart > state.periodEnd) {
    state.periodStart = period.default_start || period.start || state.periodMin;
  }

  initUI();
  renderHeader();
  await loadSelectedCityData();
  renderAll();
}

async function loadSelectedCityData() {
  const loaders = [...state.selected].map((cityId) => ensureCityDataLoaded(state, cityId));
  await Promise.all(loaders);
  state.periodMin = computeDataPeriodMin();
  state.periodMax = computeDataPeriodMax();
}

function computeDataPeriodMin() {
  let minDate = null;
  for (const city of Object.values(state.graph?.cities || {})) {
    for (const metric of ["temperature", "uv"]) {
      const first = city.series?.[metric]?.[0]?.date;
      if (first && (!minDate || first < minDate)) minDate = first;
    }
  }
  return minDate;
}

function computeDataPeriodMax() {
  let maxDate = null;
  for (const city of Object.values(state.graph?.cities || {})) {
    for (const metric of ["temperature", "uv"]) {
      const series = city.series?.[metric];
      const last = series?.[series.length - 1]?.date;
      if (last && (!maxDate || last > maxDate)) maxDate = last;
    }
  }
  return maxDate || state.periodMin || "1981-01";
}

function getCityColor(cityId) {
  const ids = [...state.selected];
  const idx = ids.indexOf(cityId);
  return CITY_COLORS[(idx >= 0 ? idx : ids.length) % CITY_COLORS.length];
}

function monthName(n) {
  return MONTHS[(n || 1) - 1] || "";
}

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const cities = params.get("cities");
  const metric = params.get("metric");
  const view = params.get("view");
  const month = params.get("month");
  const start = params.get("start");
  const end = params.get("end");

  if (cities) {
    state.selected.clear();
    const validIds = new Set([
      ...state.builtInCityIds,
      ...state.citiesConfig.cities.map((c) => c.id),
    ]);
    cities.split(",").slice(0, MAX_CITIES).forEach((id) => {
      const trimmed = id.trim();
      if (validIds.has(trimmed)) state.selected.add(trimmed);
    });
    if (state.selected.size === 0) state.selected.add(state.graph.metadata.default_city);
  }
  if (metric && (metric === "uv" || metric === "temperature")) state.metric = metric;
  if (view && CHART_VIEWS.has(view)) state.chartView = view;
  const unit = params.get("unit");
  if (unit === "F" || unit === "C") state.tempUnit = unit;
  if (month) state.calendarMonth = parseInt(month, 10);
  if (start && /^\d{4}-\d{2}$/.test(start)) {
    state.periodStart = start < state.periodMin ? state.periodMin : start;
  }
  if (end && /^\d{4}-\d{2}$/.test(end)) {
    state.periodEnd = end > state.periodMax ? state.periodMax : end;
  }
}

function updateUrl() {
  const params = new URLSearchParams();
  params.set("cities", [...state.selected].join(","));
  params.set("metric", state.metric);
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
  initCityAdd(state, {
    async onAdded(city, { loading } = {}) {
      if (loading) {
        renderCityList();
        return;
      }
      state.periodMin = computeDataPeriodMin();
      state.periodMax = computeDataPeriodMax();
      renderCityList();
      renderAll();
    },
    onDuplicate(city) {
      highlightCityRow(city.id);
    },
    showToast,
  });
  renderAttestation();
}

function highlightCityRow(cityId) {
  const row = document.querySelector(`.city-item[data-city-id="${cityId}"]`);
  if (!row) return;
  row.classList.add("city-item--highlight");
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => row.classList.remove("city-item--highlight"), 2500);
}

function ensureSelectionAfterRemove() {
  if (state.selected.size > 0) return;
  const visible = getVisibleCities(state);
  const defaultId = state.graph.metadata.default_city;
  const fallback = visible.find((c) => c.id === defaultId) || visible[0];
  if (fallback) state.selected.add(fallback.id);
}

async function onCityRemove(cityId, event) {
  event.preventDefault();
  event.stopPropagation();
  removeCity(state, cityId);
  ensureSelectionAfterRemove();
  renderCityList();
  await loadSelectedCityData();
  renderAll();
}

function renderCityList() {
  const container = document.getElementById("city-list");
  container.innerHTML = "";

  for (const city of getVisibleCities(state)) {
    const loading = state.loadingCities.has(city.id);
    container.appendChild(createCityCheckbox(city.id, `${city.name}, ${city.region}`, loading));
  }
}

function createCityCheckbox(id, label, loading = false) {
  const div = document.createElement("div");
  div.className = "city-item";
  div.dataset.cityId = id;
  const checked = state.selected.has(id) ? "checked" : "";
  const color = state.selected.has(id) ? getCityColor(id) : "transparent";
  const loadingMark = loading ? '<span class="city-loading" aria-hidden="true">…</span>' : "";
  div.innerHTML = `
    <input type="checkbox" id="city-${id}" value="${id}" ${checked}>
    <label for="city-${id}"><span class="city-dot" style="background:${color}"></span>${label}${loadingMark}</label>
    <button type="button" class="city-remove" aria-label="Remove ${label}">×</button>
  `;
  div.querySelector("input").addEventListener("change", onCityToggle);
  div.querySelector(".city-remove").addEventListener("click", (e) => onCityRemove(id, e));
  return div;
}

function initMonthSelect() {
  const select = document.getElementById("calendar-month");
  select.innerHTML = MONTHS.map((m, i) =>
    `<option value="${i + 1}" ${i + 1 === state.calendarMonth ? "selected" : ""}>${m}</option>`
  ).join("");
}

function metricLabel(metric = state.metric) {
  if (metric === "uv") return "UV Index (WHO)";
  return state.tempUnit === "F" ? "Temperature (°F)" : "Temperature (°C)";
}

function renderHeader() {
  const el = document.getElementById("page-subtitle");
  if (!el) return;
  const earliest = formatMonthLabel(state.periodMin);
  const latest = formatMonthLabel(state.periodMax);
  el.textContent = `Month-by-month and year-over-year analysis from ${earliest} through ${latest}`;
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
  document.getElementById("month-filter").classList.toggle("hidden", state.chartView !== "yoy-month");
  document.getElementById("yoy-panel").classList.toggle("hidden", state.chartView === "yoy-pct");
}

function updateDateRangeHint() {
  const el = document.getElementById("date-range-hint");
  if (!el) return;
  const period = state.graph?.metadata?.period || {};
  const calendarMonth = period.calendar_month;
  const earliest = formatMonthLabel(state.periodMin);
  const latest = formatMonthLabel(state.periodMax);
  const today = calendarMonth ? formatMonthLabel(calendarMonth) : "today";
  const uvStart = period.earliest_uv ? formatMonthLabel(period.earliest_uv) : null;
  const whoStart = period.earliest_uv_who || period.uv_who_start;
  const whoLabel = whoStart ? formatMonthLabel(whoStart) : "2021";
  el.textContent =
    `Temperature (ERA5) ${earliest}–${latest}. UV: NASA POWER ${uvStart || "2001"}–${whoLabel}, WHO peaks ${whoLabel}–${formatMonthLabel(period.end || latest)} (pre-2021 NASA adjusted to WHO scale). Default start ${formatMonthLabel(state.periodStart)}. Calendar: ${today}.`;
}

function syncDateInputs() {
  const periodStart = document.getElementById("period-start");
  const periodEnd = document.getElementById("period-end");
  if (!periodStart || !periodEnd) return;

  periodStart.min = state.periodMin;
  periodStart.max = state.periodMax;
  periodEnd.min = state.periodStart;
  periodEnd.max = state.periodMax;

  periodStart.value = state.periodStart;
  periodEnd.value = state.periodEnd;
  periodStart.setAttribute("value", state.periodStart);
  periodEnd.setAttribute("value", state.periodEnd);
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
  syncDateInputs();
  updateDateRangeHint();

  periodStart.addEventListener("change", () => {
    state.periodStart = periodStart.value;
    if (state.periodStart > state.periodEnd) {
      state.periodEnd = state.periodStart;
    }
    syncDateInputs();
    renderAll();
  });
  periodEnd.addEventListener("change", () => {
    state.periodEnd = periodEnd.value;
    if (state.periodEnd < state.periodStart) {
      state.periodStart = state.periodEnd;
    }
    syncDateInputs();
    renderAll();
  });
}

async function onCityToggle(e) {
  const id = e.target.value;
  if (e.target.checked) {
    if (state.selected.size >= MAX_CITIES) {
      e.target.checked = false;
      showToast(`You can compare up to ${MAX_CITIES} cities at once. Uncheck one to add another.`);
      return;
    }
    state.selected.add(id);
    renderCityList();
    await ensureCityDataLoaded(state, id);
    state.periodMin = computeDataPeriodMin();
    state.periodMax = computeDataPeriodMax();
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
  if (data?.name) return data.name;
  const meta = state.citiesConfig.cities.find((c) => c.id === cityId);
  if (meta) return `${meta.name}, ${meta.region}`;
  return cityId;
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
  renderHeader();
  updateViewVisibility();
  syncDateInputs();
  updateDateRangeHint();
  renderInsights();
  renderNLSummary();
  renderMainChart();
  renderYoyChart();
  renderComparisonTable();
}

function summaryContext() {
  const cities = [...state.selected].map((cityId) => {
    const summary = computeViewSummary(cityId);
    return {
      id: cityId,
      label: getCityLabel(cityId),
      color: getCityColor(cityId),
      summary,
      graph: getCityData(cityId),
    };
  });

  return {
    metric: state.metric,
    tempUnit: state.tempUnit,
    chartView: state.chartView,
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
    calendarMonth: state.calendarMonth,
    graph: state.graph,
    cities,
    metricLabel: metricLabel(),
    formatMetricValue,
    fmt,
    formatMonthLabel,
    monthName,
    getSeries,
  };
}

function renderNLSummary() {
  const el = document.getElementById("nl-summary");
  const status = document.getElementById("nl-summary-status");
  if (!el) return;

  const requestId = ++state.summaryRequestId;
  el.textContent = "Analyzing trends…";
  status.textContent = "";

  generateSummary(summaryContext(), {
    onUpdate(text, phase) {
      if (requestId !== state.summaryRequestId) return;
      el.textContent = text;
      if (phase === "instant") status.textContent = "";
      else if (phase === "rag") status.textContent = "Interpretation grounded in Open-Meteo data";
    },
  }).catch(() => {
    if (requestId === state.summaryRequestId) {
      el.textContent = buildInstantSummary(summaryContext());
    }
  });
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
      const value = state.chartView === "yoy-pct" ? yoySeriesValue(point) : metricValue(point.value);
      if (value == null || Number.isNaN(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  if (min === Infinity) return { min: 0, max: 1 };
  return { min, max };
}

function buildTempPointStyles(values, globalMin, globalMax, cityColor = null) {
  const epsilon = 0.01;
  return values.map((value) => {
    const isMin = Math.abs(value - globalMin) < epsilon;
    const isMax = Math.abs(value - globalMax) < epsilon;
    const base = cityColor || tempGradientColor(value, globalMin, globalMax);
    return {
      backgroundColor: isMin ? TEMP_COLD : isMax ? TEMP_HOT : base,
      borderColor: isMin ? TEMP_COLD : isMax ? TEMP_HOT : (cityColor || tempGradientColor(value, globalMin, globalMax, 1)),
      radius: isMin || isMax ? 5 : 2,
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
  const useTempGradient = state.metric === "temperature" && state.chartView !== "yoy-pct";
  const multiCity = state.selected.size > 1;
  const globalRange = useTempGradient ? getGlobalValueRange() : null;

  showTempLegend(useTempGradient && !multiCity);

  for (const cityId of state.selected) {
    const cityColor = getCityColor(cityId);
    const series = getSeries(cityId, state.metric);
    if (!series.length) continue;

    if (state.chartView === "yoy-month") {
      const monthStr = state.calendarMonth.toString().padStart(2, "0");
      const filtered = series.filter((p) => p.date.endsWith(`-${monthStr}`));
      const values = filtered.map((p) => metricValue(p.value));
      const styles = useTempGradient
        ? buildTempPointStyles(values, globalRange.min, globalRange.max, multiCity ? cityColor : null)
        : null;
      datasets.push({
        label: getCityLabel(cityId),
        data: filtered.map((p) => ({ x: p.date.slice(0, 4), y: metricValue(p.value) })),
        borderColor: useTempGradient && multiCity ? cityColor : (styles ? styles.map((s) => s.borderColor) : cityColor),
        backgroundColor: useTempGradient
          ? styles.map((s) => s.backgroundColor)
          : cityColor + "88",
        borderWidth: 1,
        borderSkipped: false,
      });
    } else if (state.chartView === "yoy-pct") {
      datasets.push({
        label: getCityLabel(cityId),
        data: series
          .filter((p) => hasYoyData(p))
          .map((p) => ({ x: p.date, y: yoySeriesValue(p) }))
          .filter((p) => p.y != null),
        borderColor: cityColor,
        backgroundColor: cityColor + "22",
        tension: 0.2,
      });
    } else {
      const values = series.map((p) => metricValue(p.value));
      const styles = useTempGradient
        ? buildTempPointStyles(values, globalRange.min, globalRange.max, multiCity ? cityColor : null)
        : null;
      datasets.push({
        label: getCityLabel(cityId),
        data: series.map((p) => ({ x: p.date, y: metricValue(p.value) })),
        borderColor: cityColor,
        backgroundColor: cityColor + "22",
        borderWidth: 2,
        pointBackgroundColor: useTempGradient ? styles.map((s) => s.backgroundColor) : cityColor,
        pointBorderColor: useTempGradient ? styles.map((s) => s.borderColor) : cityColor,
        pointRadius: useTempGradient ? styles.map((s) => s.radius) : 2,
        pointBorderWidth: useTempGradient ? styles.map((s) => s.borderWidth) : 1,
        pointHoverRadius: useTempGradient ? styles.map((s) => s.radius + 2) : 5,
        fill: false,
        tension: 0.2,
      });
    }
  }

  if (mainChart) mainChart.destroy();
  mainChart = new Chart(ctx, {
    type: state.chartView === "yoy-month" ? "bar" : "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        title: { display: true, text: chartTitle(), color: CHART_TEXT },
        legend: {
          labels: {
            color: CHART_TEXT,
            usePointStyle: true,
            pointStyle: "circle",
          },
        },
      },
      scales: {
        x: {
          ticks: { color: CHART_MUTED, maxTicksLimit: 14, autoSkip: true },
          grid: { color: CHART_GRID },
        },
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
  for (const cityId of state.selected) {
    const cityColor = getCityColor(cityId);
    const series = getSeries(cityId, state.metric).filter((p) => hasYoyData(p));
    if (!series.length) continue;
    datasets.push({
      label: getCityLabel(cityId),
      data: series
        .map((p) => ({ x: p.date, y: yoySeriesValue(p) }))
        .filter((p) => p.y != null),
      borderColor: cityColor,
      backgroundColor: cityColor + "22",
      borderDash: [4, 2],
      tension: 0.2,
    });
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
          title: { display: true, text: yAxisLabel(), color: CHART_MUTED },
          ticks: { color: CHART_MUTED },
          grid: { color: CHART_GRID },
        },
      },
    },
  });
}

function chartTitle() {
  if (state.chartView === "yoy-month") return `${metricLabel()} — ${MONTHS[state.calendarMonth - 1]} by year`;
  if (state.chartView === "yoy-pct") {
    return usesYoyDelta()
      ? `Year-over-year change (°${state.tempUnit})`
      : `YoY % change — ${metricLabel()}`;
  }
  return metricLabel();
}

function yAxisLabel() {
  if (state.chartView === "yoy-pct") {
    return usesYoyDelta() ? `Δ °${state.tempUnit}` : "YoY %";
  }
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

/** Compare first vs last same calendar month in a series (seasonally fair trend). */
function sameMonthPeriodChange(series) {
  if (!series.length) return { change_pct: null, change_month: null };
  const lastPoint = series[series.length - 1];
  const monthStr = lastPoint.date.split("-")[1];
  const sameMonth = series.filter((p) => p.date.endsWith(`-${monthStr}`));
  if (sameMonth.length < 2) {
    return { change_pct: null, change_month: parseInt(monthStr, 10) };
  }
  return {
    change_pct: pctChange(sameMonth[0].value, sameMonth[sameMonth.length - 1].value),
    change_month: parseInt(monthStr, 10),
    change_start_date: sameMonth[0].date,
    change_end_date: sameMonth[sameMonth.length - 1].date,
  };
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
    const stats = yoyStatsFromSeries(series, state.metric);
    if (stats.empty) return { empty: true };
    return stats;
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
  const last = values[values.length - 1];
  const periodChange = sameMonthPeriodChange(series);

  const summary = {
    empty: false,
    avg_yoy_pct: avg(yoyValues),
    latest_yoy_pct: series[series.length - 1]?.yoy_pct ?? null,
    change_pct: periodChange.change_pct,
    change_month: periodChange.change_month,
    change_start_date: periodChange.change_start_date,
    change_end_date: periodChange.change_end_date,
    min: Math.min(...values),
    max: Math.max(...values),
    latest_value: last,
    latest_date: series[series.length - 1]?.date,
    min_date: series[values.indexOf(Math.min(...values))]?.date,
    max_date: series[values.indexOf(Math.max(...values))]?.date,
    count: series.length,
  };

  if (state.chartView === "timeline" && state.metric === "temperature") {
    summary.avg_mom_pct = avg(momValues);
    summary.latest_mom_pct = withMom[withMom.length - 1]?.mom_pct ?? null;
  }

  return summary;
}

function comparisonColumns() {
  const unitSuffix = state.metric === "temperature" ? ` (${state.tempUnit})` : "";
  if (state.chartView === "yoy-pct") {
    const yoyLabel = usesYoyDelta() ? `YoY Δ (°${state.tempUnit})` : "YoY %";
    return [
      { key: "name", label: "City", sortable: true },
      { key: "avg_yoy_pct", label: `Avg ${yoyLabel}`, sortable: true },
      { key: "latest_yoy_pct", label: `Latest ${yoyLabel}`, sortable: true },
      { key: "min", label: `Min ${yoyLabel}`, sortable: true },
      { key: "max", label: `Max ${yoyLabel}`, sortable: true },
    ];
  }
  if (state.chartView === "yoy-month") {
    return [
      { key: "name", label: "City", sortable: true },
      { key: "avg_yoy_pct", label: "Avg YoY %", sortable: true },
      { key: "latest_yoy_pct", label: "Latest YoY %", sortable: true },
      { key: "change_pct", label: "Same-month Δ %", sortable: true },
      { key: "min", label: `Min${unitSuffix}`, sortable: true },
      { key: "max", label: `Max${unitSuffix}`, sortable: true },
    ];
  }
  return [
    { key: "name", label: "City", sortable: true },
    { key: "avg_yoy_pct", label: "Avg YoY %", sortable: true },
    ...(state.metric === "temperature" && state.chartView === "timeline"
      ? [{ key: "avg_mom_pct", label: "Avg MoM %", sortable: true }]
      : []),
    { key: "change_pct", label: "Same-month Δ %", sortable: true },
    { key: "min", label: `Min${unitSuffix}`, sortable: true },
    { key: "max", label: `Max${unitSuffix}`, sortable: true },
  ];
}

function formatComparisonValue(key, value) {
  if (key === "name") return value;
  if (value == null || Number.isNaN(value)) return "—";
  if (state.chartView === "yoy-pct") {
    if (["avg_yoy_pct", "latest_yoy_pct", "min", "max"].includes(key)) {
      return formatYoyStat(value);
    }
  }
  if (key === "min" || key === "max") {
    const formatted = formatMetricValue(value);
    if (state.metric === "temperature") return `${formatted}°${state.tempUnit}`;
    return formatted;
  }
  return `${fmt(value)}%`;
}

function formatMonthLabel(dateStr) {
  if (!dateStr) return "—";
  const [year, month] = dateStr.split("-");
  return `${MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

function renderInsights() {
  document.getElementById("summary-context").textContent = summaryContextLabel();
  const el = document.getElementById("summary-table");
  const unit = state.metric === "temperature" ? state.tempUnit : "";
  const showTempBadges = state.metric === "temperature" && state.chartView !== "yoy-pct";

  const cards = [...state.selected].map((cityId) => {
    const cityColor = getCityColor(cityId);
    const s = computeViewSummary(cityId);
    if (s.empty) {
      return `
        <article class="insight-card">
          <h3><span class="city-dot" style="background:${cityColor}"></span>${getCityLabel(cityId)}</h3>
          <p class="hint">No data for the current view and date range.</p>
        </article>
      `;
    }

    const cityUvBadge = state.metric === "uv" && state.chartView !== "yoy-pct" && s.latest_value != null
      ? (() => {
          const band = uvWhoCategory(s.latest_value);
          return band
            ? `<span class="uv-badge ${band.class}">${formatMetricValue(s.latest_value)} ${band.label}</span>`
            : "";
        })()
      : "";

    const badges = showTempBadges ? `
      <div class="insight-badges">
        <span class="badge badge-cold">Coldest · ${formatMonthLabel(s.min_date)} · ${formatMetricValue(s.min)}${unit ? `°${unit}` : ""}</span>
        <span class="badge badge-hot">Hottest · ${formatMonthLabel(s.max_date)} · ${formatMetricValue(s.max)}${unit ? `°${unit}` : ""}</span>
      </div>
    ` : "";

    if (state.chartView === "yoy-pct") {
      const unit = yoyUnitSuffix();
      const rangeNote = usesYoyDelta()
        ? `Same-month change vs prior year, in ${unit}`
        : "Same-month UV index change vs prior year";
      return `
        <article class="insight-card">
          <h3><span class="city-dot" style="background:${cityColor}"></span>${getCityLabel(cityId)}</h3>
          <div class="insight-stats">
            <div class="stat"><span class="stat-value">${formatYoyStat(s.avg_yoy_pct)}</span><span class="stat-label">Avg YoY</span></div>
            <div class="stat"><span class="stat-value">${formatYoyStat(s.latest_yoy_pct)}</span><span class="stat-label">Latest YoY</span></div>
            <div class="stat"><span class="stat-value">${formatYoyStat(s.min)}</span><span class="stat-label">Min YoY</span></div>
            <div class="stat"><span class="stat-value">${formatYoyStat(s.max)}</span><span class="stat-label">Max YoY</span></div>
            <p class="stat-note">${s.latest_date || "—"} · Range ${formatYoyStat(s.min)} to ${formatYoyStat(s.max)} · ${rangeNote}</p>
          </div>
        </article>
      `;
    }

    const month = MONTHS[state.calendarMonth - 1];
    const latestLabel = state.chartView === "yoy-month"
      ? `Latest ${month}`
      : "Latest";
    const changeLabel = state.chartView === "yoy-month"
      ? `${month} Δ`
      : (s.change_month ? `${monthName(s.change_month)} Δ` : "Same-month Δ");
    const changeNote = s.change_start_date && s.change_end_date
      ? `${formatMonthLabel(s.change_start_date)} → ${formatMonthLabel(s.change_end_date)}`
      : "";

    return `
      <article class="insight-card">
        <h3><span class="city-dot" style="background:${cityColor}"></span>${getCityLabel(cityId)}</h3>
        ${cityUvBadge}
        ${badges}
        <div class="insight-stats">
          <div class="stat"><span class="stat-value">${formatMetricValue(s.latest_value)}${unit ? `°${unit}` : ""}</span><span class="stat-label">${latestLabel}</span></div>
          <div class="stat"><span class="stat-value">${fmt(s.avg_yoy_pct)}%</span><span class="stat-label">Avg YoY</span></div>
          <div class="stat"><span class="stat-value">${fmt(s.change_pct)}%</span><span class="stat-label">${changeLabel}</span></div>
          ${state.chartView === "timeline" && state.metric === "temperature" ? `<div class="stat"><span class="stat-value">${fmt(s.avg_mom_pct)}%</span><span class="stat-label">Avg MoM</span></div>` : ""}
          <p class="stat-note">${s.latest_date || "—"}${changeNote ? ` · ${changeNote}` : ""}${state.chartView === "timeline" && state.metric === "temperature" && s.latest_mom_pct != null ? ` · Latest MoM ${fmt(s.latest_mom_pct)}%` : ""}</p>
        </div>
      </article>
    `;
  });

  el.innerHTML = cards.join("") || "<p class='hint'>Select a city to see insights.</p>";
}

function defaultSortAsc(key) {
  return key === "name";
}

function compareTableRows(a, b, key, asc) {
  if (key === "name") {
    const cmp = a.name.localeCompare(b.name);
    return asc ? cmp : -cmp;
  }

  const av = a[key];
  const bv = b[key];
  const aMissing = av == null || Number.isNaN(av);
  const bMissing = bv == null || Number.isNaN(bv);
  if (aMissing && bMissing) return a.name.localeCompare(b.name);
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (av < bv) return asc ? -1 : 1;
  if (av > bv) return asc ? 1 : -1;
  return a.name.localeCompare(b.name);
}

function bindComparisonSortHandlers(table) {
  if (state.sortBound) return;
  const thead = table.querySelector("thead");
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sortKey === key) state.sortAsc = !state.sortAsc;
    else {
      state.sortKey = key;
      state.sortAsc = defaultSortAsc(key);
    }
    renderComparisonTable();
  });
  state.sortBound = true;
}

function renderComparisonTable() {
  const table = document.getElementById("comparison-table");
  const columns = comparisonColumns();
  const colKeys = new Set(columns.map((col) => col.key));
  if (!colKeys.has(state.sortKey)) {
    state.sortKey = "name";
    state.sortAsc = true;
  }

  bindComparisonSortHandlers(table);

  const thead = table.querySelector("thead tr");
  thead.innerHTML = columns.map((col) => {
    const active = col.key === state.sortKey;
    const dir = active ? (state.sortAsc ? "sort-asc" : "sort-desc") : "";
    const activeCls = active ? " sort-active" : "";
    return `<th data-sort="${col.key}" class="${dir}${activeCls}">${col.label}</th>`;
  }).join("");

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

  rows.sort((a, b) => compareTableRows(a, b, state.sortKey, state.sortAsc));

  tbody.innerHTML = rows.map((row) => `
    <tr>
      ${columns.map((col) => {
        const value = formatComparisonValue(col.key, row[col.key]);
        let cls = "";
        if (state.metric === "temperature" && state.chartView !== "yoy-pct") {
          if (col.key === "min") cls = ' class="temp-cold"';
          if (col.key === "max") cls = ' class="temp-hot"';
        }
        return `<td${cls}>${value}</td>`;
      }).join("")}
    </tr>
  `).join("");
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
  console.error(err);
  const banner = document.createElement("div");
  banner.className = "load-error";
  banner.textContent = `Failed to load dashboard: ${err.message}`;
  document.body.prepend(banner);
});
