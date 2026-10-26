#!/usr/bin/env node
/**
 * Pack or derive the CI scrubbed Tempo export mini fixture.
 *
 * Pack (default) — rebuild zip from committed JSON source:
 *   node scripts/regenerate-tempo-export-mini.mjs
 *
 * Slice from a full Tempo export (streams; no media/GPS geometry/identity):
 *   node scripts/regenerate-tempo-export-mini.mjs \
 *     --from-export ../.scratch/tempo-export-….zip \
 *     --out ../.scratch/tempo-export-mini-scrubbed.zip
 *
 * Optional: --limit N (default 3), --ts-per-workout N (default 20)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open as yauzlOpen } from "yauzl";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { ignore } from "stream-json/filters/ignore.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(API_ROOT, "tests/fixtures/tempo-export-mini");
const DEFAULT_ZIP = path.join(
  API_ROOT,
  "tests/fixtures/tempo-export-mini.zip",
);

const WORKOUT_IGNORE =
  /^(?:\d+\.)?(?:rawFitData|rawGpxData|rawFileData|rawStravaData|rawHealthKitData|rawFileName|rawFileType|route|media|externalIdentities|timeSeries|splits|healthKitUuid)\b/;
const ROUTE_IGNORE = /^(?:\d+\.)?routeGeoJson\b/;

function usage(code = 0) {
  console.log(`Usage:
  node scripts/regenerate-tempo-export-mini.mjs [--out PATH]
  node scripts/regenerate-tempo-export-mini.mjs --from-export PATH [--out PATH] [--limit N] [--ts-per-workout N]
`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    fromExport: null,
    out: DEFAULT_ZIP,
    limit: 3,
    tsPerWorkout: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--from-export") opts.fromExport = argv[++i];
    else if (a === "--out") opts.out = path.resolve(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--ts-per-workout") opts.tsPerWorkout = Number(argv[++i]);
    else {
      console.error(`Unknown arg: ${a}`);
      usage(1);
    }
  }
  if (!Number.isFinite(opts.limit) || opts.limit < 1) {
    console.error("--limit must be a positive number");
    process.exit(1);
  }
  return opts;
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzlOpen(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("open failed"));
      else resolve(zip);
    });
  });
}

function listDataEntries(zip) {
  const entries = new Map();
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve(entries));
    zip.on("entry", (entry) => {
      if (entry.fileName.startsWith("data/") || entry.fileName === "manifest.json") {
        entries.set(entry.fileName, entry);
      }
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error("read failed"));
      else resolve(stream);
    });
  });
}

async function readEntryText(zip, entry) {
  const stream = await openEntryStream(zip, entry);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function* streamJsonArray(stream, ignoreFilter) {
  const stages = [stream, parser()];
  if (ignoreFilter) stages.push(ignore({ filter: ignoreFilter }));
  stages.push(streamArray());
  const pipeline = chain(stages);
  for await (const item of pipeline) {
    yield item.value;
  }
}

function asRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function packDirectory(sourceDir, outZip) {
  if (!fs.existsSync(path.join(sourceDir, "manifest.json"))) {
    throw new Error(`missing source manifest: ${sourceDir}`);
  }
  if (!fs.existsSync(path.join(sourceDir, "data/workouts.json"))) {
    throw new Error(`missing source workouts: ${sourceDir}/data/workouts.json`);
  }
  const absOut = path.resolve(outZip);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  if (fs.existsSync(absOut)) fs.unlinkSync(absOut);
  // Absolute -out path: relative paths from a temp sourceDir can escape badly.
  const result = spawnSync(
    "zip",
    ["-q", "-r", absOut, "manifest.json", "data"],
    { cwd: sourceDir, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`zip failed with status ${result.status}`);
  }
  const size = fs.statSync(absOut).size;
  console.log(`Packed ${absOut} (${size} bytes)`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function scrubSettings(raw) {
  const rec = asRecord(raw) ?? {};
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    calculationMethod: rec.calculationMethod ?? 2,
    unitPreference: rec.unitPreference ?? "metric",
    defaultShoeId: null,
    zone1MinBpm: rec.zone1MinBpm ?? null,
    zone1MaxBpm: rec.zone1MaxBpm ?? null,
    zone2MinBpm: rec.zone2MinBpm ?? null,
    zone2MaxBpm: rec.zone2MaxBpm ?? null,
    zone3MinBpm: rec.zone3MinBpm ?? null,
    zone3MaxBpm: rec.zone3MaxBpm ?? null,
    zone4MinBpm: rec.zone4MinBpm ?? null,
    zone4MaxBpm: rec.zone4MaxBpm ?? null,
    zone5MinBpm: rec.zone5MinBpm ?? null,
    zone5MaxBpm: rec.zone5MaxBpm ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function scrubShoe(raw, index) {
  const rec = asRecord(raw) ?? {};
  return {
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, "0")}`,
    brand: typeof rec.brand === "string" ? rec.brand : "Fixture",
    model: typeof rec.model === "string" ? rec.model : `Shoe ${index + 1}`,
    initialMileageM: 0,
    isRetired: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workouts: [],
  };
}

function scrubWorkout(raw, stableId) {
  const rec = asRecord(raw) ?? {};
  return {
    id: stableId,
    startedAt: rec.startedAt,
    durationS: rec.durationS,
    distanceM: rec.distanceM,
    avgPaceS: rec.avgPaceS,
    elevGainM: rec.elevGainM ?? 0,
    movingTimeS: rec.movingTimeS ?? rec.durationS,
    maxHeartRateBpm: rec.maxHeartRateBpm ?? null,
    avgHeartRateBpm: rec.avgHeartRateBpm ?? null,
    minHeartRateBpm: rec.minHeartRateBpm ?? null,
    relativeEffort: rec.relativeEffort ?? null,
    name: typeof rec.name === "string" ? rec.name.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "[redacted]") : "Workout",
    runType: rec.runType ?? null,
    notes: "fixture note",
    source: "export-slice",
    device: "fixture",
    shoeId: null,
    splits: [],
    timeSeries: [],
    // Synthetic leak markers so TempoPort strip tests stay meaningful if this becomes the CI pack.
    rawGpxData: "SHOULD_NOT_LEAK",
    rawFitData: "SHOULD_NOT_LEAK",
    rawFileData: "SHOULD_NOT_LEAK",
  };
}

async function sliceFromExport(exportPath, outZip, limit, tsPerWorkout) {
  const abs = path.resolve(exportPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`export not found: ${abs}`);
  }
  console.log(`Slicing scrubbed mini from ${abs} (limit=${limit})…`);

  const zip = await openZip(abs);
  try {
    const entries = await listDataEntries(zip);
    const workoutsEntry = entries.get("data/workouts.json");
    if (!workoutsEntry) throw new Error("export missing data/workouts.json");

    const candidates = [];
    for await (const raw of streamJsonArray(
      await openEntryStream(zip, workoutsEntry),
      WORKOUT_IGNORE,
    )) {
      const rec = asRecord(raw);
      if (!rec || typeof rec.id !== "string") continue;
      if (typeof rec.startedAt !== "string") continue;
      if (typeof rec.distanceM !== "number" || typeof rec.durationS !== "number") {
        continue;
      }
      candidates.push(rec);
    }
    candidates.sort(
      (a, b) => Date.parse(String(b.startedAt)) - Date.parse(String(a.startedAt)),
    );
    const selected = candidates.slice(0, limit);
    if (selected.length === 0) {
      throw new Error("no suitable workouts found in export");
    }

    // Prefer well-known CI ids so a 3-workout slice can refresh the committed pack.
    const CI_IDS = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const idMap = new Map();
    selected.forEach((w, i) => {
      idMap.set(
        w.id,
        CI_IDS[i] ??
          `ffffffff-ffff-4fff-8fff-${String(i + 1).padStart(12, "0")}`,
      );
    });

    const selectedIds = new Set(selected.map((w) => w.id));
    const scrubbedWorkouts = selected.map((w) => scrubWorkout(w, idMap.get(w.id)));

    const splits = [];
    const splitsEntry = entries.get("data/splits.json");
    if (splitsEntry) {
      for await (const raw of streamJsonArray(
        await openEntryStream(zip, splitsEntry),
        /^(?:\d+\.)?workout\b/,
      )) {
        const rec = asRecord(raw);
        if (!rec || !selectedIds.has(rec.workoutId)) continue;
        splits.push({
          id: rec.id ?? cryptoRandom(),
          workoutId: idMap.get(rec.workoutId),
          kind: rec.kind ?? "lap",
          idx: rec.idx ?? 0,
          distanceM: rec.distanceM ?? null,
          durationS: rec.durationS ?? null,
          paceS: rec.paceS ?? null,
          avgHeartRateBpm: rec.avgHeartRateBpm ?? null,
          startElapsedS: rec.startElapsedS ?? null,
          endElapsedS: rec.endElapsedS ?? null,
          startDistanceM: rec.startDistanceM ?? null,
          workout: null,
        });
      }
    }

    const timeSeries = [];
    const counts = new Map();
    const tsEntry = entries.get("data/time-series.json");
    if (tsEntry) {
      for await (const raw of streamJsonArray(
        await openEntryStream(zip, tsEntry),
        /^(?:\d+\.)?workout\b/,
      )) {
        const rec = asRecord(raw);
        if (!rec || !selectedIds.has(rec.workoutId)) continue;
        if (rec.heartRateBpm == null) continue;
        const n = counts.get(rec.workoutId) ?? 0;
        if (n >= tsPerWorkout) continue;
        counts.set(rec.workoutId, n + 1);
        timeSeries.push({
          id: rec.id ?? cryptoRandom(),
          workoutId: idMap.get(rec.workoutId),
          elapsedSeconds: rec.elapsedSeconds ?? null,
          distanceM: rec.distanceM ?? null,
          heartRateBpm: rec.heartRateBpm ?? null,
          cadenceRpm: rec.cadenceRpm ?? null,
          speedMps: rec.speedMps ?? null,
          elevationM: rec.elevationM ?? null,
          workout: null,
        });
      }
    }

    const routeStubs = [];
    const routesEntry = entries.get("data/routes.json");
    if (routesEntry) {
      for await (const raw of streamJsonArray(
        await openEntryStream(zip, routesEntry),
        ROUTE_IGNORE,
      )) {
        const rec = asRecord(raw);
        if (!rec || !selectedIds.has(rec.workoutId)) continue;
        routeStubs.push({
          id: rec.id ?? cryptoRandom(),
          workoutId: idMap.get(rec.workoutId),
        });
      }
    }

    let settingsRaw = {};
    const settingsEntry = entries.get("data/settings.json");
    if (settingsEntry) {
      settingsRaw = JSON.parse(await readEntryText(zip, settingsEntry));
    }
    const settings = scrubSettings(settingsRaw);

    let shoesRaw = [];
    const shoesEntry = entries.get("data/shoes.json");
    if (shoesEntry) {
      const parsed = JSON.parse(await readEntryText(zip, shoesEntry));
      shoesRaw = Array.isArray(parsed) ? parsed.slice(0, 1) : [];
    }
    const shoes = shoesRaw.map((s, i) => scrubShoe(s, i));
    if (shoes[0]) settings.defaultShoeId = shoes[0].id;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-mini-"));
    try {
      writeJson(path.join(tmp, "manifest.json"), {
        version: "1.0.0",
        tempoVersion: "export-slice",
        exportDate: new Date().toISOString(),
        exportedBy: "cadence-fixture",
        statistics: {
          settings: 1,
          shoes: shoes.length,
          workouts: scrubbedWorkouts.length,
          routes: routeStubs.length,
          splits: splits.length,
          timeSeries: timeSeries.length,
          mediaFiles: 0,
          bestEfforts: 0,
        },
        dataFormat: {
          settings: "data/settings.json",
          shoes: "data/shoes.json",
          workouts: "data/workouts.json",
          routes: "data/routes.json",
          splits: "data/splits.json",
          timeSeries: "data/time-series.json",
          mediaMetadata: "data/media-metadata.json",
          bestEfforts: "data/best-efforts.json",
        },
        scrub: {
          note: "Derived scrubbed slice: no route geometry, no media, no identity PII",
          sourceExport: path.basename(abs),
        },
      });
      writeJson(path.join(tmp, "data/settings.json"), settings);
      writeJson(path.join(tmp, "data/shoes.json"), shoes);
      writeJson(path.join(tmp, "data/workouts.json"), scrubbedWorkouts);
      writeJson(path.join(tmp, "data/splits.json"), splits);
      writeJson(path.join(tmp, "data/time-series.json"), timeSeries);
      writeJson(path.join(tmp, "data/routes.json"), routeStubs);
      writeJson(path.join(tmp, "data/media-metadata.json"), []);
      writeJson(path.join(tmp, "data/best-efforts.json"), []);
      packDirectory(tmp, outZip);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    zip.close();
  }
}

function cryptoRandom() {
  return "eeeeeeee-eeee-4eee-8eee-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.fromExport) {
    await sliceFromExport(
      opts.fromExport,
      opts.out,
      opts.limit,
      opts.tsPerWorkout,
    );
  } else {
    packDirectory(SOURCE_DIR, opts.out);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
