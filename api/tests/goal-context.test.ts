import { describe, expect, it } from "vitest";
import { resolveGoalContext } from "../src/goal/context.js";
import type { TrainingGoal } from "../src/goal/types.js";

// Lakeshore Marathon on Sun Nov 15 2026.
const RACE_DAY = "2026-11-15";
const marathon: TrainingGoal = {
  kind: "race",
  distance: "marathon",
  raceName: "Lakeshore Marathon",
  raceDate: RACE_DAY,
};

/** The Monday `weeks` whole weeks before the race week's Monday (Nov 9 2026). */
function mondayWeeksOut(weeks: number): string {
  const d = new Date(Date.UTC(2026, 10, 9 - weeks * 7));
  return d.toISOString().slice(0, 10);
}

describe("resolveGoalContext: race phase by weeks to race", () => {
  const rows: Array<[number, string]> = [
    [20, "base"],
    [13, "base"],
    [12, "build"],
    [4, "build"],
    [3, "peak"],
    [2, "peak"],
    [1, "taper"],
    [0, "taper"],
  ];
  for (const [weeks, phase] of rows) {
    it(`${weeks} weeks out is ${phase}`, () => {
      const ctx = resolveGoalContext(marathon, mondayWeeksOut(weeks));
      expect(ctx.weeksToRace).toBe(weeks);
      expect(ctx.phase).toBe(phase);
      expect(ctx.racePassed).toBe(false);
      expect(ctx.recapGoal).toBe("marathon");
      expect(ctx.knobs.phase).toBe(phase);
      expect(ctx.knobs.goal).toBe("marathon");
    });
  }

  it("the race week itself is taper with zero weeks to race", () => {
    expect(resolveGoalContext(marathon, "2026-11-09")).toMatchObject({
      phase: "taper",
      weeksToRace: 0,
      racePassed: false,
    });
  });

  it("a race with no date is base", () => {
    const ctx = resolveGoalContext(
      { kind: "race", distance: "half" },
      "2026-10-19",
    );
    expect(ctx).toMatchObject({
      recapGoal: "half",
      phase: "base",
      weeksToRace: null,
      racePassed: false,
    });
  });
});

describe("resolveGoalContext: after the race", () => {
  it("is recovery for two weeks with racePassed, then base; the goal is untouched", () => {
    const goal = { ...marathon };
    const week1 = resolveGoalContext(goal, "2026-11-16");
    const week2 = resolveGoalContext(goal, "2026-11-23");
    const week3 = resolveGoalContext(goal, "2026-11-30");
    expect(week1).toMatchObject({ phase: "recovery", racePassed: true, weeksToRace: null });
    expect(week2).toMatchObject({ phase: "recovery", racePassed: true, weeksToRace: null });
    expect(week3).toMatchObject({ phase: "base", racePassed: true, weeksToRace: null });
    expect(goal).toEqual(marathon);
  });

  it("a speed goal returns to build after its race recovery", () => {
    const speed: TrainingGoal = { kind: "speed", distance: "5k", raceDate: "2026-09-12" };
    expect(resolveGoalContext(speed, "2026-09-14")).toMatchObject({
      phase: "recovery",
      racePassed: true,
    });
    expect(resolveGoalContext(speed, "2026-10-19")).toMatchObject({
      phase: "build",
      racePassed: true,
    });
  });
});

describe("resolveGoalContext: other kinds", () => {
  it("speed without a date is build", () => {
    expect(
      resolveGoalContext({ kind: "speed", distance: "10k" }, "2026-10-19"),
    ).toMatchObject({ recapGoal: "10k", phase: "build", weeksToRace: null });
    expect(resolveGoalContext({ kind: "speed" }, "2026-10-19")).toMatchObject({
      recapGoal: "general",
      phase: "build",
    });
  });

  it("speed with a date follows the race rule", () => {
    expect(
      resolveGoalContext(
        { kind: "speed", distance: "5k", raceDate: "2026-11-01" },
        "2026-10-19",
      ),
    ).toMatchObject({ recapGoal: "5k", phase: "taper", weeksToRace: 1 });
  });

  it("fitness is base and return is recovery, whatever date is present", () => {
    expect(resolveGoalContext({ kind: "fitness" }, "2026-10-19")).toMatchObject({
      recapGoal: "general",
      phase: "base",
      weeksToRace: null,
      racePassed: false,
    });
    expect(
      resolveGoalContext(
        { kind: "return", since: "2026-10-01", startingPoint: "walk-run" },
        "2026-10-19",
      ),
    ).toMatchObject({ recapGoal: "general", phase: "recovery", racePassed: false });
  });

  it("a race of distance other is a general recap goal on the race phase", () => {
    const ctx = resolveGoalContext(
      { kind: "race", distance: "other", raceDate: "2026-12-14" },
      "2026-10-19",
    );
    expect(ctx).toMatchObject({ recapGoal: "general", phase: "build", weeksToRace: 8 });
    expect(ctx.knobs.thresholds.column).toBe("fitness");
  });

  it("no goal stored is general base with the fitness column", () => {
    const ctx = resolveGoalContext(null, "2026-10-19");
    expect(ctx).toMatchObject({
      recapGoal: "general",
      phase: "base",
      weeksToRace: null,
      racePassed: false,
    });
    expect(ctx.knobs.thresholds.column).toBe("fitness");
  });

  it("the knobs carry the goal's column", () => {
    expect(resolveGoalContext(marathon, "2026-10-19").knobs.thresholds.column).toBe(
      "endurance",
    );
    expect(
      resolveGoalContext({ kind: "speed", distance: "10k" }, "2026-10-19").knobs
        .thresholds.column,
    ).toBe("speed");
    expect(
      resolveGoalContext({ kind: "return" }, "2026-10-19").knobs.thresholds,
    ).toMatchObject({ column: "return", volumeChangeWarningPct: 10 });
  });

  it("rejects a Monday that is not a date", () => {
    expect(() => resolveGoalContext(marathon, "2026-W43")).toThrow();
  });
});
