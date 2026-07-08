import json
import random
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
GRAPH_PATH = ROOT / "data" / "knowledge_graph.json"
CITIES_PATH = ROOT / "cities.json"


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
        assert series[0]["date"] >= "1981-01", f"{city_id} should include NASA temperature history"
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


def test_temperature_range(graph):
    bounds = {
        "covina-ca": (-5, 45),
        "los-angeles-ca": (-5, 45),
        "san-francisco-ca": (-5, 40),
        "seattle-wa": (-15, 40),
        "new-york-ny": (-25, 45),
    }
    for city_id, city in graph["cities"].items():
        temps = [p["value"] for p in city["series"]["temperature"]]
        lo, hi = bounds.get(city_id, (-30, 50))
        assert min(temps) >= lo, f"{city_id} temp below {lo}"
        assert max(temps) <= hi, f"{city_id} temp above {hi}"


def test_yoy_calculation(graph):
    from build_data import MIN_TEMP_BASE_C, safe_yoy_pct

    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        valid = [p for p in series if p["yoy_pct"] is not None]
        if len(valid) < 3:
            continue
        samples = random.sample(valid, min(3, len(valid)))
        by_date = {p["date"]: p["value"] for p in series}
        for point in samples:
            year, month = map(int, point["date"].split("-"))
            prev_date = f"{year - 1:04d}-{month:02d}"
            if prev_date not in by_date:
                continue
            prev_val = by_date[prev_date]
            expected = safe_yoy_pct(point["value"], prev_val, "temperature")
            assert point["yoy_pct"] == expected, f"{city_id} YoY mismatch {point['date']}"


def test_no_extreme_yoy_spikes(graph):
    for city_id, city in graph["cities"].items():
        for metric in ("uv", "temperature"):
            for point in city["series"].get(metric, []):
                yoy = point.get("yoy_pct")
                if yoy is None:
                    continue
                if metric == "temperature":
                    by_date = {p["date"]: p["value"] for p in city["series"][metric]}
                    year, month = map(int, point["date"].split("-"))
                    prev_date = f"{year - 1:04d}-{month:02d}"
                    prev = by_date.get(prev_date)
                    if prev is not None and prev > 0:
                        assert yoy >= -100, f"{city_id} temp YoY {yoy} at {point['date']} implies impossible drop"


def test_temperature_yoy_delta_present(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        deltas = [p["yoy_delta"] for p in series if p.get("yoy_delta") is not None]
        assert len(deltas) > 100, f"{city_id} should have yoy_delta values"


def test_uv_yoy_at_2021_reasonable(graph):
    for city_id, city in graph["cities"].items():
        for point in city["series"].get("uv", []):
            if point["date"].startswith("2021-"):
                yoy = point.get("yoy_pct")
                if yoy is not None:
                    assert abs(yoy) <= 100, f"{city_id} UV YoY at {point['date']} is {yoy}"


def test_temperature_yoy_skips_near_zero_base(graph):
    from build_data import MIN_TEMP_BASE_C

    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        by_date = {p["date"]: p["value"] for p in series}
        for point in series:
            if point["yoy_pct"] is None:
                continue
            year, month = map(int, point["date"].split("-"))
            prev_date = f"{year - 1:04d}-{month:02d}"
            prev_val = by_date.get(prev_date)
            if prev_val is not None and abs(prev_val) < MIN_TEMP_BASE_C:
                pytest.fail(f"{city_id} has YoY at {point['date']} with near-zero base {prev_val}")


def test_summary_consistency(graph):
    for city_id, city in graph["cities"].items():
        for metric in ("uv", "temperature"):
            series = city["series"].get(metric, [])
            summary = city["summary"].get(metric, {})
            if not series or not summary:
                continue
            df = pd.DataFrame(series)
            last_date = series[-1]["date"]
            month_str = last_date.split("-")[1]
            same_month = df[df["date"].str.endswith(f"-{month_str}")]
            if len(same_month) >= 2:
                sm_start = float(same_month.iloc[0]["value"])
                sm_end = float(same_month.iloc[-1]["value"])
                expected = (sm_end - sm_start) / sm_start * 100 if sm_start else None
            else:
                start = series[0]["value"]
                end = series[-1]["value"]
                expected = (end - start) / start * 100 if start else None
            if expected is not None:
                assert abs(summary["change_1993_to_2026_pct"] - expected) < 0.1


def test_cross_city_ordering(graph):
    def winter_mean(city_id):
        city = graph["cities"][city_id]
        df = pd.DataFrame(city["series"]["temperature"])
        df["month"] = df["date"].str[-2:].astype(int)
        return df[df["month"].isin([12, 1, 2])]["value"].mean()

    nyc = winter_mean("new-york-ny")
    covina = winter_mean("covina-ca")
    assert nyc < covina


def test_graph_meta_exists():
    meta_path = ROOT / "data" / "graph-meta.json"
    if not meta_path.exists():
        pytest.skip("graph-meta.json not found — run build_data.py first")
    with meta_path.open(encoding="utf-8") as f:
        meta = json.load(f)
    assert meta.get("metadata", {}).get("data_version", 0) >= 4
    assert len(meta.get("city_ids", [])) == 5
    for city_id in meta["city_ids"]:
        city_path = ROOT / "data" / "cities" / f"{city_id}.json"
        assert city_path.exists(), f"Missing per-city file for {city_id}"


def test_provenance():
    prov_path = ROOT / "data" / "provenance.json"
    if not prov_path.exists():
        pytest.skip("provenance.json not found")
    with prov_path.open(encoding="utf-8") as f:
        prov = json.load(f)
    assert "generated_at" in prov
    pd.Timestamp(prov["generated_at"])
    assert len(prov.get("sources", [])) >= 1
    source_ids = {s["id"] for s in prov["sources"]}
    assert "open_meteo_era5" in source_ids or "nasa_power" in source_ids
    assert len(prov.get("cities", [])) == 5
