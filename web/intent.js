// Deterministic, offline client-side parser that turns a free-text question into
// dashboard state: { metric, chartView, cityQueries[], periodStart, periodEnd }.
// No API keys, no LLM — keyword + proper-noun heuristics. Structured so an LLM
// backend could replace parseQuery later without touching the UI.

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Words that look like proper nouns but are not cities.
const CITY_STOPWORDS = new Set([
  "can", "could", "would", "please", "show", "plot", "graph", "chart", "make", "give",
  "display", "view", "i", "uv", "uvi", "the", "a", "an", "how", "what", "is", "are",
  "compare", "comparison", "temperature", "temp", "heat", "climate", "warming",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "today", "now", "present",
  "year", "month", "monthly", "yearly", "since", "from", "over", "to", "and", "vs",
]);

function monthIndex(token) {
  const t = token.toLowerCase().replace(/\.$/, "");
  let idx = MONTHS.indexOf(t);
  if (idx >= 0) return idx + 1;
  idx = MONTH_ABBR.indexOf(t);
  return idx >= 0 ? idx + 1 : null;
}

function clampMonth(ym, min, max) {
  if (min && ym < min) return min;
  if (max && ym > max) return max;
  return ym;
}

function detectMetric(q) {
  const hasUv = /\buv\b|ultra[-\s]?violet|\buvi\b|sunburn|sunlight/.test(q);
  const hasTemp = /temp(erature)?|heat|hot|warm|cool|cold|degrees?|warming|climate/.test(q);
  if (hasUv && !hasTemp) return "uv";
  if (hasTemp && !hasUv) return "temperature";
  if (hasUv && hasTemp) return "uv";
  return null;
}

function detectView(q) {
  if (/year[-\s]?over[-\s]?year|\byoy\b|percent|year of year|% ?change/.test(q)) return "yoy-pct";
  if (/same month|month across years|each (january|february|march|april|may|june|july|august|september|october|november|december)/.test(q)) {
    return "yoy-month";
  }
  if (/month[-\s]?by[-\s]?month|monthly|timeline|over time|history|historical|\btrend/.test(q)) return "timeline";
  return null;
}

function detectDates(query, { periodMin, periodMax }) {
  const points = [];
  let work = query;

  // "Month YYYY"
  const monthYear = /\b([a-z]+)\.?\s+((?:19|20)\d{2})\b/gi;
  let m;
  while ((m = monthYear.exec(query)) !== null) {
    const mi = monthIndex(m[1]);
    if (mi) {
      points.push({ ym: `${m[2]}-${String(mi).padStart(2, "0")}`, hasMonth: true });
      work = work.replace(m[0], " ");
    }
  }

  // bare years (not already captured with a month)
  const yearRe = /\b((?:19|20)\d{2})\b/g;
  while ((m = yearRe.exec(work)) !== null) {
    points.push({ year: m[1], hasMonth: false });
  }

  if (!points.length) return { periodStart: null, periodEnd: null };

  const ymStart = (p) => (p.hasMonth ? p.ym : `${p.year}-01`);
  const ymEnd = (p) => (p.hasMonth ? p.ym : `${p.year}-12`);
  points.sort((a, b) => ymStart(a).localeCompare(ymStart(b)));

  const q = query.toLowerCase();
  const wantsTodayEnd = /\b(today|now|present|to date|current|onward|ongoing)\b/.test(q);
  const openStart = /\b(from|since|after|starting|beginning)\b/.test(q);

  let periodStart = clampMonth(ymStart(points[0]), periodMin, periodMax);
  let periodEnd;
  if (wantsTodayEnd || (points.length === 1 && openStart)) {
    periodEnd = periodMax || ymEnd(points[points.length - 1]);
  } else {
    periodEnd = ymEnd(points[points.length - 1]);
  }
  periodEnd = clampMonth(periodEnd, periodMin, periodMax);
  if (periodStart > periodEnd) [periodStart, periodEnd] = [periodEnd, periodStart];
  return { periodStart, periodEnd };
}

function isCityStop(word) {
  const w = word.replace(/[.,]/g, "").toLowerCase();
  return !w || CITY_STOPWORDS.has(w) || monthIndex(w) != null;
}

function detectCities(query) {
  const normalized = query.replace(/\bversus\b|\bvs\.?\b/gi, " and ");
  const properNoun = /([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)*(?:,\s*[A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)*)?)/g;
  const seen = new Set();
  const cities = [];
  let m;
  while ((m = properNoun.exec(normalized)) !== null) {
    const words = m[1].trim().split(/\s+/);
    // Drop leading non-city words (e.g. "Is", "Can"), then keep the contiguous
    // run of city words until the next stopword (e.g. "Seattle UV" -> "Seattle").
    let start = 0;
    while (start < words.length && isCityStop(words[start])) start += 1;
    const kept = [];
    for (let i = start; i < words.length; i += 1) {
      if (isCityStop(words[i])) break;
      kept.push(words[i]);
    }
    if (!kept.length) continue;
    // Geocode on the city name (drop trailing ", State").
    const name = kept.join(" ").split(",")[0].trim();
    const key = name.toLowerCase();
    if (name.length < 2 || seen.has(key)) continue;
    seen.add(key);
    cities.push(name);
  }
  return cities.slice(0, 5);
}

export function parseQuery(rawQuery, options = {}) {
  const query = (rawQuery || "").trim();
  const q = query.toLowerCase();
  const dates = detectDates(query, options);
  return {
    raw: query,
    metric: detectMetric(q),
    chartView: detectView(q),
    cityQueries: detectCities(query),
    periodStart: dates.periodStart,
    periodEnd: dates.periodEnd,
  };
}

/** Human-readable echo of what the parser understood, for the UI. */
export function describeIntent(intent, { cityLabels = [] } = {}) {
  const parts = [];
  if (cityLabels.length) parts.push(cityLabels.join(" vs "));
  if (intent.metric) parts.push(intent.metric === "uv" ? "UV index" : "temperature");
  if (intent.periodStart && intent.periodEnd) parts.push(`${intent.periodStart} → ${intent.periodEnd}`);
  const viewNames = { timeline: "month-by-month", "yoy-month": "same month across years", "yoy-pct": "year-over-year change" };
  if (intent.chartView) parts.push(viewNames[intent.chartView]);
  return parts.join(" · ");
}
