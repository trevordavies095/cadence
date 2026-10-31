#!/usr/bin/env node
/**
 * Generate the synthetic Tempo full export for the demo athlete, Johnny Morrissey
 * (fictional): four easy base weeks from Mon Jul 6, then the marathon block from Mon Aug 3
 * to the morning of Wed Oct 14 2026.
 * Spec: .scratch/demo-instance/spec.md ("The story", component 2).
 *
 *   node demo/generate-tempo-export.mjs [--out demo/tempo-export.zip]
 *
 * Deterministic: fixed seed, fixed zip timestamps, sorted entries, so reruns give a
 * byte-identical zip. Same shape as api/tests/fixtures/tempo-export-mini. Needs the
 * `zip` CLI (as the mini fixture packer does).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, "tempo-export.zip");

const SAMPLE_EVERY_S = 30;
const WEEK1_MONDAY = Date.UTC(2026, 7, 3); // Mon Aug 3 2026
const EXPORT_DATE = "2026-10-14T14:00:00Z";
// Stored timestamps are UTC; the athlete is in America/New_York (EDT for the whole block).
const EDT_OFFSET_H = 4;

// --- seeded randomness -------------------------------------------------------------

const rand = mulberry32(20261014);
/** Roughly normal, mean 0, sd 1. */
const gauss = gaussFrom(rand);
const uuid = uuidIn("cadence-demo");

// --- pace / effort model -----------------------------------------------------------

/** Seconds per mile for m:ss. */
const pace = (m, s = 0) => m * 60 + s;

/** Easy pace improves from 9:35 to ~9:10 over the block; August heat costs a little. */
function easyPace(week) {
  const fitness = 9 * 60 + 35 - (week - 1) * 2.6;
  const heat = week <= 3 ? 8 : week <= 5 ? 4 : 0;
  return fitness + heat;
}

/** Threshold pace improves from 7:48 to 7:30. */
const tempoPace = (week) => pace(7, 48) - (week - 1) * 2;

const MARATHON_PACE = pace(8, 0);

/** Mean temperature in C for the week (Aug warm, Oct cool). */
const weekTempC = (week) =>
  week < 1 ? 27 : [25, 26, 24, 23, 21, 20, 18, 16, 14, 13, 12][week - 1];

// Heart rate (bpm), max ~188. Zones: z2 131-150, z3 150-164, z4 164-177, z5 177-188.
const HR = { easy: 141, medium: 147, tempo: 170, mp: 160, rep: 180, jog: 142, long: 144, strides: 150 };

// --- the training plan -------------------------------------------------------------

/**
 * One entry per week: miles for Tue / Wed / Thu / Sat / Sun, the Thursday session, and
 * the story beats. Mon and Fri are rest days.
 */
const PLAN = [
  { tue: 5, wed: 7, thu: { kind: "tempo", total: 7, tempo: 3 }, sat: 5, sun: { miles: 12 } },
  { tue: 5, wed: 8, thu: { kind: "reps", total: 7, n: 6, repM: 800, jogM: 400 }, sat: 5, sun: { miles: 13 } },
  { tue: 6, wed: 8, thu: { kind: "tempo", total: 8, tempo: 4 }, sat: 5, sun: { miles: 15 } },
  { tue: 5, wed: 7, thu: { kind: "reps", total: 6, n: 8, repM: 400, jogM: 400 }, sat: 5, sun: { miles: 11 } },
  { tue: 6, wed: 9, thu: { kind: "mp", total: 8, mp: 6 }, sat: 5, sun: { miles: 16, finishMp: 2 } },
  {
    tue: 6, wed: 8,
    thu: {
      kind: "tempo", total: 3, tempo: 1, early: true,
      name: "Tempo, stopped early",
      notes: "Right Achilles tight from mile 2. Stopped at 3.",
    },
    sat: 4, sun: { miles: 10 },
  },
  {
    tue: 4, wed: 5,
    thu: { kind: "easy", total: 5, notes: "Achilles fine on the flat. Easy only this week." },
    sat: 4, sun: { miles: 8 },
  },
  {
    tue: 5, wed: 7,
    thu: { kind: "tempo", total: 7, tempo: 3, notes: "Achilles no issue." },
    sat: 4, sun: { miles: 12 },
  },
  { tue: 6, wed: 8, thu: { kind: "mp", total: 8, mp: 5 }, sat: 5, sun: { miles: 17, finishMp: 3 } },
  { tue: 5, wed: 8, thu: { kind: "reps", total: 8, n: 5, repM: M_PER_MILE, jogM: 400 }, sat: 4, sun: { miles: 20, finishMp: 4 } },
  // Week 11 (Oct 12 – 18): Mon rest, Tue easy, Wed medium-long this morning. Nothing later.
  { tue: 6, wed: 9, partial: true },
];

/**
 * Four easy base weeks before Cadence starts (weeks -3 to 0: Jul 6 - Aug 2), so the
 * coach has some history at onboarding. Same shape as PLAN, no quality sessions.
 */
const BASE = [
  { tue: 4, wed: 5, thu: { kind: "easy", total: 5 }, sat: 4, sun: { miles: 9 } },
  { tue: 5, wed: 5, thu: { kind: "easy", total: 6 }, sat: 4, sun: { miles: 10 } },
  { tue: 5, wed: 6, thu: { kind: "easy", total: 6 }, sat: 5, sun: { miles: 10 } },
  { tue: 5, wed: 6, thu: { kind: "easy", total: 6 }, sat: 5, sun: { miles: 11 } },
];

// --- segments: [distanceM, secondsPerMile, targetHr, label] -----------------------------

const miles = (n) => n * M_PER_MILE;

/** Split `totalMiles` into mile segments (last one partial) at a steady pace. */
function steady(totalMiles, secPerMile, hr, label, driftHr = 0) {
  const out = [];
  // Real runs are never exactly round: nudge easy running by up to ~0.2 mi.
  const loose = label === "easy" || label === "warmup" || label === "cooldown";
  let left = miles(totalMiles + (loose ? (rand() - 0.5) * 0.4 : 0));
  let i = 0;
  while (left > 1) {
    const d = Math.min(M_PER_MILE, left);
    const wobble = gauss() * 4;
    out.push(seg(d, secPerMile * (1 + gauss() * 0.01) + wobble, hr + driftHr * (i / Math.max(totalMiles, 1)), label));
    left -= d;
    i += 1;
  }
  return out;
}

function easyRun(week, totalMiles, { faster = 0, label = "easy", hr = HR.easy } = {}) {
  return steady(totalMiles, easyPace(week) - faster, hr, label, 4);
}

function longRun(week, spec) {
  const finish = spec.finishMp ?? 0;
  const body = steady(spec.miles - finish, easyPace(week) - 3, HR.long, "easy", 9);
  const tail = finish ? steady(finish, MARATHON_PACE + 2, HR.mp + 6, "mp") : [];
  return [...body, ...tail];
}

function thursdaySession(week, t) {
  const tp = tempoPace(week);
  const warm = (m) => steady(m, easyPace(week) + 6, HR.easy - 3, "warmup");
  const cool = (m) => steady(m, easyPace(week) + 12, HR.easy - 2, "cooldown");
  switch (t.kind) {
    case "easy":
      return easyRun(week, t.total, { faster: -2 });
    case "tempo": {
      const wc = (t.total - t.tempo) / 2;
      if (t.early) {
        // Stops during the first tempo mile: pace and HR drift the wrong way.
        const tempoMile = [seg(M_PER_MILE, tp + 16, HR.tempo + 5, "tempo")];
        return [...warm(t.total - t.tempo), ...tempoMile];
      }
      return [...warm(wc), ...steady(t.tempo, tp, HR.tempo, "tempo"), ...cool(wc)];
    }
    case "mp": {
      const wc = (t.total - t.mp) / 2;
      return [...warm(wc), ...steady(t.mp, MARATHON_PACE - 1, HR.mp, "mp"), ...cool(wc)];
    }
    case "reps": {
      const repSecPerMile = t.repM >= 1000 ? pace(7, 8) - (week - 1) : pace(6, 40) - (week - 1);
      const repMiles = (t.repM / M_PER_MILE) * t.n;
      const jogMiles = (t.jogM / M_PER_MILE) * (t.n - 1);
      const wc = Math.max((t.total - repMiles - jogMiles) / 2, 0.5);
      const out = [...warm(wc)];
      for (let i = 0; i < t.n; i += 1) {
        out.push(seg(t.repM, repSecPerMile * (1 + gauss() * 0.008), HR.rep + i * 0.6, "rep"));
        if (i < t.n - 1) out.push(seg(t.jogM, pace(9, 50), HR.jog + 6, "jog"));
      }
      return [...out, ...cool(wc)];
    }
    default:
      throw new Error(`unknown session kind ${t.kind}`);
  }
}

// --- building workouts --------------------------------------------------------------

const SHOES = [
  { id: uuid("shoe-daily"), brand: "Brooks", model: "Ghost 16" },
  { id: uuid("shoe-speed"), brand: "Saucony", model: "Endorphin Speed 4" },
].map((s) => ({
  ...s,
  initialMileageM: 0,
  isRetired: false,
  createdAt: "2026-06-15T12:00:00Z",
  updatedAt: "2026-06-15T12:00:00Z",
  workouts: [],
}));

const buildWorkout = createWorkoutBuilder({
  rand,
  uuid,
  shoeFor: (quality) => (quality === "easy" ? SHOES[0] : SHOES[1]),
  tempCFor: weekTempC,
  sampleEveryS: SAMPLE_EVERY_S,
});

function startIso(weekIdx, dayOffset, hourLocal, minuteLocal) {
  const jitter = Math.round(gauss() * 8);
  const ms =
    WEEK1_MONDAY +
    (weekIdx * 7 + dayOffset) * 86_400_000 +
    ((hourLocal + EDT_OFFSET_H) * 60 + minuteLocal + jitter) * 60_000;
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

const fmtMiles = (m) => {
  const v = m / M_PER_MILE;
  return Number.isInteger(Math.round(v * 10) / 10) ? String(Math.round(v)) : v.toFixed(1);
};

function buildAllWorkouts() {
  const workouts = [];
  const addWeek = (w, week) => {
    const i = week - 1;
    const add = (dayOffset, hh, mm, spec) => {
      const startedAt = startIso(i, dayOffset, hh, mm);
      const wk = buildWorkout({ key: `${week}-${dayOffset}`, startedAt, week, ...spec });
      workouts.push({ week, ...wk });
    };

    const easy = (miles_, label, extra = {}) => ({
      name: label,
      runType: "Easy Run",
      quality: "easy",
      segments: easyRun(week, miles_, extra),
      stops: Math.round(rand() * 25),
    });

    add(1, 6, 15, easy(w.tue, `Easy ${w.tue}`));
    add(2, 6, 10, {
      name: `Medium-long ${w.wed}`,
      runType: "Easy Run",
      quality: "easy",
      segments: easyRun(week, w.wed, { faster: 5, hr: HR.medium }),
      stops: Math.round(rand() * 25),
    });
    if (w.partial) return;

    const t = w.thu;
    const kinds = {
      tempo: { runType: "Tempo Run", label: `Tempo ${t.tempo} at ${paceLabel(tempoPace(week))}` },
      mp: { runType: "Marathon Pace Run", label: `${t.mp} at marathon pace` },
      reps: {
        runType: "Interval Run",
        label: `${t.n} x ${t.repM >= 1000 ? "1 mile" : `${t.repM}m`}`,
      },
      easy: { runType: "Easy Run", label: `Easy ${t.total}` },
    }[t.kind];
    add(3, 6, 20, {
      name: t.name ?? kinds.label,
      runType: kinds.runType,
      quality: t.kind,
      segments: thursdaySession(week, t),
      notes: t.notes,
      stops: t.kind === "reps" ? 40 : t.kind === "easy" ? 10 : 20,
    });
    add(5, 7, 5, easy(w.sat, `Easy ${w.sat}`, { faster: -8 }));
    add(6, 7, 30, {
      name: `Long run ${w.sun.miles}`,
      runType: "Long Run",
      quality: "easy",
      segments: longRun(week, w.sun),
      stops: 30 + Math.round(rand() * 60),
    });
  };
  PLAN.forEach((w, i) => addWeek(w, i + 1));
  // After the block, so the block's random draws (and runs) stay exactly as they were.
  BASE.forEach((w, i) => addWeek(w, i - 3));
  workouts.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return workouts;
}

function paceLabel(secPerMile) {
  const s = Math.round(secPerMile);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// --- export files ---------------------------------------------------------------------

const SETTINGS = {
  id: uuid("settings"),
  calculationMethod: 2,
  unitPreference: "imperial",
  defaultShoeId: SHOES[0].id,
  zone1MinBpm: 112,
  zone1MaxBpm: 131,
  zone2MinBpm: 131,
  zone2MaxBpm: 150,
  zone3MinBpm: 150,
  zone3MaxBpm: 164,
  zone4MinBpm: 164,
  zone4MaxBpm: 177,
  zone5MinBpm: 177,
  zone5MaxBpm: 188,
  createdAt: "2026-06-15T12:00:00Z",
  updatedAt: "2026-06-15T12:00:00Z",
};

function buildFiles(workouts) {
  return buildExportFiles({
    workouts,
    shoes: SHOES,
    uuid,
    exportDate: EXPORT_DATE,
    tempoVersion: "demo",
    exportedBy: "cadence-demo",
    note: "Synthetic: fictional athlete, generated by demo/generate-tempo-export.mjs",
    settings: SETTINGS,
  });
}

function weeklyTable(workouts) {
  const first = 1 - BASE.length;
  const rows = [...BASE, ...PLAN].map((_, i) => ({ week: first + i, runs: 0, m: 0 }));
  for (const w of workouts) {
    rows[w.week - first].runs += 1;
    rows[w.week - first].m += w.distanceM;
  }
  const lines = ["week  starts   runs  miles"];
  rows.forEach((r) => {
    const monday = new Date(WEEK1_MONDAY + (r.week - 1) * 7 * 86_400_000);
    const label = monday.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    lines.push(`${String(r.week).padStart(4)}  ${label.padEnd(7)}  ${String(r.runs).padStart(4)}  ${(r.m / M_PER_MILE).toFixed(1).padStart(5)}`);
  });
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out = path.resolve(argv[++i]);
    else {
      console.error("Usage: node demo/generate-tempo-export.mjs [--out PATH]");
      process.exit(argv[i] === "-h" || argv[i] === "--help" ? 0 : 1);
    }
  }
  const workouts = buildAllWorkouts();
  const abs = packZip(buildFiles(workouts), out, EXPORT_DATE);
  console.log(weeklyTable(workouts));
  console.log(`\n${workouts.length} runs -> ${abs} (${fs.statSync(abs).size} bytes)`);
}

main();
