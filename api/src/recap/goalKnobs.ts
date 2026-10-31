/**
 * Report knobs by goal column: which lines get a target or verdict, and at what value.
 * Every number lives here, with its research source beside it.
 *
 * Columns:
 *   endurance — half, marathon
 *   speed     — 5k, 10k, and the speed kind
 *   fitness   — stay fit; also legacy athletes with no goal, and a race of distance "other"
 *   return    — getting back to running
 */
import type { GoalKind } from "../goal/types.js";
import type { RecapGoal, RecapPhase } from "./phase.js";

export type GoalColumn = "endurance" | "speed" | "fitness" | "return";

export type HeadlineMetric =
  | "distance"
  | "hardMinutes"
  | "runMinutes"
  | "longestRunDuration";

export type RecapThresholdKnobs = {
  column: GoalColumn;
  /** Percent of time with HR in Z1+Z2. Null: show the share, no target and no verdict. */
  easyShareTarget: number | null;
  /**
   * The share is judged against the target ("meets" / "below"). False: the
   * target is shown as a reference only, with no verdict and no tick on the bar.
   */
  easyShareVerdict: boolean;
  /** HR drift (first vs last quarter) above which a run is labelled high. Null: never labelled. */
  driftCapBpm: { easy: number; long: number | null };
  longRun: {
    /** The long-run section appears at all. */
    section: boolean;
    /** With no run typed Long Run, the week's longest run may stand in. */
    longestRunFallback: boolean;
    /** The four-week distance trend carries an improving/declining verdict. */
    distanceTrendVerdict: boolean;
    /** A single "Longest run" line in the summary instead of the section. */
    summaryLine: boolean;
  };
  /** The "Fast finish?" line on the long run. */
  fastFinish: boolean;
  /** Hard minutes = Z4+Z5. */
  hardMinutes: {
    shown: boolean;
    /** Count of quality sessions this week. */
    qualitySessionCount: boolean;
    /** "Present this week" check (stay fit). */
    presenceCheck: boolean;
    /** Any hard minutes are flagged (return). */
    flagAboveZero: boolean;
  };
  /**
   * "Threshold minutes" on the summary: time near the athlete-set threshold
   * pace or heart rate. Shown only when a threshold is set in the running log.
   */
  thresholdMinutes: boolean;
  /** Week-over-week volume change, in percent, above which the report warns. */
  volumeChangeWarningPct: number;
  /** What the summary leads with. */
  headline: HeadlineMetric[];
};

/**
 * Easy-share targets.
 * 80%: Seiler's polarized-training studies; Fitzgerald, "80/20 Running".
 * 75%: the same sources, for a block with two quality days (5k/10k/speed).
 */
export const EASY_SHARE_TARGET_ENDURANCE = 80;
export const EASY_SHARE_TARGET_SPEED = 75;

/**
 * Easy-share verdicts.
 * Endurance: judged against 80%.
 * Speed: 75% is a reference only, never a "below" verdict. Seiler's 80/20 is
 * counted by session goal (easy sessions vs quality sessions), while this share
 * is heart-rate time in Z1+Z2. On a week with two quality sessions, warm-ups,
 * cool-downs and jog recoveries drift into Z3 and heart rate lags pace, so time
 * in zones runs well under the session count: a normal 10k block reads 56-69%
 * (issue #34), and a verdict would fire every week.
 */
export const EASY_SHARE_VERDICT_ENDURANCE = true;
export const EASY_SHARE_VERDICT_SPEED = false;

/** Drift caps in bpm (coaching convention for aerobic decoupling on easy and long runs). */
export const DRIFT_CAP_EASY_BPM = 10;
export const DRIFT_CAP_LONG_BPM = 20;

/**
 * Volume-change warnings.
 * 20% (race and speed blocks) and 30% (stay fit): Nielsen's and Damsted's running-injury
 *      cohorts on weekly progression and injury risk.
 * 10% (return): Warden's return-to-running guidance.
 */
export const VOLUME_WARNING_PCT_TRAINING = 20;
export const VOLUME_WARNING_PCT_FITNESS = 30;
export const VOLUME_WARNING_PCT_RETURN = 10;

/**
 * Which column a goal falls in. Kind wins when given (speed, fitness, return);
 * a race, or no kind (debug overrides, legacy), falls back to the recap goal.
 */
export function goalColumn(goal: RecapGoal, kind?: GoalKind): GoalColumn {
  if (kind === "speed") return "speed";
  if (kind === "fitness") return "fitness";
  if (kind === "return") return "return";
  switch (goal) {
    case "half":
    case "marathon":
      return "endurance";
    case "5k":
    case "10k":
      return "speed";
    case "general":
      return "fitness";
  }
}

/** The knobs table, resolved for one column, recap goal and phase. */
export function resolveRecapThresholds(args: {
  goal: RecapGoal;
  phase: RecapPhase;
  kind?: GoalKind;
}): RecapThresholdKnobs {
  const column = goalColumn(args.goal, args.kind);
  const { phase } = args;

  switch (column) {
    case "endurance":
      return {
        column,
        easyShareTarget:
          phase === "base" || phase === "build"
            ? EASY_SHARE_TARGET_ENDURANCE
            : null,
        easyShareVerdict: EASY_SHARE_VERDICT_ENDURANCE,
        driftCapBpm: { easy: DRIFT_CAP_EASY_BPM, long: DRIFT_CAP_LONG_BPM },
        longRun: {
          section: true,
          longestRunFallback: true,
          distanceTrendVerdict: phase === "base" || phase === "build",
          summaryLine: false,
        },
        fastFinish: true,
        hardMinutes: {
          shown: true,
          qualitySessionCount: false,
          presenceCheck: false,
          flagAboveZero: false,
        },
        // Threshold work is a staple of a half block; the marathon block leads with the long run.
        thresholdMinutes: args.goal === "half",
        volumeChangeWarningPct: VOLUME_WARNING_PCT_TRAINING,
        headline: ["distance"],
      };
    case "speed": {
      // 10k keeps the long-run section without a verdict; 5k and the speed kind drop it.
      const tenK = args.goal === "10k" && args.kind !== "speed";
      return {
        column,
        easyShareTarget: EASY_SHARE_TARGET_SPEED,
        easyShareVerdict: EASY_SHARE_VERDICT_SPEED,
        driftCapBpm: { easy: DRIFT_CAP_EASY_BPM, long: DRIFT_CAP_LONG_BPM },
        longRun: {
          section: tenK,
          longestRunFallback: tenK,
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
        volumeChangeWarningPct: VOLUME_WARNING_PCT_TRAINING,
        headline: ["distance", "hardMinutes"],
      };
    }
    case "fitness":
      return {
        column,
        easyShareTarget: null,
        easyShareVerdict: false,
        driftCapBpm: { easy: DRIFT_CAP_EASY_BPM, long: null },
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
        volumeChangeWarningPct: VOLUME_WARNING_PCT_FITNESS,
        headline: ["runMinutes"],
      };
    case "return":
      return {
        column,
        easyShareTarget: null,
        easyShareVerdict: false,
        driftCapBpm: { easy: DRIFT_CAP_EASY_BPM, long: null },
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
          // Warden: during a return, any Z4+Z5 time is worth flagging.
          flagAboveZero: true,
        },
        thresholdMinutes: false,
        volumeChangeWarningPct: VOLUME_WARNING_PCT_RETURN,
        headline: ["runMinutes", "longestRunDuration"],
      };
  }
}
