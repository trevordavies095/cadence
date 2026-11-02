import { describe, expect, it } from "vitest";
import { durationLabel, plannedRunLabel } from "../../frontend/lib/units.js";
import { formatPrescribedAmount } from "../src/recap/grading/prescribedAmount.js";
import { formatMinutesDuration } from "../src/recap/format.js";
import { buildSummaryGoalLines } from "../src/recap/summaryGoalLines.js";
import { resolveRecapDepthKnobs } from "../src/recap/phase.js";

describe("minute duration formatting (#45)", () => {
  it.each([
    [0, "0 min"],
    [40 * 60, "40 min"],
    [59 * 60 + 40, "1 h"],
    [119 * 60 + 40, "2 h"],
    [60 * 60, "1 h"],
    [90 * 60, "1 h 30 min"],
    [65 * 60, "1 h 5 min"],
  ])("formats %i seconds consistently in API and frontend", (seconds, label) => {
    expect(formatMinutesDuration(seconds)).toBe(label);
    expect(durationLabel(seconds)).toBe(label);
  });

  it("uses the same label for planned runs and long hard/threshold summaries", () => {
    const run = { type: "easy" as const, distanceM: 0, durationS: 119 * 60 + 40 };
    expect(formatPrescribedAmount(run, "metric")).toBe("2 h");
    expect(plannedRunLabel(run, "metric")).toBe("2 h");
    const lines = buildSummaryGoalLines({
      thresholds: resolveRecapDepthKnobs({ phase: "build", goal: "10k" }).thresholds,
      workouts: [],
      stats: null,
      unit: "metric",
      timezone: "UTC",
      hardSecondsFromSeries: { current: 90 * 60, previous: 20 * 60 },
      thresholdSeconds: 65 * 60,
    });
    expect(lines.find((line) => line.id === "hardMinutes")?.value).toBe("1 h 30 min, up 1 h 10 min");
    expect(lines.find((line) => line.id === "thresholdMinutes")?.value).toBe("1 h 5 min");
  });
});
