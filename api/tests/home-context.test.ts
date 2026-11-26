/**
 * The race part of Home's opening line (src/home/compose.ts, issue #79), as a
 * pure function of the goal and today's date.
 */
import { describe, expect, it } from "vitest";
import { raceAhead } from "../src/home/compose.js";

describe("the race ahead on Home", () => {
  const half = { kind: "race", distance: "half", raceName: " Winter Half ", raceDate: "2027-01-09" } as const;

  it("counts the days from today to the race, and trims its name", () => {
    expect(raceAhead(half, "2026-11-26")).toEqual({ name: "Winter Half", date: "2027-01-09", daysToRace: 44 });
    expect(raceAhead(half, "2027-01-09")).toMatchObject({ daysToRace: 0 });
  });

  it("says nothing once the race has passed, or with no date", () => {
    expect(raceAhead(half, "2027-01-10")).toBeNull();
    expect(raceAhead({ kind: "race", distance: "half" }, "2026-11-26")).toBeNull();
    expect(raceAhead(null, "2026-11-26")).toBeNull();
  });

  it("a dated speed goal counts like a race; fitness and return ignore any date", () => {
    expect(raceAhead({ kind: "speed", distance: "5k", raceDate: "2026-12-12" }, "2026-11-26")).toEqual({
      name: null,
      date: "2026-12-12",
      daysToRace: 16,
    });
    expect(raceAhead({ kind: "fitness", raceDate: "2026-12-12" }, "2026-11-26")).toBeNull();
    expect(raceAhead({ kind: "return", raceDate: "2026-12-12" }, "2026-11-26")).toBeNull();
  });
});
