import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { appendGoal } from "../src/goal/store.js";
import type { TrainingGoal } from "../src/goal/types.js";
import { migrate } from "../src/migrate.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import type { TempoUnitPreference } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const NY = "America/New_York";
// "Now" is Wed 2026-10-21 (ISO 2026-W43: Mon Oct 19 - Sun Oct 25, New York).
const NOW = new Date("2026-10-21T15:00:00.000Z");

type Split = { distanceM: number; durationS: number; paceS: number };

type Fixture = {
  id: string;
  startedAt: string;
  runType: string;
  distanceM: number;
  avgPaceS: number;
  durationS: number;
  splits: Split[];
};

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

/** 1 km splits: `first` at `restPace`, then `last` at `lastPace` (s/km). */
function kmSplits(first: number, restPace: number, last: number, lastPace: number): Split[] {
  return [
    ...Array.from({ length: first }, () => ({ distanceM: 1000, durationS: restPace, paceS: restPace })),
    ...Array.from({ length: last }, () => ({ distanceM: 1000, durationS: lastPace, paceS: lastPace })),
  ];
}

function run(n: number, startedAt: string, runType: string, km: number, splits: Split[] = []): Fixture {
  const durationS = splits.length
    ? splits.reduce((a, s) => a + s.durationS, 0)
    : km * 330;
  return {
    id: id(n),
    startedAt,
    runType,
    distanceM: km * 1000,
    avgPaceS: durationS / km,
    durationS,
    splits,
  };
}

/**
 * Long runs grow every week: 14, 16, 18, 21 km. This week's 21 km runs the
 * first 16 km at 5:30/km and the last 5 km at 5:18/km: 12 s/km faster.
 */
const LONG_W40 = run(1, "2026-10-04T13:00:00.000Z", "Long Run", 14);
const LONG_W41 = run(2, "2026-10-11T13:00:00.000Z", "Long Run", 16);
const LONG_W42 = run(3, "2026-10-18T13:00:00.000Z", "Long Run", 18);
const EASY_W43 = run(4, "2026-10-20T13:00:00.000Z", "Easy Run", 8);
const LONG_W43 = run(5, "2026-10-24T13:00:00.000Z", "Long Run", 21, kmSplits(16, 330, 5, 318));
/** The same run, typed Easy Run: no run this week is typed Long Run. */
const UNTYPED_W43 = { ...LONG_W43, runType: "Easy Run" };

const FULL = [LONG_W40, LONG_W41, LONG_W42, EASY_W43, LONG_W43];

function buildTempo(workouts: Fixture[], unit: TempoUnitPreference) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const full = (f: Fixture) => ({
      id: f.id,
      startedAt: f.startedAt,
      durationS: f.durationS,
      distanceM: f.distanceM,
      avgPaceS: f.avgPaceS,
      runType: f.runType,
      avgHeartRateBpm: 140,
      maxHeartRateBpm: 160,
      splits: f.splits,
    });
    if (p === "/workouts") {
      const start = url.searchParams.get("startDate");
      const end = url.searchParams.get("endDate");
      const items = workouts
        .filter((w) => (!start || w.startedAt >= start) && (!end || w.startedAt <= end))
        .map(full);
      return ok({ items, page: 1, pageSize: 100, totalCount: items.length, totalPages: 1 });
    }
    if (/^\/workouts\/[^/]+\/time-series$/.test(p)) return ok({ items: [] });
    const detail = p.match(/^\/workouts\/([^/]+)$/);
    if (detail) {
      const w = workouts.find((x) => x.id === detail[1]);
      return w ? ok(full(w)) : new Response("", { status: 404 });
    }
    if (p === "/settings/unit-preference") return ok({ unitPreference: unit });
    if (p === "/settings/heart-rate-zones") {
      return ok({
        calculationMethod: "Custom",
        maxHeartRateBpm: 200,
        zones: [
          { zoneNumber: 1, minBpm: 100, maxBpm: 119 },
          { zoneNumber: 2, minBpm: 120, maxBpm: 139 },
          { zoneNumber: 3, minBpm: 140, maxBpm: 149 },
          { zoneNumber: 4, minBpm: 150, maxBpm: 159 },
          { zoneNumber: 5, minBpm: 160, maxBpm: 200 },
        ],
      });
    }
    if (p === "/settings/default-shoe") return ok({ defaultShoeId: null });
    if (p === "/shoes") return ok([]);
    if (p === "/stats/best-efforts") return ok({ distances: [] });
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;

  return createLiveTempoPort({
    fetchImpl,
    readCredentials: async () => ({
      baseUrl: "http://tempo.test",
      apiKey: "tmp_fixture_key_abcd",
    }),
  });
}

async function report(
  goal: TrainingGoal | null,
  opts: { unit?: TempoUnitPreference; workouts?: Fixture[] } = {},
) {
  if (goal) await appendGoal(new Date("2026-10-01T12:00:00Z"), goal, "settings");
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    athleteTimezone: NY,
    tempoPort: buildTempo(opts.workouts ?? FULL, opts.unit ?? "metric"),
  });
  const weekRes = await app.request("/weeks/current", { method: "POST" });
  const week = await json(weekRes);
  expect(week.isoWeek).toBe("2026-W43");
  const res = await app.request(`/weeks/${week.id as string}/recap?skip_subjective=true`);
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.status).toBe("report");
  return body as {
    reportMarkdown: string;
    sections: { longRun: string; trends: string };
  };
}

const LONG_TREND_VALUES = "14.00 km → 16.00 km → 18.00 km → 21.00 km";
const FAST_FINISH_METRIC = "Fast finish? Yes (last 5 km 12 s/km faster than the rest)";

/**
 * The distance trend line. It is labelled "Long-run distance" for goals with a
 * long-run section and "Longest run" for the others.
 */
function longTrendLine(trends: string): string {
  const line = trends
    .split("\n")
    .find((l) => l.includes("**Long-run distance**") || l.includes("**Longest run**"));
  expect(line).toBeDefined();
  return line!;
}

describe("the long-run section by goal (#08)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("marathon in base: long run, metric fast-finish line, trend verdict", async () => {
    const body = await report({ kind: "race", distance: "marathon" });
    const longRun = body.sections.longRun;
    expect(longRun).toContain("### Long run — Sat Oct 24 — 21.00 km");
    expect(longRun).toContain(FAST_FINISH_METRIC);
    const finishLine = longRun.split("\n").find((l) => l.startsWith("Fast finish?"));
    expect(finishLine).toBe(FAST_FINISH_METRIC);
    expect(longRun).not.toMatch(/marathon-pace|HR above|easy cap|\bmi\b/);
    expect(longTrendLine(body.sections.trends)).toContain(LONG_TREND_VALUES);
    expect(longTrendLine(body.sections.trends)).toMatch(/\(improving\)$/);
  });

  it("marathon for an imperial athlete: the delta in s/mi over the last 3 mi", async () => {
    const body = await report({ kind: "race", distance: "marathon" }, { unit: "imperial" });
    // 12 s/km is 19 s/mi; the last 3 mi takes the last five 1 km splits.
    expect(body.sections.longRun).toContain(
      "Fast finish? Yes (last 3 mi 19 s/mi faster than the rest)",
    );
  });

  it("half in build: section, fast finish and verdict", async () => {
    // Dec 14 is eight weeks after Mon Oct 19: build.
    const body = await report({ kind: "race", distance: "half", raceDate: "2026-12-14" });
    expect(body.sections.longRun).toContain("### Long run — ");
    expect(body.sections.longRun).toContain(FAST_FINISH_METRIC);
    expect(longTrendLine(body.sections.trends)).toMatch(/\(improving\)$/);
  });

  it("marathon in peak: section and fast finish, no trend verdict", async () => {
    // Nov 2 is two weeks after Mon Oct 19: peak.
    const body = await report({ kind: "race", distance: "marathon", raceDate: "2026-11-02" });
    expect(body.sections.longRun).toContain(FAST_FINISH_METRIC);
    const line = longTrendLine(body.sections.trends);
    expect(line).toContain(LONG_TREND_VALUES);
    expect(line).not.toMatch(/improving|declining/);
  });

  it("10k: section without a fast-finish line; four trend values, no verdict", async () => {
    const body = await report({ kind: "race", distance: "10k" });
    expect(body.sections.longRun).toContain("### Long run — Sat Oct 24 — 21.00 km");
    expect(body.sections.longRun).not.toContain("Fast finish");
    const line = longTrendLine(body.sections.trends);
    expect(line).toContain(LONG_TREND_VALUES);
    expect(line).not.toMatch(/improving|declining/);
  });

  const noSection: Array<[string, TrainingGoal | null]> = [
    ["5k", { kind: "race", distance: "5k" }],
    ["speed", { kind: "speed", distance: "5k" }],
    ["stay fit", { kind: "fitness" }],
    ["return", { kind: "return" }],
    ["no goal stored", null],
  ];
  for (const [label, goal] of noSection) {
    it(`${label}: no long-run section and no trend verdict`, async () => {
      const body = await report(goal);
      expect(body.sections.longRun).toBe("");
      expect(body.reportMarkdown).not.toMatch(/^#+ Long(est)? run/m);
      expect(body.reportMarkdown).not.toContain("Fast finish");
      const line = longTrendLine(body.sections.trends);
      expect(line).toContain("**Longest run**");
      expect(line).not.toMatch(/improving|declining/);
    });
  }

  it("no run typed Long Run: the longest run stands in, titled Longest run", async () => {
    const body = await report(
      { kind: "race", distance: "half" },
      { workouts: [LONG_W40, LONG_W41, LONG_W42, EASY_W43, UNTYPED_W43] },
    );
    const longRun = body.sections.longRun;
    expect(longRun).toContain("### Longest run — Sat Oct 24 — 21.00 km");
    expect(longRun).toContain("No run was typed Long Run this week.");
    expect(longRun).not.toContain("### Long run");
    expect(longRun).toContain(FAST_FINISH_METRIC);
  });

  it("a slower finish says No, with the delta", async () => {
    const slow = run(5, "2026-10-24T13:00:00.000Z", "Long Run", 21, kmSplits(16, 330, 5, 340));
    const body = await report(
      { kind: "race", distance: "marathon" },
      { workouts: [LONG_W40, LONG_W41, LONG_W42, EASY_W43, slow] },
    );
    expect(body.sections.longRun).toContain(
      "Fast finish? No (last 5 km 10 s/km slower than the rest)",
    );
  });
});
