# UV & Temperature Historical Trends

Multi-city dashboard for historical UV index and temperature. Search for any city, use your location, and compare trends through the latest complete month.

**Live:** [97115104.github.io/temp-uv-historical-trends](https://97115104.github.io/temp-uv-historical-trends/)

## Run locally

```bash
./deploy-locally.sh
```

Opens [http://localhost:8080](http://localhost:8080). On first run it installs dependencies, fetches data if needed, and starts the server. Press Ctrl+C to stop.

To refresh data or run tests:

```bash
python3 build_data.py
pytest tests/ -v
```

## Data sources

| Metric | Source |
|---|---|
| Temperature | [Open-Meteo ERA5](https://open-meteo.com/en/docs/historical-weather-api) (1981–present) |
| UV (2021+) | [Open-Meteo Historical Forecast](https://open-meteo.com/en/docs/historical-forecast-api) |
| UV (2001–2020) | [NASA POWER](https://power.larc.nasa.gov/) `ALLSKY_SFC_UV_INDEX` |

Values reflect the latest **complete calendar month**, not live conditions. CI deploys on push to `main`; data is rebuilt monthly on the 1st.

## Attestation

This tool is [attested](https://attest.97115104.com/s/nhy04go8) with [attest](https://attest.97115104.com) as (Cursor + Auto).