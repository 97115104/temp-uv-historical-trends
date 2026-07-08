const UV_RISK = [
  { max: 2, label: "Low", note: "minimal protection needed for most people" },
  { max: 5, label: "Moderate", note: "sun protection recommended from late morning through afternoon" },
  { max: 7, label: "High", note: "shade, clothing, and SPF recommended around solar noon" },
  { max: 10, label: "Very High", note: "limit direct sun during peak hours" },
  { max: Infinity, label: "Extreme", note: "avoid prolonged midday exposure" },
];

const DOMAIN_GUIDE = {
  uv: {
    metric: "UV Index (WHO scale; pre-2021 NASA adjusted for continuity)",
    source: "NASA POWER (2001–2020, calibrated) + Open-Meteo WHO peaks (2021+)",
    coverage: "UV from 2001: NASA monthly means scaled to WHO peak scale; from 2021 onward WHO monthly peaks (Apple-comparable).",
    readTimeline:
      "The timeline shows seasonal peaks in late spring–summer and lows in winter. Compare the latest point to the city's long-run monthly average for that calendar month.",
    readYoy:
      "Year-over-year % change compares each month to the same month one year earlier. Small swings (±5%) are common; sustained positive or negative runs suggest a shift.",
    readYoyMonth:
      "Same-month across years isolates one calendar month so you can see whether, e.g., recent Julys are higher than Julys in the 1990s.",
  },
  temperature: {
    metric: "2 m air temperature (monthly mean °C from ERA5 reanalysis)",
    source: "Open-Meteo ERA5 archive",
    coverage: "Temperature spans January 1981 through the latest complete month (~5–7 day ERA5 lag).",
    readTimeline:
      "Monthly means smooth out day-to-day weather. Look for winter lows and summer highs, and whether the latest reading sits above or below the city's typical value for that month.",
    readYoy:
      "Year-over-year change shows how much warmer or cooler each month is versus the same month one year earlier (in °F/°C). Typical swings are a few degrees; double-digit changes are unusual for monthly means.",
    readYoyMonth:
      "Filtering to one month removes seasonal mixing—useful for asking 'are Augusts getting warmer here?'",
  },
};

function trendWord(pct) {
  if (pct == null || Number.isNaN(pct)) return "changed";
  if (pct > 1) return "increased";
  if (pct < -1) return "decreased";
  return "stayed roughly flat";
}

function uvRiskBand(value) {
  if (value == null || Number.isNaN(value)) return null;
  return UV_RISK.find((band) => value <= band.max) || UV_RISK[UV_RISK.length - 1];
}

function monthFromDate(dateStr) {
  return parseInt(dateStr?.split("-")[1] || "1", 10);
}

function getSeasonalBaseline(cityGraph, metric, month) {
  const baseline = cityGraph?.summary?.[metric]?.seasonal_baseline;
  if (!baseline) return null;
  return baseline[String(month)] ?? baseline[month] ?? null;
}

function peakTroughMonths(seasonal) {
  if (!seasonal) return { peak: null, trough: null };
  const entries = Object.entries(seasonal).map(([m, v]) => ({ month: parseInt(m, 10), value: v }));
  if (!entries.length) return { peak: null, trough: null };
  const peak = entries.reduce((a, b) => (b.value > a.value ? b : a));
  const trough = entries.reduce((a, b) => (b.value < a.value ? b : a));
  return { peak, trough };
}

function deviationPct(actual, baseline) {
  if (actual == null || baseline == null || baseline === 0) return null;
  return ((actual - baseline) / baseline) * 100;
}

function findComparisonDeltas(graph, cityIds, metric) {
  const selected = new Set(cityIds);
  const deltas = [];
  for (const edge of graph?.edges || []) {
    if (edge.type !== "comparedWith" || edge.metric !== metric) continue;
    const from = edge.from?.replace("loc:", "");
    const to = edge.to?.replace("loc:", "");
    if (!selected.has(from) || !selected.has(to)) continue;
    deltas.push({ from, to, delta: edge.delta_pct_1993_2026 });
  }
  return deltas;
}

function getCityLongSummary(cityGraph, metric) {
  return cityGraph?.summary?.[metric] || {};
}

function recentTrend(series, n = 12) {
  const tail = series.slice(-n).map((p) => p.value).filter((v) => v != null);
  if (tail.length < 3) return null;
  const first = tail[0];
  const last = tail[tail.length - 1];
  const change = first !== 0 ? ((last - first) / first) * 100 : null;
  const yoyTail = series.slice(-n).map((p) => p.yoy_pct).filter((v) => v != null);
  return {
    months: tail.length,
    change_pct: change,
    avg_yoy: yoyTail.length ? yoyTail.reduce((s, v) => s + v, 0) / yoyTail.length : null,
    latest: last,
    start: first,
  };
}

function buildFacts(ctx) {
  const {
    metric,
    tempUnit,
    chartView,
    periodStart,
    periodEnd,
    calendarMonth,
    cities,
    metricLabel,
  } = ctx;

  const unit = metric === "temperature" ? `°${tempUnit}` : "";
  const fmtVal = (v) => ctx.formatMetricValue(v);
  const fmtPct = (v) => ctx.fmt(v);

  const cityFacts = cities
    .map(({ id, label, color, summary: s, graph }) => ({
      id,
      label,
      color,
      graph,
      ...s,
      displayLatest:
        metric === "temperature" ? `${fmtVal(s.latest_value)}${unit}` : fmtVal(s.latest_value),
      displayMin: metric === "temperature" ? `${fmtVal(s.min)}${unit}` : fmtVal(s.min),
      displayMax: metric === "temperature" ? `${fmtVal(s.max)}${unit}` : fmtVal(s.max),
    }))
    .filter((c) => !c.empty);

  let hottest = null;
  let coldest = null;
  if (chartView !== "yoy-pct" && cityFacts.length) {
    hottest = cityFacts.reduce((best, c) => (!best || c.max > best.max ? c : best), null);
    coldest = cityFacts.reduce((best, c) => (!best || c.min < best.min ? c : best), null);
  }

  const comparisons = [];
  for (let i = 0; i < cityFacts.length; i++) {
    for (let j = i + 1; j < cityFacts.length; j++) {
      const a = cityFacts[i];
      const b = cityFacts[j];
      const delta =
        chartView === "yoy-pct"
          ? (a.avg_yoy_pct ?? 0) - (b.avg_yoy_pct ?? 0)
          : (a.change_pct ?? 0) - (b.change_pct ?? 0);
      comparisons.push({ a: a.label, b: b.label, delta });
    }
  }

  return {
    cityFacts,
    hottest,
    coldest,
    comparisons,
    unit,
    metric,
    chartView,
    periodStart,
    periodEnd,
    calendarMonth,
    metricLabel,
    fmtPct,
    fmtVal,
  };
}

function buildKnowledgeChunks(ctx, facts) {
  const { metric, chartView, calendarMonth, graph } = ctx;
  const guide = DOMAIN_GUIDE[metric];
  const chunks = [];

  chunks.push({
    id: "guide-metric",
    score: 10,
    text: `${guide.metric} from ${guide.source}. ${guide.coverage}`,
  });

  if (chartView === "timeline") chunks.push({ id: "guide-view", score: 9, text: guide.readTimeline });
  else if (chartView === "yoy-pct") chunks.push({ id: "guide-view", score: 9, text: guide.readYoy });
  else chunks.push({ id: "guide-view", score: 9, text: guide.readYoyMonth });

  for (const city of facts.cityFacts) {
    const long = getCityLongSummary(city.graph, metric);
    const seasonal = long.seasonal_baseline;
    const { peak, trough } = peakTroughMonths(seasonal);
    const focusMonth = chartView === "yoy-month" ? calendarMonth : monthFromDate(city.latest_date);
    const baseline = getSeasonalBaseline(city.graph, metric, focusMonth);
    const latestRaw = city.latest_value;
    const vsSeason = deviationPct(latestRaw, baseline);
    const series = ctx.getSeries?.(city.id, metric) || [];

    if (long.change_1993_to_2026_pct != null) {
      const verb = metric === "uv" ? "UV levels shifted" : "temperature shifted";
      chunks.push({
        id: `${city.id}-longterm`,
        score: 8,
        text: `${city.label} ${verb} ${facts.fmtPct(long.change_1993_to_2026_pct)}% from the first record through the latest month in the full series.`,
      });
    }

    if (peak && trough) {
      chunks.push({
        id: `${city.id}-seasonal`,
        score: 7,
        text: `${city.label} typical seasonal pattern: highest in ${ctx.monthName(peak.month)} (avg ${facts.fmtVal(peak.value)}), lowest in ${ctx.monthName(trough.month)} (avg ${facts.fmtVal(trough.value)}).`,
      });
    }

    if (baseline != null && latestRaw != null && chartView !== "yoy-pct") {
      const dir = vsSeason > 2 ? "above" : vsSeason < -2 ? "below" : "near";
      chunks.push({
        id: `${city.id}-vs-norm`,
        score: chartView === "yoy-month" ? 11 : 9,
        text: `Latest ${ctx.monthName(focusMonth)} for ${city.label} is ${city.displayLatest}, ${dir} the city's long-run ${ctx.monthName(focusMonth)} average (${facts.fmtVal(baseline)}${facts.unit ? facts.unit : ""}${vsSeason != null ? `, ${facts.fmtPct(vsSeason)}% vs norm` : ""}).`,
      });
    }

    if (metric === "uv" && latestRaw != null) {
      const band = uvRiskBand(latestRaw);
      if (band) {
        chunks.push({
          id: `${city.id}-uv-risk`,
          score: 6,
          text: `UV index ${facts.fmtVal(latestRaw)} is in the ${band.label} exposure band for monthly means—${band.note}.`,
        });
      }
    }

    const recent = recentTrend(series);
    if (recent?.change_pct != null && chartView === "timeline") {
      chunks.push({
        id: `${city.id}-recent`,
        score: 8,
        text: `Over the last ${recent.months} months in your selected range, ${city.label} ${trendWord(recent.change_pct)} ${facts.fmtPct(Math.abs(recent.change_pct))}% (avg YoY in that window: ${facts.fmtPct(recent.avg_yoy)}%).`,
      });
    }

    if (chartView === "yoy-pct" && city.avg_yoy_pct != null) {
      const stability =
        Math.abs(city.avg_yoy_pct) < 1
          ? "near-zero average YoY—mostly year-to-year noise"
          : city.avg_yoy_pct > 0
            ? "positive average YoY—recent years tend to run higher than the prior year"
            : "negative average YoY—recent years tend to run lower than the prior year";
      chunks.push({
        id: `${city.id}-yoy-character`,
        score: 10,
        text: `${city.label} YoY averages ${facts.fmtPct(city.avg_yoy_pct)}% with a chart-visible spread of ${facts.fmtPct(city.min)}% to ${facts.fmtPct(city.max)}%—${stability}.`,
      });
    }
  }

  const cityIds = facts.cityFacts.map((c) => c.id);
  const graphDeltas = findComparisonDeltas(graph, cityIds, metric);
  for (const { from, to, delta } of graphDeltas) {
    const fromLabel = facts.cityFacts.find((c) => c.id === from)?.label || from;
    const toLabel = facts.cityFacts.find((c) => c.id === to)?.label || to;
    const leader = delta > 0 ? fromLabel : toLabel;
    const verb = metric === "uv" ? "higher cumulative UV change" : "more warming";
    chunks.push({
      id: `cmp-${from}-${to}`,
      score: cityIds.length > 1 ? 9 : 4,
      text: `Over each city's full record, ${leader} shows ${verb} versus ${delta > 0 ? toLabel : fromLabel} (long-run gap ${facts.fmtPct(Math.abs(delta))}%).`,
    });
  }

  if (facts.comparisons.length && facts.cityFacts.length > 1) {
    const top = [...facts.comparisons].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))[0];
    if (top && Math.abs(top.delta) > 0.5) {
      const leader = top.delta > 0 ? top.a : top.b;
      chunks.push({
        id: "view-comparison",
        score: 10,
        text: `In the current view and date range, ${leader} shows the largest relative move versus the other selected cities (Δ ${facts.fmtPct(Math.abs(top.delta))}%).`,
      });
    }
  }

  return chunks;
}

function retrieveChunks(chunks, limit = 6) {
  return [...chunks]
    .sort((a, b) => b.score - a.score)
    .filter((chunk, idx, arr) => arr.findIndex((c) => c.id === chunk.id) === idx)
    .slice(0, limit);
}

function pickCityExtremes(cityFacts, facts, ctx) {
  if (cityFacts.length < 2) return null;

  const { chartView, metric } = facts;
  const rankKey =
    chartView === "yoy-pct"
      ? "avg_yoy_pct"
      : "latest_value";

  const scored = cityFacts
    .filter((c) => c[rankKey] != null && !Number.isNaN(c[rankKey]))
    .map((c) => ({ city: c, value: c[rankKey] }));

  if (!scored.length) return null;

  const rankHighFirst =
    metric === "uv" ||
    (metric === "temperature" && chartView !== "yoy-pct");

  if (chartView === "yoy-pct" && metric === "temperature") {
    scored.sort((a, b) => Math.abs(a.value) - Math.abs(b.value));
  } else {
    scored.sort((a, b) => (rankHighFirst ? b.value - a.value : a.value - b.value));
  }

  const high = scored[0];
  const low = scored[scored.length - 1];

  let highLabel;
  let lowLabel;
  if (chartView === "yoy-pct") {
    if (metric === "uv") {
      highLabel = "largest average UV YoY increase";
      lowLabel = "smallest average UV YoY change";
    } else {
      highLabel = "most stable year-over-year temperature";
      lowLabel = "most volatile year-over-year temperature";
    }
  } else if (metric === "uv") {
    highLabel = "highest UV";
    lowLabel = "lowest UV";
  } else if (chartView === "yoy-month") {
    const month = ctx.monthName(facts.calendarMonth);
    highLabel = `warmest ${month}`;
    lowLabel = `coolest ${month}`;
  } else {
    highLabel = "hottest latest reading";
    lowLabel = "coolest latest reading";
  }

  const stable = chartView === "yoy-pct"
    ? [...cityFacts]
        .filter((c) => c.min != null && c.max != null)
        .sort((a, b) => Math.abs(a.max - a.min) - Math.abs(b.max - b.min))[0]
    : [...cityFacts]
        .filter((c) => c.change_pct != null)
        .sort((a, b) => Math.abs(a.change_pct) - Math.abs(b.change_pct))[0];

  return { high, low, highLabel, lowLabel, stable };
}

function buildDataSummary(facts, ctx) {
  const { cityFacts, chartView, periodStart, periodEnd, calendarMonth, metricLabel } = facts;
  const range = `${ctx.formatMonthLabel(periodStart)} through ${ctx.formatMonthLabel(periodEnd)}`;
  const viewNote =
    chartView === "yoy-month"
      ? ` for ${ctx.monthName(calendarMonth)} across years`
      : chartView === "yoy-pct"
        ? " as year-over-year % change"
        : "";

  if (!cityFacts.length) {
    return "No data is available for the current filters, so try widening the date range or selecting different cities.";
  }

  if (cityFacts.length === 1) {
    const c = cityFacts[0];
    if (chartView === "yoy-pct") {
      const isTemp = facts.metric === "temperature";
      const unit = isTemp ? facts.unit : "%";
      const avgLine = isTemp
        ? `the average same-month change was ${facts.fmtVal(c.avg_yoy_pct)}${unit} versus the prior year`
        : `the average year-over-year change was ${facts.fmtPct(c.avg_yoy_pct)}%`;
      return [
        `For ${c.label}, ${metricLabel.toLowerCase()}${viewNote} from ${range}, ${avgLine}.`,
        isTemp
          ? `Values ranged from ${facts.fmtVal(c.min)}${unit} to ${facts.fmtVal(c.max)}${unit} warmer/cooler than the same month a year earlier.`
          : `Values in this window ranged from ${facts.fmtPct(c.min)}% to ${facts.fmtPct(c.max)}%.`,
        isTemp
          ? `The latest reading was ${facts.fmtVal(c.latest_yoy_pct ?? c.avg_yoy_pct)}${unit} as of ${ctx.formatMonthLabel(c.latest_date)}.`
          : `The latest YoY reading was ${facts.fmtPct(c.latest_yoy_pct ?? c.avg_yoy_pct)}% as of ${ctx.formatMonthLabel(c.latest_date)}.`,
      ].join(" ");
    }
    const latestLine =
      facts.metric === "temperature"
        ? `The warmest month was ${ctx.formatMonthLabel(c.max_date)} at ${c.displayMax}, and the coolest was ${ctx.formatMonthLabel(c.min_date)} at ${c.displayMin}.`
        : `Values in this window ranged from ${c.displayMin} to ${c.displayMax}.`;
    return [
      `${c.label} ${metricLabel.toLowerCase()}${viewNote} from ${range} ${trendWord(c.change_pct)} by ${facts.fmtPct(Math.abs(c.change_pct))}% over the selected period.`,
      `The latest reading is ${c.displayLatest} in ${ctx.formatMonthLabel(c.latest_date)}, with an average year-over-year change of ${facts.fmtPct(c.avg_yoy_pct)}%.`,
      latestLine,
    ].join(" ");
  }

  const extremes = pickCityExtremes(cityFacts, facts, ctx);
  const metricNoun = facts.metric === "uv" ? "UV index" : "temperature";

  if (chartView === "yoy-pct") {
    const isTemp = facts.metric === "temperature";
    const summaries = cityFacts
      .map((c) => isTemp
        ? `${c.label} averaged ${facts.fmtVal(c.avg_yoy_pct)}${facts.unit} YoY`
        : `${c.label} averaged ${facts.fmtPct(c.avg_yoy_pct)}% YoY`)
      .join(", ");
    const highSentence = extremes
      ? `${extremes.high.city.label} has the ${extremes.highLabel} among the selected cities at ${facts.fmtPct(extremes.high.value)}% average YoY.`
      : "";
    return [
      `Across ${cityFacts.length} cities, ${metricNoun}${viewNote} from ${range} compares as follows: ${summaries}.`,
      highSentence,
      extremes && extremes.low.city.id !== extremes.high.city.id
        ? `${extremes.low.city.label} has the ${extremes.lowLabel} at ${facts.fmtPct(extremes.low.value)}% average YoY.`
        : "",
      extremes?.stable
        ? isTemp
          ? `${extremes.stable.label} has the narrowest YoY swing (${facts.fmtVal(extremes.stable.min)}${facts.unit} to ${facts.fmtVal(extremes.stable.max)}${facts.unit}).`
          : `${extremes.stable.label} has the narrowest YoY range (${facts.fmtPct(extremes.stable.min)}% to ${facts.fmtPct(extremes.stable.max)}%).`
        : "Use the chart to see whether these year-over-year shifts are sustained trends or short-lived swings.",
    ]
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
  }

  const summaries = cityFacts
    .map((c) => `${c.label} ${trendWord(c.change_pct)} ${facts.fmtPct(Math.abs(c.change_pct))}% to ${c.displayLatest}`)
    .join(", ");

  const highSentence = extremes
    ? `${extremes.high.city.label} has the ${extremes.highLabel} among the selected cities at ${extremes.high.city.displayLatest}.`
    : "";

  const stableSentence = extremes?.stable
    ? chartView === "yoy-pct"
      ? `${extremes.stable.label} has the narrowest YoY range in this window (${facts.fmtPct(extremes.stable.min)}% to ${facts.fmtPct(extremes.stable.max)}%).`
      : `${extremes.stable.label} has the smallest overall swing in this window at ${facts.fmtPct(Math.abs(extremes.stable.change_pct))}%.`
    : facts.hottest && facts.coldest && facts.metric === "temperature"
      ? `${facts.hottest.label} recorded the warmest extreme (${facts.hottest.displayMax} in ${ctx.formatMonthLabel(facts.hottest.max_date)}), while ${facts.coldest.label} had the coolest (${facts.coldest.displayMin} in ${ctx.formatMonthLabel(facts.coldest.min_date)}).`
      : "";

  return [highSentence, `From ${range}, ${metricNoun}${viewNote} compares as follows: ${summaries}.`, stableSentence]
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

function takeSentences(text, max = 1) {
  return text
    .match(/[^.!?]+[.!?]+/g)
    ?.map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max) || [text.trim()];
}

function synthesizeInterpretation(retrieved, facts, ctx) {
  if (!retrieved.length || facts.cityFacts.length === 0) return "";

  const sentences = [];
  const extremes = pickCityExtremes(facts.cityFacts, facts, ctx);
  const viewComparison = retrieved.find((c) => c.id === "view-comparison");
  const seasonal = retrieved.find((c) => c.id.endsWith("-seasonal"));
  const howTo = retrieved.find((c) => c.id === "guide-view");

  if (extremes && facts.cityFacts.length > 1) {
    const lowCity = extremes.low.city.id !== extremes.high.city.id ? extremes.low.city.label : null;
    if (lowCity) {
      sentences.push(
        `${extremes.high.city.label} has the ${extremes.highLabel}, while ${lowCity} has the ${extremes.lowLabel}.`
      );
    }
  }

  if (viewComparison && sentences.length < 3) {
    sentences.push(...takeSentences(viewComparison.text, 1));
  } else if (seasonal && sentences.length < 3) {
    sentences.push(...takeSentences(seasonal.text, 1));
  }

  if (facts.metric === "uv" && ctx.chartView === "timeline" && sentences.length < 3) {
    sentences.push(
      "Pre-2021 UV uses NASA POWER monthly means adjusted to the WHO peak scale; from 2021 onward WHO monthly peaks apply the same 0–11+ categories as Apple Weather."
    );
  } else if (howTo && sentences.length < 3) {
    sentences.push(...takeSentences(howTo.text, 3 - sentences.length));
  }

  return sentences.filter(Boolean).slice(0, 3).join(" ");
}

export function buildInstantSummary(ctx) {
  const facts = buildFacts(ctx);
  return buildDataSummary(facts, ctx);
}

export async function generateSummary(ctx, { onUpdate } = {}) {
  const facts = buildFacts(ctx);
  const dataSummary = buildDataSummary(facts, ctx);
  onUpdate?.(dataSummary, "instant");

  const chunks = buildKnowledgeChunks(ctx, facts);
  const retrieved = retrieveChunks(chunks);
  const interpretation = synthesizeInterpretation(retrieved, facts, ctx);

  const full = interpretation
    ? `${dataSummary}\n\n${interpretation}`
    : dataSummary;

  onUpdate?.(full, "rag");
  return full;
}
