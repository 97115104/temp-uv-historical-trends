#!/usr/bin/env python3
"""Serve the dashboard and proxy NASA POWER for in-browser city adds."""

from __future__ import annotations

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/nasa-power":
            self._proxy_nasa(parse_qs(parsed.query))
            return
        super().do_GET()

    def _proxy_nasa(self, query: dict[str, list[str]]) -> None:
        required = ("latitude", "longitude", "start", "end")
        if not all(query.get(key, [""])[0] for key in required):
            self._json_response(400, {"error": "latitude, longitude, start, and end are required."})
            return

        params = {
            "parameters": "T2M,ALLSKY_SFC_UV_INDEX",
            "community": "RE",
            "longitude": query["longitude"][0],
            "latitude": query["latitude"][0],
            "start": query["start"][0],
            "end": query["end"][0],
            "format": "JSON",
        }
        url = f"{NASA_POWER_URL}?{urlencode(params)}"
        try:
            with urlopen(Request(url, headers={"User-Agent": "covina-uv-historical-trends/1.0"}), timeout=120) as resp:
                payload = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            self._json_response(exc.code, {"error": "NASA POWER request failed.", "detail": body[:300]})
        except URLError as exc:
            self._json_response(502, {"error": "Could not reach NASA POWER.", "detail": str(exc.reason)})

    def _json_response(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        if str(args[0]).startswith("GET /api/nasa-power"):
            super().log_message(format, *args)


def main() -> None:
    port = int(os.environ.get("WEB_PORT", "8080"))
    server = ThreadingHTTPServer(("", port), DashboardHandler)
    print(f"Serving dashboard at http://localhost:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
