import type { PrescribedWeek } from "../llm/types.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import type {
  TempoPort,
  TempoUnitPreference,
  TempoWorkoutDetail,
} from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import { resolveRecapUnit } from "./buildSummary.js";
import { gradeLongRun } from "./grading/longRunGrade.js";
import { normalizeIsoWeekId } from "./grading/match.js";
import { gradeQualitySessions } from "./grading/qualitySessions.js";
import type { RecapGradingResult } from "./grading/types.js";
import { listAllWorkoutsInWindow } from "./listWindow.js";
import type { WeekWindow } from "./weekWindows.js";

function emptyResult(): RecapGradingResult {
  return {
    included: false,
    weekMismatch: false,
    quality: [],
    longRun: null,
    qualityMarkdown: "",
    longRunGradeMarkdown: "",
  };
}

/**
 * Pure grading from an in-memory plan + workouts (unit-test seam).
 */
export function gradePrescribedVsActual(args: {
  plan: PrescribedWeek;
  workouts: readonly TempoWorkoutDetail[];
  timeZoneId: string;
  unit: TempoUnitPreference;
  resolvedIsoWeek: string;
}): RecapGradingResult {
  const quality = gradeQualitySessions(args);
  const longRun = gradeLongRun(args);
  const included =
    quality.sessions.length > 0 || longRun.grade !== null;
  if (!included) return emptyResult();

  return {
    included: true,
    weekMismatch:
      normalizeIsoWeekId(args.plan.week) !==
      normalizeIsoWeekId(args.resolvedIsoWeek),
    quality: quality.sessions,
    longRun: longRun.grade,
    qualityMarkdown: quality.markdown,
    longRunGradeMarkdown: longRun.markdown,
  };
}

/**
 * Load persisted prescribed week for the session and grade vs TempoPort actuals.
 * Missing prescribed → empty sections (omitted gracefully).
 */
export async function buildRecapGrading(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
  /** Override plan (tests); otherwise loaded from prescribed_weeks. */
  plan?: PrescribedWeek | null;
}): Promise<RecapGradingResult> {
  const { session, tempoPort } = args;
  const plan =
    args.plan !== undefined
      ? args.plan
      : (await getPrescribedWeekBySessionId(session.id))?.plan ?? null;

  if (!plan) return emptyResult();

  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const window: WeekWindow = { start: session.start, end: session.end };
  const summaries = await listAllWorkoutsInWindow(tempoPort, window);
  const workouts = (
    await Promise.all(summaries.map((s) => tempoPort.getWorkout(s.id)))
  ).filter((d): d is TempoWorkoutDetail => d !== null);

  return gradePrescribedVsActual({
    plan,
    workouts,
    timeZoneId: session.timezone,
    unit,
    resolvedIsoWeek: session.isoWeek,
  });
}
