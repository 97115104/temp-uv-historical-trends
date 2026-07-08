// Plain-language, Apple-style summary generator. Answers "has UV / temperature
// gotten worse over the decades here, or is it typical?" in one or two short
// sentences covering BOTH metrics. Temperature is always in degrees; UV in index
// points. Keep it tight and human — the charts hold the detail.

const UV_RISK = [
  { max: 2, label: "Low" },
  { max: 5, label: "Moderate" },
  { max: 7, label: "High" },
  { max: 10, label: "Very High" },
  { max: Infinity, label: "Extreme" },
];

function uvRiskBand(value) {
  if (value == null || Number.isNaN(value)) return null;
  return UV_RISK.find((band) => value <= band.max) || UV_RISK[UV_RISK.length - 1];
}

function tempDelta(celsius, unit) {
  if (celsius == null || Number.isNaN(celsius)) return null;
  return unit === "F" ? celsius * 9 / 5 : celsius;
}

function fmtTemp(celsius, unit) {
  if (celsius == null || Number.isNaN(celsius)) return "—";
  const v = unit === "F" ? celsius * 9 / 5 + 32 : celsius;
  return `${Math.round(v)}°${unit}`;
}

function fmtUv(v) {
  return v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(1);
}

function decadeLabel(trend) {
  const year = parseInt((trend?.baseline_period || "").slice(0, 4), 10);
  if (!year) return "the baseline";
  return `the ${Math.floor(year / 10) * 10}s`;
}

function cityTrend(city, metric) {
  return city.graph?.summary?.[metric]?.trend || null;
}

function typicalForMonth(city, metric, month) {
  const baseline = city.graph?.summary?.[metric]?.seasonal_baseline;
  if (!baseline || !month) return null;
  const v = baseline[String(month)] ?? baseline[month] ?? null;
  return v == null ? null : Number(v);
}

function tempVerb(trend, unit) {
  if (!trend) return "haven't got enough data to judge";
  const total = tempDelta(trend.total, unit);
  const threshold = unit === "F" ? 0.9 : 0.5;
  const mag = Math.abs(total).toFixed(1);
  if (total >= threshold) return `warmed about ${mag}°${unit} since ${decadeLabel(trend)}`;
  if (total <= -threshold) return `cooled about ${mag}°${unit} since ${decadeLabel(trend)}`;
  return "held about steady";
}

function trendSpanYears(trend) {
  const match = trend?.source_window?.match(/^(\d{4})-(\d{4})$/);
  if (!match) return 0;
  return Number(match[2]) - Number(match[1]);
}

function uvDisplayTrend(city, ctx) {
  const records = ctx.getSeries?.(city.id, "uv") || city.graph?.series?.uv || [];
  const summary = city.graph?.summary?.uv || {};
  if (ctx.resolveUvDisplayTrend) return ctx.resolveUvDisplayTrend(records, summary);
  const trend = summary.trend;
  if (!trend) return null;
  if (trend.confident !== false) return trend;
  const indicative = summary.indicative_trend;
  if (indicative && trendSpanYears(indicative) >= 10) return indicative;
  if (trendSpanYears(trend) >= 3) return trend;
  return indicative || trend;
}

function tempDirection(trend, unit) {
  const total = tempDelta(trend?.total, unit);
  if (total == null) return "flat";
  const threshold = unit === "F" ? 0.9 : 0.5;
  if (total >= threshold) return "up";
  if (total <= -threshold) return "down";
  return "flat";
}

function uvDirection(trend) {
  if (!trend || trend.total == null) return "flat";
  if (trend.total >= 0.3) return "up";
  if (trend.total <= -0.3) return "down";
  return "flat";
}

function divergenceExplanation(city, ctx) {
  const temp = cityTrend(city, "temperature");
  const uv = uvDisplayTrend(city, ctx);
  if (!temp || !uv) return null;

  const tDir = tempDirection(temp, ctx.tempUnit);
  const uDir = uvDirection(uv);
  const tempMag = Math.abs(tempDelta(temp.total, ctx.tempUnit)).toFixed(1);
  const uvMag = Math.abs(uv.total).toFixed(1);

  if (tDir === "up" && uDir === "down") {
    return `Here, average temperature rose about ${tempMag}°${ctx.tempUnit} since ${decadeLabel(temp)} while UV index trended about ${uvMag} points lower — they measure different things. Warming is long-run air temperature; UV peak depends on ozone, clouds, aerosols, and sun angle. Pre-2021 UV is scaled to the WHO index, so treat its long-run UV trend as indicative.`;
  }
  if (tDir === "down" && uDir === "up") {
    return `Cooler air on average (${tempMag}°${ctx.tempUnit} since ${decadeLabel(temp)}) can coexist with higher UV peaks (~${uvMag} index points) when cloud cover or pollution shifts differ from the temperature average.`;
  }
  if (ctx.explainDivergence && tDir !== uDir && tDir !== "flat" && uDir !== "flat") {
    return `Temperature and UV are trending in different directions here — normal, because one tracks average heat and the other tracks peak sunburn risk drivers.`;
  }
  return null;
}

function chartViewNote(ctx) {
  if (ctx.chartView !== "yoy-pct") return null;
  const u = ctx.tempUnit;
  if (ctx.metric === "temperature") {
    return `The chart shows degree change vs the same month last year (e.g. +2°${u} = warmer than last year) — not the long-term trend in the cards above.`;
  }
  return "The chart shows percent change in UV vs the same month last year (e.g. +10% = higher peak than last year) — not the long-term trend in the cards above.";
}

function uvVerb(trend, city, ctx) {
  const active = city ? uvDisplayTrend(city, ctx) : trend;
  if (!active) return "is hard to gauge from the consistent record";
  if (active.total >= 0.3) return "has trended higher";
  if (active.total <= -0.3) return "has trended lower";
  return "has stayed about the same";
}

function latestLine(city, ctx) {
  const { tempUnit, monthName } = ctx;
  const tempSeries = ctx.getSeries(city.id, "temperature");
  const uvSeries = ctx.getSeries(city.id, "uv");
  const t = tempSeries[tempSeries.length - 1];
  const u = uvSeries[uvSeries.length - 1];
  if (!t && !u) return "";
  const ref = t || u;
  const month = parseInt(ref.date.split("-")[1], 10);
  const parts = [];
  if (t) {
    const typ = typicalForMonth(city, "temperature", month);
    parts.push(`${fmtTemp(t.value, tempUnit)} (typical ${fmtTemp(typ, tempUnit)})`);
  }
  if (u) {
    const typ = typicalForMonth(city, "uv", month);
    const band = uvRiskBand(u.value);
    parts.push(`UV ${fmtUv(u.value)}${band ? ` (${band.label})` : ""}, typical ${fmtUv(typ)}`);
  }
  return `This past ${monthName(month)}: ${parts.join("; ")}.`;
}

function caveat() {
  return "UV before 2021 is adjusted onto the WHO scale, so its long-run trend is indicative.";
}

function singleCity(city, ctx) {
  const temp = cityTrend(city, "temperature");
  const lead = `${city.label}: temperatures have ${tempVerb(temp, ctx.tempUnit)}, and UV ${uvVerb(null, city, ctx)}.`;
  const lines = [lead, latestLine(city, ctx)];
  const divergence = divergenceExplanation(city, ctx);
  if (divergence) lines.push(divergence);
  const chartNote = chartViewNote(ctx);
  if (chartNote) lines.push(chartNote);
  return lines;
}

function multiCity(cities, ctx) {
  const unit = ctx.tempUnit;
  const withTemp = cities
    .map((c) => ({ label: c.label, warm: tempDelta(cityTrend(c, "temperature")?.total, unit) }))
    .filter((c) => c.warm != null);

  const lines = [];
  if (withTemp.length) {
    withTemp.sort((a, b) => b.warm - a.warm);
    const threshold = unit === "F" ? 0.9 : 0.5;
    const warmedCount = withTemp.filter((c) => c.warm >= threshold).length;
    const most = withTemp[0];
    if (warmedCount === withTemp.length) {
      lines.push(`All ${withTemp.length} places have warmed since the 1980s — most of all ${most.label} (about ${Math.abs(most.warm).toFixed(1)}°${unit}).`);
    } else if (warmedCount === 0) {
      lines.push(`Temperatures are roughly flat across these ${withTemp.length} places.`);
    } else {
      lines.push(`Most of these places have warmed since the 1980s, led by ${most.label} (about ${Math.abs(most.warm).toFixed(1)}°${unit}).`);
    }
  }

  const uvTrends = cities.map((c) => uvDisplayTrend(c, ctx)).filter(Boolean);
  const lower = uvTrends.filter((t) => t.total <= -0.3).length;
  const higher = uvTrends.filter((t) => t.total >= 0.3).length;
  if (higher > lower && higher > 0) lines.push("UV has generally trended higher.");
  else if (lower > higher && lower > 0) lines.push("UV has generally trended lower.");
  else lines.push("UV is about the same across them.");

  return lines;
}

function buildDataSummary(ctx, { withCaveat = true } = {}) {
  const active = ctx.cities.filter((c) => c.graph);
  if (!active.length) {
    return "Pick a city to see how its UV and temperature have changed.";
  }
  const lines = active.length === 1 ? singleCity(active[0], ctx) : multiCity(active, ctx);
  const chartNote = active.length === 1 ? null : chartViewNote(ctx);
  if (chartNote) lines.push(chartNote);
  if (withCaveat) lines.push(caveat());
  return lines.filter(Boolean).join(" ");
}

export function buildInstantSummary(ctx) {
  return buildDataSummary(ctx, { withCaveat: false });
}

export async function generateSummary(ctx, { onUpdate } = {}) {
  const quick = buildDataSummary(ctx, { withCaveat: false });
  onUpdate?.(quick, "instant");
  const full = buildDataSummary(ctx, { withCaveat: true });
  onUpdate?.(full, "rag");
  return full;
}
