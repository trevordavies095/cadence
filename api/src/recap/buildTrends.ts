import type { WeekSession } from "../week/store.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import { resolveRecapUnit } from "./buildSummary.js";
import { listAllWorkoutsInWindow } from "./listWindow.js";
import {
  resolveRecapDepthKnobs,
  type RecapDepthKnobs,
  type RecapGoal,
  type RecapPhase,
} from "./phase.js";
import {
  buildTrendsMarkdown,
  computeRecapTrendsSnapshot,
  trendsFetchWindow,
  type RecapTrendsSnapshot,
} from "./trends.js";
import type { WeekWindow } from "./weekWindows.js";

export type RecapTrendsResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  phase: RecapPhase;
  goal: RecapGoal;
  knobs: ReturnType<typeof resolveRecapDepthKnobs>;
  trends: RecapTrendsSnapshot;
  markdown: string;
};

/**
 * The long-run distance trend carries a verdict only for half and marathon in
 * base or build; other goals show the four values alone.
 */
function withoutLongRunVerdict(
  snapshot: RecapTrendsSnapshot,
): RecapTrendsSnapshot {
  if (!snapshot.verdicts) return snapshot;
  const { longRunDistance: _dropped, ...verdicts } = snapshot.verdicts;
  return { ...snapshot, verdicts };
}

/** Build Trends section for a persisted week session via TempoPort. */
export async function buildRecapTrends(args: {
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
  /** Full-recap mode: markdown exactly as tempo-cli (verdicts, omit when empty). */
  tempoParity?: boolean;
}): Promise<RecapTrendsResult> {
  const { session, tempoPort } = args;
  const knobs =
    args.knobs ??
    resolveRecapDepthKnobs({
      phase: args.phase,
      goal: args.goal,
    });
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const thisWeek: WeekWindow = { start: session.start, end: session.end };
  const fetchWin = trendsFetchWindow(thisWeek);

  const workouts = await listAllWorkoutsInWindow(tempoPort, fetchWin);

  const snapshot = computeRecapTrendsSnapshot({
    isoWeek: session.isoWeek,
    thisWeek,
    workouts,
    unit,
  });
  const trends = knobs.thresholds.longRun.distanceTrendVerdict
    ? snapshot
    : withoutLongRunVerdict(snapshot);
  const markdown = buildTrendsMarkdown(
    trends,
    unit,
    knobs.sections.trends,
    {
      tempoParity: args.tempoParity,
      longRunSection: knobs.thresholds.longRun.section,
    },
  );

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    phase: knobs.phase,
    goal: knobs.goal,
    knobs,
    trends,
    markdown,
  };
}
