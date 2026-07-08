const CUSTOM_CITIES_KEY = "uv-trends-custom-cities";
const HIDDEN_CITIES_KEY = "uv-trends-hidden-cities";
const ERA5_START = "1981-01-01";
const UV_START = "2021-01-01";
const WHO_UV_START_MONTH = "2021-01";
const NASA_UV_START_YEAR = 2001;
const MAX_SELECTED = 5;
export const DATA_VERSION = 5;
const MIN_UV_BASE = 0.5;

const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const OPEN_METEO_HISTORICAL = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point";

let searchTimer = null;
let builtInCityIds = new Set();

export function setBuiltInCityIds(ids) {
  builtInCityIds = new Set(ids);
}

export function isBuiltInCity(cityId) {
  return builtInCityIds.has(cityId);
}

export function isCustomCity(cityId) {
  const bundle = loadCustomCities();
  return bundle.cities.some((c) => c.id === cityId);
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function cityLabel(city) {
  const parts = [city.name];
  if (city.region) parts.push(city.region);
  else if (city.country) parts.push(city.country);
  return parts.join(", ");
}

function lastCompleteDate() {
  const now = new Date();
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return lastDay.toISOString().slice(0, 10);
}

function loadCustomCities() {
  try {
    const raw = localStorage.getItem(CUSTOM_CITIES_KEY);
    return raw ? JSON.parse(raw) : { cities: [], graphEntries: {}, dataVersion: DATA_VERSION };
  } catch {
    return { cities: [], graphEntries: {}, dataVersion: DATA_VERSION };
  }
}

function saveCustomCities(bundle) {
  bundle.dataVersion = DATA_VERSION;
  localStorage.setItem(CUSTOM_CITIES_KEY, JSON.stringify(bundle));
}

export function loadHiddenCities() {
  try {
    const raw = localStorage.getItem(HIDDEN_CITIES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveHiddenCities(hidden) {
  localStorage.setItem(HIDDEN_CITIES_KEY, JSON.stringify([...hidden]));
}

export function unhideCity(cityId) {
  const hidden = loadHiddenCities();
  if (!hidden.has(cityId)) return false;
  hidden.delete(cityId);
  saveHiddenCities(hidden);
  return true;
}

export function getVisibleCities(state) {
  const hidden = loadHiddenCities();
  return state.citiesConfig.cities.filter((city) => !hidden.has(city.id));
}

export function mergeCustomCities(state) {
  const bundle = loadCustomCities();
  for (const city of bundle.cities) {
    if (!state.citiesConfig.cities.some((c) => c.id === city.id)) {
      state.citiesConfig.cities.push(city);
    }
    if (bundle.graphEntries[city.id]) {
      state.graph.cities[city.id] = bundle.graphEntries[city.id];
      if (!state.graph.nodes.some((n) => n.id === `loc:${city.id}`)) {
        state.graph.nodes.push({ id: `loc:${city.id}`, type: "Place", label: cityLabel(city) });
      }
    }
  }
  return bundle;
}

export function existingCityMatch(state, { id, name, region }, { includeHidden = false } = {}) {
  const hidden = includeHidden ? new Set() : loadHiddenCities();
  const normRegion = (region || "").toLowerCase();
  return state.citiesConfig.cities.find((city) => {
    if (!includeHidden && hidden.has(city.id)) return false;
    if (city.id === id) return true;
    return city.name.toLowerCase() === name.toLowerCase() && (city.region || "").toLowerCase() === normRegion;
  });
}

export function removeCity(state, cityId) {
  state.selected.delete(cityId);
  delete state.graph.cities[cityId];
  state.graph.nodes = state.graph.nodes.filter((n) => n.id !== `loc:${cityId}`);
  state.loadedCities?.delete(cityId);
  state.loadingCities?.delete(cityId);

  if (isCustomCity(cityId)) {
    state.citiesConfig.cities = state.citiesConfig.cities.filter((c) => c.id !== cityId);
    const bundle = loadCustomCities();
    bundle.cities = bundle.cities.filter((c) => c.id !== cityId);
    delete bundle.graphEntries[cityId];
    saveCustomCities(bundle);
  } else if (isBuiltInCity(cityId)) {
    const hidden = loadHiddenCities();
    hidden.add(cityId);
    saveHiddenCities(hidden);
  } else {
    state.citiesConfig.cities = state.citiesConfig.cities.filter((c) => c.id !== cityId);
  }
}

function rankGeocodeResults(results, query) {
  const q = query.trim().toLowerCase();
  return [...results].sort((a, b) => {
    const score = (r) => {
      let s = 0;
      if (r.country_code === "US") s += 2000;
      if (r.name.toLowerCase() === q) s += 800;
      if (r.name.toLowerCase().startsWith(q)) s += 300;
      s += Math.min(r.population || 0, 1_000_000) / 1000;
      if (r.feature_code?.startsWith("PPL")) s += 100;
      return s;
    };
    return score(b) - score(a);
  });
}

function pickPlaceName(address = {}) {
  return (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.hamlet ||
    address.county ||
    ""
  );
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pickClosestGeocodeResult(results, lat, lon, countryCode = "") {
  const candidates = countryCode
    ? results.filter((r) => r.country_code === countryCode)
    : results;
  const pool = candidates.length ? candidates : results;
  return [...pool].sort((a, b) => {
    const da = distanceKm(lat, lon, a.latitude, a.longitude);
    const db = distanceKm(lat, lon, b.latitude, b.longitude);
    return da - db;
  })[0];
}

async function reverseGeocode(lat, lon) {
  // #region agent log
  fetch("http://127.0.0.1:7287/ingest/755ead2c-e358-4614-ab66-2eb5a9e774d8", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "530b69" },
    body: JSON.stringify({
      sessionId: "530b69",
      runId: "post-fix",
      hypothesisId: "A",
      location: "cityAdd.js:reverseGeocode:start",
      message: "reverse geocode start",
      data: { lat, lon, provider: "nominatim+open-meteo-search" },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  const nomUrl = new URL(NOMINATIM_REVERSE);
  nomUrl.searchParams.set("lat", String(lat));
  nomUrl.searchParams.set("lon", String(lon));
  nomUrl.searchParams.set("format", "json");
  nomUrl.searchParams.set("addressdetails", "1");
  nomUrl.searchParams.set("accept-language", "en");
  nomUrl.searchParams.set("zoom", "10");

  const nomRes = await fetch(nomUrl);
  // #region agent log
  fetch("http://127.0.0.1:7287/ingest/755ead2c-e358-4614-ab66-2eb5a9e774d8", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "530b69" },
    body: JSON.stringify({
      sessionId: "530b69",
      runId: "post-fix",
      hypothesisId: "A",
      location: "cityAdd.js:reverseGeocode:nominatim",
      message: "nominatim reverse response",
      data: { ok: nomRes.ok, status: nomRes.status },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (!nomRes.ok) throw new Error("Could not look up your location.");

  const nomData = await nomRes.json();
  const placeName = pickPlaceName(nomData.address || {});
  if (!placeName) throw new Error("No city found near your location.");

  const countryCode = (nomData.address?.country_code || "").toUpperCase();
  const results = (await searchCities(placeName)).filter(
    (r) => r.feature_code?.startsWith("PPL") || (r.population || 0) > 0
  );
  if (!results.length) throw new Error("No city found near your location.");

  const best = pickClosestGeocodeResult(results, lat, lon, countryCode);
  // #region agent log
  fetch("http://127.0.0.1:7287/ingest/755ead2c-e358-4614-ab66-2eb5a9e774d8", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "530b69" },
    body: JSON.stringify({
      sessionId: "530b69",
      runId: "post-fix",
      hypothesisId: "A",
      location: "cityAdd.js:reverseGeocode:success",
      message: "reverse geocode resolved",
      data: { placeName, resolvedName: best.name, countryCode: best.country_code },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  return best;
}

function normalizeGeoResult(result) {
  return {
    id: makeCityId(result),
    name: result.name,
    region: result.admin1 || "",
    country: result.country_code || "",
    lat: Number(result.latitude.toFixed(4)),
    lon: Number(result.longitude.toFixed(4)),
  };
}

/** Resolve a free-text city name to a normalized city meta (best match), or null. */
export async function resolveCityByName(query) {
  const results = await searchCities(query);
  return results.length ? normalizeGeoResult(results[0]) : null;
}

/** Resolve the user's coordinates to a normalized city meta. */
export async function resolveCityByCoords(lat, lon) {
  return normalizeGeoResult(await reverseGeocode(lat, lon));
}

async function searchCities(query) {
  if (!query || query.trim().length < 2) return [];
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query.trim());
  url.searchParams.set("count", "12");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const res = await fetch(url);
  if (!res.ok) throw new Error("City search failed.");
  const data = await res.json();
  const results = (data.results || []).filter((r) => r.feature_code?.startsWith("PPL") || (r.population || 0) > 0);
  return rankGeocodeResults(results, query).slice(0, 8);
}

function aggregateDailyToMonthly(daily, valueKey) {
  const buckets = new Map();
  for (let i = 0; i < daily.time.length; i += 1) {
    const value = daily[valueKey][i];
    if (value == null || Number.isNaN(value)) continue;
    const month = daily.time[i].slice(0, 7);
    const bucket = buckets.get(month) || { sum: 0, count: 0 };
    bucket.sum += value;
    bucket.count += 1;
    buckets.set(month, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({ date, value: bucket.sum / bucket.count }));
}

function aggregateHourlyToMonthlyMax(hourly, valueKey) {
  const buckets = new Map();
  for (let i = 0; i < hourly.time.length; i += 1) {
    const value = hourly[valueKey][i];
    if (value == null || Number.isNaN(value)) continue;
    const month = hourly.time[i].slice(0, 7);
    buckets.set(month, Math.max(buckets.get(month) ?? 0, value));
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

async function fetchOpenMeteoTemperature(lat, lon, endDate) {
  const url = new URL(OPEN_METEO_ARCHIVE);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", ERA5_START);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("daily", "temperature_2m_mean");
  url.searchParams.set("models", "era5");
  url.searchParams.set("timezone", "UTC");

  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo temperature fetch failed.");
  const data = await res.json();
  return aggregateDailyToMonthly(data.daily, "temperature_2m_mean");
}

async function fetchOpenMeteoUv(lat, lon, endDate) {
  const url = new URL(OPEN_METEO_HISTORICAL);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", UV_START);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("hourly", "uv_index");
  url.searchParams.set("timezone", "UTC");

  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo UV fetch failed.");
  const data = await res.json();
  return aggregateHourlyToMonthlyMax(data.hourly, "uv_index");
}

function parseNasaUvMonthly(payload) {
  const uv = payload?.properties?.parameter?.ALLSKY_SFC_UV_INDEX || {};
  const records = [];
  for (const [key, value] of Object.entries(uv)) {
    if (key.length !== 6 || value === -999) continue;
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(4, 6));
    if (month < 1 || month > 12) continue;
    records.push({ date: `${year}-${String(month).padStart(2, "0")}`, value: Number(value), source: "nasa_power" });
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchNasaUv(lat, lon, startYear, endYear) {
  const proxyUrl = new URL("/api/nasa-power", window.location.origin);
  proxyUrl.searchParams.set("latitude", String(lat));
  proxyUrl.searchParams.set("longitude", String(lon));
  proxyUrl.searchParams.set("start", String(startYear));
  proxyUrl.searchParams.set("end", String(endYear));

  const directUrl = new URL(NASA_POWER_URL);
  directUrl.searchParams.set("parameters", "T2M,ALLSKY_SFC_UV_INDEX");
  directUrl.searchParams.set("community", "RE");
  directUrl.searchParams.set("longitude", String(lon));
  directUrl.searchParams.set("latitude", String(lat));
  directUrl.searchParams.set("start", String(startYear));
  directUrl.searchParams.set("end", String(endYear));
  directUrl.searchParams.set("format", "JSON");

  let res = await fetch(proxyUrl);
  if (!res.ok) res = await fetch(directUrl);
  if (!res.ok) throw new Error("NASA POWER UV fetch failed.");
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return parseNasaUvMonthly(data);
}

function mergeUvSeries(nasaRecords, whoRecords) {
  const byDate = new Map();
  for (const row of nasaRecords) {
    byDate.set(row.date, { value: row.value, source: "nasa_power" });
  }
  for (const row of whoRecords) {
    const entry = { value: row.value, source: "open_meteo_who" };
    if (row.date >= WHO_UV_START_MONTH) byDate.set(row.date, entry);
    else if (!byDate.has(row.date)) byDate.set(row.date, entry);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { value, source }]) => ({ date, value, source, value_raw: value }));
}

function uvCalibrationFactorsFromSources(nasaRecords, whoRecords) {
  const factors = {};
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, "0");
    const nasa = nasaRecords.find((r) => r.date === `2020-${mm}`);
    const who = whoRecords.find((r) => r.date === `2021-${mm}`);
    if (nasa && who && nasa.value > 0.01) {
      factors[month] = who.value / nasa.value;
    }
  }
  return factors;
}

function applyUvCalibration(records, factors) {
  return records.map((row) => {
    if (row.source !== "nasa_power") return { ...row, value_raw: row.value_raw ?? row.value };
    const month = parseInt(row.date.split("-")[1], 10);
    const factor = factors[month];
    const value = factor ? row.value * factor : row.value;
    return { ...row, value_raw: row.value, value };
  });
}

async function fetchCombinedUv(lat, lon, endDate) {
  const endYear = Number(endDate.slice(0, 4));
  const [nasa, who] = await Promise.all([
    fetchNasaUv(lat, lon, NASA_UV_START_YEAR, endYear).catch(() => []),
    fetchOpenMeteoUv(lat, lon, endDate),
  ]);
  const whoWithSource = who.map((row) => ({ ...row, source: "open_meteo_who" }));
  const factors = uvCalibrationFactorsFromSources(nasa, whoWithSource);
  const merged = mergeUvSeries(nasa, whoWithSource);
  return applyUvCalibration(merged, factors);
}

// Year-over-year percent change. UV only — temperature uses degree anomalies
// (yoy_delta) because °C is an interval scale where percentages are meaningless.
function safeYoyPct(curr, prev, metric, currSource, prevSource) {
  if (metric !== "uv") return null;
  if (curr == null || prev == null || Number.isNaN(curr) || Number.isNaN(prev)) return null;
  if (currSource && prevSource && currSource !== prevSource) return null;
  if (prev < MIN_UV_BASE || prev <= 0) return null;
  return ((curr - prev) / prev) * 100;
}

function yoyDelta(curr, prev) {
  if (curr == null || prev == null || Number.isNaN(curr) || Number.isNaN(prev)) return null;
  return curr - prev;
}

function addYoy(records, metric = "temperature") {
  return records.map((row, index) => {
    if (index < 12) return { ...row, yoy_pct: null, yoy_delta: null };
    const prev = records[index - 12];
    return {
      ...row,
      yoy_pct: safeYoyPct(row.value, prev.value, metric, row.source, prev.source),
      yoy_delta: yoyDelta(row.value, prev.value),
    };
  });
}

function seriesToRecords(records) {
  return records.map((row) => {
    const out = {
      date: row.date,
      value: Number(row.value.toFixed(4)),
      yoy_pct: row.yoy_pct == null || Number.isNaN(row.yoy_pct) ? null : Number(row.yoy_pct.toFixed(4)),
    };
    if (row.yoy_delta != null && !Number.isNaN(row.yoy_delta)) {
      out.yoy_delta = Number(row.yoy_delta.toFixed(4));
    }
    if (row.value_raw != null) out.value_raw = Number(row.value_raw.toFixed(4));
    if (row.source) out.source = row.source;
    return out;
  });
}

function annualMeans(records, source = null) {
  const buckets = new Map();
  for (const row of records) {
    if (source != null && row.source !== source) continue;
    if (row.value == null) continue;
    const year = Number(row.date.slice(0, 4));
    const b = buckets.get(year) || { sum: 0, count: 0 };
    b.sum += row.value;
    b.count += 1;
    buckets.set(year, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, b]) => ({ year, mean: b.sum / b.count }));
}

function linearSlopePerYear(annual) {
  if (annual.length < 3) return null;
  const xs = annual.map((a) => a.year);
  const ys = annual.map((a) => a.mean);
  const xm = xs.reduce((s, v) => s + v, 0) / xs.length;
  const ym = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - xm) * (ys[i] - ym);
    den += (xs[i] - xm) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function computeTrend(records, metric, { allSources = false } = {}) {
  if (!records.length) return null;
  let source = null;
  let confident = true;
  if (metric === "uv" && !allSources) {
    let bestSpan = -1;
    const sources = [...new Set(records.map((r) => r.source).filter(Boolean))];
    for (const src of sources) {
      const annual = annualMeans(records, src);
      const span = annual.length ? annual[annual.length - 1].year - annual[0].year : -1;
      if (span > bestSpan) {
        bestSpan = span;
        source = src;
      }
    }
    confident = bestSpan >= 10;
  }
  const annual = annualMeans(records, allSources ? null : source);
  if (annual.length < 3) return null;
  const slope = linearSlopePerYear(annual);
  if (slope == null) return null;

  const spanYears = annual[annual.length - 1].year - annual[0].year;
  const window = Math.min(10, annual.length);
  const baseline = annual.slice(0, window).reduce((s, a) => s + a.mean, 0) / window;
  const recent = annual.slice(-window).reduce((s, a) => s + a.mean, 0) / window;
  const round4 = (v) => Number(v.toFixed(4));

  return {
    per_decade: round4(slope * 10),
    total: round4(slope * spanYears),
    baseline: round4(baseline),
    recent: round4(recent),
    baseline_period: `${annual[0].year}-${annual[window - 1].year}`,
    recent_period: `${annual[annual.length - window].year}-${annual[annual.length - 1].year}`,
    unit: metric === "temperature" ? "degC" : "uv",
    source_window: `${annual[0].year}-${annual[annual.length - 1].year}`,
    source: allSources ? null : source,
    confident: allSources ? false : (confident && spanYears >= 10),
    indicative: allSources,
  };
}

export function computeIndicativeUvTrend(records) {
  return computeTrend(records, "uv", { allSources: true });
}

function trendSpanYears(trend) {
  const match = trend?.source_window?.match(/^(\d{4})-(\d{4})$/);
  if (!match) return 0;
  return Number(match[2]) - Number(match[1]);
}

/** Best UV trend to show: confident single-source, else long indicative, else short record. */
export function resolveUvDisplayTrend(records, summary = {}) {
  if (!records?.length) return null;
  const single = summary.trend || computeTrend(records, "uv");
  const indicative = summary.indicative_trend || computeTrend(records, "uv", { allSources: true });

  if (single?.confident !== false) return single;
  if (indicative && trendSpanYears(indicative) >= 10) {
    return { ...indicative, _display: "indicative" };
  }
  if (single && trendSpanYears(single) >= 3) {
    return { ...single, _display: "short" };
  }
  if (indicative && trendSpanYears(indicative) >= 3) {
    return { ...indicative, _display: "short" };
  }
  return indicative || single;
}

function computeSummary(records, metric) {
  const values = records.map((r) => r.value).filter((v) => v != null);
  if (!values.length) return {};
  const start = values[0];
  const end = values[values.length - 1];
  const lastDate = records[records.length - 1].date;
  const monthStr = lastDate.split("-")[1];
  const sameMonth = records.filter((r) => r.date.endsWith(`-${monthStr}`));
  const smStart = sameMonth.length >= 2 ? sameMonth[0].value : start;
  const smEnd = sameMonth.length >= 2 ? sameMonth[sameMonth.length - 1].value : end;

  const seasonal = {};
  for (const row of records) {
    const month = row.date.split("-")[1];
    seasonal[month] = seasonal[month] || { sum: 0, count: 0 };
    seasonal[month].sum += row.value;
    seasonal[month].count += 1;
  }
  const round4 = (v) => Number(v.toFixed(4));

  const summary = {
    min: round4(Math.min(...values)),
    max: round4(Math.max(...values)),
    start_value: round4(start),
    end_value: round4(end),
    seasonal_baseline: Object.fromEntries(
      Object.entries(seasonal).map(([month, agg]) => [month, round4(agg.sum / agg.count)])
    ),
    trend: computeTrend(records, metric),
  };

  if (metric === "uv" && summary.trend?.confident === false) {
    const indicative = computeTrend(records, metric, { allSources: true });
    if (indicative) summary.indicative_trend = indicative;
  }

  if (metric === "uv") {
    const yoy = records.map((r) => r.yoy_pct).filter((v) => v != null);
    summary.avg_yoy_pct = yoy.length ? round4(yoy.reduce((a, b) => a + b, 0) / yoy.length) : null;
    summary.change_1993_to_2026_pct = smStart ? round4(((smEnd - smStart) / smStart) * 100) : null;
  } else {
    const delta = records.map((r) => r.yoy_delta).filter((v) => v != null);
    summary.avg_yoy_delta = delta.length ? round4(delta.reduce((a, b) => a + b, 0) / delta.length) : null;
    summary.change_delta = round4(smEnd - smStart);
  }
  return summary;
}

export async function fetchCityGraphEntry(city) {
  const endDate = lastCompleteDate();
  const [temperature, uv] = await Promise.all([
    fetchOpenMeteoTemperature(city.lat, city.lon, endDate),
    fetchCombinedUv(city.lat, city.lon, endDate),
  ]);

  if (!temperature.length) throw new Error("No temperature data returned for this location.");

  const tempRecords = addYoy(temperature, "temperature");
  const uvRecords = addYoy(uv, "uv");
  const periodStart = tempRecords[0].date;
  const periodEnd = tempRecords[tempRecords.length - 1].date;

  return {
    id: city.id,
    name: cityLabel(city),
    lat: city.lat,
    lon: city.lon,
    data_version: DATA_VERSION,
    series: {
      temperature: seriesToRecords(tempRecords),
      uv: seriesToRecords(uvRecords),
    },
    summary: {
      temperature: computeSummary(tempRecords, "temperature"),
      uv: computeSummary(uvRecords, "uv"),
    },
    period: { start: periodStart, end: periodEnd },
    sources: {
      temperature: "open_meteo_era5",
      uv: "nasa_power+open_meteo_who",
    },
  };
}

export async function ensureCityDataLoaded(state, cityId) {
  if (state.graph.cities[cityId]?.series?.temperature?.length) {
    state.loadedCities.add(cityId);
    return state.graph.cities[cityId];
  }
  if (state.loadingCities.has(cityId)) {
    return null;
  }

  state.loadingCities.add(cityId);
  try {
    const bundle = loadCustomCities();
    if (bundle.graphEntries[cityId]) {
      const entry = bundle.graphEntries[cityId];
      if ((entry.data_version || 0) < DATA_VERSION) {
        const cityMeta = state.citiesConfig.cities.find((c) => c.id === cityId);
        if (cityMeta) {
          const refreshed = await fetchCityGraphEntry(cityMeta);
          bundle.graphEntries[cityId] = refreshed;
          saveCustomCities(bundle);
          state.graph.cities[cityId] = refreshed;
          state.loadedCities.add(cityId);
          return refreshed;
        }
      }
      state.graph.cities[cityId] = entry;
      state.loadedCities.add(cityId);
      return entry;
    }

    if (isBuiltInCity(cityId)) {
      const res = await fetch(`data/cities/${cityId}.json`);
      if (!res.ok) throw new Error(`Could not load data for ${cityId}`);
      const entry = await res.json();
      state.graph.cities[cityId] = entry;
      state.loadedCities.add(cityId);
      return entry;
    }

    const cityMeta = state.citiesConfig.cities.find((c) => c.id === cityId);
    if (!cityMeta) throw new Error(`Unknown city: ${cityId}`);
    const entry = await fetchCityGraphEntry(cityMeta);
    state.graph.cities[cityId] = entry;
    state.loadedCities.add(cityId);
    return entry;
  } finally {
    state.loadingCities.delete(cityId);
  }
}

/** Add a resolved city (built-in or brand-new) to state, fetch its data if needed,
 * and optionally select it. Used by the conversational query + location flows. */
export async function addCityByMeta(state, meta, { select = true } = {}) {
  const known = builtInCityIds.has(meta.id) || state.citiesConfig.cities.some((c) => c.id === meta.id);
  if (!state.citiesConfig.cities.some((c) => c.id === meta.id)) {
    state.citiesConfig.cities.push(meta);
  }
  if (!state.graph.nodes.some((n) => n.id === `loc:${meta.id}`)) {
    state.graph.nodes.push({ id: `loc:${meta.id}`, type: "Place", label: cityLabel(meta) });
  }
  unhideCity(meta.id);
  if (select) state.selected.add(meta.id);

  if (known) {
    await ensureCityDataLoaded(state, meta.id);
    return meta.id;
  }

  const entry = await fetchCityGraphEntry(meta);
  saveCustomCityGraph(meta, entry);
  state.graph.cities[meta.id] = entry;
  state.loadedCities.add(meta.id);
  return meta.id;
}

export function saveCustomCityGraph(city, graphEntry) {
  const bundle = loadCustomCities();
  bundle.cities = bundle.cities.filter((c) => c.id !== city.id);
  bundle.cities.push(city);
  bundle.graphEntries[city.id] = graphEntry;
  saveCustomCities(bundle);
}

function makeCityId(result) {
  const region = result.admin1 ? result.admin1.split(" ").pop() : result.country_code;
  return `${slugify(result.name)}-${slugify(region || result.country_code || "city")}`.replace(/--+/g, "-");
}

function formatSuggestion(result) {
  const region = result.admin1 || result.country || "";
  const country = result.country_code ? `, ${result.country_code}` : "";
  return `${region}${country}`.replace(/^, /, "");
}

export function initCityAdd(state, { onAdded, onDuplicate, onUseLocation, showToast, ensureCityData }) {
  const btn = document.getElementById("city-add-btn");
  const panel = document.getElementById("city-add-panel");
  const input = document.getElementById("city-search");
  const locateBtn = document.getElementById("city-locate-btn");
  const list = document.getElementById("city-suggestions");
  const status = document.getElementById("city-add-status");
  if (!btn || !panel || !input || !list || !status) return;

  const setStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle("error", isError);
  };

  const closePanel = () => {
    panel.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    list.classList.add("hidden");
    list.innerHTML = "";
    input.value = "";
    setStatus("");
  };

  btn.addEventListener("click", () => {
    const open = panel.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    if (!open) input.focus();
    else closePanel();
  });

  async function addCityFromResult(result) {
    const city = {
      id: makeCityId(result),
      name: result.name,
      region: result.admin1 || "",
      country: result.country_code || "",
      lat: Number(result.latitude.toFixed(4)),
      lon: Number(result.longitude.toFixed(4)),
    };

    const hidden = loadHiddenCities();
    if (hidden.has(city.id)) {
      unhideCity(city.id);
      closePanel();
      onDuplicate?.({ id: city.id, name: city.name, region: city.region });
      return;
    }

    const duplicate = existingCityMatch(state, city);
    if (duplicate) {
      closePanel();
      onDuplicate?.(duplicate);
      return;
    }
    if (state.citiesConfig.cities.length >= 100) {
      setStatus("Too many custom cities saved in this browser.", true);
      return;
    }

    try {
      state.citiesConfig.cities.push(city);
      if (!state.graph.nodes.some((n) => n.id === `loc:${city.id}`)) {
        state.graph.nodes.push({ id: `loc:${city.id}`, type: "Place", label: cityLabel(city) });
      }

      const autoSelected = state.selected.size < MAX_SELECTED;
      if (autoSelected) state.selected.add(city.id);

      closePanel();
      onAdded?.(city, { loading: true });

      const graphEntry = await fetchCityGraphEntry(city);
      saveCustomCityGraph(city, graphEntry);
      state.graph.cities[city.id] = graphEntry;
      state.loadedCities.add(city.id);

      onAdded?.(city, { loading: false });
      if (!autoSelected) {
        showToast?.(`Added ${cityLabel(city)}. Uncheck a city to compare it (max ${MAX_SELECTED}).`);
      }
    } catch (err) {
      state.citiesConfig.cities = state.citiesConfig.cities.filter((c) => c.id !== city.id);
      state.graph.nodes = state.graph.nodes.filter((n) => n.id !== `loc:${city.id}`);
      state.selected.delete(city.id);
      setStatus(err.message, true);
    }
  }

  async function selectSuggestion(result) {
    await addCityFromResult(result);
  }

  if (locateBtn) {
    locateBtn.addEventListener("click", async () => {
      if (onUseLocation) {
        closePanel();
        await onUseLocation();
        return;
      }
      if (!navigator.geolocation) {
        setStatus("Location is not supported in this browser.", true);
        return;
      }
      setStatus("Getting your location…");
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          try {
            const { latitude, longitude } = position.coords;
            const geoResult = await reverseGeocode(latitude, longitude);
            input.value = geoResult.name;
            await addCityFromResult(geoResult);
          } catch (err) {
            setStatus(err.message, true);
          }
        },
        (err) => {
          const messages = {
            1: "Location permission denied. Allow location access or search by name.",
            2: "Could not determine your position. Try again or search by name.",
            3: "Location request timed out. Try again or search by name.",
          };
          setStatus(messages[err.code] || "Could not use your location.", true);
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
      );
    });
  }

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      list.classList.add("hidden");
      list.innerHTML = "";
      setStatus("");
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        setStatus("Searching…");
        const results = await searchCities(q);
        list.innerHTML = "";
        if (!results.length) {
          list.classList.add("hidden");
          setStatus("No matching cities found.");
          return;
        }
        for (const geoResult of results) {
          const previewCity = {
            id: makeCityId(geoResult),
            name: geoResult.name,
            region: geoResult.admin1 || "",
          };
          const already = existingCityMatch(state, previewCity, { includeHidden: true });
          const li = document.createElement("li");
          const badge = already ? '<span class="city-suggestion-badge">In list</span>' : "";
          li.innerHTML =
            `<button type="button"><strong>${geoResult.name}</strong><span>${formatSuggestion(geoResult)}</span>${badge}</button>`;
          li.querySelector("button").addEventListener("click", () => selectSuggestion(geoResult));
          list.appendChild(li);
        }
        list.classList.remove("hidden");
        setStatus("Pick a city from the suggestions.");
      } catch (err) {
        setStatus(err.message, true);
      }
    }, 250);
  });
}
