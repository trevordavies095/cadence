import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { getSubjectiveAnswers } from "../src/recap/subjectiveStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

describe("weekly recap subjective gate + merge (#23/#24)", () => {
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
    expect([200, 201]).toContain(weekRes.status);
    const week = await json(weekRes);
    expect(week.isoWeek).toBe("2026-W43");
    return { app, weekSessionId: week.id as string };
  }

  it("missing subjective → needs_subjective with questionnaire + compact runs", async () => {
    const { app, weekSessionId } = await openWeek();

    const res = await app.request(`/weeks/${weekSessionId}/recap`);
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.status).toBe("needs_subjective");
    expect(body.checkInStatus).toBe("needed");
    expect(body.week).toBe("2026-W43");
    expect(body.weekSessionId).toBe(weekSessionId);
    expect(typeof body.note).toBe("string");
    expect(body.localRange).toEqual({
      start: "2026-10-19",
      end: "2026-10-25",
    });

    const q = body.questionnaire as {
      order: string[];
      per_run: Record<string, string>;
      weekly: Record<string, string>;
      all_fields_optional: boolean;
    };
    expect(q.all_fields_optional).toBe(true);
    expect(q.order[0]).toMatch(/per_run/i);
    expect(q.per_run.rpe).toMatch(/1–10|1-10/i);
    expect(q.per_run.felt).toBeTruthy();
    expect(q.per_run.pain).toBeTruthy();
    expect(q.weekly.stress_level).toBeTruthy();
    expect(q.weekly.body_check).toBeTruthy();
    expect(q.weekly.questions_for_coach).toBeTruthy();
    expect(q.weekly.sleep_avg_hrs).toBeTruthy();
    expect(q.weekly.strength_sessions).toBeTruthy();

    const runs = body.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(2);
    // Fixture workouts: 2026-10-20T12:00:00Z and 2026-10-22T12:00:00Z (UTC week session).
    expect(runs[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      date: "2026-10-20",
      runType: "Easy Run",
      distance: "6.21 mi",
      duration: "1h 0m",
      // Raw values, so a screen can word them in the athlete's own units.
      distanceM: 10000,
      durationS: 3600,
    });
    expect(runs[0]).toHaveProperty("apiRpe");
    expect(runs[1]).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      date: "2026-10-22",
    });
    // Compact gate rows — not full run-by-run bodies.
    expect(runs[0]).not.toHaveProperty("splits");
    expect(runs[0]).not.toHaveProperty("zonePct");
  });

  it("skip_subjective produces data-only recap without gate", async () => {
    const { app, weekSessionId } = await openWeek();

    const res = await app.request(
      `/weeks/${weekSessionId}/recap?skip_subjective=true`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.status).toBe("report");
    expect(body.subjective).toBe("skipped");
    expect(body.checkInStatus).toBe("skipped");
    expect(body.subjectiveAnswers).toBeNull();
    expect(body.isoWeek).toBe("2026-W43");
    expect(typeof body.reportMarkdown).toBe("string");
    expect(body.reportMarkdown as string).toMatch(/Weekly Recap/i);
    expect(body.reportMarkdown as string).toMatch(/Run-by-run|Summary|Zone/i);
    expect(body.reportMarkdown as string).not.toContain("## Subjective recap");
    expect(body.reportMarkdown as string).not.toContain(
      "## Questions for coach",
    );
    const sections = body.sections as {
      summary: string;
      zones: string;
      runByRun: string;
      subjective: string;
      questions: string;
    };
    expect(sections.summary.length).toBeGreaterThan(0);
    expect(sections.zones.length).toBeGreaterThan(0);
    expect(sections.runByRun.length).toBeGreaterThan(0);
    expect(sections.subjective).toBe("");
    expect(sections.questions).toBe("");
  });

  it("explicit Skip persists — refresh stays skipped (plan-gate shape #49)", async () => {
    const { app, weekSessionId } = await openWeek();

    const open = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(open.status).toBe("needs_subjective");
    expect(open.checkInStatus).toBe("needed");

    const skipped = await json(
      await app.request(
        `/weeks/${weekSessionId}/recap?skip_subjective=true`,
      ),
    );
    expect(skipped.status).toBe("report");
    expect(skipped.subjective).toBe("skipped");
    expect(skipped.checkInStatus).toBe("skipped");

    // Without skip_subjective query — durable Skip must survive refresh.
    const again = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(again.status).toBe("report");
    expect(again.subjective).toBe("skipped");
    expect(again.checkInStatus).toBe("skipped");
    expect(again.subjectiveAnswers).toBeNull();
  });

  it("finishing interview marks check-in finished (plan-gate shape #49)", async () => {
    const { app, weekSessionId } = await openWeek();

    const gate = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(gate.checkInStatus).toBe("needed");

    const saveRes = await app.request(
      `/weeks/${weekSessionId}/recap/subjective`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: [{ date: "2026-10-20", rpe: 5, felt: 7 }],
          weekly: { stress_level: "ok" },
        }),
      },
    );
    expect(saveRes.status).toBe(201);
    const saved = await json(saveRes);
    expect(saved.status).toBe("saved");
    const nested = saved.gate as {
      status: string;
      subjective?: string;
      checkInStatus?: string;
    };
    expect(nested.status).toBe("report");
    expect(nested.subjective).toBe("present");
    expect(nested.checkInStatus).toBe("finished");

    const again = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(again.status).toBe("report");
    expect(again.subjective).toBe("present");
    expect(again.checkInStatus).toBe("finished");
  });

  it("gate → save subjective → full report with subjective + questions", async () => {
    const { app, weekSessionId } = await openWeek();

    const gate = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(gate.status).toBe("needs_subjective");

    const saveRes = await app.request(
      `/weeks/${weekSessionId}/recap/subjective`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: [
            { date: "2026-10-20", rpe: 4, felt: 8, pain: "none" },
            { date: "2026-10-22", rpe: 5, felt: 7 },
          ],
          weekly: {
            sleep_avg_hrs: 7.2,
            sleep_range_hrs: [6.5, 8],
            stress_level: "low",
            body_check: "calves a bit sore",
            feeling_into_next_week: "ready",
            questions_for_coach: ["Keep volume?", "Add strides?"],
          },
        }),
      },
    );
    expect(saveRes.status).toBe(201);
    const saved = await json(saveRes);
    expect(saved.status).toBe("saved");
    expect(saved.answers).toMatchObject({
      week: "2026-W43",
      runs: [
        { date: "2026-10-20", rpe: 4, felt: 8, pain: "none" },
        { date: "2026-10-22", rpe: 5, felt: 7 },
      ],
      weekly: {
        stress_level: "low",
        body_check: "calves a bit sore",
        questions_for_coach: ["Keep volume?", "Add strides?"],
      },
    });

    const nestedGate = saved.gate as {
      status: string;
      subjective?: string;
      checkInStatus?: string;
      reportMarkdown?: string;
      sections?: { subjective?: string; questions?: string; runByRun?: string };
    };
    expect(nestedGate.status).toBe("report");
    expect(nestedGate.subjective).toBe("present");
    expect(nestedGate.checkInStatus).toBe("finished");
    expect(nestedGate.reportMarkdown).toContain("## Subjective recap");
    expect(nestedGate.reportMarkdown).toContain("Sleep avg this week: 7.2 hrs");
    expect(nestedGate.reportMarkdown).toContain("Stress level: low");
    expect(nestedGate.reportMarkdown).toContain("## Questions for coach");
    expect(nestedGate.reportMarkdown).toContain("1. Keep volume?");
    expect(nestedGate.reportMarkdown).toContain("2. Add strides?");
    expect(nestedGate.reportMarkdown).toContain("RPE: 4/10");
    expect(nestedGate.reportMarkdown).toContain("Felt: 8/10");
    expect(nestedGate.sections?.subjective).toContain("## Subjective recap");
    expect(nestedGate.sections?.questions).toContain("## Questions for coach");

    const again = await json(
      await app.request(`/weeks/${weekSessionId}/recap`),
    );
    expect(again.status).toBe("report");
    expect(again.subjective).toBe("present");
    expect(again.subjectiveAnswers).toMatchObject({
      week: "2026-W43",
      weekly: { stress_level: "low" },
    });
    const md = again.reportMarkdown as string;
    expect(md).toMatch(/Weekly Recap/i);
    expect(md.indexOf("## Subjective recap")).toBeGreaterThan(
      md.indexOf("## Run-by-run"),
    );
    expect(md.indexOf("## Questions for coach")).toBeGreaterThan(
      md.indexOf("## Subjective recap"),
    );

    const fromStore = await getSubjectiveAnswers(weekSessionId);
    expect(fromStore).not.toBeNull();
    expect(fromStore!.answers.runs[0]!.felt).toBe(8);
  });

  it("prefers Tempo apiRpe when athlete omits RPE", async () => {
    await acceptAndReady();
    const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const tempoPort = {
      ...base,
      async listWorkouts(query: Parameters<typeof base.listWorkouts>[0]) {
        const page = await base.listWorkouts(query);
        return {
          ...page,
          items: page.items.map((w) =>
            w.id === "11111111-1111-4111-8111-111111111111"
              ? { ...w, rpe: 6 }
              : w,
          ),
        };
      },
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });
    const weekRes = await app.request("/weeks/current", { method: "POST" });
    expect([200, 201]).toContain(weekRes.status);
    const week = await json(weekRes);
    const weekSessionId = week.id as string;

    const saveRes = await app.request(
      `/weeks/${weekSessionId}/recap/subjective`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: [{ date: "2026-10-20", felt: 7 }],
          weekly: { stress_level: "ok" },
        }),
      },
    );
    expect(saveRes.status).toBe(201);
    const saved = await json(saveRes);
    expect(saved.answers).toMatchObject({
      runs: [{ date: "2026-10-20", rpe: 6, felt: 7 }],
    });
    const report = saved.gate as { reportMarkdown?: string };
    expect(report.reportMarkdown).toContain("RPE: 6/10");
    expect(report.reportMarkdown).toContain("Felt: 7/10");
  });

  it("accepts nested { answers } body shape", async () => {
    const { app, weekSessionId } = await openWeek();

    const res = await app.request(`/weeks/${weekSessionId}/recap/subjective`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: {
          runs: [{ date: "2026-10-20", felt: 6 }],
          weekly: { stress_level: "moderate" },
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.status).toBe("saved");
    expect(body.answers).toMatchObject({
      week: "2026-W43",
      runs: [{ date: "2026-10-20", felt: 6 }],
    });
  });
});

