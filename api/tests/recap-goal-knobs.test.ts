import { describe, expect, it } from "vitest";
import { resolveRecapDepthKnobs } from "../src/recap/phase.js";

describe("resolveRecapDepthKnobs: the knobs table by goal column", () => {
  it("half and marathon: 80% in base and build, none in taper; long run with verdict in base and build", () => {
    for (const goal of ["half", "marathon"] as const) {
      const build = resolveRecapDepthKnobs({ phase: "build", goal });
      expect(build.thresholds).toEqual({
        column: "endurance",
        easyShareTarget: 80,
        driftCapBpm: { easy: 10, long: 20 },
        longRun: {
          section: true,
          longestRunFallback: true,
          distanceTrendVerdict: true,
          summaryLine: false,
        },
        fastFinish: true,
        hardMinutes: {
          shown: true,
          qualitySessionCount: false,
          presenceCheck: false,
          flagAboveZero: false,
        },
        thresholdMinutes: goal === "half",
        volumeChangeWarningPct: 20,
        headline: ["distance"],
      });
      expect(resolveRecapDepthKnobs({ phase: "base", goal }).thresholds).toMatchObject({
        easyShareTarget: 80,
        longRun: { distanceTrendVerdict: true },
      });
      const taper = resolveRecapDepthKnobs({ phase: "taper", goal }).thresholds;
      expect(taper.easyShareTarget).toBeNull();
      expect(taper.longRun).toMatchObject({ section: true, distanceTrendVerdict: false });
      expect(
        resolveRecapDepthKnobs({ phase: "peak", goal }).thresholds.longRun
          .distanceTrendVerdict,
      ).toBe(false);
    }
  });

  it("5k, 10k and speed: 75%, quality-session count, long run only for a 10k race, no verdict", () => {
    const fiveK = resolveRecapDepthKnobs({ phase: "build", goal: "5k" }).thresholds;
    expect(fiveK).toEqual({
      column: "speed",
      easyShareTarget: 75,
      driftCapBpm: { easy: 10, long: 20 },
      longRun: {
        section: false,
        longestRunFallback: false,
        distanceTrendVerdict: false,
        summaryLine: false,
      },
      fastFinish: false,
      hardMinutes: {
        shown: true,
        qualitySessionCount: true,
        presenceCheck: false,
        flagAboveZero: false,
      },
      thresholdMinutes: true,
      volumeChangeWarningPct: 20,
      headline: ["distance", "hardMinutes"],
    });

    const tenK = resolveRecapDepthKnobs({ phase: "build", goal: "10k" }).thresholds;
    expect(tenK).toMatchObject({
      column: "speed",
      easyShareTarget: 75,
      longRun: { section: true, distanceTrendVerdict: false },
      fastFinish: false,
    });

    const speed = resolveRecapDepthKnobs({
      phase: "build",
      goal: "10k",
      kind: "speed",
    }).thresholds;
    expect(speed).toMatchObject({
      column: "speed",
      easyShareTarget: 75,
      longRun: { section: false },
      hardMinutes: { qualitySessionCount: true },
    });
    // The speed column does not change target with phase.
    expect(
      resolveRecapDepthKnobs({ phase: "taper", goal: "5k" }).thresholds.easyShareTarget,
    ).toBe(75);
  });

  it("fitness: no target, no long-run section but a summary line, presence check, 30%", () => {
    expect(resolveRecapDepthKnobs({ phase: "base", goal: "general" }).thresholds).toEqual({
      column: "fitness",
      easyShareTarget: null,
      driftCapBpm: { easy: 10, long: null },
      longRun: {
        section: false,
        longestRunFallback: false,
        distanceTrendVerdict: false,
        summaryLine: true,
      },
      fastFinish: false,
      hardMinutes: {
        shown: true,
        qualitySessionCount: false,
        presenceCheck: true,
        flagAboveZero: false,
      },
      thresholdMinutes: false,
      volumeChangeWarningPct: 30,
      headline: ["runMinutes"],
    });
    expect(
      resolveRecapDepthKnobs({ phase: "base", goal: "general", kind: "fitness" })
        .thresholds.column,
    ).toBe("fitness");
    // No arguments at all is the fitness column (legacy and debug default).
    expect(resolveRecapDepthKnobs().thresholds.column).toBe("fitness");
  });

  it("return: no target, hard minutes flagged above zero, 10%, run minutes and longest run duration", () => {
    expect(
      resolveRecapDepthKnobs({ phase: "recovery", goal: "general", kind: "return" })
        .thresholds,
    ).toEqual({
      column: "return",
      easyShareTarget: null,
      driftCapBpm: { easy: 10, long: null },
      longRun: {
        section: false,
        longestRunFallback: false,
        distanceTrendVerdict: false,
        summaryLine: false,
      },
      fastFinish: false,
      hardMinutes: {
        shown: true,
        qualitySessionCount: false,
        presenceCheck: false,
        flagAboveZero: true,
      },
      thresholdMinutes: false,
      volumeChangeWarningPct: 10,
      headline: ["runMinutes", "longestRunDuration"],
    });
  });

  it("section depths are unchanged by the goal kind", () => {
    const withoutKind = resolveRecapDepthKnobs({ phase: "build", goal: "10k" });
    const withKind = resolveRecapDepthKnobs({ phase: "build", goal: "10k", kind: "speed" });
    expect(withKind.sections).toEqual(withoutKind.sections);
    expect(withKind.longestAsLongRun).toBe(withoutKind.longestAsLongRun);
  });
});
