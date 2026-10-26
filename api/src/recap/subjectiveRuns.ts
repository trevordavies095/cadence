import { listAllWorkoutsInWindow } from "./listWindow.js";
import type { TempoPort, TempoUnitPreference, TempoWorkoutSummary } from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import { resolveRecapUnit } from "./buildSummary.js";
import { formatDistanceM, formatDuration } from "./format.js";
import type { WeekWindow } from "./weekWindows.js";

/** Compact run row for needs_subjective gate (tempo-cli MCP shape). */
export type NeedsSubjectiveRun = {
  id: string;
  date: string | null;
  runType: string | null;
  distance: string | null;
  duration: string | null;
  /** Raw distance and time, so a screen can word them in the athlete's own units. */
  distanceM: number | null;
  durationS: number | null;
  apiRpe: number | null;
};

/** Local calendar date YYYY-MM-DD in the week session timezone. */
export function workoutLocalDate(
  startedAt: string,
  timeZoneId: string,
): string | null {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZoneId,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

export function toNeedsSubjectiveRun(
  summary: TempoWorkoutSummary,
  timeZoneId: string,
  unit: TempoUnitPreference,
): NeedsSubjectiveRun {
  const date = workoutLocalDate(summary.startedAt, timeZoneId);
  const runType =
    typeof summary.runType === "string" && summary.runType.trim()
      ? summary.runType.trim()
      : null;
  const distance =
    Number.isFinite(summary.distanceM) && summary.distanceM >= 0
      ? formatDistanceM(summary.distanceM, unit)
      : null;
  const duration =
    Number.isFinite(summary.durationS) && summary.durationS >= 0
      ? formatDuration(summary.durationS)
      : null;
  const apiRpe =
    typeof summary.rpe === "number" && Number.isFinite(summary.rpe)
      ? Math.round(summary.rpe)
      : null;

  return {
    id: summary.id,
    date,
    runType,
    distance,
    duration,
    distanceM: Number.isFinite(summary.distanceM) ? summary.distanceM : null,
    durationS: Number.isFinite(summary.durationS) ? summary.durationS : null,
    apiRpe,
  };
}

/** Compact week runs for the needs_subjective questionnaire (list only — no detail fetch). */
export async function buildNeedsSubjectiveRuns(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
}): Promise<{
  runs: NeedsSubjectiveRun[];
  unit: TempoUnitPreference;
  localRange: { start: string; end: string };
}> {
  const { session, tempoPort } = args;
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const window: WeekWindow = { start: session.start, end: session.end };
  const summaries = await listAllWorkoutsInWindow(tempoPort, window);

  const runs = summaries
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.startedAt).getTime();
      const tb = new Date(b.startedAt).getTime();
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    })
    .map((s) => toNeedsSubjectiveRun(s, session.timezone, unit));

  // Local Mon–Sun labels from session timezone (en-CA YYYY-MM-DD).
  const localStart = workoutLocalDate(session.start, session.timezone);
  const localEnd = workoutLocalDate(session.end, session.timezone);

  return {
    runs,
    unit,
    localRange: {
      start: localStart ?? session.start.slice(0, 10),
      end: localEnd ?? session.end.slice(0, 10),
    },
  };
}
