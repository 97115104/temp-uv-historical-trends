#!/usr/bin/env python3
"""Build multi-city UV & temperature knowledge graph from NASA POWER."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
WEB_DATA_DIR = ROOT / "web" / "data"

DEFAULT_PERIOD_START = "1993-11"
NASA_START_YEAR = 1981
NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
OPEN_METEO_HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
UV_START_DATE = "2021-01-01"
WHO_UV_START_MONTH = "2021-01"
NASA_UV_START_YEAR = 2001
DATA_VERSION = 5
MIN_UV_BASE = 0.5

_now = datetime.now(timezone.utc)
_last_complete = (_now.replace(day=1) - timedelta(days=1))
# Filled after probing NASA; do not assume the calendar month is published yet.
PERIOD_END = _last_complete.strftime("%Y-%m")
NASA_END_YEAR = _last_complete.year

SOURCES = [
    {
        "id": "open_meteo_era5",
        "name": "Open-Meteo ERA5",
        "institution": "ECMWF / Open-Meteo",
        "url": "https://open-meteo.com/en/docs/historical-weather-api",
        "role": "temperature",
        "attribution": "ERA5 reanalysis via Open-Meteo (CC BY 4.0)",
    },
    {
        "id": "open_meteo_historical_forecast",
        "name": "Open-Meteo Historical Forecast",
        "institution": "Open-Meteo",
        "url": "https://open-meteo.com/en/docs/historical-forecast-api",
        "role": "uv",
        "attribution": "WHO-compatible UV Index via Open-Meteo (CC BY 4.0)",
    },
    {
        "id": "nasa_power",
        "name": "NASA POWER",
        "institution": "NASA Langley Research Center",
        "url": "https://power.larc.nasa.gov/",
        "role": "legacy_uv",
        "attribution": "NASA POWER Project",
    },
]


def load_cities(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def city_label(city: dict[str, Any]) -> str:
    parts = [city["name"]]
    if city.get("region"):
        parts.append(city["region"])
    elif city.get("country"):
        parts.append(city["country"])
    return ", ".join(parts)


def resolve_nasa_end_year(lat: float, lon: float, preferred_year: int) -> int:
    """Pick the newest end year NASA POWER monthly API accepts (current year often 422)."""
    for year in range(preferred_year, NASA_START_YEAR - 1, -1):
        params = {
            "parameters": "T2M",
            "community": "RE",
            "longitude": lon,
            "latitude": lat,
            "start": year,
            "end": year,
            "format": "JSON",
        }
        response = requests.get(NASA_POWER_URL, params=params, timeout=60)
        if response.status_code == 422:
            continue
        response.raise_for_status()
        return year
    return preferred_year - 1


def request_json(url: str, *, params: dict[str, Any] | None = None, timeout: int = 180) -> dict[str, Any]:
    """GET JSON with basic backoff for Open-Meteo rate limits."""
    last_error: Exception | None = None
    for attempt in range(6):
        try:
            response = requests.get(url, params=params, timeout=timeout)
            if response.status_code == 429:
                time.sleep(min(2 ** attempt, 30))
                continue
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            last_error = exc
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError(f"Request failed for {url}") from last_error


def fetch_open_meteo_temperature(lat: float, lon: float) -> pd.DataFrame:
    start_date = "1981-01-01"
    end_date = _last_complete.strftime("%Y-%m-%d")
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date,
        "end_date": end_date,
        "daily": "temperature_2m_mean",
        "models": "era5",
        "timezone": "UTC",
    }
    payload = request_json(OPEN_METEO_ARCHIVE_URL, params=params)
    daily = payload["daily"]
    monthly: dict[str, list[float]] = {}
    for date_str, value in zip(daily["time"], daily["temperature_2m_mean"]):
        if value is None:
            continue
        month = date_str[:7]
        monthly.setdefault(month, []).append(float(value))

    records = [
        {"date": month, "temperature": round(sum(values) / len(values), 4)}
        for month, values in sorted(monthly.items())
    ]
    return pd.DataFrame(records)


def fetch_open_meteo_uv(lat: float, lon: float) -> pd.DataFrame:
    """Monthly peak WHO UV Index from Open-Meteo hourly archive (Apple-comparable scale)."""
    end_date = _last_complete.strftime("%Y-%m-%d")
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": UV_START_DATE,
        "end_date": end_date,
        "hourly": "uv_index",
        "timezone": "UTC",
    }
    try:
        payload = request_json(OPEN_METEO_HISTORICAL_URL, params=params)
    except RuntimeError:
        return pd.DataFrame(columns=["date", "uv"])
    hourly = payload["hourly"]
    monthly_max: dict[str, float] = {}
    for time_str, uv in zip(hourly["time"], hourly["uv_index"]):
        if uv is None:
            continue
        month = time_str[:7]
        monthly_max[month] = max(monthly_max.get(month, 0.0), float(uv))

    records = [{"date": month, "uv": round(value, 4)} for month, value in sorted(monthly_max.items())]
    return pd.DataFrame(records)


def merge_uv_series(nasa_df: pd.DataFrame, who_df: pd.DataFrame) -> pd.DataFrame:
    """NASA monthly means through 2020; WHO monthly peaks from 2021 (NASA fills WHO gaps)."""
    by_date: dict[str, tuple[float, str]] = {}
    for _, row in nasa_df.iterrows():
        by_date[row["date"]] = (float(row["uv"]), "nasa_power")
    for _, row in who_df.iterrows():
        if row["date"] >= WHO_UV_START_MONTH:
            by_date[row["date"]] = (float(row["uv"]), "open_meteo_who")
        elif row["date"] not in by_date:
            by_date[row["date"]] = (float(row["uv"]), "open_meteo_who")

    records = [
        {"date": date, "uv": round(value, 4), "source": source}
        for date, (value, source) in sorted(by_date.items())
    ]
    return pd.DataFrame(records)


def uv_calibration_factors_from_sources(
    nasa_df: pd.DataFrame, who_df: pd.DataFrame
) -> dict[int, float]:
    """Per calendar-month scale: WHO(2021-MM) / NASA(2020-MM) from raw API frames."""
    factors: dict[int, float] = {}
    for month in range(1, 13):
        mm = f"{month:02d}"
        nasa_rows = nasa_df[nasa_df["date"] == f"2020-{mm}"] if not nasa_df.empty else pd.DataFrame()
        who_rows = who_df[who_df["date"] == f"2021-{mm}"] if not who_df.empty else pd.DataFrame()
        if nasa_rows.empty or who_rows.empty:
            continue
        nasa_val = float(nasa_rows.iloc[0]["uv"])
        who_val = float(who_rows.iloc[0]["uv"])
        if nasa_val > 0.01:
            factors[month] = who_val / nasa_val
    return factors


def apply_uv_calibration(uv_df: pd.DataFrame, factors: dict[int, float]) -> pd.DataFrame:
    if uv_df.empty:
        return uv_df
    out = uv_df.copy()
    out["value_raw"] = out["uv"].astype(float)
    calibrated: list[float] = []
    for _, row in out.iterrows():
        value = float(row["uv"])
        if row.get("source") == "nasa_power":
            month = int(str(row["date"]).split("-")[1])
            factor = factors.get(month)
            if factor:
                value = value * factor
        calibrated.append(round(value, 4))
    out["uv"] = calibrated
    out["value"] = calibrated
    return out


def safe_yoy_pct(
    curr: float | None,
    prev: float | None,
    metric: str,
    curr_source: str | None = None,
    prev_source: str | None = None,
) -> float | None:
    """Year-over-year percent change. UV only — temperature uses degree anomalies
    (yoy_delta) because °C is an interval scale where percentages are meaningless."""
    if metric != "uv":
        return None
    if curr is None or prev is None or pd.isna(curr) or pd.isna(prev):
        return None
    if curr_source and prev_source and curr_source != prev_source:
        return None
    if float(prev) < MIN_UV_BASE or float(prev) <= 0:
        return None
    pct = (float(curr) - float(prev)) / float(prev) * 100
    return round(pct, 4)


def yoy_delta(curr: float | None, prev: float | None) -> float | None:
    if curr is None or prev is None or pd.isna(curr) or pd.isna(prev):
        return None
    return round(float(curr) - float(prev), 4)


def add_yoy(df: pd.DataFrame, value_col: str = "value", metric: str = "temperature") -> pd.DataFrame:
    out = df.reset_index(drop=True).copy()
    has_source = "source" in out.columns
    yoy_list: list[float | None] = []
    delta_list: list[float | None] = []
    for i in range(len(out)):
        if i < 12:
            yoy_list.append(None)
            delta_list.append(None)
            continue
        prev_row = out.iloc[i - 12]
        curr_row = out.iloc[i]
        prev_source = str(prev_row["source"]) if has_source else None
        curr_source = str(curr_row["source"]) if has_source else None
        yoy_list.append(
            safe_yoy_pct(
                curr_row[value_col],
                prev_row[value_col],
                metric,
                curr_source,
                prev_source,
            )
        )
        delta_list.append(yoy_delta(curr_row[value_col], prev_row[value_col]))
    out["yoy_pct"] = yoy_list
    out["yoy_delta"] = delta_list
    return out


def fetch_combined_uv(lat: float, lon: float) -> pd.DataFrame:
    nasa_end_year = resolve_nasa_end_year(lat, lon, _last_complete.year)
    nasa_df = fetch_nasa_uv(lat, lon, NASA_UV_START_YEAR, nasa_end_year)
    time.sleep(1.2)
    who_df = fetch_open_meteo_uv(lat, lon)
    factors = uv_calibration_factors_from_sources(nasa_df, who_df)
    merged = merge_uv_series(nasa_df, who_df)
    return apply_uv_calibration(merged, factors)


def fetch_nasa_uv(lat: float, lon: float, start_year: int, end_year: int) -> pd.DataFrame:
    params = {
        "parameters": "ALLSKY_SFC_UV_INDEX",
        "community": "RE",
        "longitude": lon,
        "latitude": lat,
        "start": start_year,
        "end": end_year,
        "format": "JSON",
    }
    response = requests.get(NASA_POWER_URL, params=params, timeout=120)
    response.raise_for_status()
    payload = response.json()
    uv = payload.get("properties", {}).get("parameter", {}).get("ALLSKY_SFC_UV_INDEX", {})
    records: list[dict[str, Any]] = []
    for key, uv_val in uv.items():
        if len(key) != 6 or uv_val == -999.0:
            continue
        year, month = int(key[:4]), int(key[4:6])
        if month < 1 or month > 12:
            continue
        date = f"{year:04d}-{month:02d}"
        if date > PERIOD_END:
            continue
        records.append({"date": date, "uv": float(uv_val)})
    return pd.DataFrame(records).sort_values("date").reset_index(drop=True)


def _annual_means(series_df: pd.DataFrame, value_col: str, source: str | None = None) -> pd.Series:
    df = series_df
    if source is not None and "source" in df.columns:
        df = df[df["source"] == source]
    if df.empty:
        return pd.Series(dtype=float)
    tmp = df.assign(year=df["date"].str[:4].astype(int))
    return tmp.groupby("year")[value_col].mean().sort_index()


def _linear_slope_per_year(annual: pd.Series) -> float | None:
    """Least-squares slope (value per year) of an annual-mean series."""
    if len(annual) < 3:
        return None
    years = annual.index.to_numpy(dtype=float)
    vals = annual.to_numpy(dtype=float)
    denom = float(((years - years.mean()) ** 2).sum())
    if denom == 0:
        return None
    return float(((years - years.mean()) * (vals - vals.mean())).sum() / denom)


def compute_trend(
    series_df: pd.DataFrame,
    metric: str,
    value_col: str = "value",
    *,
    all_sources: bool = False,
) -> dict[str, Any] | None:
    """Long-term trend from annual means: per-decade slope, total change, and
    baseline vs recent decade. UV is computed within a single consistent source
    window (the 2021 NASA->WHO splice would otherwise fabricate a trend).
    Pass all_sources=True for a blended indicative UV trend across sources."""
    if series_df.empty:
        return None

    source = None
    confident = True
    if metric == "uv" and "source" in series_df.columns and not all_sources:
        # Prefer the source group covering the longest span of full years.
        best_span = -1
        for src in series_df["source"].dropna().unique():
            annual = _annual_means(series_df, value_col, source=src)
            span = int(annual.index.max() - annual.index.min()) if len(annual) else -1
            if span > best_span:
                best_span, source = span, src
        confident = best_span >= 10
    elif metric == "uv" and all_sources:
        confident = False

    annual = _annual_means(series_df, value_col, source=source)
    if len(annual) < 3:
        return None
    slope = _linear_slope_per_year(annual)
    if slope is None:
        return None

    span_years = int(annual.index.max() - annual.index.min())
    window = min(10, len(annual))
    baseline = float(annual.iloc[:window].mean())
    recent = float(annual.iloc[-window:].mean())
    years = list(annual.index)

    result = {
        "per_decade": round(slope * 10, 4),
        "total": round(slope * span_years, 4),
        "baseline": round(baseline, 4),
        "recent": round(recent, 4),
        "baseline_period": f"{years[0]}-{years[min(window, len(years)) - 1]}",
        "recent_period": f"{years[-window]}-{years[-1]}",
        "unit": "degC" if metric == "temperature" else "uv",
        "source_window": f"{years[0]}-{years[-1]}",
        "source": source,
        "confident": bool(confident and span_years >= 10),
    }
    if all_sources:
        result["indicative"] = True
        result["confident"] = False
    return result


def compute_summary(series_df: pd.DataFrame, metric: str, value_col: str = "value") -> dict[str, Any]:
    if series_df.empty:
        return {}

    values = series_df[value_col].astype(float)
    start_val = float(values.iloc[0])
    end_val = float(values.iloc[-1])

    # Seasonally fair change: first vs last same calendar month (not winter→summer endpoints).
    last_date = str(series_df.iloc[-1]["date"])
    month_str = last_date.split("-")[1]
    same_month = series_df[series_df["date"].str.endswith(f"-{month_str}")]
    if len(same_month) >= 2:
        sm_start = float(same_month.iloc[0][value_col])
        sm_end = float(same_month.iloc[-1][value_col])
    else:
        sm_start, sm_end = start_val, end_val

    seasonal = (
        series_df.assign(month=series_df["date"].str[-2:].astype(int))
        .groupby("month")[value_col]
        .mean()
        .round(4)
        .to_dict()
    )

    summary: dict[str, Any] = {
        "min": round(float(values.min()), 4),
        "max": round(float(values.max()), 4),
        "start_value": round(start_val, 4),
        "end_value": round(end_val, 4),
        "seasonal_baseline": {str(k): v for k, v in seasonal.items()},
        "trend": compute_trend(series_df, metric, value_col),
    }

    if metric == "uv":
        trend = summary["trend"]
        if trend and not trend.get("confident"):
            indicative = compute_trend(series_df, metric, value_col, all_sources=True)
            if indicative:
                summary["indicative_trend"] = indicative
        yoy = series_df["yoy_pct"].dropna() if "yoy_pct" in series_df else pd.Series(dtype=float)
        change_pct = ((sm_end - sm_start) / sm_start * 100) if sm_start else None
        summary["avg_yoy_pct"] = round(float(yoy.mean()), 4) if not yoy.empty else None
        summary["change_1993_to_2026_pct"] = round(change_pct, 4) if change_pct is not None else None
    else:
        # Temperature: degree anomalies, never percentages.
        delta = series_df["yoy_delta"].dropna() if "yoy_delta" in series_df else pd.Series(dtype=float)
        summary["avg_yoy_delta"] = round(float(delta.mean()), 4) if not delta.empty else None
        summary["change_delta"] = round(sm_end - sm_start, 4)

    return summary


def series_to_records(df: pd.DataFrame, value_col: str = "value") -> list[dict[str, Any]]:
    records = []
    for _, row in df.iterrows():
        yoy = row.get("yoy_pct")
        record: dict[str, Any] = {
            "date": row["date"],
            "value": round(float(row[value_col]), 4),
            "yoy_pct": None if yoy is None or pd.isna(yoy) else round(float(yoy), 4),
        }
        delta = row.get("yoy_delta")
        if delta is not None and not pd.isna(delta):
            record["yoy_delta"] = round(float(delta), 4)
        if "value_raw" in row and not pd.isna(row["value_raw"]):
            record["value_raw"] = round(float(row["value_raw"]), 4)
        if "source" in row and row["source"] is not None:
            record["source"] = row["source"]
        records.append(record)
    return records


def build_graph_edges(city_id: str, series: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    edges: list[dict[str, Any]] = []
    for metric_key, points in series.items():
        for point in points:
            period_id = f"period:{point['date']}"
            edges.append({"from": f"loc:{city_id}", "to": period_id, "type": "hasPeriod"})
            edges.append(
                {
                    "from": period_id,
                    "to": f"metric:{metric_key}",
                    "type": "hasValue",
                    "city": city_id,
                    "value": point["value"],
                }
            )
            if point.get("yoy_pct") is not None:
                prev_date = (
                    pd.Timestamp(point["date"] + "-01") - pd.DateOffset(months=12)
                ).strftime("%Y-%m")
                edges.append(
                    {
                        "from": f"period:{point['date']}",
                        "to": f"period:{prev_date}",
                        "type": "yoyChange",
                        "city": city_id,
                        "metric": metric_key,
                        "pct": point["yoy_pct"],
                    }
                )
    return edges


def build_comparison_edges(cities_data: dict[str, Any], metric: str) -> list[dict[str, Any]]:
    """Compare cities by their long-term trend per decade (degC/decade for
    temperature, UV-index/decade for UV) — a fair, source-consistent basis."""
    edges = []
    city_ids = list(cities_data.keys())

    def trend_of(cid: str) -> float | None:
        trend = cities_data[cid]["summary"].get(metric, {}).get("trend")
        return trend.get("per_decade") if trend else None

    for i, cid_a in enumerate(city_ids):
        change_a = trend_of(cid_a)
        for cid_b in city_ids[i + 1 :]:
            change_b = trend_of(cid_b)
            if change_a is not None and change_b is not None:
                edges.append(
                    {
                        "from": f"loc:{cid_a}",
                        "to": f"loc:{cid_b}",
                        "type": "comparedWith",
                        "metric": metric,
                        "delta_trend_per_decade": round(change_a - change_b, 4),
                    }
                )
    return edges


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build_city_data(city: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    lat, lon = city["lat"], city["lon"]
    label = city_label(city)

    print(f"Processing {label}...", flush=True)
    temp_df = fetch_open_meteo_temperature(lat, lon)
    temp_df = temp_df.rename(columns={"temperature": "value"})
    temp_df = add_yoy(temp_df, metric="temperature")

    uv_df = fetch_combined_uv(lat, lon)
    uv_df = add_yoy(uv_df, metric="uv")

    period_end = max(temp_df["date"].max(), uv_df["date"].max() if not uv_df.empty else temp_df["date"].max())
    uv_sources = uv_df["source"].value_counts().to_dict() if "source" in uv_df.columns else {}

    city_entry = {
        "id": city["id"],
        "name": label,
        "lat": lat,
        "lon": lon,
        "data_version": DATA_VERSION,
        "series": {
            "uv": series_to_records(uv_df),
            "temperature": series_to_records(temp_df),
        },
        "summary": {
            "uv": compute_summary(uv_df, "uv"),
            "temperature": compute_summary(temp_df, "temperature"),
        },
        "period": {"start": temp_df["date"].min(), "end": period_end},
    }

    provenance = {
        "city_id": city["id"],
        "city_name": label,
        "lat": lat,
        "lon": lon,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "temperature_points": int(len(temp_df)),
        "uv_points": int(len(uv_df)),
        "uv_sources": uv_sources,
        "sources": ["open_meteo_era5", "nasa_power", "open_meteo_historical_forecast"],
    }

    return city_entry, provenance


def build_knowledge_graph(cities_config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    global PERIOD_END

    cities_block: dict[str, Any] = {}
    provenance_cities: list[dict[str, Any]] = []
    all_edges: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = [
        {"id": "metric:uv", "type": "Metric", "unit": "WHO UV Index", "source": "nasa_power+open_meteo_who"},
        {"id": "metric:temperature", "type": "Metric", "unit": "degC", "source": "open_meteo_era5"},
    ]

    for city in cities_config["cities"]:
        city_entry, prov = build_city_data(city)
        cities_block[city["id"]] = city_entry
        provenance_cities.append(prov)
        nodes.append({"id": f"loc:{city['id']}", "type": "Place", "label": city_entry["name"]})
        all_edges.extend(build_graph_edges(city["id"], city_entry["series"]))
        time.sleep(1.5)

    for metric in ("uv", "temperature"):
        all_edges.extend(build_comparison_edges(cities_block, metric))

    period_end = max(c["period"]["end"] for c in cities_block.values())
    PERIOD_END = period_end
    earliest_temp = min(
        city["series"]["temperature"][0]["date"]
        for city in cities_block.values()
        if city["series"].get("temperature")
    )
    earliest_uv = min(
        city["series"]["uv"][0]["date"]
        for city in cities_block.values()
        if city["series"].get("uv")
    )
    earliest_uv_who = min(
        point["date"]
        for city in cities_block.values()
        for point in city["series"].get("uv", [])
        if point["date"] >= WHO_UV_START_MONTH
    )
    period_start = earliest_temp

    graph = {
        "metadata": {
            "data_version": DATA_VERSION,
            "default_city": cities_config.get("default_city", "covina-ca"),
            "period": {
                "start": period_start,
                "default_start": DEFAULT_PERIOD_START,
                "end": period_end,
                "latest_nasa": period_end,
                "earliest_temperature": earliest_temp,
                "earliest_uv": earliest_uv,
                "earliest_uv_who": earliest_uv_who,
                "uv_who_start": WHO_UV_START_MONTH,
                "calendar_month": _last_complete.strftime("%Y-%m"),
            },
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "sources": SOURCES,
        },
        "cities": cities_block,
        "nodes": nodes,
        "edges": all_edges,
    }

    summary = {city_id: cities_block[city_id]["summary"] for city_id in cities_block}
    provenance = {
        "generated_at": graph["metadata"]["generated_at"],
        "sources": SOURCES,
        "cities": provenance_cities,
    }

    return graph, summary, provenance


def write_outputs(
    graph: dict[str, Any],
    summary: dict[str, Any],
    provenance: dict[str, Any],
    cities_config: dict[str, Any],
) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)

    graph_path = DATA_DIR / "knowledge_graph.json"
    summary_path = DATA_DIR / "summary.json"
    provenance_path = DATA_DIR / "provenance.json"

    with graph_path.open("w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2)
    with summary_path.open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    with provenance_path.open("w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2)

    with (WEB_DATA_DIR / "cities.json").open("w", encoding="utf-8") as f:
        json.dump(cities_config, f, indent=2)

    per_city_dir = WEB_DATA_DIR / "cities"
    per_city_dir.mkdir(parents=True, exist_ok=True)
    for city_id, city_entry in graph["cities"].items():
        city_path = per_city_dir / f"{city_id}.json"
        with city_path.open("w", encoding="utf-8") as f:
            json.dump(city_entry, f, indent=2)
        data_city_path = DATA_DIR / "cities" / f"{city_id}.json"
        data_city_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(city_path, data_city_path)

    comparison_edges = [e for e in graph["edges"] if e.get("type") == "comparedWith"]
    graph_meta = {
        "metadata": graph["metadata"],
        "nodes": graph["nodes"],
        "edges": comparison_edges,
        "city_ids": list(graph["cities"].keys()),
    }
    meta_path = WEB_DATA_DIR / "graph-meta.json"
    with meta_path.open("w", encoding="utf-8") as f:
        json.dump(graph_meta, f, indent=2)
    shutil.copy2(meta_path, DATA_DIR / "graph-meta.json")

    for path in (graph_path, summary_path, provenance_path):
        provenance.setdefault("file_hashes", {})[path.name] = file_sha256(path)

    with provenance_path.open("w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2)

    print(f"Wrote {graph_path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build UV/temperature knowledge graph")
    parser.add_argument("--cities", type=Path, default=ROOT / "cities.json")
    args = parser.parse_args()

    cities_config = load_cities(args.cities)
    graph, summary, provenance = build_knowledge_graph(cities_config)
    write_outputs(graph, summary, provenance, cities_config)


if __name__ == "__main__":
    main()
