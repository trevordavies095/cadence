import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import type { PrescribedWeek } from "../src/llm/types.js";
import { migrate } from "../src/migrate.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { gradePrescribedVsActual } from "../src/recap/buildGrading.js";
import { RECAP_SKELETON_ORDER } from "../src/recap/phase.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoWorkoutDetail } from "../src/tempo/port.js";
import { assertNoGpsFields } from "../src/tempo/sanitize.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

function fixtureWorkout(partial: {
  id: string;
  startedAt: string;
  distanceM: number;
  durationS: number;
  avgPaceS: number;
  avgHeartRateBpm: number;
  runType: string;
  name: string;
}): TempoWorkoutDetail {
  return {
    ...partial,
    splits: [],
  };
}

describe("prescribed-vs-actual grading (#41)", () => {
  it("grades quality + long run against actuals; omits when no plan sessions", () => {
    const plan: PrescribedWeek = {
      week: "2026-W43",
      days: [
        {
          date: "2026-10-19",
          dayType: "rest",
          run: null,
        },
        {
          date: "2026-10-20",
          dayType: "long",
          run: {
            type: "long",
            distanceM: 10000,
            paceOrHr: "easy–steady",
            structure: null,
            shoes: null,
          },
        },
        {
          date: "2026-10-21",
          dayType: "easy",
          run: {
            type: "easy",
            distanceM: 8000,
            paceOrHr: "easy",
          },
        },
        {
          date: "2026-10-22",
          dayType: "quality",
          run: {
            type: "quality",
            distanceM: 5000,
            structure: "5k threshold",
            paceOrHr: "threshold effort",
            shoes: "race flat",
          },
        },
        { date: "2026-10-23", dayType: "rest", run: null },
        { date: "2026-10-24", dayType: "rest", run: null },
        { date: "2026-10-25", dayType: "rest", run: null },
      ],
    };

    const workouts: TempoWorkoutDetail[] = [
      fixtureWorkout({
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-10-20T12:00:00Z",
        distanceM: 10000,
        durationS: 3600,
        avgPaceS: 360,
        avgHeartRateBpm: 140,
        runType: "Easy Run",
        name: "Monday 10k",
      }),
      fixtureWorkout({
        id: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-10-22T12:00:00Z",
        distanceM: 5000,
        durationS: 1800,
        avgPaceS: 360,
        avgHeartRateBpm: 145,
        runType: "Easy Run",
        name: "Wednesday 5k",
      }),
    ];

    const graded = gradePrescribedVsActual({
      plan,
      workouts,
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });

    expect(graded.included).toBe(true);
    expect(graded.weekMismatch).toBe(false);
    expect(graded.quality).toHaveLength(1);
    expect(graded.quality[0]).toMatchObject({
      date: "2026-10-22",
      matched: true,
      verdict: "on_target",
      workoutId: "22222222-2222-4222-8222-222222222222",
    });
    expect(graded.qualityMarkdown).toContain("## Quality sessions");
    expect(graded.qualityMarkdown).toContain("### Quality session");
    expect(graded.qualityMarkdown).toContain("Prescribed:");
    expect(graded.qualityMarkdown).toContain("Actual:");
    expect(graded.qualityMarkdown).toContain("Verdict: on target.");

    expect(graded.longRun).toMatchObject({
      date: "2026-10-20",
      matched: true,
      thresholdMet: true,
      verdict: "on_target",
      workoutId: "11111111-1111-4111-8111-111111111111",
    });
    expect(graded.longRunGradeMarkdown).toContain("Long run grade");
    expect(graded.longRunGradeMarkdown).toContain("Prescribed vs actual");
    expect(graded.longRunGradeMarkdown).toContain("threshold 75%");

    const emptyPlan: PrescribedWeek = {
      week: "2026-W43",
      days: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-10-${String(19 + i).padStart(2, "0")}`,
        dayType: "rest" as const,
        run: null,
      })),
    };
    const omitted = gradePrescribedVsActual({
      plan: emptyPlan,
      workouts,
      timeZoneId: "UTC",
      unit: "metric",
      resolvedIsoWeek: "2026-W43",
    });
    expect(omitted.included).toBe(false);
    expect(omitted.qualityMarkdown).toBe("");
    expect(omitted.longRunGradeMarkdown).toBe("");
  });

  it("marks missed quality when no workout on prescribed date", () => {
    const plan: PrescribedWeek = {
      week: "2026-W43",
      days: [
        {
          date: "2026-10-23",
          dayType: "quality",
          run: {
            type: "quality",
            distanceM: 10000,
            structure: "intervals",
            paceOrHr: "threshold",
          },
        },
      ],
    };
    // pad to 7 days for realism (grader only needs quality days)
    while (plan.days.length < 7) {
      const i = plan.days.length;
      plan.days.push({
        date: `2026-10-${String(19 + i).padStart(2, "0")}`,
        dayType: "rest",
        run: null,
      });
    }

    const graded = gradePrescribedVsActual({
      plan,
      workouts: [
        fixtureWorkout({
          id: "22222222-2222-4222-8222-222222222222",
          startedAt: "2026-10-22T12:00:00Z",
          distanceM: 5000,
          durationS: 1800,
          avgPaceS: 360,
          avgHeartRateBpm: 145,
          runType: "Easy Run",
          name: "Wed",
        }),
      ],
      timeZoneId: "UTC",
      unit: "imperial",
      resolvedIsoWeek: "2026-W43",
    });
    expect(graded.quality[0]?.verdict).toBe("missed");
    expect(graded.qualityMarkdown).toContain("no workout/race on prescribed date");
  });
});

describe("recap skeleton grading with export fixture (#41)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function openWeek() {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });
    const weekRes = await app.request("/weeks/current", { method: "POST" });
    expect(weekRes.status).toBe(201);
    const week = await json(weekRes);
    expect(week.isoWeek).toBe("2026-W43");
    return {
      app,
      weekSessionId: week.id as string,
      tempoPort,
    };
  }

  it("omits grading sections when no prescribed week exists", async () => {
    const { app, weekSessionId } = await openWeek();
    const res = await app.request(
      `/weeks/${weekSessionId}/recap/skeleton?format=json&phase=base`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.gradingIncluded).toBe(false);
    expect(body.sectionOrder).toEqual([...RECAP_SKELETON_ORDER]);
    expect(body.sections).toMatchObject({ quality: "" });
    const md = body.markdown as string;
    expect(md).not.toContain("## Quality sessions");
    expect(md).not.toContain("Long run grade");
    expect(md).not.toContain("Prescribed vs actual");
    assertNoGpsFields(body);
  });

  it("fixture prescribed + actual workouts assert grading output", async () => {
    const { app, weekSessionId } = await openWeek();

    const plan: PrescribedWeek = {
      week: "2026-W43",
      days: [
        { date: "2026-10-19", dayType: "rest", run: null },
        {
          date: "2026-10-20",
          dayType: "long",
          run: {
            type: "long",
            distanceM: 10000,
            paceOrHr: "easy–steady",
            shoes: "cushioned",
          },
        },
        { date: "2026-10-21", dayType: "rest", run: null },
        {
          date: "2026-10-22",
          dayType: "quality",
          run: {
            type: "quality",
            distanceM: 5000,
            structure: "5k threshold",
            paceOrHr: "threshold effort",
            shoes: "race flat",
          },
        },
        { date: "2026-10-23", dayType: "rest", run: null },
        { date: "2026-10-24", dayType: "rest", run: null },
        { date: "2026-10-25", dayType: "rest", run: null },
      ],
    };

    await savePrescribedWeek({
      weekSessionId,
      plan,
      analysis: "Fixture plan for grading.",
    });

    const res = await app.request(
      `/weeks/${weekSessionId}/recap/skeleton?format=json&phase=build&goal=half`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.gradingIncluded).toBe(true);
    expect(body.sectionOrder).toEqual([...RECAP_SKELETON_ORDER]);

    const qualityMd = body.sections as { quality: string; longRun: string };
    expect(qualityMd.quality).toContain("## Quality sessions");
    expect(qualityMd.quality).toContain("### Quality session");
    expect(qualityMd.quality).toContain("Prescribed:");
    expect(qualityMd.quality).toContain("Actual:");
    expect(qualityMd.quality).toContain("Verdict: on target.");
    expect(qualityMd.longRun).toContain("Long run grade");
    expect(qualityMd.longRun).toContain("Prescribed vs actual");
    expect(qualityMd.longRun).toContain("threshold 75%");

    const md = body.markdown as string;
    const iRunByRun = md.indexOf("## Run-by-run");
    const iQuality = md.indexOf("## Quality sessions");
    const iLong = md.indexOf("## Long run");
    expect(iRunByRun).toBeGreaterThan(-1);
    expect(iQuality).toBeGreaterThan(iRunByRun);
    expect(iLong).toBeGreaterThan(iQuality);
    expect(md).toContain("5k threshold");
    assertNoGpsFields(body);
  });
});
