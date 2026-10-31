import type { WeekSession } from "../week/store.js";
import type {
  TempoPort,
  TempoUnitPreference,
  TempoWorkoutDetail,
} from "../tempo/port.js";
import { resolveRecapUnit } from "./buildSummary.js";
import { listAllWorkoutsInWindow } from "./listWindow.js";
import {
  buildLongRunMarkdown,
  computeFastFinish,
  computeHalfSplit,
  formatSplitPacesFromDetail,
} from "./longRunFormat.js";
import type { LongRunDetail, RecapLongRunResult } from "./longRunTypes.js";
import {
  resolveRecapDepthKnobs,
  type RecapDepthKnobs,
  type RecapGoal,
  type RecapPhase,
} from "./phase.js";
import { computeRunHrMetrics } from "./runByRunHr.js";
import { isLongRun } from "./runTypes.js";
import { formatTitleDate } from "./runByRunFormat.js";
import { loadRecapWorkoutDetails } from "./workoutDetails.js";
import type { WeekWindow } from "./weekWindows.js";

function pickLongRunDetail(args: {
  details: TempoWorkoutDetail[];
  longestAsLongRun: boolean;
}):
  | {
      detail: TempoWorkoutDetail;
      selectionReason: "explicit_long_run" | "longest_run_fallback";
    }
  | undefined {
  const usable = args.details.filter(
    (d) => Number.isFinite(d.distanceM) && d.distanceM > 0,
  );
  if (usable.length === 0) return undefined;

  const typed = usable.filter((d) => isLongRun(d.runType));
  if (typed.length > 0) {
    const tMax = Math.max(...typed.map((d) => d.distanceM));
    const candidates = typed.filter((d) => d.distanceM === tMax);
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return {
      detail: candidates[0]!,
      selectionReason: "explicit_long_run",
    };
  }

  if (!args.longestAsLongRun) return undefined;

  const maxDist = Math.max(...usable.map((d) => d.distanceM));
  const longest = usable.filter((d) => d.distanceM === maxDist);
  longest.sort((a, b) => a.id.localeCompare(b.id));
  return {
    detail: longest[0]!,
    selectionReason: "longest_run_fallback",
  };
}

function toLongRunDetail(args: {
  detail: TempoWorkoutDetail;
  selectionReason: "explicit_long_run" | "longest_run_fallback";
  unit: TempoUnitPreference;
  timeZone: string;
  zones: readonly { zoneNumber: number; minBpm: number; maxBpm: number }[];
  /** The goal gets the fast-finish line (half and marathon). */
  fastFinish: boolean;
}): LongRunDetail {
  const { detail, selectionReason, unit, timeZone, zones } = args;
  const hr = computeRunHrMetrics({
    timeSeries: detail.timeSeries,
    durationS: detail.durationS,
    zones,
  });
  const half = computeHalfSplit(detail.splits);
  const runType =
    typeof detail.runType === "string" && detail.runType.trim()
      ? detail.runType.trim()
      : "Run";

  const out: LongRunDetail = {
    workoutId: detail.id,
    startedAt: detail.startedAt,
    titleDate: formatTitleDate(detail.startedAt, timeZone),
    runType,
    distanceM: detail.distanceM,
    durationS: detail.durationS,
    selectionReason,
  };
  if (Number.isFinite(detail.avgPaceS) && detail.avgPaceS > 0) {
    out.avgPaceS = detail.avgPaceS;
  }
  if (
    typeof detail.avgHeartRateBpm === "number" &&
    Number.isFinite(detail.avgHeartRateBpm)
  ) {
    out.avgHeartRateBpm = detail.avgHeartRateBpm;
  } else if (hr.avgHrFromSeries !== undefined) {
    out.avgHeartRateBpm = hr.avgHrFromSeries;
  }
  if (hr.drift) out.drift = hr.drift;
  const splitFmt = formatSplitPacesFromDetail(detail.splits, unit);
  if (splitFmt) out.splitPacesFormatted = splitFmt;
  if (half) out.half = half;
  if (args.fastFinish) {
    out.fastFinish = computeFastFinish({
      splits: detail.splits,
      distanceM: detail.distanceM,
      unit,
    });
  }
  return out;
}

/** Build Long run section for a persisted week session via TempoPort. */
export async function buildRecapLongRun(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
  phase?: RecapPhase;
  goal?: RecapGoal;
  /**
   * The week's resolved knobs (goal context). Wins over phase/goal, and carries
   * the goal kind's thresholds, which phase/goal alone cannot resolve.
   */
  knobs?: RecapDepthKnobs;
  /** Full-recap mode: tempo-cli shape (no section heading, full depth). */
  tempoParity?: boolean;
}): Promise<RecapLongRunResult> {
  const { session, tempoPort } = args;
  const knobs =
    args.knobs ??
    resolveRecapDepthKnobs({
      phase: args.phase,
      goal: args.goal,
    });
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const longRunKnobs = knobs.thresholds.longRun;

  const base = {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    phase: knobs.phase,
    goal: knobs.goal,
    knobs,
  };

  // The goal has no long-run section (5k, speed, stay fit, return).
  if (!longRunKnobs.section) {
    return { ...base, included: false, reason: "not_for_goal", markdown: "" };
  }

  const window: WeekWindow = { start: session.start, end: session.end };

  const [summaries, settings] = await Promise.all([
    listAllWorkoutsInWindow(tempoPort, window),
    tempoPort.getSettings(),
  ]);
  const details = (
    await loadRecapWorkoutDetails(tempoPort, summaries)
  ).filter((d): d is TempoWorkoutDetail => d !== null);

  const picked = pickLongRunDetail({
    details,
    longestAsLongRun:
      longRunKnobs.longestRunFallback && knobs.longestAsLongRun,
  });

  if (!picked) {
    const markdown = buildLongRunMarkdown(
      undefined,
      unit,
      knobs.sections.longRun,
      { tempoParity: args.tempoParity },
    );
    return { ...base, included: false, reason: "not_eligible", markdown };
  }

  const longRun = toLongRunDetail({
    detail: picked.detail,
    selectionReason: picked.selectionReason,
    unit,
    timeZone: session.timezone,
    zones: settings.heartRateZones.zones,
    fastFinish: knobs.thresholds.fastFinish,
  });
  const markdown = buildLongRunMarkdown(
    longRun,
    unit,
    knobs.sections.longRun,
    { tempoParity: args.tempoParity },
  );

  return {
    ...base,
    included: true,
    reason: picked.selectionReason,
    longRun,
    markdown,
  };
}
