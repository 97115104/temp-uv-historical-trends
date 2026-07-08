# UV & Temperature Historical Trends

Multi-city dashboard for historical UV index and temperature trends. Defaults to **Covina, CA (91724)** with a default view from **November 1993** through the latest complete month.

**Live dashboard:** [97115104.github.io/covina-uv-historical-trends](https://97115104.github.io/covina-uv-historical-trends/) (deployed by CI on every push to `main` and monthly on the 1st).

## Cities

| City | Default |
|---|---|
| Covina, CA | Yes |
| Los Angeles, CA | |
| San Francisco, CA | |
| Seattle, WA | |
| New York, NY | |

You can also search for and add other cities in the browser (stored in `localStorage` for that device).

## Features

- **Natural-language queries** — e.g. “UV in Covina since 1993, month by month” or “Compare summer UV: Los Angeles vs Seattle”
- **Plain-language summaries** — short trend readouts for UV and temperature before diving into charts
- **Month-by-month timeline** with adjustable date range (default Nov 1993 – latest data)
- **Same-month across-years** comparison
- **Year-over-year change** charts (UV in %, temperature in °F/°C)
- **Compare up to 5 cities** side-by-side
- **Add cities** via search or geolocation (in-browser; built-in cities ship with the site)
- **Collapsible charts** — summaries first, charts on demand

## Data sources

| Metric | Source | Coverage |
|---|---|---|
| Temperature | [Open-Meteo ERA5](https://open-meteo.com/en/docs/historical-weather-api) reanalysis | 1981–present |
| UV (2021+) | [Open-Meteo Historical Forecast](https://open-meteo.com/en/docs/historical-forecast-api) (WHO UV Index) | 2021–present |
| UV (2001–2020) | [NASA POWER](https://power.larc.nasa.gov/) `ALLSKY_SFC_UV_INDEX`, adjusted to WHO scale | 2001–2020 |

Values reflect the latest **complete calendar month** (typically a 1-week to 1-month lag), not live conditions.

## Local development

```bash
./deploy-locally.sh
```

This installs Python dependencies if needed, runs `build_data.py` on first launch when data is missing, serves the static app at [http://localhost:8080](http://localhost:8080), and opens it in your browser. Press Ctrl+C to stop the server.

Optional manual steps:

```bash
python3 build_data.py          # refresh Open-Meteo / NASA data
pytest tests/ -v
npm install && npm run attest   # create attestation via attest.97115104.com
```

`serve.py` also proxies NASA POWER for in-browser city adds during local development.

## GitHub Pages deployment

Deployment is fully automated via [`.github/workflows/build-and-deploy.yml`](.github/workflows/build-and-deploy.yml).

### One-time setup

1. Open the repo on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions** (not “Deploy from a branch”).
3. Push to `main`, or run **Actions → Build and Deploy → Run workflow**.

The workflow will:

1. Fetch temperature and UV data (`build_data.py`)
2. Run tests (`pytest`)
3. Create a data attestation (`npm run attest`)
4. Build the static site from `web/` and deploy it to GitHub Pages

After the first successful run, the site is live at:

**https://97115104.github.io/covina-uv-historical-trends/**

Data is also rebuilt automatically on the **1st of each month** (12:00 UTC). Updated `data/` and `web/data/` artifacts are committed back to `main` with `[skip ci]` so only the deploy step runs on those commits.

## Adding a built-in city

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

CI rebuilds all cities and redeploys GitHub Pages. For a one-off local comparison, use **+ Add a city** in the dashboard instead.

## Attestation

Data outputs are attested using [attest](https://attest.97115104.com) (Cursor + Auto). A verify link is embedded in the dashboard footer after `npm run attest`.

## Project structure

```
build_data.py         # Open-Meteo + NASA POWER pipeline → knowledge graph JSON
cities.json           # Built-in city registry
serve.py              # Local static server + NASA POWER proxy
web/                  # Static dashboard (Chart.js)
  app.js              # Main UI and charts
  intent.js           # Offline natural-language query parser
  cityAdd.js          # In-browser city search and data fetch
  summary.js          # Plain-language trend summaries
tests/                # Data validation
scripts/attest.mjs    # Attestation script
.github/workflows/    # CI build, test, attest, and GitHub Pages deploy
```
