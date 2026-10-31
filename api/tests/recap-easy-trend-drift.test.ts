import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { appendGoal } from "../src/goal/store.js";
import type { TrainingGoal } from "../src/goal/types.js";
import { migrate } from "../src/migrate.js";
import {
  computeEasyRunTrend,
  easyRunVerdict,
  formatEasyRunTrendLine,
} from "../src/recap/trends.js";
import type {
  TempoPort,
  TempoWorkoutDetail,
  TempoWorkoutSummary,
} from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const MI = 1609.344;
/** Seconds per km for a pace given in seconds per mile. */
const perMi = (secPerMi: number) => secPerMi / (MI / 1000);

describe("easy-run verdict pairs pace with heart rate (#09)", () => {
  const earlier = { paceSecPerKm: perMi(560), avgHr: 145 };

  it("both better: faster at a lower heart rate is improving", () => {
    expect(easyRunVerdict({ paceSecPerKm: perMi(552), avgHr: 141 }, earlier)).toBe(
      "improving",
    );
    // Pace held (within a few seconds) at a lower heart rate is improving too.
    expect(easyRunVerdict({ paceSecPerKm: perMi(562), avgHr: 141 }, earlier)).toBe(
      "improving",
    );
  });

  it("heart rate lower but pace slower: no verdict", () => {
    expect(
      easyRunVerdict({ paceSecPerKm: perMi(590), avgHr: 138 }, earlier),
    ).toBeUndefined();
  });

  it("both worse: slower at a higher heart rate is declining", () => {
    expect(easyRunVerdict({ paceSecPerKm: perMi(575), avgHr: 150 }, earlier)).toBe(
      "declining",
    );
  });

  it("heart rate higher with faster pace: no verdict", () => {
    expect(
      easyRunVerdict({ paceSecPerKm: perMi(530), avgHr: 150 }, earlier),
    ).toBeUndefined();
  });

  it("states pace and heart rate for this week and three weeks ago", () => {
    const trend = computeEasyRunTrend(
      [perMi(560), perMi(558), null, perMi(552)],
      [145, 144, null, 141],
    )!;
    expect(trend.current.weeksAgo).toBe(0);
    expect(trend.earlier.weeksAgo).toBe(3);
    expect(trend.verdict).toBe("improving");
    expect(formatEasyRunTrendLine(trend, "imperial")).toBe(
      "Easy runs: 9:12/mi at 141 bpm, from 9:20/mi at 145 bpm three weeks ago (improving).",
    );
  });

  it("names the week when this week has no easy runs, and needs two weeks", () => {
    const trend = computeEasyRunTrend(
      [null, perMi(560), perMi(590), null],
      [null, 145, 138, null],
    )!;
    expect(trend.verdict).toBeUndefined();
    expect(formatEasyRunTrendLine(trend, "imperial")).toBe(
      "Easy runs: 9:50/mi at 138 bpm last week, from 9:20/mi at 145 bpm two weeks ago.",
    );
    expect(computeEasyRunTrend([null, null, perMi(560), null], [null, null, 145, null])).toBeUndefined();
  });
});

// ---- Route tests against a fake Tempo port ----

type FakeRun = {
  /** ISO instant. */
  at: string;
  runType: string;
  avgPaceS: number;
  avgHr: number;
  /** Second-half HR minus first-half HR: the run's drift in bpm. */
  driftBpm?: number;
};

const DURATION_S = 1800;

function fakePort(runs: FakeRun[]): TempoPort {
  const details: TempoWorkoutDetail[] = runs.map((r, i) => {
    const d = r.driftBpm ?? 0;
    const startHr = r.avgHr - d / 2;
    return {
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${(i + 1).toString(16).padStart(12, "0")}`,
      startedAt: r.at,
      durationS: DURATION_S,
      distanceM: Math.round((DURATION_S / r.avgPaceS) * 1000),
      avgPaceS: r.avgPaceS,
      avgHeartRateBpm: r.avgHr,
      runType: r.runType,
      splits: [],
      timeSeries: [
        { elapsedSeconds: 0, heartRateBpm: startHr },
        { elapsedSeconds: DURATION_S / 2, heartRateBpm: startHr + d },
      ],
    };
  });
  const summaries: TempoWorkoutSummary[] = details.map(
    ({ splits: _s, timeSeries: _t, ...rest }) => rest,
  );
  return {
    async listWorkouts(q) {
      const lo = q?.startDate ? Date.parse(q.startDate) : -Infinity;
      const hi = q?.endDate ? Date.parse(q.endDate) : Infinity;
      const items = summaries.filter((w) => {
        const t = Date.parse(w.startedAt);
        return t >= lo && t <= hi;
      });
      return { items, page: 1, pageSize: 100, totalCount: items.length, totalPages: 1 };
    },
    async getWorkout(id) {
      return details.find((d) => d.id === id) ?? null;
    },
    async getSettings() {
      return {
        unitPreference: "imperial",
        heartRateZones: {
          calculationMethod: "Custom",
          maxHeartRateBpm: 190,
          zones: [
            { zoneNumber: 1, minBpm: 100, maxBpm: 129 },
            { zoneNumber: 2, minBpm: 130, maxBpm: 149 },
            { zoneNumber: 3, minBpm: 150, maxBpm: 164 },
            { zoneNumber: 4, minBpm: 165, maxBpm: 177 },
            { zoneNumber: 5, minBpm: 178, maxBpm: 190 },
          ],
        },
      };
    },
    async listShoes() {
      return [];
    },
    async getBestEfforts() {
      return { distances: [] };
    },
  };
}

/** Week 2026-W43 runs Mon Oct 19 – Sun Oct 25 (UTC). */
const DRIFT_WEEK: FakeRun[] = [
  { at: "2026-10-19T12:00:00.000Z", runType: "Threshold", avgPaceS: 300, avgHr: 165, driftBpm: 18 },
  { at: "2026-10-20T12:00:00.000Z", runType: "Easy Run", avgPaceS: 380, avgHr: 140, driftBpm: 12 },
  { at: "2026-10-21T12:00:00.000Z", runType: "Easy Run", avgPaceS: 380, avgHr: 138, driftBpm: 6 },
  { at: "2026-10-24T12:00:00.000Z", runType: "Long Run", avgPaceS: 390, avgHr: 145, driftBpm: 25 },
];

/** Four weeks of a return: easy pace comes back while easy heart rate rises. */
const RETURN_WEEKS: FakeRun[] = [
  { at: "2026-09-29T12:00:00.000Z", runType: "Easy Run", avgPaceS: 440, avgHr: 130 },
  { at: "2026-10-06T12:00:00.000Z", runType: "Easy Run", avgPaceS: 425, avgHr: 133 },
  { at: "2026-10-13T12:00:00.000Z", runType: "Easy Run", avgPaceS: 410, avgHr: 136 },
  { at: "2026-10-20T12:00:00.000Z", runType: "Easy Run", avgPaceS: 395, avgHr: 140 },
];

async function setup(runs: FakeRun[], goal: TrainingGoal | null) {
  if (goal) await appendGoal(new Date("2026-10-01T12:00:00Z"), goal, "settings");
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-25T15:00:00.000Z")),
    tempoPort: fakePort(runs),
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  expect(week.isoWeek).toBe("2026-W43");
  return { app, id: week.id as string };
}

type RunRow = {
  runType: string;
  drift?: { driftBpm: number };
  driftCapBpm: number | null;
  driftSeverity?: string;
};

async function runsFor(goal: TrainingGoal | null): Promise<RunRow[]> {
  const { app, id } = await setup(DRIFT_WEEK, goal);
  const res = await app.request(`/weeks/${id}/recap/run-by-run`);
  expect(res.status).toBe(200);
  return (await json(res)).runs as RunRow[];
}

/** What the page labels "(high)": drift above a non-null cap. */
const high = (r: RunRow) =>
  r.driftCapBpm !== null && r.drift !== undefined && r.drift.driftBpm > r.driftCapBpm;

describe("drift caps by goal (#09)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("fitness: easy runs capped at 10, Threshold and Long Run never labelled", async () => {
    const runs = await runsFor({ kind: "fitness" });
    const [threshold, easyHigh, easyOk, long] = runs;
    expect(threshold).toMatchObject({ runType: "Threshold", driftCapBpm: null });
    expect(threshold!.drift!.driftBpm).toBe(18);
    expect(high(threshold!)).toBe(false);
    expect(threshold!.driftSeverity).toBeUndefined();

    expect(easyHigh).toMatchObject({ runType: "Easy Run", driftCapBpm: 10 });
    expect(easyHigh!.drift!.driftBpm).toBe(12);
    expect(high(easyHigh!)).toBe(true);
    expect(easyHigh!.driftSeverity).toContain("target ≤10 bpm");

    expect(high(easyOk!)).toBe(false);

    expect(long).toMatchObject({ runType: "Long Run", driftCapBpm: null });
    expect(long!.drift!.driftBpm).toBe(25);
    expect(high(long!)).toBe(false);
    expect(long!.driftSeverity).toBeUndefined();
  });

  it("return: no cap on the long run either", async () => {
    const runs = await runsFor({ kind: "return" });
    expect(runs.map((r) => r.driftCapBpm)).toEqual([null, 10, 10, null]);
  });

  it("half marathon: long runs capped at 20", async () => {
    const runs = await runsFor({ kind: "race", distance: "half", raceDate: "2026-12-14" });
    expect(runs.map((r) => r.driftCapBpm)).toEqual([null, 10, 10, 20]);
    expect(runs.map(high)).toEqual([false, true, false, true]);
  });

  it("the report's run-by-run uses the goal's caps", async () => {
    const { app, id } = await setup(DRIFT_WEEK, { kind: "fitness" });
    const res = await app.request(`/weeks/${id}/recap?skip_subjective=true`);
    const body = await json(res);
    expect(body.status).toBe("report");
    const md = body.reportMarkdown as string;
    expect(md).toMatch(/HR drift: [\d.]+ → [\d.]+ \(\+12 bpm\) ⚠ above target/);
    expect(md).toMatch(/\(\+18 bpm\)\n/);
    expect(md).toMatch(/\(\+25 bpm\)\n/);
  });
});

describe("easy-run trend in a return week (#09)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("heart rate rising with faster pace reads as no verdict, never declining", async () => {
    const { app, id } = await setup(RETURN_WEEKS, { kind: "return" });

    const tr = await json(await app.request(`/weeks/${id}/recap/trends`));
    const trends = tr.trends as {
      avgEasyHr: number[];
      easyRunTrend: { verdict?: string };
      easyRunLine: string;
    };
    expect(trends.avgEasyHr).toEqual([130, 133, 136, 140]);
    expect(trends.easyRunTrend.verdict).toBeUndefined();
    expect(trends.easyRunLine).toBe(
      "Easy runs: 10:36/mi at 140 bpm, from 11:48/mi at 130 bpm three weeks ago.",
    );
    expect(JSON.stringify(tr)).not.toContain("declining");

    const report = await json(
      await app.request(`/weeks/${id}/recap?skip_subjective=true`),
    );
    expect(report.status).toBe("report");
    const md = report.reportMarkdown as string;
    expect(md).toContain("- **Avg easy HR**: 130 → 133 → 136 → 140");
    expect(md).toContain(
      "- **Easy runs**: 10:36/mi at 140 bpm, from 11:48/mi at 130 bpm three weeks ago",
    );
    expect(md).not.toContain("declining");
  });
});
