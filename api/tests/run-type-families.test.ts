import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import type { PrescribedWeek } from "../src/llm/types.js";
import { migrate } from "../src/migrate.js";
import { gradePrescribedVsActual } from "../src/recap/buildGrading.js";
import { driftSeverityLabel } from "../src/recap/runByRunHr.js";
import {
  isEasyFamily,
  isLongRun,
  isQualityFamily,
  isRace,
  RUN_TYPES,
  runTypeFamily,
} from "../src/recap/runTypes.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import type { TempoWorkoutDetail } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const NY = "America/New_York";

type Run = {
  runType?: string;
  avgHeartRateBpm: number;
  avgPaceS: number;
  distanceM: number;
};

/**
 * One run of each Tempo run type plus one untyped run, all in W43
 * (2026-10-19..25, America/New_York). HR and pace are picked so that each
 * family's average is distinct from any other mix.
 */
const WEEK: Run[] = [
  { runType: "Easy Run", avgHeartRateBpm: 130, avgPaceS: 360, distanceM: 8000 },
  { runType: "Recovery", avgHeartRateBpm: 120, avgPaceS: 420, distanceM: 5000 },
  { runType: "Walk-Run", avgHeartRateBpm: 112, avgPaceS: 480, distanceM: 4000 },
  { avgHeartRateBpm: 146, avgPaceS: 400, distanceM: 6000 },
  { runType: "Long Run", avgHeartRateBpm: 150, avgPaceS: 380, distanceM: 20000 },
  { runType: "Workout", avgHeartRateBpm: 170, avgPaceS: 300, distanceM: 9000 },
  { runType: "Threshold", avgHeartRateBpm: 168, avgPaceS: 290, distanceM: 9500 },
  { runType: "Intervals", avgHeartRateBpm: 172, avgPaceS: 280, distanceM: 8500 },
  { runType: "Hills", avgHeartRateBpm: 166, avgPaceS: 330, distanceM: 7000 },
  { runType: "Fartlek", avgHeartRateBpm: 164, avgPaceS: 320, distanceM: 7500 },
  { runType: "Race", avgHeartRateBpm: 180, avgPaceS: 270, distanceM: 10000 },
];

/** Easy family = Easy Run, Recovery, Walk-Run, untyped. */
const EASY_AVG_HR = Math.round((130 + 120 + 112 + 146) / 4); // 127
const EASY_AVG_PACE = (360 + 420 + 480 + 400) / 4; // equal durations → 415

function summaryItems(runs: Run[]) {
  return runs.map((r, i) => {
    const hex = (i + 1).toString(16).padStart(12, "0");
    return {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`,
      // Mon 19 Oct, one hour apart from 14:00Z (10:00 EDT).
      startedAt: new Date(
        Date.UTC(2026, 9, 19, 14 + Math.floor(i / 2), (i % 2) * 30),
      ).toISOString(),
      durationS: 1800,
      distanceM: r.distanceM,
      avgPaceS: r.avgPaceS,
      avgHeartRateBpm: r.avgHeartRateBpm,
      ...(r.runType ? { runType: r.runType } : {}),
    };
  });
}

function buildTempo(runs: Run[]) {
  const items = summaryItems(runs);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (p === "/workouts") {
      const start = url.searchParams.get("startDate")?.slice(0, 10);
      const end = url.searchParams.get("endDate")?.slice(0, 10);
      const page = items.filter((w) => {
        const d = w.startedAt.slice(0, 10);
        return (!start || d >= start) && (!end || d <= end);
      });
      return ok({
        items: page,
        page: 1,
        pageSize: 100,
        totalCount: page.length,
        totalPages: 1,
      });
    }
    if (p === "/stats/weekly-recap") return new Response("nope", { status: 404 });
    if (p === "/settings/unit-preference") {
      return ok({ unitPreference: "metric" });
    }
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

async function weekApp(runs: Run[]) {
  await acceptAndReady();
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    athleteTimezone: NY,
    tempoPort: buildTempo(runs),
  });
  const weekRes = await app.request("/weeks/current", { method: "POST" });
  expect([200, 201]).toContain(weekRes.status);
  const week = await json(weekRes);
  expect(week.isoWeek).toBe("2026-W43");
  return { app, weekId: week.id as string };
}

describe("run-type families", () => {
  it("pins the family of each of the ten Tempo run types and untyped runs", () => {
    const families = Object.fromEntries(
      [...RUN_TYPES, "Unspecified", "", undefined, null].map((t) => [
        String(t),
        runTypeFamily(t),
      ]),
    );
    expect(families).toEqual({
      "Easy Run": "easy",
      Recovery: "easy",
      "Walk-Run": "easy",
      "Long Run": "long",
      Workout: "quality",
      Threshold: "quality",
      Intervals: "quality",
      Hills: "quality",
      Fartlek: "quality",
      Race: "race",
      Unspecified: "easy",
      "": "easy",
      undefined: "easy",
      null: "easy",
    });
    expect(WEEK.map((r) => runTypeFamily(r.runType))).toEqual([
      "easy",
      "easy",
      "easy",
      "easy",
      "long",
      "quality",
      "quality",
      "quality",
      "quality",
      "quality",
      "race",
    ]);
  });

  it("matches labels exactly, case-sensitive, so unknown labels join no family", () => {
    for (const t of ["easy", "Easy", "Tempo", "long run", "race pace"]) {
      expect(isEasyFamily(t)).toBe(false);
      expect(isQualityFamily(t)).toBe(false);
      expect(isLongRun(t)).toBe(false);
      expect(isRace(t)).toBe(false);
      expect(runTypeFamily(t)).toBe("other");
    }
  });
});

describe("summary and trends agree on easy runs", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("counts Easy Run, Recovery, Walk-Run and untyped runs, and nothing else, as easy", async () => {
    const { app, weekId } = await weekApp(WEEK);

    const sumRes = await app.request(
      `/weeks/${weekId}/recap/summary?format=json`,
    );
    expect(sumRes.status).toBe(200);
    const sum = await json(sumRes);
    const rows = sum.rows as Array<Record<string, string>>;
    expect(rows.find((r) => r.metric === "Runs")!.thisWeek).toBe("11");
    expect(rows.find((r) => r.metric === "Avg easy-run HR")!.thisWeek).toBe(
      String(EASY_AVG_HR),
    );

    const trRes = await app.request(`/weeks/${weekId}/recap/trends`);
    expect(trRes.status).toBe(200);
    const tr = await json(trRes);
    const trends = tr.trends as {
      avgEasyHr: (number | null)[];
      easyPaceSecPerKm: (number | null)[];
      longRunDistanceM: (number | null)[];
    };
    expect(trends.avgEasyHr[3]).toBe(EASY_AVG_HR);
    expect(trends.easyPaceSecPerKm[3]).toBeCloseTo(EASY_AVG_PACE, 6);
    expect(trends.longRunDistanceM[3]).toBe(20000);
  });

  it("a week of only Walk-Run and untyped runs still has an easy HR in both", async () => {
    const runs: Run[] = [
      { runType: "Walk-Run", avgHeartRateBpm: 150, avgPaceS: 480, distanceM: 4000 },
      { avgHeartRateBpm: 160, avgPaceS: 400, distanceM: 6000 },
    ];
    const { app, weekId } = await weekApp(runs);

    const sum = await json(
      await app.request(`/weeks/${weekId}/recap/summary?format=json`),
    );
    const rows = sum.rows as Array<Record<string, string>>;
    expect(rows.find((r) => r.metric === "Avg easy-run HR")!.thisWeek).toBe(
      "155",
    );

    const tr = await json(await app.request(`/weeks/${weekId}/recap/trends`));
    const trends = tr.trends as {
      avgEasyHr: (number | null)[];
      easyPaceSecPerKm: (number | null)[];
    };
    expect(trends.avgEasyHr[3]).toBe(155);
    expect(trends.easyPaceSecPerKm[3]).toBeCloseTo(440, 6);
  });
});

describe("drift label gate", () => {
  it("labels drift only on easy-family and Long Run runs", () => {
    const labelled = [...RUN_TYPES, undefined].filter(
      (t) => driftSeverityLabel(15, t) !== undefined,
    );
    expect(labelled).toEqual([
      "Easy Run",
      "Recovery",
      "Walk-Run",
      "Long Run",
      undefined,
    ]);
    expect(driftSeverityLabel(8, "Easy Run")).toBeUndefined();
  });
});

describe("quality-session matcher", () => {
  function plan(): PrescribedWeek {
    return {
      week: "2026-W43",
      days: [
        {
          date: "2026-10-22",
          dayType: "quality",
          run: {
            type: "quality",
            distanceM: 8000,
            structure: "session",
            paceOrHr: "hard",
            shoes: null,
          },
        },
      ],
    };
  }

  function run(id: string, runType: string, distanceM: number): TempoWorkoutDetail {
    return {
      id,
      startedAt: "2026-10-22T12:00:00Z",
      distanceM,
      durationS: 2400,
      avgPaceS: 300,
      avgHeartRateBpm: 160,
      runType,
      name: runType,
      splits: [],
    };
  }

  it.each(["Workout", "Threshold", "Intervals", "Hills", "Fartlek"])(
    "a %s run matches a prescribed quality day over a longer easy run",
    (runType) => {
      const graded = gradePrescribedVsActual({
        plan: plan(),
        workouts: [
          run("11111111-1111-4111-8111-111111111111", "Easy Run", 12000),
          run("22222222-2222-4222-8222-222222222222", runType, 8000),
        ],
        timeZoneId: "UTC",
        unit: "metric",
        resolvedIsoWeek: "2026-W43",
      });
      expect(graded.quality[0]).toMatchObject({
        matched: true,
        workoutId: "22222222-2222-4222-8222-222222222222",
        actualRunType: runType,
      });
    },
  );
});
