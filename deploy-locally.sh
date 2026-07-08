#!/usr/bin/env bash
# deploy-locally.sh — Start all local services and open the primary URL.
#
# Environment variables:
#   PRIMARY_URL      — URL to open in browser (default: http://localhost:8080)
#   HEALTH_TIMEOUT   — Seconds to wait for primary URL (default: 30)
#   WEB_PORT         — Port for the static web server (default: 8080)
#
# Usage: ./deploy-locally.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

WEB_PORT="${WEB_PORT:-8080}"
PRIMARY_URL="${PRIMARY_URL:-http://localhost:${WEB_PORT}}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"

# Background PIDs to clean up on exit
PIDS=()

# --- logging ---

info()  { printf '\033[0;34m[INFO]\033[0m %s\n' "$*"; }
warn()  { printf '\033[0;33m[WARN]\033[0m %s\n' "$*"; }
error() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; }

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      info "Stopping background process $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

# --- helpers ---

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url"
  elif command -v start >/dev/null 2>&1; then
    start "$url"
  else
    warn "Could not detect browser opener. Open manually: $url"
    return 1
  fi
}

wait_for_url() {
  local url="$1"
  local timeout="${2:-30}"
  local elapsed=0

  case "$url" in
    file://*) return 0 ;;
    http://*|https://*) ;;
    *)
      warn "Skipping health check for unsupported URL scheme: $url"
      return 0
      ;;
  esac

  info "Waiting for $url (timeout: ${timeout}s)"
  while ! curl -sf "$url" >/dev/null 2>&1; do
    if (( elapsed >= timeout )); then
      error "Timed out waiting for $url"
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  info "Ready: $url"
}

start_background() {
  local cmd="$1"
  info "Starting: $cmd"
  bash -c "$cmd" &
  PIDS+=($!)
}

free_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    warn "lsof not found; cannot free port ${port}"
    return 1
  fi

  local pids
  pids="$(lsof -ti ":${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  info "Stopping process(es) on port ${port}: ${pids//$'\n'/ }"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true

  local elapsed=0
  while lsof -i ":${port}" -sTCP:LISTEN >/dev/null 2>&1; do
    if (( elapsed >= 5 )); then
      warn "Force-killing stubborn listener(s) on port ${port}"
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
      sleep 1
      break
    fi
    sleep 0.5
    elapsed=$((elapsed + 1))
  done
}

ensure_python_deps() {
  if python3 -c "import pandas, numpy, requests" 2>/dev/null; then
    return 0
  fi

  info "Installing Python dependencies..."
  python3 -m pip install -r "$REPO_ROOT/requirements.txt"
}

ensure_data() {
  local graph="$REPO_ROOT/web/data/knowledge_graph.json"
  local meta="$REPO_ROOT/web/data/graph-meta.json"
  local cities="$REPO_ROOT/web/data/cities.json"

  if [[ ! -f "$graph" || ! -f "$meta" || ! -f "$cities" ]]; then
    info "Building dashboard data (first run; ~30 seconds)..."
    if ! python3 "$REPO_ROOT/build_data.py"; then
      error "build_data.py failed. Fix errors above, then run: python3 build_data.py"
      exit 1
    fi
  else
    info "Using existing data. Run python3 build_data.py to refresh Open-Meteo/NASA data."
  fi
}

# --- services ---

start_services() {
  ensure_python_deps
  ensure_data

  if curl -sf "$PRIMARY_URL" >/dev/null 2>&1; then
    info "Web server already running at $PRIMARY_URL"
    return 0
  fi

  if command -v lsof >/dev/null 2>&1 && lsof -i ":${WEB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Port ${WEB_PORT} is in use but $PRIMARY_URL is not responding — restarting"
    free_port "$WEB_PORT"
  fi

  start_background "WEB_PORT=${WEB_PORT} python3 \"$REPO_ROOT/serve.py\""
}

# --- main ---

main() {
  info "Deploying locally from $REPO_ROOT"
  start_services
  wait_for_url "$PRIMARY_URL" "$HEALTH_TIMEOUT"
  open_url "$PRIMARY_URL"
  info "Done. Primary URL: $PRIMARY_URL"

  if ((${#PIDS[@]} > 0)); then
    info "Press Ctrl+C to stop background processes."
    wait
  else
    info "Using existing server; no background processes to manage."
  fi
}

main "$@"
