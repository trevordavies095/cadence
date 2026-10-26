import type { TempoUnitPreference } from "../tempo/port.js";
import type { RecapDepthKnobs, RecapPhase, RecapGoal } from "./phase.js";
import type { RunByRunHrDrift } from "./runByRunHr.js";

export type LongRunSelectionReason =
  | "explicit_long_run"
  | "longest_run_fallback"
  | "not_eligible";

export type LongRunHalfSplit = {
  frontHalfSecPerMi: number;
  backHalfSecPerMi: number;
  deltaSecPerMi: number;
  negativeSplit: boolean;
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
  /** Last-window finish looked like goal effort (pace pickup). */
  finishAtGoalEffort?: boolean | null;
  selectionReason: Exclude<LongRunSelectionReason, "not_eligible">;
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
