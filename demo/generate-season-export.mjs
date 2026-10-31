#!/usr/bin/env node
/**
 * Generate a synthetic Tempo full export from a season script: the replay seasons in
 * api/tests/fixtures/seasons/ (fictional athletes, six weeks each). The demo season has
 * its own hand-tuned generator (generate-tempo-export.mjs); both share lib/tempoExport.mjs.
 *
 *   node demo/generate-season-export.mjs --season api/tests/fixtures/seasons/10k.json --out api/tests/fixtures/seasons/10k.zip
 *
 * A season script names the athlete's timezone offset, HR zones, shoes and weekly
 * temperatures, and lists each week's runs. A run is a day, a start time, a Tempo run type
 * and a list of parts; a part is `{ km | m | min, pace: "m:ss" per km, hr, label? }` or
 * `{ repeat: n, parts: [...] }`. Parts given in km are split into 1 km laps; the others are
 * one lap each. A run with `best: { distance, distanceM, previousTimeS }` adds an entry to
 * the export's best efforts, timed over its last `distanceM`.
 *
 * Deterministic: the season's seed, fixed zip timestamps and sorted entries give a
 * byte-identical zip on every run. Needs the `zip` CLI.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  M_PER_MILE,
  buildExportFiles,
  createWorkoutBuilder,
  gaussFrom,
  mulberry32,
  packZip,
  seg,
  uuidIn,
} from "./lib/tempoExport.mjs";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SAMPLE_EVERY_S = 60;

/** Seconds per km for "m:ss". */
export function paceSPerKm(text) {
  const m = /^(\d+):(\d{2})$/.exec(String(text));
  if (!m) throw new Error(`pace "${text}" is not m:ss`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The parts of a run with every repeat unrolled. */
export function flattenParts(parts) {
  return parts.flatMap((p) => (p.repeat ? Array.from({ length: p.repeat }, () => flattenParts(p.parts)).flat() : [p]));
}

/** Local date YYYY-MM-DD of a day in a season week (week 1 is the first). */
export function seasonDate(season, week, day) {
  const offset = DAYS.indexOf(day);
  if (offset < 0) throw new Error(`unknown day ${day}`);
  const ms = Date.parse(`${season.weekOneMonday}T00:00:00Z`) + ((week - 1) * 7 + offset) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC start of a run: its local date and time, the season's offset, a few minutes' jitter. */
function startIso(season, week, run, jitterMin) {
  const [hh, mm] = run.at.split(":").map(Number);
  const local = Date.parse(`${seasonDate(season, week, run.day)}T00:00:00Z`) + (hh * 60 + mm + jitterMin) * 60_000;
  return new Date(local - season.athlete.utcOffsetHours * 3_600_000).toISOString().replace(".000Z", "Z");
}

/** Which shoe and relative-effort weight a run type gets. */
function qualityOf(runType) {
  if (runType === "Threshold") return "tempo";
  if (runType === "Intervals" || runType === "Race") return "reps";
  return "easy";
}

export function buildSeasonFiles(season) {
  const rand = mulberry32(season.seed);
  const gauss = gaussFrom(rand);
  const uuid = uuidIn(`cadence-season-${season.id}`);
  const shoes = season.shoes.map((s) => ({
    id: uuid(`shoe-${s.key}`),
    brand: s.brand,
    model: s.model,
    initialMileageM: s.initialKm ? s.initialKm * 1000 : 0,
    isRetired: false,
    createdAt: "2026-06-01T12:00:00Z",
    updatedAt: "2026-06-01T12:00:00Z",
    workouts: [],
  }));
  const buildWorkout = createWorkoutBuilder({
    rand,
    uuid,
    shoeFor: (quality) => (quality === "easy" ? shoes[0] : shoes[shoes.length - 1]),
    tempCFor: (week) => season.tempC[week - 1],
    sampleEveryS: SAMPLE_EVERY_S,
    source: "cadence-fixture",
  });

  /** Segments for one part: km laps with a little pace noise, or a single lap. */
  const segmentsOf = (part) => {
    const secPerMile = paceSPerKm(part.pace) * (M_PER_MILE / 1000);
    const label = part.label ?? "easy";
    if (part.km !== undefined) {
      const out = [];
      let left = part.km * 1000;
      let i = 0;
      while (left > 1) {
        const d = Math.min(1000, left);
        out.push(seg(d, secPerMile * (1 + gauss() * 0.01), part.hr + (part.driftBpm ?? 0) * (i / Math.max(part.km, 1)), label));
        left -= d;
        i += 1;
      }
      return out;
    }
    const distM = part.m ?? (part.min * 60 * 1000) / paceSPerKm(part.pace);
    return [seg(distM, secPerMile * (1 + gauss() * 0.006), part.hr, label)];
  };

  const workouts = [];
  const bestEfforts = [];
  season.weeks.forEach((w, i) => {
    const week = i + 1;
    w.runs.forEach((run) => {
      const segments = flattenParts(run.parts).flatMap(segmentsOf);
      const startedAt = startIso(season, week, run, Math.round(gauss() * 6));
      const workout = buildWorkout({
        key: `${week}-${run.day}`,
        startedAt,
        week,
        name: run.name,
        runType: run.type,
        quality: qualityOf(run.type),
        segments,
        notes: run.notes,
        stops: run.stopsS ?? 0,
      });
      workouts.push({ week, ...workout });
      if (run.best) {
        // Time over the run's last distanceM (after any warm-up), from its laps.
        let t = 0;
        let left = run.best.distanceM;
        for (const s of [...segments].reverse()) {
          const d = Math.min(s.distM, left);
          t += (d / M_PER_MILE) * s.secPerMile;
          left -= d;
          if (left <= 0) break;
        }
        bestEfforts.push({
          distance: run.best.distance,
          distanceM: run.best.distanceM,
          timeS: Math.round(t),
          workoutId: workout.id,
          workoutDate: startedAt,
          previousTimeS: run.best.previousTimeS ?? null,
        });
      }
    });
  });
  workouts.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const [z1, z2, z3, z4, z5] = season.zones;
  const settings = {
    id: uuid("settings"),
    calculationMethod: 2,
    unitPreference: season.unitPreference,
    defaultShoeId: shoes[0].id,
    zone1MinBpm: z1[0],
    zone1MaxBpm: z1[1],
    zone2MinBpm: z2[0],
    zone2MaxBpm: z2[1],
    zone3MinBpm: z3[0],
    zone3MaxBpm: z3[1],
    zone4MinBpm: z4[0],
    zone4MaxBpm: z4[1],
    zone5MinBpm: z5[0],
    zone5MaxBpm: z5[1],
    createdAt: "2026-06-01T12:00:00Z",
    updatedAt: "2026-06-01T12:00:00Z",
  };
  const files = buildExportFiles({
    workouts,
    shoes,
    uuid,
    settings,
    exportDate: season.exportDate,
    tempoVersion: "fixture",
    exportedBy: "cadence-fixture",
    note: `Synthetic: fictional athlete, generated by demo/generate-season-export.mjs from ${season.id}.json`,
    bestEfforts,
  });
  return { files, workouts };
}

function weeklyTable(season, workouts) {
  const lines = ["week  starts      runs     km   min"];
  season.weeks.forEach((_, i) => {
    const runs = workouts.filter((w) => w.week === i + 1);
    const km = runs.reduce((a, w) => a + w.distanceM, 0) / 1000;
    const min = runs.reduce((a, w) => a + w.movingTimeS, 0) / 60;
    lines.push(`${String(i + 1).padStart(4)}  ${seasonDate(season, i + 1, "Mon")}  ${String(runs.length).padStart(4)}  ${km.toFixed(1).padStart(5)}  ${min.toFixed(0).padStart(4)}`);
  });
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  let seasonPath = null;
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--season") seasonPath = path.resolve(argv[++i]);
    else if (argv[i] === "--out") out = path.resolve(argv[++i]);
    else {
      console.error("Usage: node demo/generate-season-export.mjs --season FILE [--out PATH]");
      process.exit(argv[i] === "-h" || argv[i] === "--help" ? 0 : 1);
    }
  }
  if (!seasonPath) {
    console.error("Usage: node demo/generate-season-export.mjs --season FILE [--out PATH]");
    process.exit(1);
  }
  const season = JSON.parse(fs.readFileSync(seasonPath, "utf8"));
  out ??= seasonPath.replace(/\.json$/, ".zip");
  const { files, workouts } = buildSeasonFiles(season);
  const abs = packZip(files, out, season.exportDate);
  console.log(`${season.id}:\n${weeklyTable(season, workouts)}`);
  console.log(`${workouts.length} runs -> ${abs} (${fs.statSync(abs).size} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
