import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { appendGoal } from "../src/goal/store.js";
import { buildStubWeeklyReply } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const NY = "America/New_York";
// "Now" is Wed 2026-10-21 (ISO 2026-W43: Mon Oct 19 - Sun Oct 25, New York).
const NOW = new Date("2026-10-21T15:00:00.000Z");
const THIS_WEEK_START_ISO = "2026-10-19T04:00:00.000Z";

type Fixture = {
  id: string;
  startedAt: string;
  runType: string;
  distanceM: number;
  avgPaceS: number;
  durationS: number;
  avgHeartRateBpm: number;
};

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

/**
 * Hand-computed sample (imperial; Z2 max 139):
 *   W40 (Sep 28-Oct 4):  Easy 2.00 mi, pace 480 s/km, HR 130
 *   W41: no runs
 *   W42 (Oct 12-18):     Easy 5.00 mi, pace 420 s/km, HR 138
 *   W43 (this week):     Easy 3 mi, pace 450 s/km, HR 135 + Long Run 10 mi
 */
const W40_EASY: Fixture = {
  id: id(1),
  startedAt: "2026-09-29T14:00:00.000Z",
  runType: "Easy Run",
  distanceM: 3219,
  avgPaceS: 480,
  durationS: 1500,
  avgHeartRateBpm: 130,
};
const W42_EASY: Fixture = {
  id: id(2),
  startedAt: "2026-10-13T14:00:00.000Z",
  runType: "Easy Run",
  distanceM: 8047,
  avgPaceS: 420,
  durationS: 2000,
  avgHeartRateBpm: 138,
};
const W43_EASY: Fixture = {
  id: id(3),
  startedAt: "2026-10-19T14:00:00.000Z",
  runType: "Easy Run",
  distanceM: 4828,
  avgPaceS: 450,
  durationS: 1800,
  avgHeartRateBpm: 135,
};
const W43_LONG: Fixture = {
  id: id(4),
  startedAt: "2026-10-24T14:00:00.000Z",
  runType: "Long Run",
  distanceM: 16093,
  avgPaceS: 400,
  durationS: 6400,
  avgHeartRateBpm: 145,
};

/** Mon Oct 19 06:00 in Brisbane (UTC+10) is Sun Oct 18 20:00 UTC. */
const BNE_EARLY_MONDAY: Fixture = {
  id: id(5),
  startedAt: "2026-10-18T20:00:00.000Z",
  runType: "Easy Run",
  distanceM: 8047,
  avgPaceS: 400,
  durationS: 3200,
  avgHeartRateBpm: 135,
};

const TREND_PACE =
  "- **Easy pace (≤Z2, list/detail approx.)**: 12:52/mi → — → 11:16/mi → 12:04/mi ▁▁█▅";
const TREND_HR = "- **Avg easy HR**: 130 → — → 138 → 135 █▁▁▃";
const TREND_LONG =
  "- **Long-run distance** (max long-typed, else max run in week): 2.00 mi → — → 5.00 mi → 10.00 mi ▁▁▃█ (improving)";
const NOTABLE_PR = [
  "- New best: 5K 21:40 (was 22:05)",
  "- New best: Half-Marathon 1:41:05 (was 1:43:20)",
].join("\n");

type Behavior = {
  workouts: Fixture[];
  /**
   * What Tempo's `since` call returns: "pr" (default) a 5K and a half
   * marathon that beat earlier bests, "first" a first-ever 10K, "later" a
   * best set by a run after this week, "early-monday" a 5K by the Brisbane
   * run (returned only when since is on or before its UTC date, as Tempo
   * compares), "empty" none, "500" a failure.
   */
  bestEfforts?: "pr" | "first" | "later" | "early-monday" | "empty" | "500";
  /** Records the `since` query of each best-efforts call. */
  bestEffortsSince?: (string | null)[];
  /** Make only the Notable builder's shoe lookup throw (Run-by-run keeps working). */
  notableThrows?: boolean;
  /** Fail the multi-week Trends window (spans before and into this week). */
  failOlderWorkouts?: boolean;
};

function buildTempo(b: Behavior) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const full = (f: Fixture) => ({
      id: f.id,
      startedAt: f.startedAt,
      durationS: f.durationS,
      distanceM: f.distanceM,
      avgPaceS: f.avgPaceS,
      runType: f.runType,
      avgHeartRateBpm: f.avgHeartRateBpm,
      maxHeartRateBpm: 160,
      splits: [],
    });
    if (p === "/workouts") {
      const start = url.searchParams.get("startDate");
      const end = url.searchParams.get("endDate");
      if (
        b.failOlderWorkouts &&
        start &&
        end &&
        start < THIS_WEEK_START_ISO &&
        end > THIS_WEEK_START_ISO
      ) {
        return new Response("boom", { status: 500 });
      }
      const items = b.workouts
        .filter(
          (w) =>
            (!start || w.startedAt >= start) && (!end || w.startedAt <= end),
        )
        .map(full);
      return ok({
        items,
        page: 1,
        pageSize: 100,
        totalCount: items.length,
        totalPages: 1,
      });
    }
    if (/^\/workouts\/[^/]+\/time-series$/.test(p)) return ok({ items: [] });
    const detail = p.match(/^\/workouts\/([^/]+)$/);
    if (detail) {
      const w = b.workouts.find((x) => x.id === detail[1]);
      return w ? ok(full(w)) : new Response("", { status: 404 });
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
    if (p === "/stats/best-efforts") {
      const since = url.searchParams.get("since");
      b.bestEffortsSince?.push(since);
      if (b.bestEfforts === "500") return new Response("boom", { status: 500 });
      // Without since Tempo returns all-time bests; Notable must not use them.
      if (!since) {
        return ok({
          distances: [
            {
              distance: "5K",
              distanceM: 5000,
              timeS: 1200,
              workoutId: W40_EASY.id,
              workoutDate: "2026-09-29",
              previousTimeS: null,
            },
          ],
        });
      }
      if (b.bestEfforts === "empty") return ok({ distances: [] });
      const row = (
        distance: string,
        distanceM: number,
        timeS: number,
        previousTimeS: number | null,
        workoutId = W43_LONG.id,
      ) => ({
        distance,
        distanceM,
        timeS,
        workoutId,
        workoutDate: "2026-10-24",
        previousTimeS,
      });
      if (b.bestEfforts === "early-monday") {
        // Tempo compares since with the run's UTC start date (2026-10-18).
        const utcDate = BNE_EARLY_MONDAY.startedAt.slice(0, 10);
        return ok({
          distances:
            since <= utcDate
              ? [
                  {
                    ...row("5K", 5000, 1300, 1325, BNE_EARLY_MONDAY.id),
                    workoutDate: utcDate,
                  },
                ]
              : [],
        });
      }
      if (b.bestEfforts === "first") {
        return ok({ distances: [row("10K", 10000, 2770, null)] });
      }
      if (b.bestEfforts === "later") {
        return ok({ distances: [row("5K", 5000, 1290, 1325, id(9))] });
      }
      return ok({
        distances: [
          row("Half-Marathon", 21097.5, 6065, 6200),
          row("5K", 5000, 1300, 1325),
        ],
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;

  const live = createLiveTempoPort({
    fetchImpl,
    readCredentials: async () => ({
      baseUrl: "http://tempo.test",
      apiKey: "tmp_fixture_key_abcd",
    }),
  });
  if (!b.notableThrows) return live;
  return {
    ...live,
    listShoes: async (q) => {
      if (new Error().stack?.includes("buildRecapNotable")) {
        throw new Error("shoes down");
      }
      return live.listShoes(q);
    },
  };
}

function makeApp(b: Behavior, extra: Record<string, unknown> = {}) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    athleteTimezone: NY,
    tempoPort: buildTempo(b),
    ...extra,
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
      weekly: { stress_level: "ok", questions_for_coach: ["Volume?"] },
    }),
  });
}

const FULL: Behavior = { workouts: [W40_EASY, W42_EASY, W43_EASY, W43_LONG] };

/** A marathon with no race date: base, so the report has the long-run section. */
async function storeMarathonGoal() {
  await appendGoal(
    new Date("2026-10-01T12:00:00Z"),
    { kind: "race", distance: "marathon" },
    "settings",
  );
}

describe("full recap sections in tempo-cli order (#88)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
    await storeMarathonGoal();
  });

  it("stored recap and thread artifact contain Long run, Trends, Notable in order", async () => {
    const app = makeApp(FULL);
    const weekSessionId = await openWeek(app);
    const saveRes = await saveSubjective(app, weekSessionId);
    expect(saveRes.status).toBe(201);
    const saved = await json(saveRes);

    const stored = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(stored.status).toBe("report");
    const md = stored.reportMarkdown as string;
    const artifact = (saved.threadArtifact as { markdown: string }).markdown;
    expect(artifact).toBe(md);

    const order = [
      "## Summary",
      "## HR zone distribution (week total)",
      "## Run-by-run",
      "### Long run — ",
      "## Trends",
      "## Notable",
      "## Subjective recap",
      "Volume?",
    ].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Trends lines as tempo-cli prints them for the hand-computed data.
    const trends = md.slice(md.indexOf("## Trends"), md.indexOf("## Notable"));
    expect(trends).toBe(
      ["## Trends", "", TREND_PACE, "", TREND_HR, "", TREND_LONG, "", ""].join(
        "\n",
      ),
    );
    expect(md).not.toContain("Weeks:");

    // Notable names each new best of the week, shortest distance first.
    expect(md).toContain(`## Notable\n\n${NOTABLE_PR}\n`);

    // Long run: tempo-cli shape (no section heading).
    const longRun = md.slice(
      md.indexOf("### Long run — "),
      md.indexOf("## Trends"),
    );
    expect(longRun).toContain(" — 10.00 mi / 1h 46m");
    expect(longRun).toContain(
      "Avg pace: 10:44/mi  ·  Avg HR 145  ·  Drift: n/a",
    );
    expect(longRun).toContain("Splits: n/a");
    // No splits in the fixture, so the fast-finish line cannot tell.
    expect(longRun).toContain("Fast finish? n/a (no split paces)");
    expect(md).not.toMatch(/^## Long run/m);

    // Per-section routes keep returning what they did.
    const routeTrends = await app.request(
      `/weeks/${weekSessionId}/recap/trends?format=markdown`,
    );
    expect(routeTrends.status).toBe(200);
    expect(await routeTrends.text()).toContain("## Trends");
  });

  it("without a typed long run the longest run stands in; Notable omitted when empty", async () => {
    const app = makeApp({
      workouts: [W42_EASY, W43_EASY],
      bestEfforts: "empty",
    });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).not.toContain("### Long run —");
    expect(md).toContain("### Longest run — ");
    expect(md).toContain("No run was typed Long Run this week.");
    expect(md).toContain("## Trends");
    // Long-run trend falls back to the longest run, as in tempo-cli (marathon base: verdict).
    expect(md).toContain(
      "- **Long-run distance** (max long-typed, else max run in week): — → — → 5.00 mi → 3.00 mi ▁▁█▁ (declining)",
    );
    expect(md).not.toContain("## Notable");
    expect(md).not.toContain("New best");
    expect(md.indexOf("## Run-by-run")).toBeLessThan(md.indexOf("## Trends"));
    expect(md.indexOf("## Trends")).toBeLessThan(
      md.indexOf("## Subjective recap"),
    );

    // The separate routes keep their placeholder behaviour.
    const notableRoute = await app.request(
      `/weeks/${weekSessionId}/recap/notable?format=markdown`,
    );
    expect(await notableRoute.text()).toContain("No notable items this week.");
  });

  it("a week with no runs has no Trends, Notable or Long run", async () => {
    const app = makeApp({ workouts: [], bestEfforts: "empty" });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).not.toContain("## Trends");
    expect(md).not.toContain("## Notable");
    expect(md).not.toContain("Long run —");
    expect(md).toContain("## Summary");
  });

  it("failing trends and notable fetches never block the check-in", async () => {
    const app = makeApp({
      workouts: [W40_EASY, W42_EASY, W43_EASY, W43_LONG],
      failOlderWorkouts: true,
      notableThrows: true,
    });
    const weekSessionId = await openWeek(app);
    const saveRes = await saveSubjective(app, weekSessionId);
    expect(saveRes.status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).not.toContain("## Trends");
    expect(md).not.toContain("## Notable");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Run-by-run");
    expect(md).toContain("### Long run — ");
    expect(md).toContain("## Subjective recap");
  });

  it("asks Tempo for bests set since this week's Monday", async () => {
    const since: (string | null)[] = [];
    const app = makeApp({ ...FULL, bestEffortsSince: since });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    expect(since.length).toBeGreaterThan(0);
    // The Sunday before the local Monday, as Tempo compares UTC dates.
    expect(new Set(since)).toEqual(new Set(["2026-10-18"]));
  });

  it("a best from an early Monday run east of UTC is still named", async () => {
    const app = makeApp(
      { workouts: [BNE_EARLY_MONDAY], bestEfforts: "early-monday" },
      { athleteTimezone: "Australia/Brisbane" },
    );
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).toContain("- New best: 5K 21:40 (was 22:05)");
  });

  it("a first effort at a distance says so", async () => {
    const app = makeApp({ ...FULL, bestEfforts: "first" });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).toContain(
      "## Notable\n\n- New best: 10K 46:10 (first time at this distance)\n",
    );
  });

  it("a best set after this week stays out of this week's Notable", async () => {
    const app = makeApp({
      workouts: [W42_EASY, W43_EASY],
      bestEfforts: "later",
    });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).not.toContain("New best");
    expect(md).not.toContain("## Notable");
  });

  it("a failing best-efforts fetch drops only the new-best lines", async () => {
    const app = makeApp({ ...FULL, bestEfforts: "500" });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    const md = (await json(await app.request(`/weeks/${weekSessionId}/recap`)))
      .reportMarkdown as string;
    expect(md).toContain("## Trends");
    expect(md).not.toContain("## Notable");
  });
});

describe("full recap sections reach the weekly reply (#88)", () => {
  let prevProvider: string | undefined;

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    prevProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "anthropic";
  });

  afterEach(() => {
    if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prevProvider;
  });

  it("the logged weekly reply request contains Trends, Notable and Long run", async () => {
    await acceptAndReady();
    await storeMarathonGoal();
    await putAnthropicConnection(
      "sk-ant-test-key-fixture-xyz",
      new SecretProtector(TEST_DATA_PROTECTION_KEY),
    );
    const stub = buildStubWeeklyReply(
      buildModelPacket({
        dossier: null,
        recapMarkdown: null,
        thread: [],
        attachments: [],
        week: {
          isoWeek: "2026-W43",
          start: "2026-10-19T00:00:00.000Z",
          end: "2026-10-25T23:59:59.999Z",
          weekSessionId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    );
    const llmFetch = vi.fn(async () =>
      anthropicStreamResponse(anthropicToolMessage("submit_weekly_reply", stub)),
    ) as unknown as typeof globalThis.fetch;
    const app = makeApp(FULL, { llmFetch });
    const weekSessionId = await openWeek(app);
    expect((await saveSubjective(app, weekSessionId)).status).toBe(201);
    // Finishing the check-in already started a reply; let it settle first.
    await waitForReplyRunsIdle();

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId }),
    });
    expect(res.status).toBe(200);

    const thread = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    const coach = (thread.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "coach",
    );
    const row = await json(await app.request(`/llm-calls/${coach!.llmCallId}`));
    const sent = JSON.stringify(row.request);
    for (const needle of [
      "## Trends",
      "## Notable",
      "### Long run — ",
      "Long-run distance",
      "New best: 5K 21:40 (was 22:05)",
    ]) {
      expect(sent).toContain(needle);
    }
    expect(sent.indexOf("Run-by-run")).toBeLessThan(sent.indexOf("## Trends"));
    expect(sent.indexOf("## Trends")).toBeLessThan(sent.indexOf("## Notable"));
    expect(sent.indexOf("## Notable")).toBeLessThan(
      sent.indexOf("## Subjective recap"),
    );
  });
});
