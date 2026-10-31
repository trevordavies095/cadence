import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { toAttachment } from "../src/packet/index.js";
import {
  detectReps,
  formatRepSummary,
  summarizeReps,
  type RepLap,
} from "../src/recap/repSummary.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "tempo-export-mini");

function lap(
  idx: number,
  distanceM: number,
  durationS: number,
  extra: Partial<RepLap> & { trigger?: string | null; stepIndex?: number | null } = {},
) {
  return {
    idx,
    kind: "device_lap",
    distanceM,
    durationS,
    paceS: (durationS / distanceM) * 1000,
    ...extra,
  };
}

/** FIT-style: warmup, 6 x 800 m with 90 s rests, cooldown; intensities set. */
function fitIntervals() {
  const repTimes = [185, 186, 187, 188, 190, 192];
  const laps = [lap(0, 2000, 720, { intensity: "warmup", trigger: "manual", stepIndex: 0 })];
  let idx = 1;
  repTimes.forEach((t, i) => {
    laps.push(lap(idx++, 800, t, { intensity: "active", trigger: "distance", stepIndex: 1 }));
    if (i < repTimes.length - 1) {
      laps.push(lap(idx++, 200, 90, { intensity: i === 2 ? "recovery" : "rest", trigger: "time", stepIndex: 2 }));
    }
  });
  laps.push(lap(idx++, 1500, 600, { intensity: "cooldown", trigger: "session_end", stepIndex: 3 }));
  // A km distance split rides along; it is never a rep.
  laps.push({ idx: 0, kind: "distance", distanceM: 1000, durationS: 230, paceS: 230 });
  return laps;
}

/** HealthKit-style: same lap shape, no intensity anywhere. */
function healthKitFartlek(): RepLap[] {
  return [
    lap(0, 1500, 540, { intensity: null }),
    lap(1, 400, 120, { intensity: null }),
    lap(2, 200, 90, { intensity: null }),
    lap(3, 400, 120, { intensity: null }),
    lap(4, 200, 90, { intensity: null }),
    lap(5, 400, 124, { intensity: null }),
    lap(6, 1000, 360, { intensity: null }),
  ];
}

describe("rep detection", () => {
  it("uses lap intensity when the watch sent it", () => {
    const { repIndexes, method } = detectReps(fitIntervals(), 300);
    expect(method).toBe("intensity");
    expect(repIndexes).toHaveLength(6);

    const summary = summarizeReps(fitIntervals(), 300);
    expect(summary).toMatchObject({
      method: "intensity",
      count: 6,
      avgDurationS: 188,
      fadePct: 4,
      avgRestS: 90,
    });
    expect(summary!.avgPaceS).toBeCloseTo(235, 5);
    expect(formatRepSummary(summary!, "metric")).toBe(
      "6 reps, avg 3:08 at 3:55/km, fade 4%, rests 90 s",
    );
  });

  it("falls back to pace when no lap has intensity", () => {
    const summary = summarizeReps(healthKitFartlek(), 330);
    expect(summary).toMatchObject({
      method: "pace",
      count: 3,
      avgDurationS: 121,
      fadePct: 3,
      avgRestS: 90,
    });
    expect(formatRepSummary(summary!, "metric")).toBe(
      "3 reps, avg 2:01 at 5:03/km, fade 3%, rests 90 s (by pace)",
    );
  });

  it("reports a negative fade when the last rep was faster", () => {
    const laps = [
      lap(0, 1000, 240, { intensity: "interval" }),
      lap(1, 200, 60, { intensity: "rest" }),
      lap(2, 1000, 228, { intensity: "interval" }),
    ];
    expect(summarizeReps(laps, 300)!.fadePct).toBe(-5);
  });

  it("gives no summary with fewer than two reps", () => {
    const one = [
      lap(0, 2000, 720, { intensity: "warmup" }),
      lap(1, 3000, 690, { intensity: "active" }),
      lap(2, 1500, 600, { intensity: "cooldown" }),
    ];
    expect(summarizeReps(one, 300)).toBeNull();
    // Steady run by pace: nothing 20 s/km under the average.
    const steady = [lap(0, 1000, 300), lap(1, 1000, 295), lap(2, 1000, 305)];
    expect(summarizeReps(steady, 300)).toBeNull();
  });

  it("gives no summary when every split is a distance split", () => {
    const splits = [
      { idx: 0, kind: "distance", distanceM: 1000, durationS: 200, paceS: 200, intensity: null },
      { idx: 1, kind: "distance", distanceM: 1000, durationS: 320, paceS: 320, intensity: null },
      { idx: 2, kind: "distance", distanceM: 1000, durationS: 200, paceS: 200, intensity: null },
    ];
    expect(summarizeReps(splits, 260)).toBeNull();
  });
});

describe("lap intensity, trigger and step pass through", () => {
  it("the live adapter keeps them on each split", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id,
          startedAt: "2026-10-20T12:00:00Z",
          durationS: 3000,
          distanceM: 9000,
          avgPaceS: 333,
          runType: "Intervals",
          splits: [
            { idx: 0, kind: "device_lap", distanceM: 800, durationS: 185, paceS: 231, intensity: "active", trigger: "distance", stepIndex: 1 },
            { idx: 0, kind: "distance", distanceM: 1000, durationS: 240, paceS: 240, intensity: null, trigger: null, stepIndex: null },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;
    const port = createLiveTempoPort({
      fetchImpl,
      readCredentials: async () => ({ baseUrl: "http://tempo.test", apiKey: "tmp_k" }),
    });
    const detail = await port.getWorkout(id);
    expect(detail!.splits[0]).toMatchObject({
      intensity: "active",
      trigger: "distance",
      stepIndex: 1,
    });
    expect(detail!.splits[1]).toMatchObject({
      intensity: null,
      trigger: null,
      stepIndex: null,
    });
  });

  it("the packet attachment keeps them on each split", () => {
    const attachment = toAttachment({
      id: "44444444-4444-4444-8444-444444444444",
      startedAt: "2026-10-20T12:00:00Z",
      durationS: 3000,
      distanceM: 9000,
      avgPaceS: 333,
      splits: [
        { idx: 1, kind: "device_lap", paceS: 231, intensity: "interval", trigger: "time", stepIndex: 2 },
      ],
    });
    expect(attachment!.splits![0]).toMatchObject({
      intensity: "interval",
      trigger: "time",
      stepIndex: 2,
    });
  });
});

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

/**
 * The mini export with Monday as a Threshold run carrying only distance
 * splits, and Wednesday as Intervals with FIT device laps.
 */
function exportZipWithQualityRuns(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-export-reps-"));
  const dir = path.join(tmp, "pack");
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });

  const workoutsPath = path.join(dir, "data", "workouts.json");
  const workouts = JSON.parse(fs.readFileSync(workoutsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  for (const w of workouts) {
    if (w.id === W1) w.runType = "Threshold";
    if (w.id === W2) w.runType = "Intervals";
  }
  fs.writeFileSync(workoutsPath, JSON.stringify(workouts));

  const splitsPath = path.join(dir, "data", "splits.json");
  const splits = JSON.parse(fs.readFileSync(splitsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  const w1Splits = splits
    .filter((s) => s.workoutId === W1)
    .map((s) => ({ ...s, kind: "distance", intensity: null }));
  const w2Splits = fitIntervals()
    .filter((s) => s.kind === "device_lap")
    .map((s, i) => ({
      id: `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      workoutId: W2,
      ...s,
    }));
  fs.writeFileSync(
    splitsPath,
    JSON.stringify([
      ...w1Splits,
      ...w2Splits,
      ...splits.filter((s) => s.workoutId !== W1 && s.workoutId !== W2),
    ]),
  );

  const zipPath = path.join(tmp, "export.zip");
  execFileSync("zip", ["-q", "-r", zipPath, "."], { cwd: dir });
  return zipPath;
}

describe("rep line on Your week's runs", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("prints reps for a quality run with device laps, in the athlete's unit", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: exportZipWithQualityRuns() });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const res = await app.request(
      `/weeks/${week.id as string}/recap/run-by-run?format=json`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.unit).toBe("imperial");
    const runs = body.runs as Array<Record<string, unknown>>;

    const threshold = runs.find((r) => r.workoutId === W1)!;
    expect(threshold.runType).toBe("Threshold");
    expect(threshold).not.toHaveProperty("repSummary");

    const intervals = runs.find((r) => r.workoutId === W2)!;
    expect(intervals.repSummary).toBe(
      "6 reps, avg 3:08 at 6:18/mi, fade 4%, rests 90 s",
    );
    const firstSplit = (intervals.splits as Array<Record<string, unknown>>)[1]!;
    expect(firstSplit).toMatchObject({
      kind: "device_lap",
      intensity: "active",
      trigger: "distance",
      stepIndex: 1,
    });

    expect(body.markdown as string).toContain(
      "Reps: 6 reps, avg 3:08 at 6:18/mi, fade 4%, rests 90 s",
    );
  });
});
