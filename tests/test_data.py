import json
import os
import random
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
GRAPH_PATH = ROOT / "data" / "knowledge_graph.json"
CITIES_PATH = ROOT / "cities.json"

# Physically plausible monthly-mean temperature bounds per city, expressed in °F
# then converted to °C (the stored unit). These are independent sanity guardrails:
# e.g. New York's coldest monthly mean should sit above ~15°F, not near 0.
TEMP_BOUNDS_F = {
    "covina-ca": (40, 95),
    "los-angeles-ca": (40, 95),
    "san-francisco-ca": (35, 88),
    "seattle-wa": (25, 88),
    "new-york-ny": (15, 92),
}


def f_to_c(f):
    return (f - 32) * 5 / 9


@pytest.fixture(scope="module")
def graph():
    if not GRAPH_PATH.exists():
        pytest.skip("knowledge_graph.json not found — run build_data.py first")
    with GRAPH_PATH.open(encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def cities_config():
    with CITIES_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def test_all_cities_present(graph, cities_config):
    for city in cities_config["cities"]:
        assert city["id"] in graph["cities"]


def test_default_city(graph):
    assert graph["metadata"]["default_city"] == "covina-ca"


def test_date_range_per_city(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        assert series, f"No temperature data for {city_id}"
        assert series[0]["date"] >= "1981-01", f"{city_id} should include temperature history"
        assert series[-1]["date"] >= "2025-01"


def test_no_null_gaps_temperature(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        dates = pd.date_range(series[0]["date"] + "-01", series[-1]["date"] + "-01", freq="MS")
        actual = {p["date"] for p in series}
        expected = {d.strftime("%Y-%m") for d in dates}
        missing = expected - actual
        assert len(missing) <= 1, f"{city_id} missing months: {sorted(missing)[:5]}"


def test_uv_history_starts_2001(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["uv"]
        assert series, f"No UV data for {city_id}"
        assert series[0]["date"] <= "2001-12", f"{city_id} UV should reach back to 2001 (NASA POWER)"


def test_uv_seasonality(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["uv"]
        if len(series) < 12:
            pytest.skip(f"{city_id}: insufficient UV data")
        df = pd.DataFrame(series)
        df["month"] = df["date"].str[-2:].astype(int)
        summer = df[df["month"].isin([6, 7, 8])]["value"].mean()
        winter = df[df["month"].isin([12, 1, 2])]["value"].mean()
        assert summer > winter, f"{city_id}: summer UV should exceed winter"


def test_uv_physically_bounded(graph):
    for city_id, city in graph["cities"].items():
        values = [p["value"] for p in city["series"]["uv"]]
        assert min(values) >= 0, f"{city_id} has negative UV"
        assert max(values) <= 14, f"{city_id} UV peak {max(values)} is implausibly high"


def test_temperature_range(graph):
    for city_id, city in graph["cities"].items():
        temps = [p["value"] for p in city["series"]["temperature"]]
        lo_f, hi_f = TEMP_BOUNDS_F.get(city_id, (-10, 100))
        lo, hi = f_to_c(lo_f), f_to_c(hi_f)
        assert min(temps) >= lo, f"{city_id} coldest monthly mean {min(temps):.1f}°C below {lo_f}°F"
        assert max(temps) <= hi, f"{city_id} hottest monthly mean {max(temps):.1f}°C above {hi_f}°F"


def test_temperature_has_no_percentage_yoy(graph):
    """Temperature must never carry a percentage YoY (meaningless on °C)."""
    for city_id, city in graph["cities"].items():
        for point in city["series"]["temperature"]:
            assert point.get("yoy_pct") is None, f"{city_id} temperature has yoy_pct at {point['date']}"


def test_temperature_yoy_delta_present_and_sane(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        deltas = [p["yoy_delta"] for p in series if p.get("yoy_delta") is not None]
        assert len(deltas) > 100, f"{city_id} should have yoy_delta values"
        # Year-over-year monthly-mean swings beyond ±15°C are not credible.
        assert max(abs(d) for d in deltas) <= 15, f"{city_id} has an implausible YoY delta"


def test_temperature_yoy_delta_matches_series(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        by_date = {p["date"]: p["value"] for p in series}
        checked = 0
        for point in series:
            if point.get("yoy_delta") is None:
                continue
            year, month = map(int, point["date"].split("-"))
            prev = by_date.get(f"{year - 1:04d}-{month:02d}")
            if prev is None:
                continue
            assert abs(point["yoy_delta"] - (point["value"] - prev)) < 0.01
            checked += 1
        assert checked > 50, f"{city_id}: too few yoy_delta checks"


def test_uv_yoy_bounded(graph):
    """UV YoY % can never drop below -100% (UV >= 0) and shouldn't spike absurdly."""
    for city_id, city in graph["cities"].items():
        for point in city["series"]["uv"]:
            yoy = point.get("yoy_pct")
            if yoy is None:
                continue
            assert yoy >= -100, f"{city_id} UV YoY {yoy} below -100% at {point['date']}"
            assert yoy <= 200, f"{city_id} UV YoY {yoy} implausibly high at {point['date']}"


def test_uv_yoy_at_2021_reasonable(graph):
    for city_id, city in graph["cities"].items():
        for point in city["series"].get("uv", []):
            if point["date"].startswith("2021-"):
                yoy = point.get("yoy_pct")
                if yoy is not None:
                    assert abs(yoy) <= 100, f"{city_id} UV YoY at {point['date']} is {yoy}"


def test_uv_yoy_calculation(graph):
    from build_data import safe_yoy_pct

    for city_id, city in graph["cities"].items():
        series = city["series"]["uv"]
        valid = [p for p in series if p.get("yoy_pct") is not None]
        if len(valid) < 3:
            continue
        by_date = {p["date"]: p for p in series}
        for point in random.sample(valid, min(3, len(valid))):
            year, month = map(int, point["date"].split("-"))
            prev = by_date.get(f"{year - 1:04d}-{month:02d}")
            if prev is None:
                continue
            expected = safe_yoy_pct(
                point["value"], prev["value"], "uv", point.get("source"), prev.get("source")
            )
            assert point["yoy_pct"] == expected, f"{city_id} UV YoY mismatch {point['date']}"


def _independent_trend_per_decade(series, source=None):
    """Recompute the per-decade trend from scratch (numpy), independent of build_data."""
    df = pd.DataFrame(series)
    if source is not None and "source" in df.columns:
        df = df[df["source"] == source]
    if df.empty:
        return None
    df = df.assign(year=df["date"].str[:4].astype(int))
    annual = df.groupby("year")["value"].mean()
    if len(annual) < 3:
        return None
    slope = np.polyfit(annual.index.to_numpy(dtype=float), annual.to_numpy(dtype=float), 1)[0]
    return slope * 10


def test_trend_matches_independent_recomputation(graph):
    for city_id, city in graph["cities"].items():
        for metric in ("temperature", "uv"):
            summary = city["summary"].get(metric, {})
            trend = summary.get("trend")
            assert trend is not None, f"{city_id} {metric} missing trend"
            expected = _independent_trend_per_decade(
                city["series"][metric], trend.get("source")
            )
            assert expected is not None, f"{city_id} {metric} trend not recomputable"
            assert abs(trend["per_decade"] - expected) < 0.05, (
                f"{city_id} {metric} trend {trend['per_decade']} != recomputed {expected:.4f}"
            )


def test_summary_consistency(graph):
    for city_id, city in graph["cities"].items():
        for metric in ("uv", "temperature"):
            series = city["series"].get(metric, [])
            summary = city["summary"].get(metric, {})
            if not series or not summary:
                continue
            df = pd.DataFrame(series)
            month_str = series[-1]["date"].split("-")[1]
            same_month = df[df["date"].str.endswith(f"-{month_str}")]
            if len(same_month) >= 2:
                sm_start = float(same_month.iloc[0]["value"])
                sm_end = float(same_month.iloc[-1]["value"])
            else:
                sm_start = float(series[0]["value"])
                sm_end = float(series[-1]["value"])
            if metric == "uv":
                expected = (sm_end - sm_start) / sm_start * 100 if sm_start else None
                if expected is not None:
                    assert abs(summary["change_1993_to_2026_pct"] - expected) < 0.1
            else:
                assert abs(summary["change_delta"] - (sm_end - sm_start)) < 0.1


def test_cross_city_ordering(graph):
    def winter_mean(city_id):
        city = graph["cities"][city_id]
        df = pd.DataFrame(city["series"]["temperature"])
        df["month"] = df["date"].str[-2:].astype(int)
        return df[df["month"].isin([12, 1, 2])]["value"].mean()

    assert winter_mean("new-york-ny") < winter_mean("covina-ca")


def test_graph_meta_exists():
    meta_path = ROOT / "data" / "graph-meta.json"
    if not meta_path.exists():
        pytest.skip("graph-meta.json not found — run build_data.py first")
    with meta_path.open(encoding="utf-8") as f:
        meta = json.load(f)
    assert meta.get("metadata", {}).get("data_version", 0) >= 5
    assert len(meta.get("city_ids", [])) == 5
    for city_id in meta["city_ids"]:
        assert (ROOT / "data" / "cities" / f"{city_id}.json").exists()


def test_provenance():
    prov_path = ROOT / "data" / "provenance.json"
    if not prov_path.exists():
        pytest.skip("provenance.json not found")
    with prov_path.open(encoding="utf-8") as f:
        prov = json.load(f)
    assert "generated_at" in prov
    pd.Timestamp(prov["generated_at"])
    source_ids = {s["id"] for s in prov.get("sources", [])}
    assert "open_meteo_era5" in source_ids or "nasa_power" in source_ids
    assert len(prov.get("cities", [])) == 5


# --- Independent network re-fetch spot checks (opt-in) ---------------------------
# Run with: RUN_NETWORK_TESTS=1 pytest -q  (skipped by default / offline).

network = pytest.mark.skipif(
    not os.environ.get("RUN_NETWORK_TESTS"),
    reason="set RUN_NETWORK_TESTS=1 to run live source re-fetch checks",
)


@network
def test_temperature_matches_source_refetch(graph, cities_config):
    import requests

    city = random.choice(cities_config["cities"])
    series = graph["cities"][city["id"]]["series"]["temperature"]
    point = random.choice([p for p in series if p["date"] >= "1990-01"])
    year, month = point["date"].split("-")
    start = f"{year}-{month}-01"
    end = (pd.Timestamp(start) + pd.offsets.MonthEnd(0)).strftime("%Y-%m-%d")

    resp = requests.get(
        "https://archive-api.open-meteo.com/v1/archive",
        params={
            "latitude": city["lat"], "longitude": city["lon"],
            "start_date": start, "end_date": end,
            "daily": "temperature_2m_mean", "models": "era5", "timezone": "UTC",
        },
        timeout=60,
    )
    resp.raise_for_status()
    vals = [v for v in resp.json()["daily"]["temperature_2m_mean"] if v is not None]
    refetched = sum(vals) / len(vals)
    assert abs(refetched - point["value"]) < 1.0, (
        f"{city['id']} {point['date']} stored {point['value']} vs re-fetched {refetched:.2f}"
    )
