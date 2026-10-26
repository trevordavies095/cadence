import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import { assertNoGpsFields } from "../src/tempo/sanitize.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const NY = "America/New_York";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Fixture = {
  id: string;
  startedAt: string;
  runType: string;
  avgHeartRateBpm: number;
  avgCadenceRpm?: number;
  durationS: number;
};

function workout(f: Fixture) {
  return {
    id: f.id,
    startedAt: f.startedAt,
    durationS: f.durationS,
    distanceM: 4828, // 3 mi
    avgPaceS: 450,
    runType: f.runType,
    avgHeartRateBpm: f.avgHeartRateBpm,
    maxHeartRateBpm: 160,
    ...(f.avgCadenceRpm !== undefined ? { avgCadenceRpm: f.avgCadenceRpm } : {}),
    hasRoute: true,
    route: { type: "LineString", coordinates: [[-77.6, 43.1]] },
    splits: [],
  };
}

/**
 * Hand-computed series (durationS 8, one sample per second):
 *   HR 140 140 145 145 150 150 155 155
 *   Q1 = first 2s avg 140, Q4 = last 2s avg 155 => drift +15
 *   avg = 1180 / 8 = 147.5 -> 148
 *   zones (100-119 / 120-139 / 140-149 / 150-159 / 160-200):
 *     Z3 = 4s (140,140,145,145), Z4 = 4s (150..155) => 50% / 50%
 * Max HR 200 (Custom) => 148 / 200 = 74% (summary avg 150 is displayed as-is).
 */
const GOOD_SERIES = [140, 140, 145, 145, 150, 150, 155, 155].map((hr, i) => ({
  elapsedSeconds: i,
  heartRateBpm: hr,
  cadenceRpm: 157,
  distanceM: i * 10,
  // GPS-ish keys Tempo might emit; the port must drop them.
  latitude: 43.1 + i / 1000,
  longitude: -77.6,
  route: { type: "LineString" },
}));

type SeriesBehavior = "ok" | "500" | "404" | "empty";

function buildTempo(args: {
  workouts: Fixture[];
  series: Record<string, SeriesBehavior>;
}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    calls.push(`${p}${url.search}`);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (p === "/workouts") {
      const start = url.searchParams.get("startDate");
      const end = url.searchParams.get("endDate");
      const items = args.workouts
        .filter(
          (w) =>
            (!start || w.startedAt >= start) && (!end || w.startedAt <= end),
        )
        .map(workout);
      return ok({
        items,
        page: 1,
        pageSize: 100,
        totalCount: items.length,
        totalPages: 1,
      });
    }
    const series = p.match(/^\/workouts\/([^/]+)\/time-series$/);
    if (series) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const behavior = args.series[series[1]!] ?? "ok";
      if (behavior === "500") return new Response("boom", { status: 500 });
      if (behavior === "404") return new Response("nope", { status: 404 });
      if (behavior === "empty") return ok([]);
      return ok({ items: GOOD_SERIES });
    }
    const detail = p.match(/^\/workouts\/([^/]+)$/);
    if (detail) {
      const w = args.workouts.find((x) => x.id === detail[1]);
      return w ? ok(workout(w)) : new Response("", { status: 404 });
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
    if (p === "/shoes") return ok([]);
    if (p === "/stats/best-efforts") return ok({ distances: [] });
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;

  const port = createLiveTempoPort({
    fetchImpl,
    readCredentials: async () => ({
      baseUrl: "http://tempo.test",
      apiKey: "tmp_fixture_key_abcd",
    }),
  });
  return { port, calls, maxInFlight: () => maxInFlight };
}

function makeApp(port: ReturnType<typeof createLiveTempoPort>) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    athleteTimezone: NY,
    tempoPort: port,
  });
}

async function openWeek(app: ReturnType<typeof makeApp>) {
  const res = await app.request("/weeks/current", { method: "POST" });
  expect([200, 201]).toContain(res.status);
  const week = await json(res);
  expect(week.isoWeek).toBe("2026-W43");
  return week.id as string;
}

async function saveSubjective(
  app: ReturnType<typeof makeApp>,
  weekSessionId: string,
) {
  return app.request(`/weeks/${weekSessionId}/recap/subjective`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runs: [{ date: "2026-10-19", rpe: 4, felt: 7 }],
      weekly: { stress_level: "ok" },
    }),
  });
}

const MON = "2026-10-19T14:00:00.000Z"; // Mon 10:00 New York

describe("live Tempo time-series in the recap (#84)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("stored recap shows zones, drift, cadence and % of max matching tempo-cli", async () => {
    await acceptAndReady();
    const tempo = buildTempo({
      workouts: [
        {
          id: ID_A,
          startedAt: MON,
          runType: "Easy Run",
          avgHeartRateBpm: 150,
          avgCadenceRpm: 157,
          durationS: 8,
        },
      ],
      series: {},
    });
    const app = makeApp(tempo.port);
    const weekSessionId = await openWeek(app);

    const saveRes = await saveSubjective(app, weekSessionId);
    expect(saveRes.status).toBe(201);
    expect((await json(saveRes)).status).toBe("saved");

    const again = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(again.status).toBe("report");
    const md = again.reportMarkdown as string;

    // Week zone block (tempo-cli bar: width 35, one decimal pct, minutes).
    expect(md).toContain("## HR zone distribution (week total)");
    expect(md).toContain(`Z3 ${"█".repeat(18)}${"░".repeat(17)}  50%   (0m)`);
    expect(md).toContain(`Z4 ${"█".repeat(18)}${"░".repeat(17)}  50%   (0m)`);
    expect(md).toContain(`Z1 ${"░".repeat(35)}  0%   (0m)`);
    expect(md).toContain("This week: **0%**");

    // Run line: summary avg HR shown, % max from series average (148/200).
    expect(md).toContain(
      "Pace: 12:04/mi  ·  Avg HR 150 (74% max)  ·  Max HR 160  ·  Cad 314 spm",
    );
    expect(md).toContain(
      "HR drift: 140 → 155 (+15 bpm) ⚠ above target (target ≤10 bpm)",
    );
    expect(md).toContain("Time in zones: Z1 0% · Z2 0% · Z3 50% · Z4 50% · Z5 0%");
    expect(md).not.toContain("No usable HR samples");
    expect(md).not.toContain("HR drift: n/a");

    // Structured run-by-run too.
    const rbr = await json(
      await app.request(`/weeks/${weekSessionId}/recap/run-by-run?format=json`),
    );
    const run = (rbr.runs as Array<Record<string, unknown>>)[0]!;
    expect(run.pctMaxHr).toBe(74);
    expect(run.cadenceSpm).toBe(314);
    expect(run.drift).toEqual({ q1AvgHr: 140, q4AvgHr: 155, driftBpm: 15 });
    expect(run.zoneSeconds).toEqual([0, 0, 4, 4, 0]);

    // Series was requested through the live port, GPS-free.
    expect(
      tempo.calls.some((c) => c.startsWith(`/workouts/${ID_A}/time-series`)),
    ).toBe(true);
    const points = await tempo.port.getWorkoutTimeSeries!(ID_A);
    expect(points).toHaveLength(8);
    assertNoGpsFields(points);
    expect(JSON.stringify(points)).not.toMatch(
      /latitude|longitude|route|LineString/,
    );
  });

  it("falls back to the series cadence mean when summary lacks avgCadenceRpm", async () => {
    await acceptAndReady();
    const tempo = buildTempo({
      workouts: [
        {
          id: ID_A,
          startedAt: MON,
          runType: "Tempo",
          avgHeartRateBpm: 150,
          durationS: 8,
        },
      ],
      series: {},
    });
    const app = makeApp(tempo.port);
    const weekSessionId = await openWeek(app);
    const rbr = await json(
      await app.request(`/weeks/${weekSessionId}/recap/run-by-run?format=json`),
    );
    const run = (rbr.runs as Array<Record<string, unknown>>)[0]!;
    expect(run.cadenceSpm).toBe(314);
    // Severity label is Easy/Long only (tempo-cli).
    const md = rbr.markdown as string;
    expect(md).toContain("HR drift: 140 → 155 (+15 bpm)\n");
  });

  it("time-series 500 / 404 / empty render n/a with a reason and the check-in completes", async () => {
    await acceptAndReady();
    const tempo = buildTempo({
      workouts: [
        { id: ID_A, startedAt: MON, runType: "Easy Run", avgHeartRateBpm: 150, durationS: 8 },
        { id: ID_B, startedAt: "2026-10-20T14:00:00.000Z", runType: "Easy Run", avgHeartRateBpm: 150, durationS: 8 },
        { id: ID_C, startedAt: "2026-10-21T10:00:00.000Z", runType: "Easy Run", avgHeartRateBpm: 150, durationS: 8 },
      ],
      series: { [ID_A]: "500", [ID_B]: "404", [ID_C]: "empty" },
    });
    const app = makeApp(tempo.port);
    const weekSessionId = await openWeek(app);

    const gate = await app.request(`/weeks/${weekSessionId}/recap`);
    expect(gate.status).toBe(200);
    expect((await json(gate)).status).toBe("needs_subjective");

    const saveRes = await saveSubjective(app, weekSessionId);
    expect(saveRes.status).toBe(201);
    const saved = await json(saveRes);
    expect((saved.gate as { checkInStatus?: string }).checkInStatus).toBe(
      "finished",
    );

    const recap = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(recap.status).toBe("report");
    expect(recap.checkInStatus).toBe("finished");
    const md = recap.reportMarkdown as string;
    expect(md).toContain("HR drift: n/a (time-series unavailable: HTTP 500)");
    expect(md).toContain(
      "HR drift: n/a (time-series unavailable: no samples returned)",
    );
    expect(md).toContain("Time in zones: n/a (no HR data)");
    expect(md).toContain("time-series unavailable");
    // Summary-level run data still renders.
    expect(md).toContain("Avg HR 150 (75% max)");
    expect(md).not.toContain("tmp_fixture_key");
    expect(md).not.toContain("http://tempo.test");
  });

  it("keeps time-series fan-out modest", async () => {
    await acceptAndReady();
    const workouts = Array.from({ length: 8 }, (_, i) => ({
      id: `dddddddd-dddd-4ddd-8ddd-00000000000${i}`,
      startedAt: `2026-10-${String(19 + (i % 3)).padStart(2, "0")}T1${i}:00:00.000Z`,
      runType: "Easy Run",
      avgHeartRateBpm: 150,
      durationS: 8,
    }));
    const tempo = buildTempo({ workouts, series: {} });
    const app = makeApp(tempo.port);
    const weekSessionId = await openWeek(app);
    const res = await app.request(
      `/weeks/${weekSessionId}/recap/run-by-run?format=json`,
    );
    expect(res.status).toBe(200);
    expect(tempo.maxInFlight()).toBeGreaterThan(0);
    expect(tempo.maxInFlight()).toBeLessThanOrEqual(4);
  });

  it("sends no GPS / route keys to the model packet", async () => {
    await acceptAndReady();
    const tempo = buildTempo({
      workouts: [
        {
          id: ID_A,
          startedAt: MON,
          runType: "Easy Run",
          avgHeartRateBpm: 150,
          avgCadenceRpm: 157,
          durationS: 8,
        },
      ],
      series: {},
    });
    const app = makeApp(tempo.port);
    const weekSessionId = await openWeek(app);
    await saveSubjective(app, weekSessionId);
    const recap = await json(await app.request(`/weeks/${weekSessionId}/recap`));

    const res = await app.request("/packet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId,
        recapMarkdown: recap.reportMarkdown,
        attachmentWorkoutIds: [ID_A],
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    assertNoGpsFields(body.packet);
    const text = JSON.stringify(body.packet);
    expect(text).toContain("HR drift: 140 → 155");
    expect(text).not.toMatch(
      /latitude|longitude|LineString|coordinates|"route"|rawGpx|rawFit/,
    );
  });
});
