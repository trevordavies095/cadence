import type { TempoUnitPreference } from "../tempo/port.js";
import type { RecapDepthKnobs, RecapPhase, RecapGoal } from "./phase.js";
import type { RunByRunHrDrift } from "./runByRunHr.js";

export type LongRunSelectionReason =
  | "explicit_long_run"
  | "longest_run_fallback"
  | "not_eligible"
  /** The goal has no long-run section (see goalKnobs longRun.section). */
  | "not_for_goal";

export type LongRunHalfSplit = {
  frontHalfSecPerMi: number;
  backHalfSecPerMi: number;
  deltaSecPerMi: number;
  negativeSplit: boolean;
};

export type LongRunFastFinish = {
  /** Window length: 5000 m, or 3 mi for imperial athletes. */
  windowM: number;
  lastPaceSecPerKm: number;
  restPaceSecPerKm: number;
  /** Rest pace minus last-window pace; positive = the finish was faster. */
  fasterBySecPerKm: number;
  fastFinish: boolean;
};

export type LongRunDetail = {
  workoutId: string;
  startedAt: string;
  titleDate: string;
  runType: string;
  distanceM: number;
  durationS: number;
  avgPaceS?: number;
  avgHeartRateBpm?: number;
  drift?: RunByRunHrDrift;
  splitPacesFormatted?: string;
  half?: LongRunHalfSplit;
  /**
   * Last 5 km (3 mi) against the rest of the run, by pace. Present only for
   * goals that get the fast-finish line; null when splits cannot tell.
   */
  fastFinish?: LongRunFastFinish | null;
  selectionReason: "explicit_long_run" | "longest_run_fallback";
};

export type RecapLongRunResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  phase: RecapPhase;
  goal: RecapGoal;
  knobs: RecapDepthKnobs;
  included: boolean;
  reason?: LongRunSelectionReason;
  longRun?: LongRunDetail;
  markdown: string;
};
