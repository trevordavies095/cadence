import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const NY = "America/New_York";

type Fixture = {
  id: string;
  startedAt: string;
  distanceM: number;
  durationS: number;
  elevGainM?: number;
  relativeEffort?: number;
  runType?: string;
  avgHeartRateBpm?: number;
};

// W43 (2026-10-19..25 NY): Mon 00:00 EDT = 04:00Z. Prev window W42 ends
// 2026-10-19T03:59:59.999Z, but Tempo matches endDate by DATE (2026-10-19).
const THIS_MON_RUN: Fixture = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  startedAt: "2026-10-19T15:58:52.000Z", // on W42's end DATE, after its end INSTANT
  distanceM: 4828,
  durationS: 2000,
  elevGainM: 10,
  relativeEffort: 78,
  runType: "Easy Run",
  avgHeartRateBpm: 150,
};
const PREV_WEEK_RUN: Fixture = {
  // Mon of W42: on W41's end date, after W41's end instant.
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  startedAt: "2026-10-12T15:00:00.000Z",
  distanceM: 5000,
  durationS: 1800,
  elevGainM: 20,
  relativeEffort: 30,
};
const W41_RUN: Fixture = {
  id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  startedAt: "2026-10-07T12:00:00.000Z",
  distanceM: 10000,
  durationS: 3600,
  elevGainM: 50,
  relativeEffort: 60,
};

function summaryWorkout(f: Fixture) {
  return {
    id: f.id,
    startedAt: f.startedAt,
    durationS: f.durationS,
    distanceM: f.distanceM,
    avgPaceS: 450,
    ...(f.elevGainM !== undefined ? { elevGainM: f.elevGainM } : {}),
    ...(f.relativeEffort !== undefined
      ? { relativeEffort: f.relativeEffort }
      : {}),
    ...(f.runType ? { runType: f.runType } : {}),
    ...(f.avgHeartRateBpm !== undefined
      ? { avgHeartRateBpm: f.avgHeartRateBpm }
      : {}),
  };
}

type StatsBehavior = "404" | "500" | { metrics: unknown } | "garbage";

function buildTempo(args: { workouts: Fixture[]; stats: StatsBehavior }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    calls.push(`${p}${url.search}`);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (p === "/workouts") {
      // Real Tempo: startDate/endDate filter by calendar DATE, not time.
      const start = url.searchParams.get("startDate")?.slice(0, 10);
      const end = url.searchParams.get("endDate")?.slice(0, 10);
      const items = args.workouts
        .filter((w) => {
          const d = w.startedAt.slice(0, 10);
          return (!start || d >= start) && (!end || d <= end);
        })
        .map(summaryWorkout);
      return ok({
        items,
        page: 1,
        pageSize: 100,
        totalCount: items.length,
        totalPages: 1,
      });
    }
    if (p === "/stats/weekly-recap") {
      if (args.stats === "404") return new Response("nope", { status: 404 });
      if (args.stats === "500") return new Response("boom", { status: 500 });
      if (args.stats === "garbage") return ok({ unrelated: true });
      return ok(args.stats);
    }
    if (p === "/settings/unit-preference") {
      return ok({ unitPreference: "imperial" });
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

  const port = createLiveTempoPort({
    fetchImpl,
    readCredentials: async () => ({
      baseUrl: "http://tempo.test",
      apiKey: "tmp_fixture_key_abcd",
    }),
  });
  return { port, calls };
}

async function summary(args: { workouts: Fixture[]; stats: StatsBehavior }) {
  await acceptAndReady();
  const tempo = buildTempo(args);
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    athleteTimezone: NY,
    tempoPort: tempo.port,
  });
  const weekRes = await app.request("/weeks/current", { method: "POST" });
  expect([200, 201]).toContain(weekRes.status);
  const week = await json(weekRes);
  expect(week.isoWeek).toBe("2026-W43");
  const res = await app.request(
    `/weeks/${week.id as string}/recap/summary?format=json`,
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  const rows = body.rows as Array<Record<string, string>>;
  const byMetric = (m: string) => rows.find((r) => r.metric === m)!;
  return { body, rows, byMetric, calls: tempo.calls };
}

const STATS_BODY = {
  metrics: {
    runs: { current: 1, previous: 4, trailingAvg: 3 },
    distanceM: { current: 4828, previous: 32186.88, trailingAvg: 48280.32 },
    durationS: { current: 2000, previous: 7200, trailingAvg: 10800 },
    elevationGainM: { current: 10, previous: 100, trailingAvg: 200 },
    relativeEffortSum: { current: 78, previous: 300, trailingAvg: 400 },
    easyRunAvgHeartRateBpm: { current: 150, previous: 150, trailingAvg: 152 },
  },
};

describe("recap week windows + summary columns match tempo-cli (#83)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("(a) a run on the previous window's end date but after its end instant is not in the previous week or 3-wk avg", async () => {
    const { byMetric, body } = await summary({
      workouts: [THIS_MON_RUN, PREV_WEEK_RUN, W41_RUN],
      stats: "404",
    });
    expect(body.comparisonSource).toBe("windows");
    // This week keeps its Monday run.
    expect(byMetric("Runs").thisWeek).toBe("1");
    expect(byMetric("Mileage").thisWeek).toBe("3.00 mi");
    // Prev week = only PREV_WEEK_RUN (5000 m), not also THIS_MON_RUN.
    expect(byMetric("Runs").prevWeek).toBe("1");
    expect(byMetric("Mileage").prevWeek).toBe("3.11 mi"); // 5000 m
    // 3-wk avg over W40(0) / W41(10000, not +PREV_WEEK_RUN) / W42(5000).
    const comparison = body.comparison as {
      mileage: { threeWkAvgDistanceM: number };
      runs: { threeWkAvg: number };
    };
    expect(comparison.mileage.threeWkAvgDistanceM).toBeCloseTo(5000, 6);
    expect(comparison.runs.threeWkAvg).toBeCloseTo(2 / 3, 6);
  });

  it("(b) prev / 3-wk / delta columns come from /stats/weekly-recap (tempo-cli params)", async () => {
    const { byMetric, body, calls } = await summary({
      workouts: [THIS_MON_RUN, PREV_WEEK_RUN, W41_RUN],
      stats: STATS_BODY,
    });
    expect(body.comparisonSource).toBe("weekly-recap");
    expect(calls).toContain(
      "/stats/weekly-recap?timezoneOffsetMinutes=-240&referenceDate=2026-10-19",
    );
    // Prior windows are not listed when stats answer.
    expect(
      calls.filter((c) => c.startsWith("/workouts?")).length,
    ).toBe(1);

    expect(byMetric("Mileage")).toMatchObject({
      thisWeek: "3.00 mi",
      prevWeek: "20.00 mi",
      threeWkAvg: "30.00 mi",
      delta: "-27.0",
    });
    expect(byMetric("Runs")).toMatchObject({
      thisWeek: "1",
      prevWeek: "4",
      threeWkAvg: "3.0",
      delta: "-2.0",
    });
    expect(byMetric("Total time")).toMatchObject({
      thisWeek: "33m 20s",
      prevWeek: "2h 0m",
      threeWkAvg: "3h 0m",
      delta: "-2h 26m",
    });
    expect(byMetric("Total elevation")).toMatchObject({
      thisWeek: "33 ft",
      prevWeek: "328 ft",
      threeWkAvg: "656 ft",
      delta: "-623 ft",
    });
    expect(byMetric("Relative effort")).toMatchObject({
      thisWeek: "78",
      prevWeek: "300",
      threeWkAvg: "400",
      delta: "-322",
    });
    expect(byMetric("Avg easy-run HR")).toMatchObject({
      thisWeek: "150",
      prevWeek: "150",
      threeWkAvg: "152",
      delta: "-2",
    });
  });

  it.each(["404", "500", "garbage"] as const)(
    "(c) falls back to the filtered windows when /stats/weekly-recap is %s",
    async (stats) => {
      const { byMetric, body, calls } = await summary({
        workouts: [THIS_MON_RUN, PREV_WEEK_RUN, W41_RUN],
        stats,
      });
      expect(calls.some((c) => c.startsWith("/stats/weekly-recap"))).toBe(true);
      expect(body.comparisonSource).toBe("windows");
      expect(byMetric("Mileage")).toMatchObject({
        thisWeek: "3.00 mi",
        prevWeek: "3.11 mi",
        threeWkAvg: "3.11 mi",
        delta: "-0.1",
      });
      expect(byMetric("Runs")).toMatchObject({
        prevWeek: "1",
        threeWkAvg: "0.7",
        delta: "+0.3",
      });
    },
  );

  it("(d) zero weeks use tempo-cli cells: 0.00 mi, 0s, 0 ft, 0", async () => {
    const noElev = { ...THIS_MON_RUN };
    delete noElev.elevGainM;
    const { byMetric, rows, body } = await summary({
      workouts: [noElev],
      stats: "404",
    });
    expect(body.comparisonSource).toBe("windows");
    expect(byMetric("Mileage")).toMatchObject({
      thisWeek: "3.00 mi",
      prevWeek: "0.00 mi",
      threeWkAvg: "0.00 mi",
      delta: "+3.0",
    });
    expect(byMetric("Runs")).toMatchObject({
      prevWeek: "0",
      threeWkAvg: "0.0",
      delta: "+1.0",
    });
    expect(byMetric("Total time")).toMatchObject({
      thisWeek: "33m 20s",
      prevWeek: "0s",
      threeWkAvg: "0s",
      delta: "+33m",
    });
    expect(byMetric("Total elevation")).toMatchObject({
      thisWeek: "0 ft",
      prevWeek: "0 ft",
      threeWkAvg: "0 ft",
      delta: "+0 ft",
    });
    expect(byMetric("Relative effort")).toMatchObject({
      thisWeek: "78",
      prevWeek: "0",
      threeWkAvg: "0",
      delta: "+78",
    });
    expect(byMetric("Avg easy-run HR").prevWeek).toBe("—");
    expect(body.markdown as string).toContain(
      "| Total elevation | 0 ft | 0 ft | 0 ft | +0 ft |",
    );
    expect(rows).toHaveLength(6);
  });
});
