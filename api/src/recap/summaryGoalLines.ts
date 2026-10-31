/**
 * The goal's lines on the summary (ticket 13): hard minutes, quality sessions,
 * threshold minutes (ticket 16), run time and longest run, chosen by the knobs table (goalKnobs.ts).
 */
import type {
  TempoUnitPreference,
  TempoWeeklyRecapStats,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import type { RecapThresholdKnobs } from "./goalKnobs.js";
import { isQualityFamily, isRace } from "./runTypes.js";

const METERS_PER_MILE = 1609.344;

export type SummaryGoalLineId =
  | "hardMinutes"
  | "qualitySessions"
  | "thresholdMinutes"
  | "runTime"
  | "longestRun"
  | "hardMinutesAboveZero"
  | "noHardMinutes";

export type SummaryGoalLine = {
  id: SummaryGoalLineId;
  /** "Hard minutes (zones 4 and 5)"; for a statement line, the whole sentence. */
  label: string;
  /** "22 min, up 8"; null for a statement line. */
  value: string | null;
  /** The goal leads the summary with this number. */
  headline: boolean;
  /** A line Coach Cade wants the athlete to notice (a return athlete's hard minutes). */
  flag: boolean;
};

/** "36 min", "1 h 12 min", "4 h" (rounded to the minute). */
export function formatMinutesDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function formatDistanceOneDecimal(
  meters: number,
  unit: TempoUnitPreference,
): string {
  return unit === "imperial"
    ? `${(meters / METERS_PER_MILE).toFixed(1)} mi`
    : `${(meters / 1000).toFixed(1)} km`;
}

function weekdayShort(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(
    new Date(iso),
  );
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Moving time, else elapsed. */
function runSeconds(w: TempoWorkoutSummary): number {
  if (finite(w.movingTimeS) && w.movingTimeS > 0) return w.movingTimeS;
  return finite(w.durationS) ? w.durationS : 0;
}

/** Z4 + Z5 seconds for one column of the weekly recap; undefined when a bucket is null. */
function hardSeconds(
  stats: TempoWeeklyRecapStats | null,
  column: "current" | "previous",
): number | undefined {
  const z4 = stats?.zoneSecondsZ4?.[column];
  const z5 = stats?.zoneSecondsZ5?.[column];
  if (!finite(z4) || !finite(z5) || z4 < 0 || z5 < 0) return undefined;
  return z4 + z5;
}

export function buildSummaryGoalLines(args: {
  thresholds: RecapThresholdKnobs;
  /** The week's runs. */
  workouts: readonly TempoWorkoutSummary[];
  stats: TempoWeeklyRecapStats | null;
  unit: TempoUnitPreference;
  timezone: string;
  /**
   * The week's seconds near the athlete-set threshold (thresholdMinutes.ts).
   * Undefined when no threshold is set in the running log: no line.
   */
  thresholdSeconds?: number;
}): SummaryGoalLine[] {
  const { thresholds: k, workouts, stats, unit, timezone } = args;
  const headline = new Set(k.headline);
  const lines: SummaryGoalLine[] = [];
  const statements: SummaryGoalLine[] = [];

  if (headline.has("runMinutes")) {
    const fromLog = stats?.movingTimeS?.current;
    const seconds = finite(fromLog)
      ? fromLog
      : workouts.reduce((sum, w) => sum + runSeconds(w), 0);
    lines.push({
      id: "runTime",
      label: "Run time",
      value: `${formatMinutesDuration(seconds)} moving`,
      headline: true,
      flag: false,
    });
  }

  if (headline.has("longestRunDuration") && workouts.length > 0) {
    const fromLog = stats?.longestRunDurationS?.current;
    const seconds =
      finite(fromLog) && fromLog > 0
        ? fromLog
        : Math.max(...workouts.map(runSeconds));
    lines.push({
      id: "longestRun",
      label: "Longest run",
      value: formatMinutesDuration(seconds),
      headline: true,
      flag: false,
    });
  }

  if (k.hardMinutes.shown) {
    const current = hardSeconds(stats, "current");
    let value = "not available (no heart-rate data)";
    if (current !== undefined) {
      const minutes = Math.round(current / 60);
      value = `${minutes} min`;
      const previous = hardSeconds(stats, "previous");
      if (previous !== undefined) {
        const delta = minutes - Math.round(previous / 60);
        value +=
          delta > 0
            ? `, up ${delta}`
            : delta < 0
              ? `, down ${-delta}`
              : ", same as last week";
      }
      if (k.hardMinutes.flagAboveZero && minutes > 0) {
        statements.push({
          id: "hardMinutesAboveZero",
          label: "Hard minutes above zero this week",
          value: null,
          headline: false,
          flag: true,
        });
      }
      if (k.hardMinutes.presenceCheck && minutes === 0) {
        statements.push({
          id: "noHardMinutes",
          label: "No hard minutes this week",
          value: null,
          headline: false,
          flag: false,
        });
      }
    }
    const line: SummaryGoalLine = {
      id: "hardMinutes",
      label: "Hard minutes (zones 4 and 5)",
      value,
      headline: headline.has("hardMinutes"),
      flag: false,
    };
    if (line.headline) lines.unshift(line);
    else lines.push(line);
  }

  if (k.hardMinutes.qualitySessionCount) {
    const count = workouts.filter(
      (w) => isQualityFamily(w.runType) || isRace(w.runType),
    ).length;
    lines.push({
      id: "qualitySessions",
      label: "Quality sessions",
      value: String(count),
      headline: false,
      flag: false,
    });
  }

  if (k.thresholdMinutes && finite(args.thresholdSeconds)) {
    lines.push({
      id: "thresholdMinutes",
      label: "Threshold minutes",
      value: `${Math.max(0, Math.round(args.thresholdSeconds / 60))} min`,
      headline: false,
      flag: false,
    });
  }

  if (k.longRun.summaryLine && workouts.length > 0) {
    const longest = workouts.reduce((best, w) =>
      (finite(w.distanceM) ? w.distanceM : 0) >
      (finite(best.distanceM) ? best.distanceM : 0)
        ? w
        : best,
    );
    if (finite(longest.distanceM) && longest.distanceM > 0) {
      lines.push({
        id: "longestRun",
        label: "Longest run",
        value: `${formatDistanceOneDecimal(longest.distanceM, unit)} (${weekdayShort(longest.startedAt, timezone)})`,
        headline: false,
        flag: false,
      });
    }
  }

  return [...lines, ...statements];
}

/** Markdown bullets for the summary; empty when the goal adds no lines. */
export function buildSummaryGoalLinesMarkdown(
  lines: readonly SummaryGoalLine[],
): string {
  return lines
    .map((l) => (l.value === null ? `- ${l.label}` : `- ${l.label}: ${l.value}`))
    .join("\n");
}
