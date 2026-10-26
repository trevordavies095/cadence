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
const MON = "2026-10-19T14:00:00.000Z"; // Mon 10:00 New York
const SIMILAR_STARTED = "2026-06-15T14:00:00.000Z"; // exactly 18 weeks earlier

/** Lines as tempo-cli prints them for this run. */
const TEMPO_CLI_WEATHER = "Weather: 60°F, 49% RH, 7.5 mph";
const TEMPO_CLI_SIMILAR =
  "Similar route: 3.0 mi Easy Run 18 weeks ago at 12:06/mi · avg HR 139 → 2s/mi faster at -21 bpm avg HR ✓";

type SimilarBehavior =
  | "ok-flat"
  | "ok-wrapped"
  | "500"
  | "404"
  | "empty"
  | "no-data";

function buildTempo(args: {
  unit?: "imperial" | "metric";
  hasRoute?: boolean;
  weather?: unknown;
  similar?: SimilarBehavior;
}) {
  const calls: string[] = [];
  const w = {
    id: ID_A,
    startedAt: MON,
    durationS: 2179,
    distanceM: 4844, // 3.01 mi
    avgPaceS: 450,
    runType: "Easy Run",
    avgHeartRateBpm: 160,
    maxHeartRateBpm: 170,
    hasRoute: args.hasRoute ?? true,
    route: { type: "LineString", coordinates: [[-77.6, 43.1]] },
    splits: [],
    ...(args.weather !== undefined ? { weather: args.weather } : {}),
  };
  const similarRow = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    startedAt: SIMILAR_STARTED,
    distanceM: 4828, // 3.0 mi
    avgPaceS: 451.1, // 12:06/mi
    avgHeartRateBpm: 139,
    runType: "Easy Run",
    route: { type: "LineString", coordinates: [[-77.6, 43.1]] },
    latitude: 43.1,
  };
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    calls.push(`${p}${url.search}`);
    if (p === "/workouts") {
      return ok({
        items: [w],
        page: 1,
        pageSize: 100,
        totalCount: 1,
        totalPages: 1,
      });
    }
    const sim = p.match(/^\/workouts\/([^/]+)\/similar-routes$/);
    if (sim) {
      switch (args.similar ?? "ok-wrapped") {
        case "500":
          return new Response("boom", { status: 500 });
        case "404":
          return new Response("nope", { status: 404 });
        case "empty":
          return ok([]);
        case "no-data":
          return ok([{ startedAt: SIMILAR_STARTED }]);
        case "ok-flat":
          return ok([similarRow]);
        default:
          return ok({
            items: [
              {
                workout: similarRow,
                paceDifferenceSecondsPerKm: 1.1,
                heartRateDifferenceBpm: -21,
              },
            ],
          });
      }
    }
    if (/^\/workouts\/[^/]+\/time-series$/.test(p)) return ok({ items: [] });
    if (/^\/workouts\/[^/]+$/.test(p)) return ok(w);
    if (p === "/settings/unit-preference") {
      return ok({ unitPreference: args.unit ?? "imperial" });
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
  return { port, calls };
}

function makeApp(port: ReturnType<typeof createLiveTempoPort>) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    athleteTimezone: NY,
    tempoPort: port,
  });
}

/** Opens W43, saves the subjective check-in (must complete), returns the report. */
async function recapMarkdown(app: ReturnType<typeof makeApp>) {
  const res = await app.request("/weeks/current", { method: "POST" });
  expect([200, 201]).toContain(res.status);
  const week = await json(res);
  const save = await app.request(`/weeks/${week.id}/recap/subjective`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runs: [{ date: "2026-10-19", rpe: 3, felt: 4 }],
      weekly: { stress_level: "ok" },
    }),
  });
  expect(save.status).toBe(201);
  expect((await json(save)).status).toBe("saved");
  const recap = await json(await app.request(`/weeks/${week.id}/recap`));
  expect(recap.status).toBe("report");
  return { md: recap.reportMarkdown as string, weekId: week.id as string };
}

const WEATHER_C = { temperature: 15.6, humidity: 49, windSpeed: 3.35 };

describe("recap similar-route and weather lines (#87)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("PARITY: Oct 19 run lines equal tempo-cli's W43 recap, in its position", async () => {
    await acceptAndReady();
    const tempo = buildTempo({ weather: WEATHER_C });
    const { md } = await recapMarkdown(makeApp(tempo.port));

    expect(md).toContain(`\n${TEMPO_CLI_WEATHER}\n`);
    expect(md).toContain(`\n${TEMPO_CLI_SIMILAR}\n`);

    // tempo-cli order: zones, weather, relative effort, similar route, notes/RPE.
    const zones = md.indexOf("Time in zones:");
    const weather = md.indexOf(TEMPO_CLI_WEATHER);
    const similar = md.indexOf(TEMPO_CLI_SIMILAR);
    const rpe = md.indexOf("RPE: 3/10");
    expect(zones).toBeGreaterThan(-1);
    expect(weather).toBeGreaterThan(zones);
    expect(similar).toBeGreaterThan(weather);
    expect(rpe).toBeGreaterThan(similar);

    expect(
      tempo.calls.filter((c) => c.includes("/similar-routes")),
    ).toContain(`/workouts/${ID_A}/similar-routes?maxResults=3`);
  });

  it("joins Elevation and Weather on one line like tempo-cli", async () => {
    const { buildRunByRunMarkdown } = await import(
      "../src/recap/runByRunFormat.js"
    );
    const md = buildRunByRunMarkdown(
      [
        {
          workoutId: ID_A,
          startedAt: MON,
          titleDate: "Mon Oct 19",
          runType: "Easy Run",
          distanceM: 4844,
          durationS: 2179,
          avgPaceS: 450,
          elevGainM: 10,
          elevLossM: 20,
          weather: "60°F, 49% RH, 7.5 mph",
          splits: [],
        },
      ],
      "imperial",
    );
    expect(md).toContain("Elevation: ↑33 ft ↓66 ft  ·  Weather: 60°F, 49% RH, 7.5 mph");
  });

  it("metric unit: °C, km/h, km and sec/km; API deltas on a wrapped row", async () => {
    await acceptAndReady();
    const tempo = buildTempo({
      unit: "metric",
      weather: WEATHER_C,
      similar: "ok-wrapped",
    });
    const { md } = await recapMarkdown(makeApp(tempo.port));
    expect(md).toContain("\nWeather: 16°C, 49% RH, 12.1 km/h\n");
    expect(md).toContain(
      "\nSimilar route: 4.83 km Easy Run 18 weeks ago at 7:31/km · avg HR 139 → 1s/km faster at -21 bpm avg HR ✓\n",
    );
  });

  it("computes deltas from the rows when the API sends none (tempo-cli fallback)", async () => {
    await acceptAndReady();
    const tempo = buildTempo({ weather: WEATHER_C, similar: "ok-flat" });
    const { md } = await recapMarkdown(makeApp(tempo.port));
    expect(md).toContain(
      "\nSimilar route: 3.0 mi Easy Run 18 weeks ago at 12:06/mi · avg HR 139 → 2s/mi faster at +21 bpm avg HR\n",
    );
  });

  it("omits Weather when Tempo has none; string wind passes through", async () => {
    await acceptAndReady();
    const none = buildTempo({});
    const a = await recapMarkdown(makeApp(none.port));
    expect(a.md).not.toContain("Weather:");

    await resetAppTables();
    await acceptAndReady();
    const str = buildTempo({
      weather: { temperature: 0, humidity: 80.4, wind: " 5 mph NW " },
    });
    const b = await recapMarkdown(makeApp(str.port));
    expect(b.md).toContain("\nWeather: 32°F, 80% RH, 5 mph NW\n");
  });

  it("no route: no similar-routes request; tempo-cli's 'n/a' line", async () => {
    await acceptAndReady();
    const tempo = buildTempo({ hasRoute: false, weather: WEATHER_C });
    const { md } = await recapMarkdown(makeApp(tempo.port));
    expect(tempo.calls.some((c) => c.includes("similar-routes"))).toBe(false);
    expect(md).toContain("\nSimilar route: n/a\n");
    expect(md).toContain(TEMPO_CLI_WEATHER);
  });

  it.each([
    ["500", "Similar route: n/a (HTTP 500)"],
    ["404", "Similar route: n/a (HTTP 404)"],
    ["empty", "Similar route: n/a"],
    ["no-data", "Similar route: n/a"],
  ] as const)(
    "similar-routes %s degrades without blocking the check-in",
    async (similar, expected) => {
      await acceptAndReady();
      const tempo = buildTempo({ weather: WEATHER_C, similar });
      const { md } = await recapMarkdown(makeApp(tempo.port));
      expect(md).toContain(`\n${expected}\n`);
      expect(md).toContain(TEMPO_CLI_WEATHER);
      expect(md).toContain("### Mon Oct 19");
    },
  );

  it("no GPS / route geometry reaches the packet or the port rows", async () => {
    await acceptAndReady();
    const tempo = buildTempo({ weather: WEATHER_C });
    const app = makeApp(tempo.port);
    const { md, weekId } = await recapMarkdown(app);
    expect(md).not.toMatch(/latitude|longitude|LineString|coordinates|"route"/);

    const rows = await tempo.port.getSimilarRoutes!(ID_A, 3);
    expect(rows).toHaveLength(1);
    assertNoGpsFields(rows);
    expect(JSON.stringify(rows)).not.toMatch(
      /latitude|longitude|route|LineString|coordinates/,
    );

    const rbr = await app.request(
      `/weeks/${weekId}/recap/run-by-run?format=json`,
    );
    const text = await rbr.text();
    expect(text).not.toMatch(/latitude|longitude|LineString|coordinates/);
    expect(text).toContain("Similar route:");
  });
});
