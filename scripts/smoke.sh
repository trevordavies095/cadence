#!/usr/bin/env bash
# End-to-end health smoke against local Compose ports.
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:5002}"
FRONTEND_BASE="${FRONTEND_BASE:-http://localhost:3001}"
TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-120}"
INTERVAL_SEC=2

log() { printf '%s\n' "$*"; }
fail() { printf 'smoke FAIL: %s\n' "$*" >&2; exit 1; }

wait_for() {
  local url="$1"
  local label="$2"
  local elapsed=0
  log "Waiting for ${label} (${url})…"
  while true; do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "  ${label} is up"
      return 0
    fi
    if (( elapsed >= TIMEOUT_SEC )); then
      fail "${label} not ready within ${TIMEOUT_SEC}s"
    fi
    sleep "$INTERVAL_SEC"
    elapsed=$((elapsed + INTERVAL_SEC))
  done
}

assert_json_field() {
  local url="$1"
  local field="$2"
  local expected="$3"
  local body
  body="$(curl -sf "$url")" || fail "GET ${url}"
  local actual
  actual="$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('${field}',''))")"
  if [[ "$actual" != "$expected" ]]; then
    fail "${url}: expected ${field}=${expected}, got ${actual} (body=${body})"
  fi
  log "  OK ${url} → ${field}=${expected}"
}

wait_for "${API_BASE}/ready" "API ready"
wait_for "${FRONTEND_BASE}/health" "frontend health"

assert_json_field "${API_BASE}/health" "status" "healthy"
assert_json_field "${API_BASE}/ready" "status" "ready"

# Frontend rewrite proxies /api/* to the API service
assert_json_field "${FRONTEND_BASE}/api/health" "status" "healthy"

frontend_health="$(curl -sf "${FRONTEND_BASE}/health")" || fail "GET ${FRONTEND_BASE}/health"
frontend_status="$(printf '%s' "$frontend_health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")"
[[ "$frontend_status" == "healthy" ]] || fail "frontend /health status=${frontend_status}"
log "  OK ${FRONTEND_BASE}/health → status=healthy"

log "smoke PASS"
