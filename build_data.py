#!/usr/bin/env python3
"""Build multi-city UV & temperature knowledge graph from NASA POWER."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
WEB_DATA_DIR = ROOT / "web" / "data"

PERIOD_START = "1993-11"
PERIOD_END = "2025-12"
NASA_START_YEAR = 1993
NASA_END_YEAR = 2025

NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"

SOURCES = [
    {
        "id": "nasa_power",
        "name": "NASA POWER",
        "institution": "NASA Langley Research Center",
        "url": "https://power.larc.nasa.gov/",
        "role": "uv_and_temperature",
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


def fetch_nasa_power(lat: float, lon: float, start_year: int, end_year: int) -> pd.DataFrame:
    params = {
        "parameters": "T2M,ALLSKY_SFC_UV_INDEX",
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

    parameters = payload.get("properties", {}).get("parameter", {})
    t2m = parameters.get("T2M", {})
    uv = parameters.get("ALLSKY_SFC_UV_INDEX", {})

    records: list[dict[str, Any]] = []
    for key, temp in t2m.items():
        if len(key) != 6:
            continue
        year, month = int(key[:4]), int(key[4:6])
        if month < 1 or month > 12 or temp == -999.0:
            continue
        date = f"{year:04d}-{month:02d}"
        if date < PERIOD_START or date > PERIOD_END:
            continue
        uv_val = None
        if key in uv and uv[key] != -999.0:
            uv_val = float(uv[key])
        records.append({"date": date, "temperature": float(temp), "uv": uv_val})

    return pd.DataFrame(records).sort_values("date").reset_index(drop=True)


def add_yoy(df: pd.DataFrame, value_col: str = "value") -> pd.DataFrame:
    out = df.copy()
    values = out[value_col].astype(float)
    out["yoy_pct"] = (values.pct_change(periods=12) * 100).replace([np.inf, -np.inf], np.nan)
    return out


def compute_summary(series_df: pd.DataFrame, value_col: str = "value") -> dict[str, Any]:
    if series_df.empty:
        return {}

    values = series_df[value_col].astype(float)
    yoy = series_df["yoy_pct"].dropna() if "yoy_pct" in series_df else pd.Series(dtype=float)
    start_val = float(values.iloc[0])
    end_val = float(values.iloc[-1])
    change_pct = ((end_val - start_val) / start_val * 100) if start_val else None

    seasonal = (
        series_df.assign(month=series_df["date"].str[-2:].astype(int))
        .groupby("month")[value_col]
        .mean()
        .round(4)
        .to_dict()
    )

    return {
        "avg_yoy_pct": round(float(yoy.mean()), 4) if not yoy.empty else None,
        "change_1993_to_2026_pct": round(change_pct, 4) if change_pct is not None else None,
        "min": round(float(values.min()), 4),
        "max": round(float(values.max()), 4),
        "start_value": round(start_val, 4),
        "end_value": round(end_val, 4),
        "seasonal_baseline": {str(k): v for k, v in seasonal.items()},
    }


def series_to_records(df: pd.DataFrame, value_col: str = "value") -> list[dict[str, Any]]:
    records = []
    for _, row in df.iterrows():
        yoy = row.get("yoy_pct")
        records.append(
            {
                "date": row["date"],
                "value": round(float(row[value_col]), 4),
                "yoy_pct": None if pd.isna(yoy) else round(float(yoy), 4),
            }
        )
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
    edges = []
    city_ids = list(cities_data.keys())
    for i, cid_a in enumerate(city_ids):
        change_a = cities_data[cid_a]["summary"].get(metric, {}).get("change_1993_to_2026_pct")
        for cid_b in city_ids[i + 1 :]:
            change_b = cities_data[cid_b]["summary"].get(metric, {}).get("change_1993_to_2026_pct")
            if change_a is not None and change_b is not None:
                edges.append(
                    {
                        "from": f"loc:{cid_a}",
                        "to": f"loc:{cid_b}",
                        "type": "comparedWith",
                        "metric": metric,
                        "delta_pct_1993_2026": round(change_a - change_b, 4),
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
    nasa_df = fetch_nasa_power(lat, lon, NASA_START_YEAR, NASA_END_YEAR)

    temp_df = nasa_df[["date", "temperature"]].rename(columns={"temperature": "value"})
    temp_df = add_yoy(temp_df)
    uv_df = nasa_df.dropna(subset=["uv"])[["date", "uv"]].rename(columns={"uv": "value"})
    uv_df = add_yoy(uv_df)

    period_end = temp_df["date"].max() if not temp_df.empty else PERIOD_END

    city_entry = {
        "id": city["id"],
        "name": label,
        "lat": lat,
        "lon": lon,
        "series": {
            "uv": series_to_records(uv_df),
            "temperature": series_to_records(temp_df),
        },
        "summary": {
            "uv": compute_summary(uv_df),
            "temperature": compute_summary(temp_df),
        },
        "period": {"start": PERIOD_START, "end": period_end},
    }

    provenance = {
        "city_id": city["id"],
        "city_name": label,
        "lat": lat,
        "lon": lon,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "nasa_monthly_points": int(len(nasa_df)),
        "sources": [s["id"] for s in SOURCES],
    }

    return city_entry, provenance


def build_knowledge_graph(cities_config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    cities_block: dict[str, Any] = {}
    provenance_cities: list[dict[str, Any]] = []
    all_edges: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = [
        {"id": "metric:uv", "type": "Metric", "unit": "UV index", "source": "nasa_power"},
        {"id": "metric:temperature", "type": "Metric", "unit": "degC", "source": "nasa_power"},
    ]

    for city in cities_config["cities"]:
        city_entry, prov = build_city_data(city)
        cities_block[city["id"]] = city_entry
        provenance_cities.append(prov)
        nodes.append({"id": f"loc:{city['id']}", "type": "Place", "label": city_entry["name"]})
        all_edges.extend(build_graph_edges(city["id"], city_entry["series"]))

    for metric in ("uv", "temperature"):
        all_edges.extend(build_comparison_edges(cities_block, metric))

    period_end = max(c["period"]["end"] for c in cities_block.values())
    period_start = PERIOD_START

    graph = {
        "metadata": {
            "default_city": cities_config.get("default_city", "covina-ca"),
            "period": {
                "start": period_start,
                "end": period_end,
                "latest_nasa": period_end,
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

    shutil.copy2(graph_path, WEB_DATA_DIR / "knowledge_graph.json")
    with (WEB_DATA_DIR / "cities.json").open("w", encoding="utf-8") as f:
        json.dump(cities_config, f, indent=2)

    for path in (graph_path, summary_path, provenance_path):
        provenance.setdefault("file_hashes", {})[path.name] = file_sha256(path)

    with provenance_path.open("w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2)

    print(f"Wrote {graph_path}", flush=True)
    print(f"Wrote {WEB_DATA_DIR / 'knowledge_graph.json'}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build UV/temperature knowledge graph")
    parser.add_argument("--cities", type=Path, default=ROOT / "cities.json")
    args = parser.parse_args()

    cities_config = load_cities(args.cities)
    graph, summary, provenance = build_knowledge_graph(cities_config)
    write_outputs(graph, summary, provenance, cities_config)


if __name__ == "__main__":
    main()
