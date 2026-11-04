import { isoWeekMondayDate } from "../clock/isoWeek.js";
import { expectedPlanDates } from "../llm/schema.js";
import type { PrescribedWeek } from "../llm/types.js";
import {
  loadActualDistanceByDate,
  planDayOutcomes,
} from "../prescribed/dayOutcomes.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import type { TempoPort } from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import type { ModelPacketDayOutcome } from "./types.js";

/**
 * The plan the reviewed week was meant to follow and what happened on each
 * of its days, for the weekly read's packet (coaching-quality 01, #59). Both
 * null when the week has no stored plan.
 */
export type ReviewedWeekPlan = {
  prescribedWeek: PrescribedWeek | null;
  prescribedWeekOutcomes: ModelPacketDayOutcome[] | null;
};

/** The calendar day after a YYYY-MM-DD date. */
function dayAfter(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Read the reviewed week's stored plan and grade each day against the running
 * log, with the same helper Home uses. The week is read as finished: today is
 * taken as the day after its Sunday, so a planned run with nothing recorded is
 * missed, never today or upcoming. A running-log failure leaves planned days
 * unknown rather than blocking the read.
 */
export async function loadReviewedWeekPlan(
  session: WeekSession,
  tempoPort: TempoPort,
): Promise<ReviewedWeekPlan> {
  const record = await getPrescribedWeekBySessionId(session.id);
  if (!record) return { prescribedWeek: null, prescribedWeekOutcomes: null };

  const dates = expectedPlanDates(isoWeekMondayDate(session.isoWeek));
  const actualByDate = await loadActualDistanceByDate(
    tempoPort,
    { start: session.start, end: session.end },
    session.timezone,
  );
  const outcomes = planDayOutcomes({
    dates,
    days: record.plan.days,
    actualDistanceByDate: actualByDate,
    todayYmd: dayAfter(dates[6]!),
  }).map((day): ModelPacketDayOutcome => {
    if (day.state === "today" || day.state === "upcoming") {
      // Every date is before the day after the week's Sunday.
      throw new Error(`reviewed day ${day.date} graded as ${day.state}`);
    }
    return {
      date: day.date,
      state: day.state,
      actualDistanceM: day.actualDistanceM,
    };
  });
  return { prescribedWeek: record.plan, prescribedWeekOutcomes: outcomes };
}
