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
        assert series[0]["date"] == "1993-11"
        assert series[-1]["date"] >= "2025-01"


def test_no_null_gaps_temperature(graph):
    for city_id, city in graph["cities"].items():
        series = city["series"]["temperature"]
        dates = pd.date_range(series[0]["date"] + "-01", series[-1]["date"] + "-01", freq="MS")
        actual = {p["date"] for p in series}
        expected = {d.strftime("%Y-%m") for d in dates}
        missing = expected - actual
        assert len(missing) <= 1, f"{city_id} missing months: {sorted(missing)[:5]}"


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
            expected = (point["value"] - by_date[prev_date]) / by_date[prev_date] * 100
            assert abs(point["yoy_pct"] - expected) < 0.05, f"{city_id} YoY mismatch {point['date']}"


def test_summary_consistency(graph):
    for city_id, city in graph["cities"].items():
        for metric in ("uv", "temperature"):
            series = city["series"].get(metric, [])
            summary = city["summary"].get(metric, {})
            if not series or not summary:
                continue
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


def test_provenance():
    prov_path = ROOT / "data" / "provenance.json"
    if not prov_path.exists():
        pytest.skip("provenance.json not found")
    with prov_path.open(encoding="utf-8") as f:
        prov = json.load(f)
    assert "generated_at" in prov
    pd.Timestamp(prov["generated_at"])
    assert len(prov.get("sources", [])) >= 1
    assert prov["sources"][0]["id"] == "nasa_power"
    assert len(prov.get("cities", [])) == 5
