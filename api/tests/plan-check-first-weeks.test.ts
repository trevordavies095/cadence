/**
 * The volume rule's recent average for a new athlete (coaching-quality, the
 * baseline of 2026-11-03): the report's 3-week average counts the weeks before
 * the athlete's first run as 0 km, so a careful first plan read as a big step
 * up. Over the beginner season's packets: the first week is skipped, the weeks
 * before the start are left out, and a week of nothing run once the athlete has
 * started still counts. Pure: the season packets and the check, no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelPacket } from "../src/packet/index.js";
import { recentWeeklyDistanceM, runningWeeksAverageM } from "../src/packet/recentTraining.js";
import { parsePlanLines } from "../src/prescribed/planLines.js";
import { checkPlan, rulesTripped } from "../src/prescribed/planCheck.js";

const PACKETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "seasons", "season-packets");
const beginner = (week: number): ModelPacket => JSON.parse(readFileSync(path.join(PACKETS, `5-beginner-w${week}.json`), "utf8"));
const km = (m: unknown) => Math.round((m as number) / 10) / 100;

describe("the volume rule's recent average for a new athlete", () => {
  it("skips the first week: there is no running before it to compare with", () => {
    const p = beginner(1);
    expect(runningWeeksAverageM(p)).toBe("no running before");
    // The stub keeps the report's own figure, a quarter of the one week.
    expect(km(recentWeeklyDistanceM(p))).toBe(1.7);
    expect(checkPlan(p, p.recentHistory[0]?.prescribedWeek ?? { week: "x", days: [] }).skipped).toContainEqual({
      rule: "volume jump",
      reason: "first week: no running before",
    });
  });

  it("leaves out the weeks before the start in weeks two and three", () => {
    // Week 2: 7.30 km this week, 6.78 km in week 1, nothing before.
    expect(km(runningWeeksAverageM(beginner(2)))).toBe(7.04);
    // Week 3, the fever week: 2.78, 7.30 and 6.78 km; the week before the start is left out.
    expect(km(runningWeeksAverageM(beginner(3)))).toBe(5.62);
  });

  it("counts a week of nothing run once the athlete has started", () => {
    // Week 8, the second missed week: 0, 0, 5.1 and 0 km (week 5 ran nothing), all on Cadence.
    expect(km(runningWeeksAverageM(beginner(8)))).toBe(km(recentWeeklyDistanceM(beginner(8))));
    expect(km(runningWeeksAverageM(beginner(8)))).toBeLessThan(1.5);
  });
});

describe("the long-run rule on race week", () => {
  // The marathon season's taper week (seasons/30 in the hard set): its longest recent run is 20 mi.
  const taper = JSON.parse(readFileSync(path.join(PACKETS, "4-marathon-w12.json"), "utf8")) as ModelPacket;
  const planWith = (sunday: string) => {
    const lines = [
      "Mon 2026-10-12: rest.",
      "Tue 2026-10-13: easy, 5 mi, relaxed.",
      "Wed 2026-10-14: easy, 5 mi with 4 strides.",
      "Thu 2026-10-15: easy, 3 mi.",
      "Fri 2026-10-16: rest.",
      "Sat 2026-10-17: easy, 2 mi shakeout.",
      `Sun 2026-10-18: ${sunday}`,
    ];
    const read = parsePlanLines({ text: lines.join("\n"), weekStartMonday: "2026-10-12", unit: "imperial" });
    expect(read.failures).toEqual([]);
    return { week: "2026-W42", days: read.days };
  };

  it("does not count the race itself as a long run", () => {
    expect(rulesTripped(checkPlan(taper, planWith("race, 26.2 mi, Wexley Lakes Marathon.")))).not.toContain("long-run jump");
  });

  it("still trips on a training run of the same length", () => {
    expect(rulesTripped(checkPlan(taper, planWith("long, 26 mi easy.")))).toContain("long-run jump");
  });
});
