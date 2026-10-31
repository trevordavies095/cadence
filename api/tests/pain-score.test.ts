import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import {
  buildSubjectiveRecapMarkdown,
  formatPainHighLine,
  formatSubjectiveRunLine,
  subjectiveRunsToDateMap,
} from "../src/recap/formatSubjective.js";
import { parseSubjectiveAnswers } from "../src/recap/subjectiveQuestionnaire.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

function parseRun(row: Record<string, unknown>) {
  return parseSubjectiveAnswers({ runs: [{ date: "2026-10-22", ...row }] }, "2026-W43");
}

describe("pain score parser", () => {
  it("keeps an integer 0 to 10 beside the free text", () => {
    expect(parseRun({ pain_score: 3, pain: "left calf" })).toEqual({
      ok: true,
      answers: {
        week: "2026-W43",
        runs: [{ date: "2026-10-22", pain_score: 3, pain: "left calf" }],
      },
    });
  });

  it("accepts 0 as an answer, not as blank", () => {
    const parsed = parseRun({ pain_score: 0 });
    expect(parsed.ok && parsed.answers.runs[0]).toEqual({
      date: "2026-10-22",
      pain_score: 0,
    });
  });

  it("rounds like the effort scores", () => {
    const parsed = parseRun({ pain_score: 2.6 });
    expect(parsed.ok && parsed.answers.runs[0]!.pain_score).toBe(3);
  });

  it("treats null and missing as unanswered", () => {
    const parsed = parseRun({ pain_score: null, rpe: 4 });
    expect(parsed.ok && parsed.answers.runs[0]).toEqual({ date: "2026-10-22", rpe: 4 });
  });

  it.each([[11], [-1], ["3"], [Number.NaN], [true]])("rejects %s", (value) => {
    expect(parseRun({ pain_score: value })).toEqual({
      ok: false,
      error: "invalid_pain_score",
    });
  });
});

describe("pain score format", () => {
  it("prints the score on the run line, with the free text after it", () => {
    expect(formatSubjectiveRunLine({ rpe: 4, pain_score: 3, pain: "left calf" })).toBe(
      "RPE: 4/10  ·  Pain: 3/10 (left calf)",
    );
    expect(formatSubjectiveRunLine({ pain_score: 0 })).toBe("Pain: 0/10");
    expect(formatSubjectiveRunLine({ pain: "left calf" })).toBe("Pain: left calf");
  });

  it("carries the score through the date map", () => {
    const m = subjectiveRunsToDateMap([{ date: "2026-10-22", pain_score: 2 }]);
    expect(m.get("2026-10-22")).toEqual({ pain_score: 2 });
  });

  it("prints the week's highest score with its day", () => {
    expect(
      formatPainHighLine([
        { date: "2026-10-20", pain_score: 1 },
        { date: "2026-10-22", pain_score: 3 },
        { date: "2026-10-24", rpe: 5 },
      ]),
    ).toBe("Pain: highest 3/10 (Thu)");
  });

  it("names every day that reached the highest score", () => {
    expect(
      formatPainHighLine([
        { date: "2026-10-20", pain_score: 2 },
        { date: "2026-10-22", pain_score: 2 },
      ]),
    ).toBe("Pain: highest 2/10 (Tue, Thu)");
  });

  it("prints nothing when no run has a score", () => {
    expect(formatPainHighLine([{ date: "2026-10-20", pain: "sore" }])).toBeUndefined();
    expect(formatPainHighLine([])).toBeUndefined();
  });

  it("puts the highest score in the Subjective recap, even with no weekly answers", () => {
    const md = buildSubjectiveRecapMarkdown(undefined, [
      { date: "2026-10-22", pain_score: 3 },
    ]);
    expect(md).toContain("## Subjective recap");
    expect(md).toContain("Pain: highest 3/10 (Thu)");

    const withWeekly = buildSubjectiveRecapMarkdown({ stress_level: "low" }, [
      { date: "2026-10-22", pain_score: 3 },
    ]);
    expect(withWeekly).toContain("Pain: highest 3/10 (Thu)");
    expect(withWeekly).toContain("Stress level: low");
  });
});

describe("pain score route", () => {
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
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    return { app, weekSessionId: week.id as string };
  }

  function save(app: ReturnType<typeof createApp>, weekSessionId: string, body: unknown) {
    return app.request(`/weeks/${weekSessionId}/recap/subjective`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("asks for the score in the questionnaire", async () => {
    const { app, weekSessionId } = await openWeek();
    const gate = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(gate.questionnaire.per_run.pain_score).toMatch(/0.10/);
  });

  it("saves the score and puts it in the report Coach Cade reads", async () => {
    const { app, weekSessionId } = await openWeek();
    await app.request(`/weeks/${weekSessionId}/recap`);

    const res = await save(app, weekSessionId, {
      runs: [
        { date: "2026-10-20", rpe: 4, pain_score: 1 },
        { date: "2026-10-22", rpe: 5, pain_score: 3, pain: "left calf" },
      ],
    });
    expect(res.status).toBe(201);
    const saved = await json(res);
    expect(saved.answers.runs).toEqual([
      { date: "2026-10-20", rpe: 4, pain_score: 1 },
      { date: "2026-10-22", rpe: 5, pain_score: 3, pain: "left calf" },
    ]);
    const md = saved.gate.reportMarkdown as string;
    expect(md).toContain("Pain: 1/10");
    expect(md).toContain("Pain: 3/10 (left calf)");
    expect(md).toContain("Pain: highest 3/10 (Thu)");
    expect(saved.gate.sections.subjective).toContain("Pain: highest 3/10 (Thu)");

    const again = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(again.subjectiveAnswers.runs[1].pain_score).toBe(3);
  });

  it("refuses a score outside 0 to 10", async () => {
    const { app, weekSessionId } = await openWeek();
    await app.request(`/weeks/${weekSessionId}/recap`);
    const res = await save(app, weekSessionId, {
      runs: [{ date: "2026-10-22", pain_score: 12 }],
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "invalid_pain_score" });
  });
});
