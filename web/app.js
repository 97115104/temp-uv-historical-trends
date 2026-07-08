import { generateSummary, buildInstantSummary } from "./summary.js";
import {
  initCityAdd,
  mergeCustomCities,
  removeCity,
  ensureCityDataLoaded,
  setBuiltInCityIds,
  resolveCityByCoords,
  resolveCityBySlug,
  addCityByMeta,
  resolveUvDisplayTrend,
  MAX_SELECTED,
} from "./cityAdd.js";
const CITY_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];
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
    return convertTempDelta(point.yoy_delta);
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
  loadingCities: new Set(),
  cityLoadPromises: new Map(),
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
    cities: {},
  };
  state.builtInCityIds = new Set(meta.city_ids || state.citiesConfig.cities.map((c) => c.id));
  setBuiltInCityIds([...state.builtInCityIds]);
  mergeCustomCities(state);

  if (attestRes?.ok) {
    const attest = await attestRes.json();
    state.attestationUrl = attest?.verify_url;
  }

  // Landing starts empty: insights/charts appear only after the user picks a city.
  // Deep links (?cities=) still populate a selection via applyUrlParams().
  const period = state.graph.metadata.period || {};
  state.periodMin = period.earliest_temperature || period.start || "1981-01";
  state.periodMax = period.end || period.latest_nasa || "2025-12";
  state.periodStart = period.default_start || period.start || state.periodMin;

  const urlCityState = applyUrlParams();
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
  if (state.selected.size > 0) {
    await loadSelectedCityData();
    revealCharts();
    syncControlsToState();
  }
  if (urlCityState.unknownCityIds.length) {
    setLoading("Loading cities from link…");
    await resolveUrlCitySlugs(urlCityState.unknownCityIds);
    await loadSelectedCityData();
    revealCharts();
    syncControlsToState();
  }
  if (state.selected.size === 0 && urlCityState.hadCitiesParam) {
    showToast("Could not load the city from this link — try searching by name.");
  } else if (state.selected.size === 0 && !urlCityState.hadCitiesParam) {
    setLoading("Finding your location…");
    await loadLocation({ prompt: false });
  }
  renderAll();
  setLoading(null);
}

async function loadSelectedCityData() {
  for (const cityId of state.selected) {
    await ensureCityDataLoaded(state, cityId);
  }
  const dmin = computeDataPeriodMin();
  const dmax = computeDataPeriodMax();
  if (dmin) state.periodMin = dmin;
  if (dmax) state.periodMax = dmax;
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
  const unknownCityIds = [];

  if (cities) {
    state.selected.clear();
    const validIds = new Set(state.citiesConfig.cities.map((c) => c.id));
    cities.split(",").slice(0, MAX_SELECTED).forEach((id) => {
      const trimmed = id.trim();
      if (!trimmed) return;
      if (validIds.has(trimmed)) state.selected.add(trimmed);
      else unknownCityIds.push(trimmed);
    });
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

  return { unknownCityIds, hadCitiesParam: Boolean(cities) };
}

async function resolveUrlCitySlugs(slugs) {
  for (const slug of slugs) {
    try {
      const meta = await resolveCityBySlug(slug);
      if (meta) await addCityByMeta(state, meta, { select: true });
    } catch (err) {
      console.warn(`Could not resolve city from URL slug: ${slug}`, err);
    }
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

function setLoading(text) {
  const el = document.getElementById("loading-overlay");
  if (!el) return;
  if (text) {
    const label = document.getElementById("loading-text");
    if (label) label.textContent = text;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function syncControlsToState() {
  document.querySelectorAll('input[name="metric"]').forEach((el) => { el.checked = el.value === state.metric; });
  document.querySelectorAll('input[name="chart-view"]').forEach((el) => { el.checked = el.value === state.chartView; });
  document.querySelectorAll('input[name="temp-unit"]').forEach((el) => { el.checked = el.value === state.tempUnit; });
  const monthSelect = document.getElementById("calendar-month");
  if (monthSelect) monthSelect.value = String(state.calendarMonth);
  updateTempUnitVisibility();
  updateViewVisibility();
}

function initChartsReveal() {
  const btn = document.getElementById("toggle-charts");
  const view = document.getElementById("charts-view");
  if (!btn || !view) return;
  btn.addEventListener("click", () => {
    const collapsed = view.classList.toggle("charts-collapsed");
    btn.textContent = collapsed ? "Show charts" : "Hide charts";
    if (!collapsed) {
      setTimeout(() => { mainChart?.resize(); yoyChart?.resize(); }, 30);
    }
  });
}

function revealCharts() {
  const view = document.getElementById("charts-view");
  const btn = document.getElementById("toggle-charts");
  if (view) view.classList.remove("charts-collapsed");
  if (btn) btn.textContent = "Hide charts";
  setTimeout(() => { mainChart?.resize(); yoyChart?.resize(); }, 30);
}

async function resetToLocationCity(meta) {
  state.selected.clear();
  await addCityByMeta(state, meta, { select: true });
  state.periodMin = computeDataPeriodMin();
  state.periodMax = computeDataPeriodMax();
  state.periodStart = state.periodMin;
  state.periodEnd = state.periodMax;
  const understood = document.getElementById("ask-understood");
  if (understood) understood.textContent = `Showing: ${meta.name}${meta.region ? `, ${meta.region}` : ""}`;
  syncControlsToState();
  renderCityList();
  revealCharts();
  renderAll();
}

function initHeroActions() {
  const locate = document.getElementById("ask-locate");
  if (locate) locate.addEventListener("click", () => loadLocation({ prompt: true }));
}

async function loadLocation({ prompt = false } = {}) {
  if (!navigator.geolocation) {
    if (prompt) showToast("Location isn't available in this browser — search for a city instead.");
    return false;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          setLoading("Finding your location…");
          const meta = await resolveCityByCoords(position.coords.latitude, position.coords.longitude);
          await resetToLocationCity(meta);
          resolve(true);
        } catch {
          if (prompt) showToast("Couldn't load your location — search for a city instead.");
          resolve(false);
        } finally {
          setLoading(null);
        }
      },
      () => {
        if (prompt) showToast("Location permission denied — search for a city instead.");
        resolve(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  });
}

function initUI() {
  renderCityList();
  initMonthSelect();
  bindControls();
  initHeroActions();
  initChartsReveal();
  initCityAdd(state, {
    async onAdded(city, { loading, failed } = {}) {
      if (loading) {
        renderCityList();
        return;
      }
      if (failed) {
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
    onUseLocation: () => loadLocation({ prompt: true }),
    showToast,
  });
  renderAttestation();
}

function highlightCityRow(cityId) {
  const row = document.querySelector(`.city-chip[data-city-id="${cityId}"]`);
  if (!row) return;
  row.classList.add("city-item--highlight");
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => row.classList.remove("city-item--highlight"), 2500);
}

async function onCityRemove(cityId, event) {
  event.preventDefault();
  event.stopPropagation();
  removeCity(state, cityId);
  renderCityList();
  await loadSelectedCityData();
  renderAll();
}

function renderEmptyPrompt() {
  const understood = document.getElementById("ask-understood");
  if (!understood || state.selected.size > 0) return;
  understood.textContent = "Use your location or add a city to get started.";
}

function renderCityList() {
  const container = document.getElementById("city-list");
  if (!container) return;
  container.innerHTML = "";

  const cities = state.citiesConfig.cities.filter((city) => state.selected.has(city.id));
  for (const city of cities) {
    const selected = state.selected.has(city.id);
    const loading = state.loadingCities.has(city.id);
    const color = selected ? getCityColor(city.id) : "transparent";
    const chip = document.createElement("div");
    chip.className = `city-chip${selected ? " is-selected" : ""}`;
    chip.dataset.cityId = city.id;
    chip.innerHTML = `
      <button type="button" class="city-chip-toggle" aria-pressed="${selected}">
        <span class="city-dot" style="background:${color}"></span>${city.name}${loading ? " …" : ""}
      </button>
      <button type="button" class="city-chip-remove" aria-label="Remove ${city.name}">×</button>
    `;
    chip.querySelector(".city-chip-toggle").addEventListener("click", () => toggleCitySelection(city.id));
    chip.querySelector(".city-chip-remove").addEventListener("click", (e) => onCityRemove(city.id, e));
    container.appendChild(chip);
  }
}

async function toggleCitySelection(id) {
  if (state.selected.has(id)) {
    state.selected.delete(id);
    renderCityList();
    renderAll();
    return;
  }
  if (state.selected.size >= MAX_SELECTED) {
    showToast(`You can compare up to ${MAX_SELECTED} cities at once. Remove one to add another.`);
    return;
  }
  state.selected.add(id);
  await ensureCityDataLoaded(state, id);
  state.periodMin = computeDataPeriodMin() || state.periodMin;
  state.periodMax = computeDataPeriodMax() || state.periodMax;
  renderCityList();
  renderAll();
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

// Convert a temperature *difference* (anomaly). A delta scales by 9/5 only —
// no +32 offset, which would be wrong for a change in degrees.
function convertTempDelta(celsius) {
  if (celsius == null || Number.isNaN(celsius)) return null;
  return state.tempUnit === "F" ? celsius * 9 / 5 : celsius;
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
  updateChartViewHint();
}

function chartViewHintText() {
  const u = state.tempUnit;
  if (state.chartView === "timeline") {
    return state.metric === "temperature"
      ? "Each point is the average temperature that month — the actual reading, not a change from another year."
      : "Each point is the peak UV index that month — the actual level, not a change from another year.";
  }
  if (state.chartView === "yoy-month") {
    const month = MONTHS[state.calendarMonth - 1];
    return state.metric === "temperature"
      ? `Each bar is the average temperature every ${month}, so you can compare the same season across years.`
      : `Each bar is the peak UV every ${month}, so you can compare the same season across years.`;
  }
  if (state.metric === "temperature") {
    return `Temperature change in degrees (°${u}) vs the same month last year. Example: +2°${u} means this June was 2 degrees warmer than last June — not a percent.`;
  }
  return "UV percent change vs the same month last year. Example: +10% means the UV peak was 10% higher than that month a year ago.";
}

function updateChartViewHint() {
  const el = document.getElementById("chart-view-hint");
  if (el) el.textContent = chartViewHintText();
}

function updateDateRangeHint() {
  const el = document.getElementById("date-range-hint");
  if (!el) return;
  const tempYear = (state.periodMin || "").slice(0, 4);
  const uvYear = (state.graph?.metadata?.period?.earliest_uv || "2001").slice(0, 4);
  el.textContent = `Temperature from ${tempYear}, UV from ${uvYear} (monthly peak, ~1-month lag).`;
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

function updateComparisonVisibility() {
  const panel = document.querySelector(".comparison-panel");
  if (panel) panel.classList.toggle("hidden", state.selected.size <= 1);
}

function updateSelectionVisibility() {
  const hasSelection = state.selected.size > 0;
  document.getElementById("insights-bar")?.classList.toggle("hidden", !hasSelection);
  document.querySelector(".charts-reveal")?.classList.toggle("hidden", !hasSelection);
  updateComparisonVisibility();
  if (!hasSelection) {
    document.getElementById("charts-view")?.classList.add("charts-collapsed");
    const btn = document.getElementById("toggle-charts");
    if (btn) btn.textContent = "Show charts";
    const understood = document.getElementById("ask-understood");
    if (understood) understood.textContent = "";
  }
}

function renderAll() {
  updateSelectionVisibility();
  if (state.selected.size === 0) {
    renderCityList();
    renderEmptyPrompt();
    if (window.location.search) {
      history.replaceState(null, "", window.location.pathname);
    }
    return;
  }
  updateUrl();
  renderHeader();
  renderCityList();
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
    resolveUvDisplayTrend,
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

/** Least-squares fit over point index; returns the two endpoints for a trend line. */
function trendLineEndpoints(dataArr) {
  const pts = dataArr
    .map((p, i) => ({ i, x: p.x, y: p.y }))
    .filter((p) => p.y != null && !Number.isNaN(p.y));
  if (pts.length < 3) return null;
  const n = pts.length;
  const xm = pts.reduce((s, p) => s + p.i, 0) / n;
  const ym = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.i - xm) * (p.y - ym);
    den += (p.i - xm) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = ym - slope * xm;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return [
    { x: first.x, y: intercept + slope * first.i },
    { x: last.x, y: intercept + slope * last.i },
  ];
}

function pushTrendLine(datasets, dataArr, cityColor, label) {
  const endpoints = trendLineEndpoints(dataArr);
  if (!endpoints) return;
  datasets.push({
    type: "line",
    label: `${label} · trend`,
    data: endpoints,
    borderColor: cityColor,
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    tension: 0,
    order: 99,
  });
}

function isTrendLabel(label) {
  return typeof label === "string" && label.endsWith(" · trend");
}

/** Month key (YYYY-MM) → ISO date for Chart.js time scale. */
function chartMonthDate(ym) {
  return `${ym}-01`;
}

function chartYearDate(year) {
  return `${year}-01-01`;
}

function chartTimeScale({ unit = "month", maxTicksLimit = 14 } = {}) {
  return {
    type: "time",
    time: {
      unit,
      tooltipFormat: unit === "year" ? "yyyy" : "yyyy-MM",
      displayFormats: { month: "yyyy-MM", year: "yyyy" },
    },
    ticks: { color: CHART_MUTED, maxTicksLimit, autoSkip: true },
    grid: { color: CHART_GRID },
  };
}

function longTermTempDirection(cityId) {
  const total = convertTempDelta(getCityData(cityId)?.summary?.temperature?.trend?.total);
  if (total == null || Number.isNaN(total)) return "flat";
  const threshold = state.tempUnit === "F" ? 0.9 : 0.5;
  if (total >= threshold) return "up";
  if (total <= -threshold) return "down";
  return "flat";
}

function longTermUvDirection(cityId) {
  const data = getCityData(cityId);
  const total = resolveUvDisplayTrend(data?.series?.uv || [], data?.summary?.uv || {})?.total;
  if (total == null || Number.isNaN(total)) return "flat";
  if (total >= 0.3) return "up";
  if (total <= -0.3) return "down";
  return "flat";
}

function divergentTrendsNote(cityId) {
  const tempDir = longTermTempDirection(cityId);
  const uvDir = longTermUvDirection(cityId);
  if (tempDir === "up" && uvDir === "down") {
    return "Temperature and UV can move opposite ways: warming is average air heat over decades, while UV peak depends more on ozone, clouds, and season. Pre-2021 UV is scaled to the WHO index, so its long-run trend is indicative.";
  }
  if (tempDir === "down" && uvDir === "up") {
    return "Cooler decades alongside higher UV can happen when cloud cover or pollution shifts differ from the temperature average — UV peaks also track ozone and sun angle.";
  }
  return "";
}

function yoyChartContextLine(cityId, metric) {
  if (state.chartView !== "yoy-pct") return "";
  const stats = yoyStatsFromSeries(getSeries(cityId, metric), metric);
  if (stats.empty || stats.avg_yoy_pct == null) return "";
  const mean = stats.avg_yoy_pct;
  if (metric === "temperature") {
    return `Chart avg: ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}°${state.tempUnit} vs same month last year (a degree change, not a percent).`;
  }
  return `Chart avg: ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}% vs same month last year (percent change in UV).`;
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
      const monthData = filtered.map((p) => ({ x: chartYearDate(p.date.slice(0, 4)), y: metricValue(p.value) }));
      datasets.push({
        label: getCityLabel(cityId),
        data: monthData,
        borderColor: useTempGradient && multiCity ? cityColor : (styles ? styles.map((s) => s.borderColor) : cityColor),
        backgroundColor: useTempGradient
          ? styles.map((s) => s.backgroundColor)
          : cityColor + "88",
        borderWidth: 1,
        borderSkipped: false,
      });
      pushTrendLine(datasets, monthData, cityColor, getCityLabel(cityId));
    } else if (state.chartView === "yoy-pct") {
      datasets.push({
        label: getCityLabel(cityId),
        data: series
          .filter((p) => hasYoyData(p))
          .map((p) => ({ x: chartMonthDate(p.date), y: yoySeriesValue(p) }))
          .filter((p) => p.y != null),
        borderColor: cityColor,
        backgroundColor: cityColor + "22",
        tension: 0.2,
      });
    } else {
      const values = series.map((p) => metricValue(p.value));
      const timelineData = series.map((p) => ({ x: chartMonthDate(p.date), y: metricValue(p.value) }));
      const styles = useTempGradient
        ? buildTempPointStyles(values, globalRange.min, globalRange.max, multiCity ? cityColor : null)
        : null;
      datasets.push({
        label: getCityLabel(cityId),
        data: timelineData,
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
      pushTrendLine(datasets, timelineData, cityColor, getCityLabel(cityId));
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
            filter: (item) => !isTrendLabel(item.text),
          },
        },
        tooltip: {
          filter: (item) => !isTrendLabel(item.dataset?.label),
        },
      },
      scales: {
        x: state.chartView === "yoy-month"
          ? chartTimeScale({ unit: "year", maxTicksLimit: 12 })
          : chartTimeScale({ unit: "month", maxTicksLimit: 14 }),
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
        .map((p) => ({ x: chartMonthDate(p.date), y: yoySeriesValue(p) }))
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
        x: chartTimeScale({ unit: "month", maxTicksLimit: 24 }),
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
      ? `Same month vs last year (°${state.tempUnit})`
      : `Same month vs last year (%) — ${metricLabel()}`;
  }
  return metricLabel();
}

function yAxisLabel() {
  if (state.chartView === "yoy-pct") {
    return usesYoyDelta() ? `Change vs last year (°${state.tempUnit})` : "Change vs last year (%)";
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
  if (!series.length) return { change_pct: null, change_delta: null, change_month: null };
  const lastPoint = series[series.length - 1];
  const monthStr = lastPoint.date.split("-")[1];
  const sameMonth = series.filter((p) => p.date.endsWith(`-${monthStr}`));
  if (sameMonth.length < 2) {
    return { change_pct: null, change_delta: null, change_month: parseInt(monthStr, 10) };
  }
  const startVal = sameMonth[0].value;
  const endVal = sameMonth[sameMonth.length - 1].value;
  return {
    change_pct: pctChange(startVal, endVal),
    change_delta: convertTempDelta(endVal - startVal),
    change_month: parseInt(monthStr, 10),
    change_start_date: sameMonth[0].date,
    change_end_date: sameMonth[sameMonth.length - 1].date,
  };
}

function summaryContextLabel() {
  const startYear = (state.periodStart || "").slice(0, 4);
  const endYear = (state.periodEnd || "").slice(0, 4);
  const n = state.selected.size;
  const cityWord = n === 1 ? "1 place" : `${n} places`;
  return `${cityWord} · ${startYear}–${endYear}`;
}

function computeViewSummary(cityId) {
  const series = getViewSeries(cityId);
  if (!series.length) return { empty: true };

  if (state.chartView === "yoy-pct") {
    const stats = yoyStatsFromSeries(series, state.metric);
    if (stats.empty) return { empty: true };
    stats.trend = getCityTrend(cityId, state.metric);
    return stats;
  }

  const isTemp = state.metric === "temperature";
  const values = series.map((p) => p.value);
  const last = values[values.length - 1];
  const periodChange = sameMonthPeriodChange(series);

  const summary = {
    empty: false,
    latest_yoy_pct: isTemp ? null : (series[series.length - 1]?.yoy_pct ?? null),
    latest_yoy_delta: isTemp
      ? convertTempDelta(series[series.length - 1]?.yoy_delta ?? null)
      : null,
    change_pct: isTemp ? null : periodChange.change_pct,
    change_delta: isTemp ? periodChange.change_delta : null,
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
    trend: getCityTrend(cityId, state.metric),
  };

  if (isTemp) {
    const deltaVals = series.map((p) => convertTempDelta(p.yoy_delta)).filter((v) => v != null);
    summary.avg_yoy_delta = avg(deltaVals);
    summary.avg_yoy_pct = null;
  } else {
    const yoyValues = series.map((p) => p.yoy_pct).filter((v) => v != null);
    summary.avg_yoy_pct = avg(yoyValues);
  }

  if (state.chartView === "timeline" && isTemp) {
    const momDeltas = [];
    for (let i = 1; i < series.length; i += 1) {
      const d = convertTempDelta(series[i].value - series[i - 1].value);
      if (d != null) momDeltas.push(d);
    }
    summary.avg_mom_delta = avg(momDeltas);
    summary.latest_mom_delta = momDeltas.length ? momDeltas[momDeltas.length - 1] : null;
  }

  return summary;
}

/** Read the precomputed long-term trend for a city/metric from the loaded graph. */
function getCityTrend(cityId, metric = state.metric) {
  return getCityData(cityId)?.summary?.[metric]?.trend || null;
}

function comparisonColumns() {
  const isTemp = state.metric === "temperature";
  const unitSuffix = isTemp ? ` (°${state.tempUnit})` : "";

  if (state.chartView === "yoy-pct") {
    const yoyLabel = usesYoyDelta()
      ? `change (°${state.tempUnit})`
      : "change (%)";
    return [
      { key: "name", label: "City", sortable: true },
      { key: "avg_yoy_pct", label: `Avg ${yoyLabel}`, sortable: true },
      { key: "latest_yoy_pct", label: `Latest ${yoyLabel}`, sortable: true },
      { key: "min", label: "Smallest change", sortable: true },
      { key: "max", label: "Largest change", sortable: true },
    ];
  }

  const avgKey = isTemp ? "avg_yoy_delta" : "avg_yoy_pct";
  const avgLabel = isTemp ? `Avg change (°${state.tempUnit})` : "Avg change (%)";
  const latestKey = isTemp ? "latest_yoy_delta" : "latest_yoy_pct";
  const latestLabel = isTemp ? `Latest change (°${state.tempUnit})` : "Latest change (%)";
  const changeKey = isTemp ? "change_delta" : "change_pct";
  const changeLabel = isTemp ? `Total change (°${state.tempUnit})` : "Total change (%)";

  if (state.chartView === "yoy-month") {
    return [
      { key: "name", label: "City", sortable: true },
      { key: avgKey, label: avgLabel, sortable: true },
      { key: latestKey, label: latestLabel, sortable: true },
      { key: changeKey, label: changeLabel, sortable: true },
      { key: "min", label: `Lowest${unitSuffix}`, sortable: true },
      { key: "max", label: `Highest${unitSuffix}`, sortable: true },
    ];
  }
  return [
    { key: "name", label: "City", sortable: true },
    { key: avgKey, label: avgLabel, sortable: true },
    ...(isTemp && state.chartView === "timeline"
      ? [{ key: "avg_mom_delta", label: `Avg month-to-month (°${state.tempUnit})`, sortable: true }]
      : []),
    { key: changeKey, label: changeLabel, sortable: true },
    { key: "min", label: `Lowest${unitSuffix}`, sortable: true },
    { key: "max", label: `Highest${unitSuffix}`, sortable: true },
  ];
}

const TEMP_DELTA_KEYS = new Set([
  "avg_yoy_delta", "latest_yoy_delta", "change_delta", "avg_mom_delta", "latest_mom_delta",
]);

function formatComparisonValue(key, value) {
  if (key === "name") return value;
  if (value == null || Number.isNaN(value)) return "—";
  if (state.chartView === "yoy-pct" &&
      ["avg_yoy_pct", "latest_yoy_pct", "min", "max"].includes(key)) {
    return formatYoyStat(value);
  }
  if (TEMP_DELTA_KEYS.has(key)) {
    return `${Number(value).toFixed(2)}°${state.tempUnit}`;
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

/** Long-run typical value for a calendar month (seasonal baseline). */
function getTypicalForMonth(cityId, metric, month) {
  if (!month) return null;
  const baseline = getCityData(cityId)?.summary?.[metric]?.seasonal_baseline;
  if (!baseline) return null;
  const v = baseline[String(month)] ?? baseline[month] ?? null;
  return v == null ? null : Number(v);
}

/** Plain-language "has it changed?" verdict from the long-term trend. */
function trendVerdict(trend, metric) {
  if (!trend) return null;

  if (metric === "temperature") {
    const total = convertTempDelta(trend.total);
    const perDec = convertTempDelta(trend.per_decade);
    const u = `°${state.tempUnit}`;
    const warmThreshold = state.tempUnit === "F" ? 0.9 : 0.5;
    let tone = "flat";
    let hero = "About the same";
    if (total >= warmThreshold) { tone = "hot"; hero = `+${total.toFixed(1)}${u} warmer`; }
    else if (total <= -warmThreshold) { tone = "cold"; hero = `${total.toFixed(1)}${u} cooler`; }
    const sub = `${perDec >= 0 ? "+" : ""}${perDec.toFixed(2)}${u}/decade · vs ${trend.baseline_period}`;
    return { hero, sub, tone };
  }

  if (trend._display === "indicative") {
    const total = trend.total;
    const perDec = trend.per_decade;
    let hero = "About the same";
    if (total >= 0.3) hero = `+${total.toFixed(1)} higher`;
    else if (total <= -0.3) hero = `${total.toFixed(1)} lower`;
    const sub = `${perDec >= 0 ? "+" : ""}${perDec.toFixed(2)}/decade · Indicative · ${trend.source_window} (NASA scaled pre-2021)`;
    return { hero, sub, tone: "flat" };
  }
  if (trend._display === "short") {
    const total = trend.total;
    const perDec = trend.per_decade;
    let hero = "About the same";
    if (total >= 0.3) hero = `+${total.toFixed(1)} higher`;
    else if (total <= -0.3) hero = `${total.toFixed(1)} lower`;
    const startYear = trend.source_window?.split("-")[0] || "";
    const sub = `${perDec >= 0 ? "+" : ""}${perDec.toFixed(2)}/decade · Since ${startYear} · short WHO record`;
    return { hero, sub, tone: "flat" };
  }
  if (trend.confident === false) {
    return {
      hero: "Trend unclear",
      sub: `Not enough single-source UV history to call a trend (${trend.source_window}).`,
      tone: "flat",
    };
  }
  const total = trend.total;
  const perDec = trend.per_decade;
  let hero = "About the same";
  if (total >= 0.3) hero = `+${total.toFixed(1)} higher`;
  else if (total <= -0.3) hero = `${total.toFixed(1)} lower`;
  const sub = `${perDec >= 0 ? "+" : ""}${perDec.toFixed(2)}/decade · ${trend.source_window}`;
  return { hero, sub, tone: "flat" };
}

/** Format an absolute value for a specific metric, independent of state.metric. */
function formatValueFor(metric, value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (metric === "temperature") return `${Number(convertTempValue(value)).toFixed(1)}°${state.tempUnit}`;
  return Number(value).toFixed(1);
}

/** Latest value + typical for the latest month, for one metric within the period. */
function metricSnapshot(cityId, metric) {
  const series = getSeries(cityId, metric);
  if (!series.length) return null;
  const last = series[series.length - 1];
  const monthNum = parseInt(last.date.split("-")[1], 10);
  return {
    latest_value: last.value,
    latest_date: last.date,
    monthNum,
    typical: getTypicalForMonth(cityId, metric, monthNum),
    trend: metric === "uv"
      ? resolveUvDisplayTrend(getSeries(cityId, "uv"), getCityData(cityId)?.summary?.uv || {})
      : (getCityData(cityId)?.summary?.[metric]?.trend || null),
  };
}

/** One metric's verdict + latest-vs-typical block, for the both-metrics card. */
function metricVerdictBlock(cityId, metric, label) {
  const snap = metricSnapshot(cityId, metric);
  if (!snap) {
    return `<div class="metric-verdict"><span class="mv-label">${label}</span><p class="hint">No data in range.</p></div>`;
  }
  const verdict = trendVerdict(snap.trend, metric);
  const verdictBlock = verdict
    ? `<div class="verdict verdict-${verdict.tone}">
        <span class="verdict-hero">${verdict.hero}</span>
        <span class="verdict-sub">${verdict.sub}</span>
      </div>`
    : "";

  const monthLbl = snap.monthNum ? monthName(snap.monthNum) : "";
  const latestStr = formatValueFor(metric, snap.latest_value);
  const typicalStr = snap.typical != null ? formatValueFor(metric, snap.typical) : "—";

  let latestLine;
  if (metric === "uv") {
    const band = snap.latest_value != null ? uvWhoCategory(snap.latest_value) : null;
    const badge = band ? `<span class="uv-badge ${band.class}">${band.label}</span>` : "";
    latestLine = `Latest peak (${formatMonthLabel(snap.latest_date)}): <strong>${latestStr}</strong> ${badge} · typical ${monthLbl}: ${typicalStr}`;
  } else {
    latestLine = `Latest (${formatMonthLabel(snap.latest_date)}): <strong>${latestStr}</strong> · typical ${monthLbl}: ${typicalStr}`;
  }

  const chartCtx = yoyChartContextLine(cityId, metric);
  const chartCtxBlock = chartCtx ? `<p class="chart-context hint">${chartCtx}</p>` : "";

  return `
    <div class="metric-verdict">
      <span class="mv-label">${label}</span>
      ${verdictBlock}
      <p class="latest-line">${latestLine}</p>
      ${chartCtxBlock}
    </div>`;
}

function renderInsights() {
  document.getElementById("summary-context").textContent = summaryContextLabel();
  const el = document.getElementById("summary-table");

  const cards = [...state.selected].map((cityId) => {
    const cityColor = getCityColor(cityId);
    const divergence = divergentTrendsNote(cityId);
    const divergenceBlock = divergence
      ? `<p class="divergence-note hint">${divergence}</p>`
      : "";
    return `
      <article class="insight-card">
        <h3><span class="city-dot" style="background:${cityColor}"></span>${getCityLabel(cityId)}</h3>
        <div class="metric-verdicts">
          ${metricVerdictBlock(cityId, "temperature", "Temperature")}
          ${metricVerdictBlock(cityId, "uv", "UV")}
        </div>
        ${divergenceBlock}
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
    return { name: getCityLabel(cityId), ...(s.empty ? {} : s) };
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
    el.innerHTML = `Attestation: <a href="${state.attestationUrl}" target="_blank" rel="noopener">(Cursor + Auto)</a>`;
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
