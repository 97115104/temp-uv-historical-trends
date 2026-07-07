# UV & Temperature Historical Trends

Multi-city dashboard for historical UV index and temperature trends from **November 1993** to the present. Defaults to **Covina, CA (91724)**.

**Live dashboard:** Enable GitHub Pages from the `docs/` folder after the first CI run.

## Cities

| City | Default |
|---|---|
| Covina, CA | Yes |
| Los Angeles, CA | |
| San Francisco, CA | |
| Seattle, WA | |
| New York, NY | |

## Features

- Month-by-month timeline with adjustable date range (default Nov 1993 – latest NASA data)
- Same-month across-years comparison
- Year-over-year % change charts
- Compare up to 5 cities side-by-side

## Data source

All data comes from [NASA POWER](https://power.larc.nasa.gov/):

| Parameter | Description | Coverage |
|---|---|---|
| `T2M` | Monthly mean 2m air temperature (°C) | 1981–present |
| `ALLSKY_SFC_UV_INDEX` | All-sky surface UV index | ~2010–present |

## Local development

```bash
./deploy-locally.sh
```

This installs Python dependencies if needed, builds dashboard data on first run, serves the static app at [http://localhost:8080](http://localhost:8080), and opens it in your browser. Press Ctrl+C to stop the server.

Optional manual steps:

```bash
pytest tests/ -v
npm install && npm run attest   # create attestation via attest.97115104.com
```

## Adding a city

Add an entry to [`cities.json`](cities.json) and open a PR:

```json
{
  "id": "miami-fl",
  "name": "Miami",
  "region": "FL",
  "country": "US",
  "lat": 25.7617,
  "lon": -80.1918
}
```

CI rebuilds all cities from NASA POWER and redeploys GitHub Pages.

## Attestation

Data outputs are attested using [attest](https://attest.97115104.com) (Cursor + Auto). Verify URL is embedded in the dashboard footer after `npm run attest`.

## Project structure

```
build_data.py       # NASA POWER pipeline → knowledge graph JSON
cities.json         # City registry
web/                # Static dashboard (Chart.js)
tests/              # Data validation
scripts/attest.mjs  # Attestation script
docs/               # GitHub Pages output (CI-generated)
```
