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
