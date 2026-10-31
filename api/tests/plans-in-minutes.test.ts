import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  createStubLlmPort,
  expectedPlanDates,
  type LlmPort,
  type MidWeekChatReply,
  type PrescribedDay,
  type PrescribedRun,
  type PrescribedWeek,
  validateMidWeekChatReply,
  validateWeeklyReply,
} from "../src/llm/index.js";
import { prescribedRunJsonSchema } from "../src/llm/anthropic.js";
import { migrate } from "../src/migrate.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { gradePrescribedVsActual } from "../src/recap/buildGrading.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoWorkoutDetail } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const NEXT_MONDAY = "2026-10-26";

/** A weekly reply whose Tuesday carries `run`, every other day rest. */
function replyWithTuesday(run: unknown, dayType = "easy") {
  return {
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek: {
      week: "2026-W44",
      days: expectedPlanDates(NEXT_MONDAY).map((date, i) =>
        i === 1 ? { date, dayType, run } : { date, dayType: "rest", run: null },
      ),
    },
  };
}

describe("a planned run can be prescribed by duration", () => {
  it("accepts a run with a duration and no distance", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ type: "easy", distanceM: 0, durationS: 2400 }),
      NEXT_MONDAY,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.prescribedWeek.days[1]!.run).toEqual({
      type: "easy",
      distanceM: 0,
      durationS: 2400,
    });
  });

  it("accepts a duration with distanceM left out, storing distance as 0", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ type: "easy", durationS: 2400 }),
      NEXT_MONDAY,
    );
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.run).toEqual({
      type: "easy",
      distanceM: 0,
      durationS: 2400,
    });
  });

  it("keeps both when a run has a distance and a duration", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ type: "easy", distanceM: 8000, durationS: 2700 }),
      NEXT_MONDAY,
    );
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.run).toMatchObject({
      distanceM: 8000,
      durationS: 2700,
    });
  });

  it("refuses a run with neither a distance nor a duration", () => {
    const checked = validateWeeklyReply(replyWithTuesday({ type: "easy" }), NEXT_MONDAY);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toMatch(/distanceM must be a number >= 0/);
  });

  it("refuses a duration that is not a positive number", () => {
    for (const durationS of [-60, 0, "40 min", Number.NaN]) {
      const checked = validateWeeklyReply(
        replyWithTuesday({ type: "easy", distanceM: 0, durationS }),
        NEXT_MONDAY,
      );
      expect(checked.ok, String(durationS)).toBe(false);
      expect(!checked.ok && checked.error).toMatch(/durationS must be a number > 0 or null/);
    }
  });

  it("treats a timed run on a rest day as a run, not rest", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ type: "easy", distanceM: 0, durationS: 1800 }, "rest"),
      NEXT_MONDAY,
    );
    expect(!checked.ok && checked.error).toMatch(/is rest but has a non-rest run/);
  });

  it("accepts a timed day in a mid-week change", () => {
    const checked = validateMidWeekChatReply(
      {
        body: "Thursday is now 40 minutes easy.",
        prescribedDayPatches: [
          { date: "2026-10-29", dayType: "easy", run: { type: "easy", durationS: 2400 } },
        ],
      },
      NEXT_MONDAY,
    );
    expect(checked.ok && checked.value.prescribedDayPatches).toEqual([
      { date: "2026-10-29", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 2400 } },
    ]);
  });

  it("offers Coach Cade a duration in seconds on the tool schema", () => {
    const schema = prescribedRunJsonSchema() as {
      properties: Record<string, { type: unknown; description?: string }>;
    };
    expect(schema.properties.durationS!.type).toEqual(["number", "null"]);
    expect(schema.properties.durationS!.description).toMatch(/seconds/);
    expect(schema.properties.distanceM!.description).toMatch(/0 when/);
  });
});

function workout(
  partial: Partial<TempoWorkoutDetail> & { id: string; startedAt: string },
): TempoWorkoutDetail {
  return {
    distanceM: 6000,
    durationS: 2500,
    avgPaceS: 400,
    avgHeartRateBpm: 140,
    runType: "Workout",
    name: "Run",
    splits: [],
    ...partial,
  } as TempoWorkoutDetail;
}

/** A W43 plan with the given runs by weekday index; every other day rest. */
function gradingPlan(runs: Record<number, PrescribedRun>): PrescribedWeek {
  return {
    week: "2026-W43",
    days: expectedPlanDates("2026-10-19").map((date, i): PrescribedDay => {
      const run = runs[i];
      if (!run) return { date, dayType: "rest", run: null };
      return { date, dayType: run.type === "long" ? "long" : "quality", run };
    }),
  };
}

describe("grading a timed day", () => {
  it("matches a timed quality day by date and grades it on target", () => {
    const graded = gradePrescribedVsActual({
      plan: gradingPlan({
        3: { type: "quality", distanceM: 0, durationS: 2400, structure: "5 x 3 min hard" },
      }),
      workouts: [workout({ id: "q1", startedAt: "2026-10-22T12:00:00Z" })],
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.quality).toHaveLength(1);
    expect(graded.quality[0]).toMatchObject({
      matched: true,
      workoutId: "q1",
      verdict: "on_target",
    });
    expect(graded.quality[0]!.distanceRatio).toBeUndefined();
    expect(graded.qualityMarkdown).toContain("Prescribed: 40 min");
    expect(graded.qualityMarkdown).not.toContain("% of plan");
  });

  it("still misses a timed day with no run on its date", () => {
    const graded = gradePrescribedVsActual({
      plan: gradingPlan({ 3: { type: "quality", distanceM: 0, durationS: 2400 } }),
      workouts: [workout({ id: "q1", startedAt: "2026-10-21T12:00:00Z" })],
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.quality[0]).toMatchObject({ matched: false, verdict: "missed" });
  });

  it("matches a timed long run by date", () => {
    const graded = gradePrescribedVsActual({
      plan: gradingPlan({ 6: { type: "long", distanceM: 0, durationS: 5400 } }),
      workouts: [
        workout({
          id: "l1",
          startedAt: "2026-10-25T12:00:00Z",
          runType: "Long Run",
          distanceM: 15000,
        }),
      ],
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.longRun).toMatchObject({
      matched: true,
      workoutId: "l1",
      verdict: "on_target",
      thresholdMet: true,
    });
    expect(graded.longRunGradeMarkdown).toContain("Prescribed: 1 h 30 min");
  });

  it("names both distance and duration when the plan had both", () => {
    const graded = gradePrescribedVsActual({
      plan: gradingPlan({ 3: { type: "quality", distanceM: 8000, durationS: 2700 } }),
      workouts: [
        workout({ id: "q1", startedAt: "2026-10-22T12:00:00Z", distanceM: 8000 }),
      ],
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.qualityMarkdown).toContain("Prescribed: 8.00 km, 45 min");
    expect(graded.quality[0]!.distanceRatio).toBe(1);
  });
});

const THIS_WEEK: PrescribedWeek = {
  week: "2026-W43",
  days: [
    { date: "2026-10-19", dayType: "easy", run: { type: "easy", distanceM: 8000 } },
    { date: "2026-10-20", dayType: "rest", run: null },
    { date: "2026-10-21", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 2400 } },
    {
      date: "2026-10-22",
      dayType: "quality",
      run: { type: "quality", distanceM: 10000, durationS: 3000 },
    },
    { date: "2026-10-23", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 1800 } },
    { date: "2026-10-24", dayType: "rest", run: null },
    { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 16000 } },
  ],
};

describe("timed days through the API", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function setup(nowIso: string, llmPort: LlmPort = createStubLlmPort()) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(nowIso)),
      athleteTimezone: "America/New_York",
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort,
    });
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_minutes_test_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-minutes-test-key" }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
    ] as const) {
      const res = await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.ok).toBe(true);
    }
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    await savePrescribedWeek({
      at: new Date(nowIso),
      weekSessionId,
      plan: structuredClone(THIS_WEEK),
      analysis: "Seeded.",
    });
    return { app, weekSessionId };
  }

  it("Home carries each day's planned minutes and totals the minutes of timed days", async () => {
    const { app } = await setup("2026-10-21T15:00:00.000Z");
    const body = await json(await app.request("/home"));
    const week = body.week as Array<Record<string, unknown>>;
    expect(week[2]).toMatchObject({ plannedDistanceM: 0, plannedDurationS: 2400, state: "today" });
    expect(week[3]).toMatchObject({ plannedDistanceM: 10000, plannedDurationS: 3000 });
    expect(week[0]).toMatchObject({ plannedDistanceM: 8000, plannedDurationS: null });
    expect(week[4]).toMatchObject({ plannedDurationS: 1800, state: "upcoming" });
    expect(body.totals).toMatchObject({
      plannedDistanceM: 8000 + 10000 + 16000,
      // Only days with no distance: a day with both is already in the distance.
      plannedDurationS: 2400 + 1800,
    });
    expect(body.today).toMatchObject({ run: { distanceM: 0, durationS: 2400 } });
  });

  it("Home totals no minutes when every day has a distance", async () => {
    const { app, weekSessionId } = await setup("2026-10-21T15:00:00.000Z");
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId,
      plan: {
        ...THIS_WEEK,
        days: THIS_WEEK.days.map((d) =>
          d.run && d.run.distanceM === 0
            ? { ...d, run: { type: "easy" as const, distanceM: 5000 } }
            : d,
        ),
      },
      analysis: "Seeded.",
    });
    const body = await json(await app.request("/home"));
    expect(body.totals).toMatchObject({ plannedDistanceM: 8000 + 5000 + 10000 + 5000 + 16000 });
    expect((body.totals as { plannedDurationS: number }).plannedDurationS).toBe(0);
  });

  it("a mid-week change to a timed day is stored and carried on the card", async () => {
    const stub = createStubLlmPort();
    const port: LlmPort = {
      ...stub,
      async generateMidWeekChatReply() {
        return {
          body: "Friday is now 40 minutes easy.",
          prescribedDayPatches: [
            { date: "2026-10-23", dayType: "easy", run: { type: "easy", durationS: 2400 } },
          ],
        } as unknown as MidWeekChatReply;
      },
    };
    const { app, weekSessionId } = await setup("2026-10-21T15:00:00.000Z", port);
    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Can Friday be by time?" }),
    });
    expect(res.status).toBe(201);
    const reply = (await json(res)).coachMessage as { planChanges: PrescribedDay[] | null };
    expect(reply.planChanges).toEqual([
      { date: "2026-10-23", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 2400 } },
    ]);
    const stored = await json(await app.request(`/weeks/${weekSessionId}/prescribed`));
    const plan = (stored.prescribed as { plan: PrescribedWeek }).plan;
    expect(plan.days[4]!.run).toEqual({ type: "easy", distanceM: 0, durationS: 2400 });
  });
});
