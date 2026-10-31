import { describe, expect, it } from "vitest";
import { parseWeeklyRecapStats } from "../src/tempo/weeklyRecapStats.js";

/**
 * Body of Tempo GET /stats/weekly-recap as shipped (WeeklyRecapDocument in
 * tempo api/Models/Responses, docs/openapi.json). Current week has HR series;
 * the previous week had none, so its zone buckets and easy-run HR are null.
 */
const SHIPPED_BODY = {
  weekStart: "2026-10-19",
  weekEnd: "2026-10-25",
  referenceDate: "2026-10-19",
  timezoneOffsetMinutes: -240,
  currentWeekIsPartial: true,
  generatedAtUtc: "2026-10-21T15:00:00.000Z",
  metrics: {
    runs: { current: 3, previous: 2, trailingAvg: 2.6666666666666665, deltaVsPrevious: 1 },
    distanceM: { current: 21000.5, previous: 16000, trailingAvg: 18000.25, deltaVsPrevious: 5000.5 },
    durationS: { current: 7400, previous: 5600, trailingAvg: 6200, deltaVsPrevious: 1800 },
    elevationGainM: { current: 120.4, previous: 80, trailingAvg: 95.5, deltaVsPrevious: 40.4 },
    relativeEffortSum: { current: 140, previous: 90, trailingAvg: 110.33333333333333, deltaVsPrevious: 50 },
    easyRunAvgHeartRateBpm: { current: 142.3, previous: null, trailingAvg: 141, deltaVsPrevious: null },
    movingTimeS: { current: 7200, previous: 5500, trailingAvg: 6100, deltaVsPrevious: 1700 },
    longestRunDistanceM: { current: 12000, previous: 9000, trailingAvg: 10500, deltaVsPrevious: 3000 },
    longestRunDurationS: { current: 4300, previous: 3200, trailingAvg: 3600, deltaVsPrevious: 1100 },
    runsByType: { "Easy Run": 1, "Long Run": 1, Unspecified: 1 },
    zoneSecondsZ1: { current: 1200, previous: null, trailingAvg: 900, deltaVsPrevious: null },
    zoneSecondsZ2: { current: 4000, previous: null, trailingAvg: 3500.5, deltaVsPrevious: null },
    zoneSecondsZ3: { current: 1500, previous: null, trailingAvg: 1000, deltaVsPrevious: null },
    zoneSecondsZ4: { current: 400, previous: null, trailingAvg: 300, deltaVsPrevious: null },
    zoneSecondsZ5: { current: 100, previous: null, trailingAvg: null, deltaVsPrevious: null },
  },
};

type MutableBody = typeof SHIPPED_BODY & { metrics: Record<string, unknown> };

describe("parseWeeklyRecapStats (shipped Tempo shape)", () => {
  it("reads every metric, including deltaVsPrevious, the new fields and runsByType", () => {
    const stats = parseWeeklyRecapStats(SHIPPED_BODY);
    expect(stats).toEqual({
      runs: { current: 3, previous: 2, trailingAvg: 2.6666666666666665, deltaVsPrevious: 1 },
      distanceM: { current: 21000.5, previous: 16000, trailingAvg: 18000.25, deltaVsPrevious: 5000.5 },
      durationS: { current: 7400, previous: 5600, trailingAvg: 6200, deltaVsPrevious: 1800 },
      elevationGainM: { current: 120.4, previous: 80, trailingAvg: 95.5, deltaVsPrevious: 40.4 },
      relativeEffortSum: { current: 140, previous: 90, trailingAvg: 110.33333333333333, deltaVsPrevious: 50 },
      easyRunAvgHeartRateBpm: { current: 142.3, trailingAvg: 141 },
      movingTimeS: { current: 7200, previous: 5500, trailingAvg: 6100, deltaVsPrevious: 1700 },
      longestRunDistanceM: { current: 12000, previous: 9000, trailingAvg: 10500, deltaVsPrevious: 3000 },
      longestRunDurationS: { current: 4300, previous: 3200, trailingAvg: 3600, deltaVsPrevious: 1100 },
      runsByType: { "Easy Run": 1, "Long Run": 1, Unspecified: 1 },
      zoneSecondsZ1: { current: 1200, trailingAvg: 900 },
      zoneSecondsZ2: { current: 4000, trailingAvg: 3500.5 },
      zoneSecondsZ3: { current: 1500, trailingAvg: 1000 },
      zoneSecondsZ4: { current: 400, trailingAvg: 300 },
      zoneSecondsZ5: { current: 100 },
    });
  });

  it("drops an all-null zone bucket (a week with no HR series) and keeps an empty runsByType", () => {
    const body = structuredClone(SHIPPED_BODY) as MutableBody;
    const allNull = { current: null, previous: null, trailingAvg: null, deltaVsPrevious: null };
    for (const z of [1, 2, 3, 4, 5]) body.metrics[`zoneSecondsZ${z}`] = allNull;
    body.metrics.runsByType = {};
    const stats = parseWeeklyRecapStats(body)!;
    for (const z of [1, 2, 3, 4, 5] as const) {
      expect(stats[`zoneSecondsZ${z}`]).toBeUndefined();
    }
    expect(stats.runsByType).toEqual({});
    expect(stats.runs?.current).toBe(3);
  });

  it("keeps only non-negative integer runsByType counts", () => {
    const body = structuredClone(SHIPPED_BODY) as MutableBody;
    body.metrics.runsByType = { Tempo: 2, Bogus: "x", Neg: -1, Half: 1.5 };
    expect(parseWeeklyRecapStats(body)!.runsByType).toEqual({ Tempo: 2 });
  });
});
