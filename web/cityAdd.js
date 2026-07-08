const CUSTOM_CITIES_KEY = "uv-trends-custom-cities";
const HIDDEN_CITIES_KEY = "uv-trends-hidden-cities";
const ERA5_START = "1981-01-01";
const UV_START = "2021-01-01";
const WHO_UV_START_MONTH = "2021-01";
const NASA_UV_START_YEAR = 2001;
const MAX_SELECTED = 5;
export const DATA_VERSION = 4;
const MIN_TEMP_BASE_C = 3.0;
const MIN_UV_BASE = 0.5;

const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const OPEN_METEO_HISTORICAL = "https://historical-forecast-api.open-meteo.com/v1/forecast";

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

async function reverseGeocode(lat, lon) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/reverse");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not look up your location.");
  const data = await res.json();
  const results = (data.results || []).filter((r) => r.feature_code?.startsWith("PPL") || (r.population || 0) > 0);
  if (!results.length) throw new Error("No city found near your location.");
  return rankGeocodeResults(results, results[0].name)[0];
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
  const url = new URL("/api/nasa-power", window.location.origin);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start", String(startYear));
  url.searchParams.set("end", String(endYear));
  const res = await fetch(url);
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

function uvCalibrationFactors(records) {
  const factors = {};
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, "0");
    const nasa = records.find((r) => r.date === `2020-${mm}` && r.source === "nasa_power");
    const who = records.find(
      (r) => r.date >= WHO_UV_START_MONTH && r.date.endsWith(`-${mm}`) && r.source === "open_meteo_who"
    );
    if (nasa && who && nasa.value > 0.01) {
      factors[month] = who.value / nasa.value;
    }
  }
  return factors;
}

function calibrateUvSeries(records) {
  const factors = uvCalibrationFactors(records);
  return applyUvCalibration(records, factors);
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

function safeYoyPct(curr, prev, metric, currSource, prevSource) {
  if (curr == null || prev == null || Number.isNaN(curr) || Number.isNaN(prev)) return null;
  if (metric === "uv" && currSource && prevSource && currSource !== prevSource) return null;
  if (metric === "temperature" && Math.abs(prev) < MIN_TEMP_BASE_C) return null;
  if (metric === "uv" && prev < MIN_UV_BASE) return null;
  if (prev <= 0) return null;
  const pct = ((curr - prev) / prev) * 100;
  if (metric === "temperature" && prev > 0 && pct < -100) return null;
  return pct;
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

function computeSummary(records) {
  const values = records.map((r) => r.value).filter((v) => v != null);
  if (!values.length) return {};
  const yoy = records.map((r) => r.yoy_pct).filter((v) => v != null);
  const start = values[0];
  const end = values[values.length - 1];
  const lastDate = records[records.length - 1].date;
  const monthStr = lastDate.split("-")[1];
  const sameMonth = records.filter((r) => r.date.endsWith(`-${monthStr}`));
  let changePct = null;
  if (sameMonth.length >= 2) {
    const smStart = sameMonth[0].value;
    const smEnd = sameMonth[sameMonth.length - 1].value;
    changePct = smStart ? Number((((smEnd - smStart) / smStart) * 100).toFixed(4)) : null;
  } else if (start) {
    changePct = Number((((end - start) / start) * 100).toFixed(4));
  }
  const seasonal = {};
  for (const row of records) {
    const month = row.date.split("-")[1];
    seasonal[month] = seasonal[month] || { sum: 0, count: 0 };
    seasonal[month].sum += row.value;
    seasonal[month].count += 1;
  }
  return {
    avg_yoy_pct: yoy.length ? Number((yoy.reduce((a, b) => a + b, 0) / yoy.length).toFixed(4)) : null,
    change_1993_to_2026_pct: changePct,
    min: Number(Math.min(...values).toFixed(4)),
    max: Number(Math.max(...values).toFixed(4)),
    start_value: Number(start.toFixed(4)),
    end_value: Number(end.toFixed(4)),
    seasonal_baseline: Object.fromEntries(
      Object.entries(seasonal).map(([month, agg]) => [month, Number((agg.sum / agg.count).toFixed(4))])
    ),
  };
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
      temperature: computeSummary(tempRecords),
      uv: computeSummary(uvRecords),
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

export function initCityAdd(state, { onAdded, onDuplicate, showToast, ensureCityData }) {
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
