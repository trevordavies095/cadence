# Tempo export fixtures

## `tempo-export-mini.zip` (CI default)

Committed scrubbed Tempo full-export shape used by `tempoExportPort.test.ts` and `tempoExportFixture.test.ts`.

| Property | Value |
|----------|--------|
| Size | ~few KB (not the ~300MB athlete export) |
| Workouts | 3 synthetic (stable UUIDs) |
| Routes | Presence-only stubs (`workoutId` only — **no** `routeGeoJson`) |
| Media | Empty `media-metadata.json`; no `workouts/*/raw` FIT/GPX |
| Identity | `exportedBy: cadence-fixture`; no age/email/athlete name |

Export-backed TempoPort tests point at this zip by **path**, not `TEMPO_EXPORT_PATH`. CI does not need the full scratch export.

Source of truth for the pack lives in [`tempo-export-mini/`](./tempo-export-mini/) (JSON). Rebuild the zip after editing source:

```bash
cd api
node scripts/regenerate-tempo-export-mini.mjs
```

## `replay-packets/` (replay dry run)

Two hand-built weekly model packets, a stay-fit runner and a 10K runner, each carrying its goal and coaching block as the app builds them. `replay-weekly-reads.test.ts` runs `scripts/replay-weekly-reads.ts --packets tests/fixtures/replay-packets --dry-run` over them with the offline stub and expects every goal check to pass. Fictional athlete; no identity.

## `seasons/` (replay seasons)

Three six-week fictional seasons that are not marathon blocks, for replaying the weekly read (coaching-bias 25):

| Season | Goal | What happens |
|---|---|---|
| `1-stay-fit` | Stay fit | Four easy runs a week, 30 to 35 km, no races |
| `2-10k` | Riverside 10K (fictional), Nov 8 | One Threshold and one Intervals session a week; a 5K best at parkrun in week 4 |
| `3-return` | Return from a shin stress reaction | Walk-run from 15 minutes, one pain report (3/10) in week 3, 30 minutes continuous in week 6 |

Each `<n>-<id>.json` is the season script (goal, About you, every run as parts, every check-in); `<n>-<id>.zip` is its Tempo export, written by the demo's generator (`demo/generate-season-export.mjs`, sharing `demo/lib/tempoExport.mjs` with the demo season); `season-packets/` holds the packet each weekly read sent, built by the app itself. Regenerate all of it with:

```bash
cd api
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ai_coach_test \
  npx tsx scripts/regenerate-replay-seasons.ts
```

It plays each season through the app on the offline stub (goal, About you, then a Sunday check-in each week), against a test database it clears. The exports regenerate byte for byte; the packets differ only in week-session ids and About you version numbers. `replay-seasons.test.ts` checks the packets against the scripts and runs the replay dry run over `season-packets/`.

## Full athlete export (local only)

Keep real Tempo downloads under gitignored `.scratch/` (see repo root `.gitignore`). Example:

```bash
export TEMPO_EXPORT_PATH="$PWD/.scratch/tempo-export-….zip"
```

Do **not** commit full exports.

## Regenerate a scrubbed slice from an export

Stream a small scrubbed zip from a full export (drops route geometry, media files/metadata, and identity fields; remaps up to three workouts onto the stable CI UUIDs):

```bash
cd api
node scripts/regenerate-tempo-export-mini.mjs \
  --from-export ../.scratch/tempo-export.zip \
  --out ../.scratch/tempo-export-mini-scrubbed.zip \
  --limit 3 \
  --ts-per-workout 20
```

To refresh the **committed** CI pack from an export:

1. Slice as above with `--out` pointing at a scratch zip.
2. Manually align metrics/dates with what `tempoExportPort.test.ts` expects (fixed week 2026-W43 and synthetic names), **or** unpack into `tempo-export-mini/` and edit.
3. Prefer editing JSON under `tempo-export-mini/` then `node scripts/regenerate-tempo-export-mini.mjs` so the zip stays byte-rebuildable.

The synthetic CI source under `tempo-export-mini/` is the supported default; `--from-export` is for deriving scrubbed slices and occasional refreshes.
