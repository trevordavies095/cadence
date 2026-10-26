/** Prescribed-vs-actual grading types (issue #41). */

export type GradeVerdict = "on_target" | "short" | "missed" | "partial";

export type QualitySessionGrade = {
  date: string;
  dayType: "quality" | "race";
  description: string;
  prescribedDistanceM: number;
  prescribedPaceOrHr: string | null;
  prescribedStructure: string | null;
  matched: boolean;
  workoutId?: string;
  actualDistanceM?: number;
  actualAvgPaceS?: number;
  actualAvgHeartRateBpm?: number;
  actualRunType?: string;
  distanceRatio?: number;
  verdict: GradeVerdict;
};

export type LongRunGrade = {
  date: string;
  description: string;
  prescribedDistanceM: number;
  prescribedPaceOrHr: string | null;
  matched: boolean;
  workoutId?: string;
  actualDistanceM?: number;
  actualAvgPaceS?: number;
  actualAvgHeartRateBpm?: number;
  actualRunType?: string;
  distanceRatio?: number;
  /** tempo-cli §2.6 shape: ≥75% of prescribed target qualifies. */
  thresholdMet: boolean;
  verdict: GradeVerdict;
};

export type RecapGradingResult = {
  included: boolean;
  weekMismatch: boolean;
  quality: QualitySessionGrade[];
  longRun: LongRunGrade | null;
  qualityMarkdown: string;
  longRunGradeMarkdown: string;
};
