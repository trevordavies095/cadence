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
  type PrescribedWeek,
  validateMidWeekChatReply,
  validateWeeklyReply,
} from "../src/llm/index.js";
import { prescribedDayJsonSchema } from "../src/llm/anthropic.js";
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

/** A weekly reply whose Tuesday is `tuesday`, every other day rest. */
function replyWithTuesday(tuesday: Record<string, unknown>) {
  return {
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek: {
      week: "2026-W44",
      days: expectedPlanDates(NEXT_MONDAY).map((date, i) =>
        i === 1 ? { date, ...tuesday } : { date, dayType: "rest", run: null },
      ),
    },
  };
}

describe("a planned day that is not a run", () => {
  it("accepts an other day with no run, its notes saying what the day is", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ dayType: "other", run: null, notes: "45 min on the bike, easy." }),
      NEXT_MONDAY,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.prescribedWeek.days[1]).toEqual({
      date: "2026-10-27",
      dayType: "other",
      run: null,
      notes: "45 min on the bike, easy.",
    });
  });

  it("accepts an other day with the run left out", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ dayType: "other", notes: "Strength: squats and lunges." }),
      NEXT_MONDAY,
    );
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.run).toBeUndefined();
  });

  it("refuses an other day with no run and nothing saying what it is", () => {
    for (const notes of [undefined, null, "  "]) {
      const checked = validateWeeklyReply(
        replyWithTuesday({ dayType: "other", run: null, notes }),
        NEXT_MONDAY,
      );
      expect(checked.ok, String(notes)).toBe(false);
      expect(!checked.ok && checked.error).toMatch(/other\) with no run needs notes/);
    }
  });

  it("still requires a run on easy, quality, long and race days", () => {
    for (const dayType of ["easy", "quality", "long", "race"]) {
      const checked = validateWeeklyReply(
        replyWithTuesday({ dayType, run: null, notes: "A walk." }),
        NEXT_MONDAY,
      );
      expect(checked.ok, dayType).toBe(false);
      expect(!checked.ok && checked.error).toMatch(/requires a run object/);
    }
  });

  it("keeps an other day with a run as a run", () => {
    const checked = validateWeeklyReply(
      replyWithTuesday({ dayType: "other", run: { type: "other", distanceM: 5000 } }),
      NEXT_MONDAY,
    );
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.run).toEqual({
      type: "other",
      distanceM: 5000,
    });
  });

  it("accepts a run-less day in a mid-week change", () => {
    const checked = validateMidWeekChatReply(
      {
        body: "Thursday is a swim instead.",
        prescribedDayPatches: [
          { date: "2026-10-29", dayType: "other", run: null, notes: "30 min easy swim." },
        ],
      },
      NEXT_MONDAY,
    );
    expect(checked.ok && checked.value.prescribedDayPatches).toEqual([
      { date: "2026-10-29", dayType: "other", run: null, notes: "30 min easy swim." },
    ]);
  });

  it("tells Coach Cade an other day may have no run, with notes saying what it is", () => {
    const schema = prescribedDayJsonSchema() as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.dayType!.description).toMatch(/other.*no run/i);
    expect(schema.properties.dayType!.description).toMatch(/notes/);
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

describe("grading a day that is not a run", () => {
  const plan: PrescribedWeek = {
    week: "2026-W43",
    days: expectedPlanDates("2026-10-19").map((date, i): PrescribedDay => {
      if (i === 1) return { date, dayType: "other", run: null, notes: "Strength, 30 min." };
      if (i === 3) {
        return {
          date,
          dayType: "quality",
          run: { type: "quality", distanceM: 10000, structure: "5 x 1 km" },
        };
      }
      return { date, dayType: "rest", run: null };
    }),
  };

  it("neither misses nor counts a run-less day when nothing was run on it", () => {
    const graded = gradePrescribedVsActual({
      plan,
      workouts: [workout({ id: "q1", startedAt: "2026-10-22T12:00:00Z", distanceM: 10000 })],
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.quality).toHaveLength(1);
    expect(graded.quality[0]).toMatchObject({ date: "2026-10-22", verdict: "on_target" });
    expect(graded.longRun).toBeNull();
    expect(graded.qualityMarkdown ?? "").not.toContain("2026-10-20");
  });

  it("does not grade a run on a run-less day as a planned session", () => {
    const graded = gradePrescribedVsActual({
      plan,
      workouts: [
        workout({ id: "x1", startedAt: "2026-10-20T12:00:00Z" }),
        workout({ id: "q1", startedAt: "2026-10-22T12:00:00Z", distanceM: 10000 }),
      ],
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.quality.map((g) => g.workoutId)).toEqual(["q1"]);
  });
});

const THIS_WEEK: PrescribedWeek = {
  week: "2026-W43",
  days: [
    { date: "2026-10-19", dayType: "other", run: null, notes: "Strength: 30 min, legs and core." },
    { date: "2026-10-20", dayType: "easy", run: { type: "easy", distanceM: 8000 } },
    { date: "2026-10-21", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 2400 } },
    { date: "2026-10-22", dayType: "other", run: null, notes: "An hour's walk." },
    { date: "2026-10-23", dayType: "rest", run: null },
    { date: "2026-10-24", dayType: "other", notes: "45 min on the bike." },
    { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 16000 } },
  ],
};

describe("days that are not runs through the API", () => {
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
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_notrun_test_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-notrun-test-key" }],
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

  it("Home counts nothing for run-less days and never marks a past one missed", async () => {
    // Wednesday: Monday's strength day is past, with nothing run on it.
    const { app } = await setup("2026-10-21T15:00:00.000Z");
    const body = await json(await app.request("/home"));
    const week = body.week as Array<Record<string, unknown>>;
    expect(week[0]).toMatchObject({
      dayType: "other",
      plannedDistanceM: null,
      plannedDurationS: null,
    });
    expect(["missed", "unknown"]).not.toContain(week[0]!.state);
    expect(week[3]).toMatchObject({ dayType: "other", plannedDistanceM: null, plannedDurationS: null });
    expect(week[5]).toMatchObject({ dayType: "other", plannedDistanceM: null, plannedDurationS: null });
    expect(body.totals).toMatchObject({
      plannedDistanceM: 8000 + 16000,
      plannedDurationS: 2400,
    });
  });

  it("Home's today carries a run-less day with its notes", async () => {
    const { app } = await setup("2026-10-22T15:00:00.000Z");
    const body = await json(await app.request("/home"));
    expect(body.today).toEqual({
      date: "2026-10-22",
      dayType: "other",
      run: null,
      notes: "An hour's walk.",
    });
  });

  it("a mid-week change to a run-less day is stored and carried on the card", async () => {
    const stub = createStubLlmPort();
    const port: LlmPort = {
      ...stub,
      async generateMidWeekChatReply() {
        return {
          body: "Friday is a swim, to rest the calf.",
          prescribedDayPatches: [
            { date: "2026-10-23", dayType: "other", run: null, notes: "30 min easy swim." },
          ],
        } as unknown as MidWeekChatReply;
      },
    };
    const { app, weekSessionId } = await setup("2026-10-21T15:00:00.000Z", port);
    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "My calf is tight, can Friday be a swim?" }),
    });
    expect(res.status).toBe(201);
    const reply = (await json(res)).coachMessage as { planChanges: PrescribedDay[] | null };
    expect(reply.planChanges).toEqual([
      { date: "2026-10-23", dayType: "other", run: null, notes: "30 min easy swim." },
    ]);
    const stored = await json(await app.request(`/weeks/${weekSessionId}/prescribed`));
    const plan = (stored.prescribed as { plan: PrescribedWeek }).plan;
    expect(plan.days[4]).toEqual({
      date: "2026-10-23",
      dayType: "other",
      run: null,
      notes: "30 min easy swim.",
    });
  });
});
