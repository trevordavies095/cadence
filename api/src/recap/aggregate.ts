import type { TempoWorkoutSummary } from "../tempo/port.js";
import { isEasyFamily } from "./runTypes.js";

/** Raw totals for one week window (tempo-cli Summary “This week” shape). */
export type WeekAggregate = {
  runCount: number;
  distanceM: number;
  durationS: number;
  elevGainM: number;
  relativeEffort: number;
  /** True when at least one workout had elevGainM. */
  hasElevation: boolean;
  /** True when at least one workout had relativeEffort. */
  hasRelativeEffort: boolean;
  /** Mean avg HR on easy-family runs; undefined if none. */
  easyRunAvgHr?: number;
};

export function aggregateWorkouts(
  workouts: readonly TempoWorkoutSummary[],
): WeekAggregate {
  let distanceM = 0;
  let durationS = 0;
  let elevGainM = 0;
  let relativeEffort = 0;
  let hasElevation = false;
  let hasRelativeEffort = false;
  const easyHrs: number[] = [];

  for (const w of workouts) {
    if (Number.isFinite(w.distanceM)) distanceM += w.distanceM;
    if (Number.isFinite(w.durationS)) durationS += w.durationS;
    if (typeof w.elevGainM === "number" && Number.isFinite(w.elevGainM)) {
      elevGainM += w.elevGainM;
      hasElevation = true;
    }
    if (
      typeof w.relativeEffort === "number" &&
      Number.isFinite(w.relativeEffort)
    ) {
      relativeEffort += w.relativeEffort;
      hasRelativeEffort = true;
    }
    if (
      isEasyFamily(w.runType) &&
      typeof w.avgHeartRateBpm === "number" &&
      Number.isFinite(w.avgHeartRateBpm)
    ) {
      easyHrs.push(w.avgHeartRateBpm);
    }
  }

  const agg: WeekAggregate = {
    runCount: workouts.length,
    distanceM,
    durationS,
    elevGainM,
    relativeEffort,
    hasElevation,
    hasRelativeEffort,
  };
  if (easyHrs.length > 0) {
    agg.easyRunAvgHr = Math.round(
      easyHrs.reduce((a, b) => a + b, 0) / easyHrs.length,
    );
  }
  return agg;
}
