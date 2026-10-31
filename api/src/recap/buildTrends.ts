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

  const trends = computeRecapTrendsSnapshot({
    isoWeek: session.isoWeek,
    thisWeek,
    workouts,
  });
  const markdown = buildTrendsMarkdown(
    trends,
    unit,
    knobs.sections.trends,
    { tempoParity: args.tempoParity },
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
