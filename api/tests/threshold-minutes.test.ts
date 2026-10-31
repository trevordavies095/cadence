import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { appendGoal } from "../src/goal/store.js";
import type { TrainingGoal } from "../src/goal/types.js";
import { migrate } from "../src/migrate.js";
import {
  thresholdSecondsForRun,
  thresholdSecondsForWeek,
} from "../src/recap/thresholdMinutes.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type {
  TempoPort,
  TempoThresholds,
  TempoTimeSeriesPoint,
} from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/** One 60 s interval at the given pace (s/km), from a standing start. */
function paceInterval(paceS: number, hr = 150): TempoTimeSeriesPoint[] {
  return [
    { elapsedSeconds: 0, distanceM: 0, heartRateBpm: hr },
    { elapsedSeconds: 60, distanceM: (60 / paceS) * 1000, heartRateBpm: hr },
  ];
}

/** One 60 s interval with heart rate and no distance (treadmill, no GPS). */
function hrInterval(hr: number): TempoTimeSeriesPoint[] {
  return [
    { elapsedSeconds: 0, heartRateBpm: hr },
    { elapsedSeconds: 60, heartRateBpm: hr },
  ];
}

describe("threshold seconds per run (#16)", () => {
  const T = { paceS: 250, heartRateBpm: 170 };

  it("pace band: 4.9% off counts, 5.1% off does not, on either side", () => {
    expect(thresholdSecondsForRun(paceInterval(250 * 1.049), T)).toBe(60);
    expect(thresholdSecondsForRun(paceInterval(250 * 0.951), T)).toBe(60);
    expect(thresholdSecondsForRun(paceInterval(250 * 1.051), T)).toBe(0);
    expect(thresholdSecondsForRun(paceInterval(250 * 0.949), T)).toBe(0);
  });

  it("heart-rate band for a run with no pace: 3 bpm off counts, 4 does not", () => {
    expect(thresholdSecondsForRun(hrInterval(173), T)).toBe(60);
    expect(thresholdSecondsForRun(hrInterval(167), T)).toBe(60);
    expect(thresholdSecondsForRun(hrInterval(174), T)).toBe(0);
    expect(thresholdSecondsForRun(hrInterval(166), T)).toBe(0);
  });

  it("jittery GPS (±10% per sample around threshold pace) still counts: the 30 s window smooths it", () => {
    const series: TempoTimeSeriesPoint[] = [];
    let d = 0;
    for (let t = 0; t <= 600; t++) {
      series.push({ elapsedSeconds: t, distanceM: d, heartRateBpm: 150 });
      const pace = 250 * (t % 2 === 0 ? 1.1 : 0.9);
      d += 1000 / pace;
    }
    // Every step alone is 10% off; only the first (a 1 s window) stays out.
    expect(thresholdSecondsForRun(series, T)).toBe(599);
  });

  it("jittery heart rate (166/174 around 170) counts on the 30 s mean", () => {
    const series: TempoTimeSeriesPoint[] = [];
    for (let t = 0; t <= 120; t++) {
      series.push({ elapsedSeconds: t, heartRateBpm: t % 2 === 0 ? 166 : 174 });
    }
    // Only the first step (a 1 s window at 174) stays out.
    expect(thresholdSecondsForRun(series, T)).toBe(119);
  });

  it("a short surge inside the window does not count until it fills the window", () => {
    // 60 s at 5:33/km, then 60 s at threshold, in 10 s samples.
    const series: TempoTimeSeriesPoint[] = [];
    let d = 0;
    for (let t = 0; t <= 120; t += 10) {
      series.push({ elapsedSeconds: t, distanceM: d });
      d += t < 60 ? 30 : 40;
    }
    // Steps ending at 70 and 80 still average in the slower running.
    expect(thresholdSecondsForRun(series, T)).toBe(40);
  });

  it("a run with pace ignores its heart rate when threshold pace is set", () => {
    expect(thresholdSecondsForRun(paceInterval(400, 170), T)).toBe(0);
  });

  it("a run with neither pace nor heart rate contributes nothing", () => {
    expect(
      thresholdSecondsForRun(
        [{ elapsedSeconds: 0 }, { elapsedSeconds: 60 }],
        T,
      ),
    ).toBe(0);
    expect(thresholdSecondsForRun(undefined, T)).toBe(0);
  });

  it("a run with no pace and no threshold heart rate contributes nothing", () => {
    expect(thresholdSecondsForRun(hrInterval(170), { paceS: 250, heartRateBpm: null })).toBe(0);
  });

  it("sums across the week's runs", () => {
    expect(
      thresholdSecondsForWeek(
        [paceInterval(250), hrInterval(171), hrInterval(140), null],
        T,
      ),
    ).toBe(120);
  });
});

const TEMPO_RUN = "11111111-1111-4111-8111-111111111111";

/**
 * 30 minutes: the first ten at 4:10/km (threshold), the rest at 5:33/km.
 * Samples every 10 s.
 */
function tempoRunSeries(): TempoTimeSeriesPoint[] {
  const out: TempoTimeSeriesPoint[] = [];
  let d = 0;
  for (let t = 0; t <= 1800; t += 10) {
    out.push({ elapsedSeconds: t, distanceM: d, heartRateBpm: 160 });
    d += t < 600 ? 40 : 30;
  }
  return out;
}

const SET: TempoThresholds = {
  thresholdPaceS: 250,
  thresholdHeartRateBpm: null,
  suggestedThresholdPaceS: 245,
  suggestedFrom: null,
};

function port(thresholds: TempoThresholds | undefined): TempoPort {
  const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
  return {
    ...base,
    async getSettings() {
      const s = await base.getSettings();
      return thresholds ? { ...s, thresholds } : s;
    },
    async getWorkout(id) {
      const d = await base.getWorkout(id);
      return d && id === TEMPO_RUN ? { ...d, timeSeries: tempoRunSeries() } : d;
    },
  };
}

async function goalLines(
  goal: TrainingGoal,
  thresholds: TempoThresholds | undefined,
  now = "2026-10-21T15:00:00.000Z",
): Promise<{ texts: string[]; markdown: string }> {
  await appendGoal(new Date("2026-10-01T12:00:00Z"), goal, "settings");
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date(now)),
    tempoPort: port(thresholds),
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  const res = await app.request(`/weeks/${week.id}/recap/summary?unit=metric`);
  expect(res.status).toBe(200);
  const body = (await json(res)) as unknown as {
    goalLines: Array<{ label: string; value: string | null }>;
    markdown: string;
  };
  return {
    texts: body.goalLines.map((l) => (l.value === null ? l.label : `${l.label}: ${l.value}`)),
    markdown: body.markdown,
  };
}

const HALF: TrainingGoal = { kind: "race", distance: "half", raceDate: "2026-12-14" };

describe("Threshold minutes on the summary (#16)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("half with a threshold set: ten minutes inside the band", async () => {
    const s = await goalLines(HALF, SET);
    expect(s.texts).toContain("Threshold minutes: 10 min");
    expect(s.markdown).toContain("- Threshold minutes: 10 min");
  });

  it("speed goal shows the line too", async () => {
    const s = await goalLines({ kind: "speed", distance: "5k" }, SET);
    expect(s.texts).toContain("Threshold minutes: 10 min");
  });

  it("a week without any time near threshold reads 0 min", async () => {
    const s = await goalLines(HALF, { ...SET, thresholdPaceS: 180 });
    expect(s.texts).toContain("Threshold minutes: 0 min");
  });

  it("a week with no runs reads 0 min", async () => {
    const s = await goalLines(HALF, SET, "2026-11-04T15:00:00.000Z");
    expect(s.texts).toContain("Threshold minutes: 0 min");
  });

  it("absent with only the suggestion (no athlete-set threshold)", async () => {
    const s = await goalLines(HALF, { ...SET, thresholdPaceS: null });
    expect(s.texts.join("\n")).not.toContain("Threshold minutes");
  });

  it("absent when the running log has no thresholds at all", async () => {
    const s = await goalLines(HALF, undefined);
    expect(s.texts.join("\n")).not.toContain("Threshold minutes");
  });

  it("absent for marathon, fitness and return goals", async () => {
    for (const goal of [
      { kind: "race", distance: "marathon", raceDate: "2026-12-14" },
      { kind: "fitness" },
      { kind: "return" },
    ] as TrainingGoal[]) {
      await resetAppTables();
      await acceptAndReady();
      const s = await goalLines(goal, SET);
      expect(s.markdown).not.toContain("Threshold minutes");
    }
  });
});
