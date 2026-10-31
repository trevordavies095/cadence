/**
 * The machinery behind a synthetic Tempo full export: seeded randomness, stable ids, one
 * workout (laps, a time series, heart rate, elevation, weather) from a list of segments,
 * the export's files, and a deterministic zip. Shared by the demo season
 * (demo/generate-tempo-export.mjs) and the replay seasons
 * (api/tests/fixtures/seasons/generate.mjs). Same shape as
 * api/tests/fixtures/tempo-export-mini. Packing needs the `zip` CLI.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const M_PER_MILE = 1609.344;

/** A seeded generator in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal draws, mean 0, sd 1, from a generator. */
export const gaussFrom = (rand) => () => rand() + rand() + rand() + rand() - 2;

/** A uuid-shaped id that is stable for a key within a namespace. */
export function uuidIn(namespace) {
  return (key) => {
    const h = createHash("sha1").update(`${namespace}:${key}`).digest("hex");
    const variant = "89ab"[parseInt(h[16], 16) % 4];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

/** One stretch of a run: distance, seconds per mile, target heart rate, label. */
export const seg = (distM, secPerMile, hr, label = "easy") => ({ distM, secPerMile, hr, label });

/** A rolling profile that differs run to run (own phase and amplitude). */
function elevationAt(distM, profile) {
  return (
    profile.base +
    profile.amp * Math.sin((distM + profile.phase) / 1200) +
    3 * Math.sin((distM + profile.phase) / 370)
  );
}

/**
 * Returns buildWorkout(spec), which turns a run's segments into a Tempo workout with
 * private `_splits` and `_timeSeries`. Every random draw comes from `rand`, in a fixed
 * order, so a seeded season is reproducible.
 *
 * - `shoeFor(quality)`: the shoe a run of that quality wears.
 * - `tempCFor(week)`: the week's mean temperature in C.
 * - `sampleEveryS`: time-series spacing in seconds.
 * - `source`: the export's source and device label.
 */
export function createWorkoutBuilder({ rand, uuid, shoeFor, tempCFor, sampleEveryS = 30, source = "demo" }) {
  const gauss = gaussFrom(rand);
  return function buildWorkout({ key, startedAt, name, runType, segments, week, quality, notes, stops = 0 }) {
    const id = uuid(`workout-${key}`);
    const profile = { base: 30 + rand() * 25, amp: 7 + rand() * 9, phase: rand() * 7000 };
    const distanceM = Math.round(segments.reduce((a, s) => a + s.distM, 0));
    const segTimes = segments.map((s) => (s.distM / M_PER_MILE) * s.secPerMile);
    const movingTimeS = Math.round(segTimes.reduce((a, b) => a + b, 0));
    const durationS = movingTimeS + stops;

    // Cumulative bounds per segment on the elapsed clock.
    let t0 = 0;
    let d0 = 0;
    const bounds = segments.map((s, i) => {
      const b = { t0, t1: t0 + segTimes[i], d0, d1: d0 + s.distM };
      t0 = b.t1;
      d0 = b.d1;
      return b;
    });

    // Splits: one lap per segment (mile laps for steady running, reps/jogs as run).
    const splits = segments.map((s, idx) => ({
      id: uuid(`split-${key}-${idx}`),
      workoutId: id,
      kind: "lap",
      idx,
      distanceM: Math.round(s.distM),
      durationS: Math.round(segTimes[idx]),
      paceS: Math.round(segTimes[idx] / (s.distM / 1000)),
      avgHeartRateBpm: Math.round(s.hr + gauss() * 1.5),
      startElapsedS: Math.round(bounds[idx].t0),
      endElapsedS: Math.round(bounds[idx].t1),
      startDistanceM: Math.round(bounds[idx].d0),
      workout: null,
    }));

    // Time series: HR follows the segment target with a lag and a little noise.
    const timeSeries = [];
    let hr = segments[0].hr - 18;
    let si = 0;
    let elevGainM = 0;
    let prevEl = elevationAt(0, profile);
    const hrValues = [];
    for (let t = 0; t <= movingTimeS; t += sampleEveryS) {
      while (si < segments.length - 1 && t > bounds[si].t1) si += 1;
      const s = segments[si];
      const b = bounds[si];
      const within = (t - b.t0) / Math.max(b.t1 - b.t0, 1);
      const distM = Math.min(b.d0 + within * s.distM, distanceM);
      hr += (s.hr - hr) * 0.22 + gauss() * 0.9;
      const bpm = Math.round(hr);
      hrValues.push(bpm);
      const el = elevationAt(distM, profile);
      if (t > 0 && el > prevEl) elevGainM += el - prevEl;
      prevEl = el;
      const hard = s.label === "rep" || s.label === "tempo" || s.label === "mp";
      timeSeries.push({
        id: uuid(`ts-${key}-${t}`),
        workoutId: id,
        elapsedSeconds: t,
        distanceM: Math.round(distM),
        heartRateBpm: bpm,
        cadenceRpm: Math.round((hard ? 181 : 172) + gauss() * 2),
        speedMps: Number((M_PER_MILE / s.secPerMile).toFixed(2)),
        elevationM: Number(el.toFixed(1)),
        workout: null,
      });
    }

    const avgHr = Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length);
    const minutes = durationS / 60;
    const intensity = { easy: 0.7, tempo: 1.5, mp: 1.3, reps: 1.6 }[quality] ?? 0.7;
    const shoe = shoeFor(quality);

    return {
      id,
      startedAt,
      durationS,
      distanceM,
      avgPaceS: Math.round(durationS / (distanceM / 1000)),
      elevGainM: Math.round(elevGainM),
      movingTimeS,
      maxHeartRateBpm: Math.max(...hrValues) + 2,
      avgHeartRateBpm: avgHr,
      minHeartRateBpm: Math.min(...hrValues),
      relativeEffort: Math.round(minutes * intensity),
      name,
      runType,
      notes: notes ?? null,
      source,
      device: source,
      shoeId: shoe.id,
      shoe,
      splits: [],
      timeSeries: [],
      weather: { tempC: tempCFor(week) + Math.round(gauss() * 2) },
      _splits: splits,
      _timeSeries: timeSeries,
    };
  };
}

/**
 * The export's files, keyed by path inside the zip. `workouts` are buildWorkout results
 * (an extra `week` field is dropped); `settings` is data/settings.json.
 */
export function buildExportFiles({ workouts, shoes, uuid, settings, exportDate, tempoVersion, exportedBy, note, bestEfforts = [] }) {
  const splits = workouts.flatMap((w) => w._splits);
  const timeSeries = workouts.flatMap((w) => w._timeSeries);
  const clean = workouts.map(({ week, _splits, _timeSeries, ...w }) => w);
  const routes = clean.map((w) => ({ id: uuid(`route-${w.id}`), workoutId: w.id }));

  return {
    "manifest.json": {
      version: "1.0.0",
      tempoVersion,
      exportDate,
      exportedBy,
      statistics: {
        settings: 1,
        shoes: shoes.length,
        workouts: clean.length,
        routes: routes.length,
        splits: splits.length,
        timeSeries: timeSeries.length,
        mediaFiles: 0,
        bestEfforts: bestEfforts.length,
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
        note,
        routes: "presence-only (workoutId stubs; no routeGeoJson)",
        media: "empty",
        identity: "none",
      },
    },
    "data/settings.json": settings,
    "data/shoes.json": shoes,
    "data/workouts.json": clean,
    "data/splits.json": splits,
    "data/time-series.json": timeSeries,
    "data/routes.json": routes,
    "data/media-metadata.json": [],
    "data/best-efforts.json": bestEfforts,
  };
}

/** Writes the files into a zip with fixed timestamps and sorted entries; returns its path. */
export function packZip(files, outZip, fixedAt) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-tempo-"));
  try {
    const names = Object.keys(files).sort();
    const fixed = new Date(fixedAt);
    for (const name of names) {
      const file = path.join(tmp, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(files[name])}\n`, "utf8");
      fs.utimesSync(file, fixed, fixed);
    }
    const abs = path.resolve(outZip);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    const result = spawnSync("zip", ["-q", "-X", "-D", abs, ...names], {
      cwd: tmp,
      stdio: "inherit",
      env: { ...process.env, TZ: "UTC" },
    });
    if (result.status !== 0) throw new Error(`zip failed with status ${result.status}`);
    return abs;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
