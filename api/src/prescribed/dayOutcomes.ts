import type { PrescribedDay } from "../llm/types.js";
import { listAllWorkoutsInWindow } from "../recap/listWindow.js";
import type { TempoPort } from "../tempo/port.js";

/**
 * What happened on a day of a plan, as Home shows it and as the Sunday packet
 * reports it. One helper for both, so they never disagree.
 */
export type PlanDayState =
  | "done"
  | "today"
  | "upcoming"
  | "rest"
  | "missed"
  /** A past day with a planned run while the running log could not be read. */
  | "unknown"
  /**
   * A day Coach Cade wrote that Cadence could not read, or a date the plan
   * left out. Nothing is planned on it, so it is never missed.
   */
  | "not_filed";

export type PlanDayOutcome = {
  date: string;
  /** The stored day for the date; null when the plan has no day for it or there is no plan. */
  planned: PrescribedDay | null;
  /**
   * False when Cadence could not read the day's structure from Coach Cade's
   * line, or the plan gave no line for the date. True for every other day,
   * including old stored plans without the field and weeks with no plan.
   */
  parsed: boolean;
  plannedDistanceM: number | null;
  /** Planned duration in seconds, when the day's run was prescribed by time. */
  plannedDurationS: number | null;
  /** Distance the running log recorded on this local date; null when it could not be read. */
  actualDistanceM: number | null;
  state: PlanDayState;
  isToday: boolean;
};

/** Local calendar date of an instant in a timezone, as YYYY-MM-DD. */
export function ymdInZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/**
 * The outcome of each date against the plan's days and the distance run on
 * it. Pure. `actualDistanceByDate` null means the running log could not be
 * read: a past planned run is then unknown rather than missed, and every
 * actual distance is null. A date after `todayYmd` is upcoming; `todayYmd`
 * itself is today unless something was run on it.
 */
export function planDayOutcomes(input: {
  dates: readonly string[];
  days: readonly PrescribedDay[] | null | undefined;
  actualDistanceByDate: ReadonlyMap<string, number> | null;
  todayYmd: string;
}): PlanDayOutcome[] {
  const planByDate = new Map<string, PrescribedDay>(
    (input.days ?? []).map((d) => [d.date, d]),
  );
  const actualByDate = input.actualDistanceByDate;
  const { todayYmd } = input;

  return input.dates.map((date) => {
    const planned = planByDate.get(date) ?? null;
    // Absent reads as parsed: plans stored before plans were text.
    const parsed = planned?.parsed !== false;
    // An unread day has nothing planned, whatever it carries.
    const plannedRunSpec = parsed ? planned?.run : null;
    const plannedDistanceM = plannedRunSpec?.distanceM ?? null;
    const durationS = plannedRunSpec?.durationS;
    const plannedDurationS =
      typeof durationS === "number" && durationS > 0 ? durationS : null;
    const plannedRun = plannedDistanceM != null;
    const actual = actualByDate === null ? null : (actualByDate.get(date) ?? 0);
    const isToday = date === todayYmd;

    let state: PlanDayState;
    if (actual != null && actual > 0) state = "done";
    else if (!parsed) state = "not_filed";
    else if (isToday) state = "today";
    else if (date < todayYmd) {
      if (!plannedRun) state = "rest";
      else state = actual == null ? "unknown" : "missed";
    } else state = plannedRun || !planned ? "upcoming" : "rest";

    return {
      date,
      planned,
      parsed,
      plannedDistanceM,
      plannedDurationS,
      actualDistanceM: actual,
      state,
      isToday,
    };
  });
}

/**
 * Distance run per local date inside a window, from the running log. Null
 * when the log could not be read, so the caller degrades to the plan alone.
 */
export async function loadActualDistanceByDate(
  tempoPort: TempoPort,
  window: { start: string; end: string },
  timezone: string,
): Promise<Map<string, number> | null> {
  try {
    const workouts = await listAllWorkoutsInWindow(tempoPort, window);
    const actualByDate = new Map<string, number>();
    for (const w of workouts) {
      const ymd = ymdInZone(w.startedAt, timezone);
      actualByDate.set(ymd, (actualByDate.get(ymd) ?? 0) + w.distanceM);
    }
    return actualByDate;
  } catch {
    return null;
  }
}
