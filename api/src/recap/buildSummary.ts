import { listAllWorkoutsInWindow } from "./listWindow.js";
import type {
  TempoAthleteSettings,
  TempoPort,
  TempoUnitPreference,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import type { RecapDepthKnobs } from "./phase.js";
import { aggregateWorkouts, type WeekAggregate } from "./aggregate.js";
import {
  buildSummaryComparison,
  buildSummaryComparisonFromStats,
  type SummaryComparison,
} from "./compare.js";
import {
  buildSummaryMarkdown,
  buildSummaryTableRows,
  type RecapSummaryTableRow,
} from "./format.js";
import {
  fetchWeeklyRecapStats,
  type SharedWeeklyRecapStats,
} from "./fetchWeeklyRecapStats.js";
import {
  buildSummaryGoalLines,
  buildSummaryGoalLinesMarkdown,
  type SummaryGoalLine,
} from "./summaryGoalLines.js";
import {
  hasAthleteThreshold,
  thresholdSecondsForWeek,
  type AthleteThresholds,
} from "./thresholdMinutes.js";
import { loadRecapWorkoutDetails } from "./workoutDetails.js";
import { priorWeekWindows, type WeekWindow } from "./weekWindows.js";

export type RecapSummaryResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  thisWeek: WeekAggregate;
  comparison: SummaryComparison;
  /** Where prev / 3-wk columns came from: Tempo stats or the week windows. */
  comparisonSource: "weekly-recap" | "windows";
  rows: RecapSummaryTableRow[];
  /** The goal's lines (hard minutes, quality sessions, run time, longest run); [] without knobs. */
  goalLines: SummaryGoalLine[];
  markdown: string;
};

type PortWithOptionalSettings = TempoPort & {
  getExportSettings?: () => Promise<unknown>;
};

/** getSettings when the port has it; null when absent or failing. */
async function readSettings(
  port: TempoPort,
): Promise<TempoAthleteSettings | null> {
  if (typeof port.getSettings !== "function") return null;
  try {
    return (await port.getSettings()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve display units without requiring unfinished TempoPort settings methods.
 * Prefer getSettings (or the settings already read) when present; else export
 * settings; else metric.
 */
export async function resolveRecapUnit(
  port: TempoPort,
  /** Settings already read by the caller; read here when omitted. */
  settings?: TempoAthleteSettings | null,
): Promise<TempoUnitPreference> {
  const p = port as PortWithOptionalSettings;
  const s = settings !== undefined ? settings : await readSettings(port);
  if (s?.unitPreference === "imperial" || s?.unitPreference === "metric") {
    return s.unitPreference;
  }
  if (typeof p.getExportSettings === "function") {
    try {
      const raw = await p.getExportSettings();
      if (raw && typeof raw === "object" && "unitPreference" in raw) {
        const u = (raw as { unitPreference: unknown }).unitPreference;
        if (u === "imperial" || u === "metric") return u;
      }
    } catch {
      // fall through
    }
  }
  return "metric";
}

/** The athlete-set threshold pace and heart rate; null when neither is set. */
function athleteThresholds(
  settings: TempoAthleteSettings | null,
): AthleteThresholds | null {
  const t = settings?.thresholds;
  if (!t) return null;
  const out = { paceS: t.thresholdPaceS, heartRateBpm: t.thresholdHeartRateBpm };
  return hasAthleteThreshold(out) ? out : null;
}

/**
 * The week's seconds near the athlete-set threshold, from each run's series.
 * Undefined when no threshold is set (the line is then absent).
 */
async function weekThresholdSeconds(
  port: TempoPort,
  settings: TempoAthleteSettings | null,
  workouts: readonly TempoWorkoutSummary[],
): Promise<number | undefined> {
  const thresholds = athleteThresholds(settings);
  if (!thresholds) return undefined;
  if (workouts.length === 0) return 0;
  const details = await loadRecapWorkoutDetails(port, workouts);
  return thresholdSecondsForWeek(
    details.map((d) => d?.timeSeries),
    thresholds,
  );
}

/** Build Summary section for a persisted week session via TempoPort. */
export async function buildRecapSummary(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
  /** The report's one weekly-recap fetch; fetched here when omitted. */
  weeklyStats?: SharedWeeklyRecapStats;
  /** The week's resolved knobs (goal context); the summary's goal lines read these. */
  knobs?: RecapDepthKnobs;
}): Promise<RecapSummaryResult> {
  const { session, tempoPort } = args;
  const wantsThresholds = args.knobs?.thresholds.thresholdMinutes === true;
  // One settings read serves both the units and the athlete-set thresholds.
  const settings =
    args.unit === undefined || wantsThresholds
      ? await readSettings(tempoPort)
      : null;
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort, settings));
  const thisWindow: WeekWindow = { start: session.start, end: session.end };
  const { prev, trailing } = priorWeekWindows(thisWindow);

  // Prev / 3-wk columns: Tempo GET /stats/weekly-recap when the port offers it
  // and it answers; otherwise computed from the (instant-filtered) windows.
  const statsPromise =
    args.weeklyStats ?? fetchWeeklyRecapStats(tempoPort, session);
  const [thisItems, stats] = await Promise.all([
    listAllWorkoutsInWindow(tempoPort, thisWindow),
    statsPromise,
  ]);
  const thisWeek = aggregateWorkouts(thisItems);

  let comparison: SummaryComparison;
  let comparisonSource: "weekly-recap" | "windows";
  if (stats) {
    comparison = buildSummaryComparisonFromStats({ thisWeek, stats });
    comparisonSource = "weekly-recap";
  } else {
    const [prevItems, ...trailingItemSets] = await Promise.all([
      listAllWorkoutsInWindow(tempoPort, prev),
      ...trailing.map((w) => listAllWorkoutsInWindow(tempoPort, w)),
    ]);
    comparison = buildSummaryComparison({
      thisWeek,
      prevWeek: aggregateWorkouts(prevItems),
      trailingWeeks: trailingItemSets.map((items) => aggregateWorkouts(items)),
    });
    comparisonSource = "windows";
  }
  const rows = buildSummaryTableRows({ thisWeek, comparison, unit });
  // Only the goals that show the line pay for the series fetch.
  const thresholdSeconds = wantsThresholds
    ? await weekThresholdSeconds(tempoPort, settings, thisItems)
    : undefined;
  const goalLines = args.knobs
    ? buildSummaryGoalLines({
        thresholds: args.knobs.thresholds,
        workouts: thisItems,
        stats,
        unit,
        timezone: session.timezone,
        thresholdSeconds,
      })
    : [];
  const markdown = buildSummaryMarkdown(
    rows,
    buildSummaryGoalLinesMarkdown(goalLines),
  );

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    thisWeek,
    comparison,
    comparisonSource,
    rows,
    goalLines,
    markdown,
  };
}
