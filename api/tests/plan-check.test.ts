/**
 * The plan check (src/prescribed/planCheck.ts, issue #58) as a pure function
 * of the packet and the plan: which rules trip, what the notice says, and
 * what is recorded when a rule cannot be judged. No database, no model.
 */
import { describe, expect, it } from "vitest";
import { buildStubWeeklyReply, expectedPlanDates, type PrescribedWeek } from "../src/llm/index.js";
import { buildModelPacket, type BuildModelPacketInput, type ModelPacket } from "../src/packet/index.js";
import { recentWeeklyDistanceM } from "../src/packet/recentTraining.js";
import { parsePlanLines } from "../src/prescribed/planLines.js";
import {
  checkPlan,
  PLAN_RULES,
  plannedWeeklyDistanceM,
  rulesTripped,
  VOLUME_JUMP_RATIO,
} from "../src/prescribed/planCheck.js";

// The reviewed week is 2026-W43; the plan is for 2026-W44 (Mon Oct 26).
const PLAN_MONDAY = "2026-10-26";

/** The reports here carry no long-run trend line, so that rule is skipped on every packet. */
const LONG_RUN_SKIPPED = { rule: "long-run jump", reason: "no recent long run" };

function summaryWith(thisWeek: string, threeWkAvg: string): string {
  return [
    "## Summary",
    "",
    "| Metric | This week | Prev week | 3-wk avg | Δ |",
    "| --- | --- | --- | --- | --- |",
    `| Distance | ${thisWeek} | 30.00 km | ${threeWkAvg} | +1.0 |`,
    "| Runs | 4 | 4 | 4.0 | +0.0 |",
    "",
  ].join("\n");
}

function packet(extra: Partial<BuildModelPacketInput> = {}): ModelPacket {
  return buildModelPacket({
    dossier: { versionId: 1, body: "Runs before work." },
    recapMarkdown: summaryWith("30.00 km", "30.00 km"),
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

/** A plan of easy runs, one per weekday, with the distances given in km. */
function planOf(km: number[], unit: "metric" | "imperial" = "metric"): PrescribedWeek {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const u = unit === "metric" ? "km" : "mi";
  const dates = expectedPlanDates(PLAN_MONDAY);
  const lines = km.map((d, i) => {
    const date = dates[i];
    return d === 0 ? `${names[i]} ${date}: rest.` : `${names[i]} ${date}: easy, ${d} ${u}, relaxed.`;
  });
  const read = parsePlanLines({ text: lines.join("\n"), weekStartMonday: PLAN_MONDAY, unit });
  expect(read.failures).toEqual([]);
  return { week: "2026-W44", days: read.days };
}

describe("the plan check's rules", () => {
  it("names its rules as a fixed list", () => {
    expect(PLAN_RULES).toContain("volume jump");
  });

  it("the volume rule trips above a third over the recent average and names both figures in the athlete's unit", () => {
    // Recent: 30 km a week. 1.4x: 42 km.
    const result = checkPlan(packet(), planOf([0, 8, 8, 8, 0, 8, 10]));
    expect(rulesTripped(result)).toEqual(["volume jump"]);
    const [warning] = result.warnings;
    expect(warning).toMatchObject({
      rule: "volume jump",
      title: "A big step up in distance",
      body: "This plan is 42 km against your recent 30 km a week. Ease into it, or ask me to adjust.",
      figures: { plannedM: 42000, recentM: 30000 },
    });
    expect(result.skipped).toEqual([LONG_RUN_SKIPPED]);
    // The notice never names the rule.
    expect(`${warning!.title} ${warning!.body}`).not.toMatch(/volume|rule/i);
  });

  it("a plan a fifth over the recent average trips nothing", () => {
    // 1.2x: 36 km.
    const result = checkPlan(packet(), planOf([0, 7, 7, 7, 0, 7, 8]));
    expect(result).toEqual({ warnings: [], skipped: [LONG_RUN_SKIPPED] });
    expect(VOLUME_JUMP_RATIO).toBeCloseTo(4 / 3, 10);
  });

  it("speaks in miles when the athlete's unit is miles", () => {
    const p = packet({
      recapMarkdown: summaryWith("30.00 mi", "30.00 mi"),
      coaching: { phase: "base", unitPreference: "imperial" },
    });
    const result = checkPlan(p, planOf([0, 8, 8, 8, 0, 8, 10], "imperial"));
    expect(result.warnings[0]!.body).toBe(
      "This plan is 42 mi against your recent 30 mi a week. Ease into it, or ask me to adjust.",
    );
  });

  it("a packet with no recent distance trips nothing and records why", () => {
    const p = packet({ recapMarkdown: "## Summary\nSteady aerobic week." });
    expect(recentWeeklyDistanceM(p)).toBeNull();
    const result = checkPlan(p, planOf([0, 8, 8, 8, 0, 8, 10]));
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([{ rule: "volume jump", reason: "no recent distance" }, LONG_RUN_SKIPPED]);
  });

  it("counts a duration-only run as nothing and an unread day as nothing", () => {
    const lines = [
      "Mon 2026-10-26: rest.",
      "Tue 2026-10-27: easy, 60 min, relaxed.",
      "Wed 2026-10-28: easy, 20 km, relaxed.",
      "Thu 2026-10-29: easy 30, relaxed.",
      "Fri 2026-10-30: rest.",
      "Sat 2026-10-31: easy, 20 km, relaxed.",
      "Sun 2026-11-01: rest.",
    ].join("\n");
    const read = parsePlanLines({ text: lines, weekStartMonday: PLAN_MONDAY, unit: "metric" });
    expect(read.failures).toEqual([{ date: "2026-10-29", reason: "no distance unit" }]);
    const plan = { week: "2026-W44", days: read.days };
    expect(plannedWeeklyDistanceM(plan)).toBe(40000);
    // 40 km against 30 km: exactly a third over is not more than a third over.
    expect(checkPlan(packet(), plan).warnings).toEqual([]);
  });

  it("the offline coach's own plan, sized from the same text, trips nothing", () => {
    const p = packet();
    const reply = buildStubWeeklyReply(p);
    expect(checkPlan(p, reply.prescribedWeek)).toEqual({ warnings: [], skipped: [LONG_RUN_SKIPPED] });
  });
});
