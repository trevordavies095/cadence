import type { WeekSession } from "../week/store.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import { aggregateWorkouts } from "./aggregate.js";
import { resolveRecapUnit } from "./buildSummary.js";
import { listAllWorkoutsInWindow } from "./listWindow.js";
import {
  buildNotableMarkdown,
  buildRecapNotableSnapshot,
  type RecapNotableSnapshot,
} from "./notable.js";
import {
  resolveRecapDepthKnobs,
  type RecapDepthKnobs,
  type RecapGoal,
  type RecapPhase,
} from "./phase.js";
import { weeklyRecapQueryForWeek } from "./weeklyRecapParams.js";
import { priorWeekWindows, type WeekWindow } from "./weekWindows.js";

export type RecapNotableResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  phase: RecapPhase;
  goal: RecapGoal;
  knobs: ReturnType<typeof resolveRecapDepthKnobs>;
  notable: RecapNotableSnapshot;
  markdown: string;
};

/** yyyy-MM-dd of the calendar day before `date` (yyyy-MM-dd). */
function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

/** Build Notable section for a persisted week session via TempoPort. */
export async function buildRecapNotable(args: {
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
  /** Full-recap mode: omit the section when empty, never truncate bullets. */
  tempoParity?: boolean;
}): Promise<RecapNotableResult> {
  const { session, tempoPort } = args;
  const knobs =
    args.knobs ??
    resolveRecapDepthKnobs({
      phase: args.phase,
      goal: args.goal,
    });
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const thisWindow: WeekWindow = { start: session.start, end: session.end };
  const { trailing } = priorWeekWindows(thisWindow);

  const monday = weeklyRecapQueryForWeek(session.start, session.timezone)
    .referenceDate;
  const [weekWorkouts, trailingSets, shoes, bestEfforts, fromMonday] =
    await Promise.all([
      listAllWorkoutsInWindow(tempoPort, thisWindow),
      Promise.all(trailing.map((w) => listAllWorkoutsInWindow(tempoPort, w))),
      tempoPort.listShoes({ status: "all" }),
      tempoPort.getBestEfforts({ since: dayBefore(monday) }).catch(() => null),
      tempoPort.getBestEfforts({ since: monday }).catch(() => null),
    ]);

  // Tempo compares `since` with each run's UTC start date, so it is the
  // Sunday before the local Monday: a run early Monday local time east of UTC
  // starts on Sunday in UTC. Tempo also reports the latest best on or after
  // `since`. Keep only bests set by this week's own runs.
  const weekWorkoutIds = new Set(weekWorkouts.map((w) => w.id.toLowerCase()));
  // The Sunday call's "was" is the best before that Sunday, so it skips a best
  // set on the Sunday itself. The Monday call's counts it: use it for any best
  // both calls name.
  const mondayKey = (e: { distance: string; workoutId: string }) =>
    `${e.distance}|${e.workoutId.toLowerCase()}`;
  const mondayPrevious = new Map(
    (fromMonday?.distances ?? []).map((e) => [mondayKey(e), e.previousTimeS]),
  );
  const newBestEfforts = (bestEfforts?.distances ?? [])
    .filter((e) => weekWorkoutIds.has(e.workoutId.toLowerCase()))
    .map((e) =>
      mondayPrevious.has(mondayKey(e))
        ? { ...e, previousTimeS: mondayPrevious.get(mondayKey(e)) }
        : e,
    );

  const thisAgg = aggregateWorkouts(weekWorkouts);
  const trailingAggs = trailingSets.map((items) => aggregateWorkouts(items));
  const activeRe = trailingAggs
    .filter((a) => a.runCount > 0 && a.hasRelativeEffort)
    .map((a) => a.relativeEffort);
  const threeWeekAvgRelativeEffort =
    activeRe.length > 0
      ? activeRe.reduce((a, b) => a + b, 0) / activeRe.length
      : undefined;

  const notable = buildRecapNotableSnapshot({
    bestEffortsFetchOk: bestEfforts !== null,
    newBestEfforts,
    shoes,
    weekWorkouts,
    weekRelativeEffort: thisAgg.relativeEffort,
    threeWeekAvgRelativeEffort,
    unit,
  });

  const markdown = buildNotableMarkdown(notable, knobs.sections.notable, {
    tempoParity: args.tempoParity,
  });

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    phase: knobs.phase,
    goal: knobs.goal,
    knobs,
    notable,
    markdown,
  };
}
