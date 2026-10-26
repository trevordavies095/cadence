import { describe, expect, it } from "vitest";
import {
  applyApiRpeDefaults,
  buildCoachQuestionsMarkdown,
  buildSubjectiveRecapMarkdown,
  formatSubjectiveRunLine,
} from "../src/recap/formatSubjective.js";
import type { SubjectiveAnswers } from "../src/recap/subjectiveQuestionnaire.js";

describe("formatSubjective", () => {
  it("formats RPE/Felt/Pain line", () => {
    expect(formatSubjectiveRunLine({ rpe: 4, felt: 7, pain: "ok" })).toBe(
      "RPE: 4/10  ·  Felt: 7/10  ·  Pain: ok",
    );
  });

  it("builds Subjective recap and Questions for coach sections", () => {
    const md = buildSubjectiveRecapMarkdown({
      sleep_avg_hrs: 7.2,
      sleep_range_hrs: [6.5, 8],
      stress_level: "low",
      body_check: "fine",
      feeling_into_next_week: "ready",
      strength_sessions: { completed: 2, planned: 3, notes: "easy" },
    });
    expect(md).toContain("## Subjective recap");
    expect(md).toContain("Sleep avg this week: 7.2 hrs (range 6.5–8)");
    expect(md).toContain("Strength sessions completed: 2 of 3 (easy)");
    expect(md).toContain("Stress level: low");

    const coach = buildCoachQuestionsMarkdown(["First?", "Second?"]);
    expect(coach).toContain("## Questions for coach");
    expect(coach).toContain("1. First?");
    expect(coach).toContain("2. Second?");
  });

  it("applyApiRpeDefaults fills omitted RPE from Tempo", () => {
    const answers: SubjectiveAnswers = {
      week: "2026-W43",
      runs: [{ date: "2026-10-20", felt: 8 }],
    };
    const out = applyApiRpeDefaults(answers, [
      {
        id: "a",
        date: "2026-10-20",
        runType: "Easy",
        distance: "5 mi",
        duration: "45m",
        apiRpe: 5,
      },
    ]);
    expect(out.runs[0]).toMatchObject({ date: "2026-10-20", rpe: 5, felt: 8 });
  });

  it("applyApiRpeDefaults keeps athlete RPE over apiRpe", () => {
    const answers: SubjectiveAnswers = {
      week: "2026-W43",
      runs: [{ date: "2026-10-20", rpe: 3, felt: 8 }],
    };
    const out = applyApiRpeDefaults(answers, [
      {
        id: "a",
        date: "2026-10-20",
        runType: null,
        distance: null,
        duration: null,
        apiRpe: 9,
      },
    ]);
    expect(out.runs[0]!.rpe).toBe(3);
  });
});
