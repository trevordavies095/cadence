import type {
  TempoWeeklyRecapMetric,
  TempoWeeklyRecapStats,
} from "../tempo/port.js";
import type { WeekAggregate } from "./aggregate.js";

/** Structured comparison columns (Δ = this week − 3-wk avg). */
export type SummaryComparison = {
  mileage: {
    prevDistanceM?: number;
    threeWkAvgDistanceM?: number;
    deltaVsThreeWkM?: number;
  };
  runs: {
    prev?: number;
    threeWkAvg?: number;
    deltaVsThreeWk?: number;
  };
  time: {
    prevDurationS?: number;
    threeWkAvgDurationS?: number;
    deltaVsThreeWkS?: number;
  };
  elevation: {
    prevElevM?: number;
    threeWkAvgElevM?: number;
    deltaVsThreeWkM?: number;
  };
  relativeEffort: {
    prev?: number;
    threeWkAvg?: number;
    deltaVsThreeWk?: number;
  };
  easyRunHr?: {
    prev?: number;
    threeWkAvg?: number;
    deltaVsThreeWk?: number;
  };
};

function mean(vals: number[]): number | undefined {
  if (vals.length === 0) return undefined;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Fallback comparison computed from correctly filtered week windows (used when
 * Tempo weekly-recap stats are unavailable, e.g. export mode).
 * Like tempo-cli, an empty prior week is a real zero week (not a dash) and the
 * 3-wk avg is the mean of all three trailing weeks, empty ones included.
 */
export function buildSummaryComparison(args: {
  thisWeek: WeekAggregate;
  prevWeek: WeekAggregate;
  /** Oldest -> newest among W-3...W-1. */
  trailingWeeks: readonly WeekAggregate[];
}): SummaryComparison {
  const { thisWeek, prevWeek, trailingWeeks } = args;
  const active = trailingWeeks.filter((w) => w.runCount > 0);

  const out: SummaryComparison = {
    mileage: {
      prevDistanceM: prevWeek.distanceM,
    },
    runs: { prev: prevWeek.runCount },
    time: { prevDurationS: prevWeek.durationS },
    elevation: { prevElevM: prevWeek.elevGainM },
    relativeEffort: { prev: prevWeek.relativeEffort },
  };

  if (trailingWeeks.length > 0) {
    const distAvg = mean(trailingWeeks.map((w) => w.distanceM))!;
    const runsAvg = mean(trailingWeeks.map((w) => w.runCount))!;
    const timeAvg = mean(trailingWeeks.map((w) => w.durationS))!;
    const elevAvg = mean(trailingWeeks.map((w) => w.elevGainM))!;
    const reAvg = mean(trailingWeeks.map((w) => w.relativeEffort))!;
    out.mileage.threeWkAvgDistanceM = distAvg;
    out.mileage.deltaVsThreeWkM = thisWeek.distanceM - distAvg;
    out.runs.threeWkAvg = runsAvg;
    out.runs.deltaVsThreeWk = thisWeek.runCount - runsAvg;
    out.time.threeWkAvgDurationS = timeAvg;
    out.time.deltaVsThreeWkS = thisWeek.durationS - timeAvg;
    out.elevation.threeWkAvgElevM = elevAvg;
    out.elevation.deltaVsThreeWkM = thisWeek.elevGainM - elevAvg;
    out.relativeEffort.threeWkAvg = reAvg;
    out.relativeEffort.deltaVsThreeWk = thisWeek.relativeEffort - reAvg;
  }

  const easyPrev =
    prevWeek.runCount > 0 ? prevWeek.easyRunAvgHr : undefined;
  const easyAvgs = active
    .map((w) => w.easyRunAvgHr)
    .filter((x): x is number => x !== undefined);
  const easy3 = mean(easyAvgs);

  if (easyPrev !== undefined || easy3 !== undefined) {
    out.easyRunHr = {};
    if (easyPrev !== undefined) out.easyRunHr.prev = easyPrev;
    if (easy3 !== undefined) {
      out.easyRunHr.threeWkAvg = easy3;
      if (thisWeek.easyRunAvgHr !== undefined) {
        out.easyRunHr.deltaVsThreeWk = thisWeek.easyRunAvgHr - easy3;
      }
    }
  }

  return out;
}

/**
 * Comparison columns from Tempo GET /stats/weekly-recap, the way tempo-cli
 * does: prev and trailing avg come from the response; delta is always
 * (this week computed from workouts) - trailing avg.
 */
export function buildSummaryComparisonFromStats(args: {
  thisWeek: WeekAggregate;
  stats: TempoWeeklyRecapStats;
}): SummaryComparison {
  const { thisWeek, stats } = args;
  const out: SummaryComparison = {
    mileage: {},
    runs: {},
    time: {},
    elevation: {},
    relativeEffort: {},
  };
  const fill = (
    block: TempoWeeklyRecapMetric | undefined,
    thisValue: number,
  ): { prev?: number; avg?: number; delta?: number } => ({
    prev: block?.previous,
    avg: block?.trailingAvg,
    delta:
      block?.trailingAvg !== undefined
        ? thisValue - block.trailingAvg
        : undefined,
  });

  const dist = fill(stats.distanceM, thisWeek.distanceM);
  out.mileage = {
    prevDistanceM: dist.prev,
    threeWkAvgDistanceM: dist.avg,
    deltaVsThreeWkM: dist.delta,
  };
  const runs = fill(stats.runs, thisWeek.runCount);
  out.runs = { prev: runs.prev, threeWkAvg: runs.avg, deltaVsThreeWk: runs.delta };
  const time = fill(stats.durationS, thisWeek.durationS);
  out.time = {
    prevDurationS: time.prev,
    threeWkAvgDurationS: time.avg,
    deltaVsThreeWkS: time.delta,
  };
  const elev = fill(stats.elevationGainM, thisWeek.elevGainM);
  out.elevation = {
    prevElevM: elev.prev,
    threeWkAvgElevM: elev.avg,
    deltaVsThreeWkM: elev.delta,
  };
  const re = fill(stats.relativeEffortSum, thisWeek.relativeEffort);
  out.relativeEffort = {
    prev: re.prev,
    threeWkAvg: re.avg,
    deltaVsThreeWk: re.delta,
  };

  const ez = stats.easyRunAvgHeartRateBpm;
  if (ez && (ez.previous !== undefined || ez.trailingAvg !== undefined)) {
    out.easyRunHr = {};
    if (ez.previous !== undefined) out.easyRunHr.prev = ez.previous;
    if (ez.trailingAvg !== undefined) {
      out.easyRunHr.threeWkAvg = ez.trailingAvg;
      if (thisWeek.easyRunAvgHr !== undefined) {
        out.easyRunHr.deltaVsThreeWk = thisWeek.easyRunAvgHr - ez.trailingAvg;
      }
    }
  }
  return out;
}
