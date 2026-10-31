import { describe, expect, it } from "vitest";
import { formatPaceFromSecondsPerKm } from "../src/recap/runByRunFormat.js";
import { buildTrendsMarkdown, type RecapTrendsSnapshot } from "../src/recap/trends.js";

describe("pace formatting", () => {
  it("rounds the whole pace, so 359.6 s/km reads 6:00/km, never 5:60/km", () => {
    expect(formatPaceFromSecondsPerKm(359.6, "metric")).toBe("6:00/km");
    expect(formatPaceFromSecondsPerKm(359.4, "metric")).toBe("5:59/km");
    expect(formatPaceFromSecondsPerKm(300, "metric")).toBe("5:00/km");
  });
});

describe("trends distance row by goal", () => {
  const snapshot: RecapTrendsSnapshot = {
    included: true,
    weekLabels: ["2026-W40", "2026-W41", "2026-W42", "2026-W43"],
    easyPaceSecPerKm: [null, null, null, null],
    avgEasyHr: [null, null, null, null],
    longRunDistanceM: [8000, 9000, 10000, 11000],
  };

  it("names the row a long run when the goal has a long-run section", () => {
    const md = buildTrendsMarkdown(snapshot, "metric", "standard", { tempoParity: true });
    expect(md).toContain("**Long-run distance** (max long-typed, else max run in week)");
  });

  it("names the row the longest run when the goal has no long-run section", () => {
    const md = buildTrendsMarkdown(snapshot, "metric", "standard", {
      tempoParity: true,
      longRunSection: false,
    });
    expect(md).toContain("- **Longest run**: ");
    expect(md).not.toMatch(/long-run|long run/i);
  });
});
