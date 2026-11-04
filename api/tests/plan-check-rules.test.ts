/**
 * The plan check's long-run, pain and return-from-injury rules
 * (src/prescribed/planCheck.ts, issue #58), as pure functions of the packet
 * and the plan, and the acceptance case: the demo athlete's Achilles week
 * (2026-W37) with the plans Opus 4.7 and gpt-oss-20b wrote for it in the
 * final run of 2026-11-02, copied into tests/fixtures/plan-check/.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectedPlanDates, MAX_SAFETY_CALLOUT_BODY, type PrescribedWeek } from "../src/llm/index.js";
import { buildModelPacket, type BuildModelPacketInput, type ModelPacket } from "../src/packet/index.js";
import { longestRecentRunM, parseLongRunTrend } from "../src/packet/recentTraining.js";
import { parsePlanLines } from "../src/prescribed/planLines.js";
import {
  checkPlan,
  isReturningFromInjury,
  LONG_RUN_JUMP_RATIO,
  painReports,
  PLAN_RULES,
  rulesTripped,
} from "../src/prescribed/planCheck.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plan-check");

// The reviewed week is 2026-W43; the plan is for 2026-W44 (Mon Oct 26).
const PLAN_MONDAY = "2026-10-26";
const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A report with 30 km a week, a long-run trend topping out at 10 km, and the given run note and check-in lines. */
function recap(options: { trends?: string | null; note?: string; checkIn?: string[]; questions?: string[] } = {}): string {
  const trends = options.trends === undefined ? "- **Long-run distance** (max long-typed, else max run in week): 8.00 km → 9.00 km → 10.00 km → 9.50 km ▁▃█▅" : options.trends;
  return [
    "## Summary",
    "",
    "| Metric | This week | Prev week | 3-wk avg | Δ |",
    "| --- | --- | --- | --- | --- |",
    "| Distance | 30.00 km | 30.00 km | 30.00 km | +0.0 |",
    "",
    "## Run-by-run",
    "",
    "### Tue Oct 20 — Easy Run — 8.00 km / 48m",
    "",
    "Pace: 6:00/km  ·  Avg HR 140",
    "",
    ...(options.note ? [`Notes (from app): "${options.note}"`, ""] : []),
    "RPE: 3/10  ·  Felt: 7/10",
    "",
    "### Sun Oct 25 — Long Run — 9.50 km / 58m",
    "",
    "RPE: 4/10  ·  Felt: 7/10  ·  Pain: 0/10",
    "",
    "## Trends",
    "",
    ...(trends ? [trends, ""] : []),
    "## Subjective recap",
    "",
    "Sleep avg this week: 7 hrs",
    ...(options.checkIn ?? []),
    "",
    ...(options.questions?.length ? ["## Questions for coach", "", ...options.questions.map((q, i) => `${i + 1}. ${q}`), ""] : []),
  ].join("\n");
}

function packet(extra: Partial<BuildModelPacketInput> = {}): ModelPacket {
  return buildModelPacket({
    dossier: { versionId: 1, body: "# About you\n\n## Schedule\nYou run four days a week." },
    recapMarkdown: recap(),
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    },
    goal: { kind: "fitness" },
    coaching: { phase: "base", unitPreference: "metric" },
    ...extra,
  });
}

/** Seven lines: a number is an easy run of that many km, 0 a rest day, text a line as written. */
function planOf(days: Array<number | string>): PrescribedWeek {
  const dates = expectedPlanDates(PLAN_MONDAY);
  const lines = days.map((d, i) => {
    if (typeof d === "string") return `${NAMES[i]} ${dates[i]}: ${d}`;
    return d === 0 ? `${NAMES[i]} ${dates[i]}: rest.` : `${NAMES[i]} ${dates[i]}: easy, ${d} km, relaxed.`;
  });
  const read = parsePlanLines({ text: lines.join("\n"), weekStartMonday: PLAN_MONDAY, unit: "metric" });
  expect(read.failures).toEqual([]);
  return { week: "2026-W44", days: read.days };
}

/** 30 km of easy running with the given Sunday long run; `thursday` replaces the quality day. */
const easyWeek = (longKm: number, thursday: number | string = 6) => planOf([0, 6, 6, thursday, 0, 6, longKm]);

describe("the four rules", () => {
  it("are listed in the order their notices are shown", () => {
    expect(PLAN_RULES).toEqual(["volume jump", "long-run jump", "quality with pain", "return from injury"]);
  });
});

describe("the long-run rule", () => {
  it("reads the longest recent run from the report's trend line, taking the largest of the weeks it lists", () => {
    expect(parseLongRunTrend(recap())).toEqual([8000, 9000, 10000, 9500]);
    expect(parseLongRunTrend("- **Longest run**: — → — → 10.00 km → 11.00 km ▁▁▁█")).toEqual([10000, 11000]);
    expect(
      parseLongRunTrend("- **Long-run distance** (max long-typed, else max run in week): 15.17 mi → 10.86 mi → 16.10 mi → 10.00 mi █▁█▁")!.map(Math.round),
    ).toEqual([24414, 17477, 25910, 16093]);
    expect(longestRecentRunM(packet())).toBe(10000);
    expect(longestRecentRunM(packet({ recapMarkdown: recap({ trends: null }) }))).toBeNull();
  });

  it("falls back to the recent weeks' reports when this week's has no trend line", () => {
    const p = packet({
      recapMarkdown: recap({ trends: null }),
      recentHistory: [{ isoWeek: "2026-W42", weekSessionId: "w42", recapMarkdown: "## Trends\n\n- **Longest run**: 7.00 km → 12.00 km → 8.00 km → 9.00 km\n" }],
    });
    expect(longestRecentRunM(p)).toBe(12000);
  });

  it("a long run 1.3 times the longest recent run trips it, naming the day and both figures; 1.2 times does not", () => {
    // 30 km a week with a 13 km Sunday is under the volume threshold, so only the long run speaks.
    const result = checkPlan(packet(), easyWeek(13, 0));
    expect(rulesTripped(result)).toEqual(["long-run jump"]);
    expect(result.warnings[0]).toMatchObject({
      rule: "long-run jump",
      title: "The long run is a big jump",
      body: "The 13 km on Sun Nov 1 is well above your longest recent run of 10 km. Build to it over a few weeks, or ask me to adjust.",
      figures: { plannedLongM: 13000, longestRecentM: 10000 },
    });
    expect(checkPlan(packet(), easyWeek(12, 0)).warnings).toEqual([]);
    expect(LONG_RUN_JUMP_RATIO).toBe(1.25);
  });

  it("a report with no trend line is recorded as skipped, not passed", () => {
    const result = checkPlan(packet({ recapMarkdown: recap({ trends: null }) }), easyWeek(13, 0));
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([{ rule: "long-run jump", reason: "no recent long run" }]);
  });
});

describe("the pain rule", () => {
  const quality = "quality, 8 km. Warm up, 5 x 1 km at threshold, cool down.";

  it("a quality day in a week with a pain word in a run note trips it, naming the day and what was seen", () => {
    const p = packet({ recapMarkdown: recap({ note: "Achilles tight for the first 2 km, eased off." }) });
    expect(painReports(p)).toEqual([{ source: "run", day: "Tue Oct 20", text: "Achilles tight for the first 2 km, eased off." }]);
    const result = checkPlan(p, easyWeek(9, quality));
    expect(rulesTripped(result)).toEqual(["quality with pain"]);
    expect(result.warnings[0]).toMatchObject({
      title: "Hard running after a week with pain",
      body: 'You reported pain on Tue Oct 20: "Achilles tight for the first 2 km, eased off". This plan still has hard running on Thu Oct 29. Keep it easy until it settles, or ask me to adjust.',
    });
  });

  it("the same plan with no pain words trips nothing, and a pain score of 0 is not pain", () => {
    expect(painReports(packet())).toEqual([]);
    expect(checkPlan(packet(), easyWeek(9, quality)).warnings).toEqual([]);
  });

  it("an easy week after pain trips nothing", () => {
    const p = packet({ recapMarkdown: recap({ note: "Achilles tight for the first 2 km." }) });
    expect(checkPlan(p, easyWeek(9)).warnings).toEqual([]);
  });

  it("reads pain from the check-in, the athlete's questions and the conversation, and names each day of hard running", () => {
    const checkIn = packet({ recapMarkdown: recap({ checkIn: ["Body check: Left shin sore after the long run"] }) });
    expect(painReports(checkIn)).toEqual([{ source: "check-in", day: null, text: "Body check: Left shin sore after the long run" }]);
    const asked = packet({ recapMarkdown: recap({ questions: ["Should I stop running for a few days?"] }) });
    expect(painReports(asked)).toEqual([{ source: "question", day: null, text: "Should I stop running for a few days?" }]);
    const said = packet({ thread: [{ role: "athlete", body: "The niggle in my calf is back." }, { role: "coach", body: "Noted." }] });
    expect(painReports(said)).toEqual([{ source: "message", day: null, text: "The niggle in my calf is back." }]);

    const twoHard = planOf([0, quality, 6, 0, 0, "race, 5 km. Parkrun.", 9]);
    expect(checkPlan(said, twoHard).warnings[0]!.body).toBe(
      'You said "The niggle in my calf is back". This plan still has hard running on Tue Oct 27 and Sat Oct 31. Keep it easy until it settles, or ask me to adjust.',
    );
    expect(checkPlan(checkIn, twoHard).warnings[0]!.body).toMatch(/^Your check-in said "Body check: Left shin sore after the long run"\. /);
    expect(checkPlan(asked, twoHard).warnings[0]!.body).toMatch(/^You asked "Should I stop running for a few days"\. /);
  });

  it("a pain score above 0, or a score of 0 with a pain word beside it, is pain", () => {
    const scored = packet({ recapMarkdown: recap({ checkIn: ["Pain: highest 3/10 (Thu)"] }) });
    expect(painReports(scored)).toHaveLength(1);
    const zeroWithWord = packet({ recapMarkdown: recap({ checkIn: ["Pain: 0/10 (a niggle on Thursday)"] }) });
    expect(painReports(zeroWithWord)).toHaveLength(1);
    const zero = packet({ recapMarkdown: recap({ checkIn: ["Pain: 0/10 (all fine)"] }) });
    expect(painReports(zero)).toEqual([]);
  });
});

describe("the return-from-injury rule", () => {
  const quality = "quality, 6 km. 6 x 400 m.";

  it("a quality day for a return goal trips it, naming the day", () => {
    const p = packet({ goal: { kind: "return", startingPoint: "Six weeks off with a calf strain" } });
    const result = checkPlan(p, easyWeek(9, quality));
    expect(rulesTripped(result)).toEqual(["return from injury"]);
    expect(result.warnings[0]).toMatchObject({
      title: "This plan may rush your return",
      body: "You are coming back from injury, and this plan has hard running on Thu Oct 29. Keep it easy a while longer, or ask me to adjust.",
    });
  });

  it("an easy week for a return goal trips nothing", () => {
    const p = packet({ goal: { kind: "return" } });
    expect(checkPlan(p, easyWeek(9)).warnings).toEqual([]);
  });

  it("a long run above the recent longest, with no margin, trips it for a returning athlete", () => {
    const p = packet({ goal: { kind: "return" } });
    const result = checkPlan(p, easyWeek(11));
    expect(rulesTripped(result)).toEqual(["return from injury"]);
    expect(result.warnings[0]!.body).toBe(
      "You are coming back from injury, and the 11 km on Sun Nov 1 is above your longest recent run of 10 km. Keep it easy a while longer, or ask me to adjust.",
    );
    // Both at once, in one notice.
    expect(checkPlan(p, easyWeek(11, quality)).warnings[0]!.body).toBe(
      "You are coming back from injury, and this plan has hard running on Thu Oct 29, and the 11 km on Sun Nov 1 is above your longest recent run of 10 km. Keep it easy a while longer, or ask me to adjust.",
    );
  });

  it("About you can say the athlete is returning; an injury in the history alone does not", () => {
    expect(isReturningFromInjury(packet({ dossier: { versionId: 1, body: "## Current Status\nYou are returning from an Achilles injury, four weeks in." } }))).toBe(true);
    expect(isReturningFromInjury(packet({ dossier: { versionId: 1, body: "## Running history\nPost-injury, you are building back." } }))).toBe(true);
    expect(isReturningFromInjury(packet({ dossier: { versionId: 1, body: "## Injuries and constraints\nYou had shin splints in your first marathon block." } }))).toBe(false);
    expect(isReturningFromInjury(packet({ dossier: { versionId: 1, body: "You are coming back from a holiday." } }))).toBe(false);
  });

  it("with no quality day and no recent long run to compare, the rule is recorded as skipped", () => {
    const p = packet({ goal: { kind: "return" }, recapMarkdown: recap({ trends: null }) });
    const result = checkPlan(p, easyWeek(11));
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([
      { rule: "long-run jump", reason: "no recent long run" },
      { rule: "return from injury", reason: "no recent long run" },
    ]);
  });
});

describe("the notices together", () => {
  it("come one per rule, in rule order, each body short enough for the notice component, naming no rule", () => {
    const p = packet({
      goal: { kind: "return" },
      recapMarkdown: recap({ note: "Sore Achilles again." }),
    });
    // 46 km with a 14 km long run and a quality day: every rule.
    const result = checkPlan(p, planOf([0, 8, 8, "quality, 8 km. Threshold.", 0, 8, 14]));
    expect(rulesTripped(result)).toEqual(PLAN_RULES);
    for (const w of result.warnings) {
      expect(w.body.length).toBeLessThan(MAX_SAFETY_CALLOUT_BODY);
      expect(`${w.title} ${w.body}`).not.toMatch(/volume jump|long-run jump|quality with pain|return from injury|\brule\b/i);
      expect(w.body).not.toMatch(/!/);
    }
  });
});

describe("the demo athlete's Achilles week (2026-W37), with the plans the final run saved", () => {
  const read = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const achilles = read("2026-W37.packet.json") as ModelPacket;

  it("the packet is the week the athlete asked whether to stop", () => {
    expect(achilles.week?.isoWeek).toBe("2026-W37");
    expect(achilles.recapMarkdown).toContain("Should I stop running for a few days");
    expect(painReports(achilles).map((r) => r.source)).toEqual(["run", "run", "run", "run", "check-in", "check-in", "question"]);
    expect(longestRecentRunM(achilles)).toBeCloseTo(25910, 0);
  });

  it("Opus 4.7's plan, all easy running and a held long run, trips none", () => {
    const plan = read("2026-W37.opus-4-7.plan.json") as PrescribedWeek;
    expect(plan.days.map((d) => d.dayType)).toEqual(["rest", "easy", "easy", "easy", "rest", "easy", "long"]);
    expect(checkPlan(achilles, plan)).toEqual({ warnings: [], skipped: [] });
  });

  it("gpt-oss-20b's plan, with a goal-pace session on Thursday, trips the pain rule and names what was seen", () => {
    // Its 31 mi week against a 38 mi recent average, and its 12 mi long run
    // against a 16 mi recent longest, are under the volume and long-run
    // thresholds: on this saved plan only the pain rule can speak.
    const plan = read("2026-W37.gpt-oss-20b.plan.json") as PrescribedWeek;
    expect(plan.days[3]).toMatchObject({ dayType: "quality", date: "2026-09-17" });
    const result = checkPlan(achilles, plan);
    expect(rulesTripped(result)).toEqual(["quality with pain"]);
    expect(result.warnings[0]!.body).toBe(
      'You reported pain on Thu Sep 10: "Right Achilles tight from mile 2. Stopped at 3". This plan still has hard running on Thu Sep 17. Keep it easy until it settles, or ask me to adjust.',
    );
    expect(result.skipped).toEqual([]);
  });
});
