import { describe, expect, it } from "vitest";
import type { TrainingGoal } from "../src/goal/types.js";
import {
  buildStubWeeklyReply,
  validateWeeklyReply,
  type PrescribedDay,
  type WeeklyReply,
} from "../src/llm/index.js";
import { buildModelPacket, type BuildModelPacketInput } from "../src/packet/index.js";

// The reviewed week is 2026-W43; the stub plans 2026-W44 (Mon Oct 26).
const PLAN_MONDAY = "2026-10-26";

const SUMMARY_NO_TABLE = "## Summary\nSteady aerobic week.";

function summaryWith(thisWeek: string, threeWkAvg: string): string {
  return [
    "## Summary",
    "",
    "| Metric | This week | Prev week | 3-wk avg | Δ |",
    "| --- | --- | --- | --- | --- |",
    `| Mileage | ${thisWeek} | 30.00 km | ${threeWkAvg} | +1.0 |`,
    "| Runs | 4 | 4 | 4.0 | +0.0 |",
    "",
  ].join("\n");
}

function reply(
  goal: TrainingGoal | null,
  extra: Partial<BuildModelPacketInput> = {},
): WeeklyReply {
  const packet = buildModelPacket({
    dossier: { versionId: 1, body: "Runs before work." },
    recapMarkdown: SUMMARY_NO_TABLE,
    attachments: [{ id: "w1", startedAt: "2026-10-20T07:00:00Z", distanceM: 8000, durationS: 2700, avgPaceS: 337 }],
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    },
    goal,
    ...extra,
  });
  const out = buildStubWeeklyReply(packet);
  // Every shape is a valid weekly reply for the plan week.
  const checked = validateWeeklyReply(out, PLAN_MONDAY);
  expect(checked.ok, checked.ok ? "" : checked.error).toBe(true);
  return out;
}

const runs = (r: WeeklyReply): PrescribedDay[] =>
  r.prescribedWeek.days.filter((d) => d.dayType !== "rest");
const totalM = (r: WeeklyReply): number =>
  r.prescribedWeek.days.reduce((sum, d) => sum + (d.run?.distanceM ?? 0), 0);
const count = (r: WeeklyReply, type: string): number =>
  r.prescribedWeek.days.filter((d) => d.dayType === type).length;

describe("the offline coach plans by goal (coaching-bias 20)", () => {
  it("a race keeps today's shape: quality Thursday, long Sunday", () => {
    const r = reply({ kind: "race", distance: "marathon" });
    expect(r.prescribedWeek.days.map((d) => d.dayType)).toEqual([
      "easy", "rest", "easy", "quality", "rest", "easy", "long",
    ]);
    expect(r.prescribedWeek.days[6]!.dayType).toBe("long");
    expect(r.headline).toMatch(/looks workable\. Protect easy days and land the long run\./);
    expect(r.prescribedWeek.days[6]!.notes).toBe("Fuel early; no heroics.");
    expect(r.flags?.map((f) => f.title)).toEqual(["Heart rate drift"]);
  });

  it("stay fit gets three easy runs and one optional longer run, no quality", () => {
    const r = reply({ kind: "fitness" });
    expect(count(r, "easy")).toBe(3);
    expect(count(r, "long")).toBe(1);
    expect(count(r, "quality")).toBe(0);
    const longer = r.prescribedWeek.days.find((d) => d.dayType === "long")!;
    expect(longer.notes).toMatch(/optional/i);
    const easyMax = Math.max(
      ...r.prescribedWeek.days.filter((d) => d.dayType === "easy").map((d) => d.run!.distanceM),
    );
    expect(longer.run!.distanceM).toBeGreaterThan(easyMax);
    expect(r.headline).not.toMatch(/long run/i);
    expect(r.flags?.map((f) => f.title)).not.toContain("Heart rate drift");
    expect(JSON.stringify(r)).not.toMatch(/heroics|threshold/i);
  });

  it("no goal plans as stay fit", () => {
    const none = reply(null);
    const fit = reply({ kind: "fitness" });
    expect(none.prescribedWeek).toEqual(fit.prescribedWeek);
    expect(none.headline).toBe(fit.headline);
  });

  it("speed gets one quality session and one longer run", () => {
    const r = reply({ kind: "speed", distance: "5k" });
    expect(count(r, "quality")).toBe(1);
    expect(count(r, "long")).toBe(1);
    const quality = r.prescribedWeek.days.find((d) => d.dayType === "quality")!;
    expect(quality.run?.structure).toBeTruthy();
    expect(quality.run?.paceOrHr).toBeTruthy();
    expect(r.headline).toMatch(/quality session/);
    expect(r.flags?.map((f) => f.title)).not.toContain("Heart rate drift");
  });

  describe("return", () => {
    it("is walk-run sessions in minutes only, from 15 min when the starting point gives no number", () => {
      const r = reply({ kind: "return", startingPoint: "Back after a calf strain." });
      expect(runs(r).length).toBe(3);
      for (const d of runs(r)) {
        expect(d.dayType).toBe("easy");
        expect(d.run!.distanceM).toBe(0);
        expect(d.run!.durationS).toBe(15 * 60);
        expect(d.run!.structure).toMatch(/walk-run/);
      }
      expect(count(r, "quality")).toBe(0);
      expect(count(r, "long")).toBe(0);
      expect(totalM(r)).toBe(0);
      expect(r.headline).toMatch(/walk-run/i);
      // Pain is always watched on a return week.
      expect(r.flags?.map((f) => f.title)).toContain("Pain over pace");
    });

    it("starts from the starting point's minutes", () => {
      const r = reply({ kind: "return", startingPoint: "Can jog 20 min without pain" });
      expect(runs(r)[0]!.run!.durationS).toBe(20 * 60);
    });

    it("builds a little each week since the return began", () => {
      const week0 = reply({ kind: "return", since: PLAN_MONDAY });
      const week2 = reply({ kind: "return", since: "2026-10-12" });
      const week4 = reply({ kind: "return", since: "2026-09-28" });
      const mins = (r: WeeklyReply) => runs(r)[0]!.run!.durationS! / 60;
      expect(mins(week0)).toBe(15);
      expect(mins(week2)).toBeGreaterThan(mins(week0));
      expect(mins(week4)).toBeGreaterThan(mins(week2));
      expect(mins(week4) - mins(week0)).toBeLessThanOrEqual(15);
    });
  });

  describe("weekly distance", () => {
    it("scales from the last four weeks in the report", () => {
      // (40 + 3 × 32) / 4 = 34 km.
      const recapMarkdown = summaryWith("40.00 km", "32.00 km");
      for (const goal of [
        { kind: "race", distance: "half" },
        { kind: "speed" },
        { kind: "fitness" },
      ] as TrainingGoal[]) {
        const total = totalM(reply(goal, { recapMarkdown }));
        expect(Math.abs(total - 34000)).toBeLessThanOrEqual(2000);
      }
    });

    it("reads miles too", () => {
      const r = reply({ kind: "fitness" }, { recapMarkdown: summaryWith("20.00 mi", "20.00 mi") });
      expect(Math.abs(totalM(r) - 20 * 1609.344)).toBeLessThanOrEqual(2000);
    });

    it("falls back to this week and the recent weeks' reports without a 3-week average", () => {
      const recapMarkdown = summaryWith("30.00 km", "—");
      const recentHistory = [20, 10].map((km, i) => ({
        isoWeek: `2026-W4${2 - i}`,
        weekSessionId: `00000000-0000-4000-8000-00000000000${i}`,
        recapMarkdown: summaryWith(`${km}.00 km`, "—"),
      }));
      const r = reply({ kind: "fitness" }, { recapMarkdown, recentHistory });
      expect(Math.abs(totalM(r) - 20000)).toBeLessThanOrEqual(2000);
    });

    it("uses a modest default per kind with no history, never the old 56 km", () => {
      const race = totalM(reply({ kind: "race", distance: "10k" }));
      const speed = totalM(reply({ kind: "speed" }));
      const fit = totalM(reply({ kind: "fitness" }));
      expect(race).toBeLessThan(56000);
      expect(fit).toBeLessThan(speed);
      expect(speed).toBeLessThan(race);
    });
  });
});
