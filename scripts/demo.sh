#!/usr/bin/env bash
# Demo instance: Johnny Morrissey's fictional season, for screenshots and the README.
#
#   scripts/demo.sh up              restore the committed snapshot and open the app (free, no key)
#   scripts/demo.sh build [opts]    replay the season through the API and write a new snapshot
#
# build options:
#   --through-week N    play onboarding, weeks 1..N, and (N = 11) the Mon-Wed chat (default 11)
#   --from-week N       restore the checkpoint taken after week N-1 and replay from week N
#   --live              use the live model (needs ANTHROPIC_API_KEY; costs money). Default: stub.
#
# Uses the default compose stack (project "cadence"). Every wipe backs up the database
# to .scratch/backups/ first and aborts if the backup fails. Host ports follow
# POSTGRES_HOST_PORT / API_HOST_PORT / FRONTEND_HOST_PORT (defaults 5433 / 5002 / 3001).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.demo.yml)
PG_CONTAINER="cadence-postgres"
DB_NAME="ai_coach"
BACKUP_DIR=".scratch/backups"
SNAPSHOT="demo/snapshot.sql"
STUB_SNAPSHOT="demo/snapshot.stub.sql"
CLOCK_TAG="-- cadence-demo-clock: "
CHECKPOINT_ROOT=".scratch/demo-checkpoints"
TIMEOUT_SEC="${DEMO_TIMEOUT_SEC:-180}"

export API_HOST_PORT="${API_HOST_PORT:-5002}"
export FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-3001}"
export POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5433}"
export CADENCE_DEMO=1
export ATHLETE_TIMEZONE="America/New_York"
# Free by default. `build --live` and `up` set this explicitly; the internal subcommands that
# demo/build.mjs calls inherit it, so this must not overwrite a value that is already set.
export LLM_PROVIDER="${LLM_PROVIDER:-stub}"

log() { printf '%s\n' "$*"; }
die() { printf 'demo FAIL: %s\n' "$*" >&2; exit 1; }

wait_for() {
  local url="$1" label="$2" elapsed=0
  until curl -sf "$url" >/dev/null 2>&1; do
    (( elapsed < TIMEOUT_SEC )) || die "${label} not ready within ${TIMEOUT_SEC}s (${url})"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  log "  ${label} is up"
}

pg() { docker exec -i "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

start_postgres() {
  "${COMPOSE[@]}" up -d postgres
  local elapsed=0
  until docker exec "$PG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
    (( elapsed < TIMEOUT_SEC )) || die "postgres not ready within ${TIMEOUT_SEC}s"
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

# Dump the current database before anything destroys it. Aborts if the dump fails.
backup_db() {
  local exists
  exists="$(pg -d postgres -Atc "select 1 from pg_database where datname = '${DB_NAME}'")"
  if [[ -z "$exists" ]]; then
    log "No ${DB_NAME} database yet, nothing to back up"
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  local file="${BACKUP_DIR}/$(date +%Y%m%dT%H%M%S).sql"
  if ! docker exec "$PG_CONTAINER" pg_dump -U postgres --no-owner "$DB_NAME" > "${file}.partial"; then
    rm -f "${file}.partial"
    die "backup failed, nothing was wiped"
  fi
  [[ -s "${file}.partial" ]] || { rm -f "${file}.partial"; die "backup is empty, nothing was wiped"; }
  mv "${file}.partial" "$file"
  log "Backed up ${DB_NAME} to ${file}"
}

reset_db() {
  "${COMPOSE[@]}" stop api frontend >/dev/null 2>&1 || true
  pg -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)"
  pg -d postgres -c "CREATE DATABASE ${DB_NAME}"
  log "Reset ${DB_NAME}"
}

# (Re)create the API container with "now" pinned to $1 (ISO instant), and the live model's
# thinking effort to $2 when given. The clock is read once at startup, so every change of
# fictional time is a restart.
start_api() {
  ANTHROPIC_EFFORT="${2:-}" DEV_CLOCK_NOW="$1" "${COMPOSE[@]}" up -d --no-deps --force-recreate api >/dev/null
  wait_for "http://localhost:${API_HOST_PORT}/ready" "API (clock ${1}${2:+, effort ${2}})"
}

restore_snapshot() {
  pg -d "$DB_NAME" < "$1"
  log "Restored $1"
}

# dump_snapshot FILE CLOCK
dump_snapshot() {
  local file="$1" clock="$2" tmp="$1.partial"
  mkdir -p "$(dirname "$file")"
  if ! { printf '%s%s\n' "$CLOCK_TAG" "$clock"; docker exec "$PG_CONTAINER" pg_dump -U postgres --no-owner --no-privileges "$DB_NAME"; } > "$tmp"; then
    rm -f "$tmp"
    die "snapshot dump failed"
  fi
  mv "$tmp" "$file"
  log "Wrote ${file} (clock ${clock})"
}

cmd_up() {
  local snapshot="$SNAPSHOT"
  if [[ ! -f "$snapshot" ]]; then
    [[ -f "$STUB_SNAPSHOT" ]] || die "no snapshot found. Run: scripts/demo.sh build"
    snapshot="$STUB_SNAPSHOT"
    log "WARNING: ${SNAPSHOT} not found, using the stub snapshot ${STUB_SNAPSHOT}"
  fi
  local clock
  clock="$(sed -n "s/^${CLOCK_TAG}//p" "$snapshot" | head -1)"
  [[ -n "$clock" ]] || die "${snapshot} has no '${CLOCK_TAG}' header"

  start_postgres
  backup_db
  reset_db
  restore_snapshot "$snapshot"

  export LLM_PROVIDER=stub
  export DEV_CLOCK_NOW="$clock"
  "${COMPOSE[@]}" up -d --build api frontend
  wait_for "http://localhost:${API_HOST_PORT}/ready" "API"
  wait_for "http://localhost:${FRONTEND_HOST_PORT}/health" "frontend"
  log ""
  log "Demo is up at http://localhost:${FRONTEND_HOST_PORT} (clock ${clock})"
}

cmd_build() {
  local through=11 from=0 live=0
  while (( $# )); do
    case "$1" in
      --through-week) through="${2:?--through-week needs a number}"; shift 2 ;;
      --from-week) from="${2:?--from-week needs a number}"; shift 2 ;;
      --live) live=1; shift ;;
      *) die "unknown build option: $1" ;;
    esac
  done

  local mode=stub
  export LLM_PROVIDER=stub
  if (( live )); then
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] || die "--live needs ANTHROPIC_API_KEY in the environment"
    mode=live
    export LLM_PROVIDER=anthropic
  fi
  local checkpoint_dir="${CHECKPOINT_ROOT}/${mode}"

  # --from-week N resumes from the checkpoint taken after week N-1 (00 = after onboarding).
  local checkpoint=""
  if (( from > 0 )); then
    checkpoint="${checkpoint_dir}/week-$(printf '%02d' $((from - 1))).sql"
    [[ -f "$checkpoint" ]] || die "no checkpoint ${checkpoint}. Run a full build first."
  fi

  start_postgres
  backup_db
  reset_db
  [[ -z "$checkpoint" ]] || restore_snapshot "$checkpoint"
  "${COMPOSE[@]}" build api
  exec node demo/build.mjs --through-week "$through" --from-week "$from" --checkpoints "$checkpoint_dir"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  build) shift; cmd_build "$@" ;;
  # Internal: called by demo/build.mjs.
  _clock) start_api "${2:?clock required}" "${3:-}" ;;
  _dump) dump_snapshot "${2:?file required}" "${3:?clock required}" ;;
  # Run SQL from stdin against the demo database (prints rows, no headers).
  _sql) pg -d "$DB_NAME" -At ;;
  *)
    sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
