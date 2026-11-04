import { nextIsoWeekBounds } from "../clock/isoWeek.js";
import {
  getPrescribedWeekBySessionId,
  type PrescribedWeekRecord,
} from "../prescribed/store.js";
import { findWeekSession, type WeekSession } from "../week/store.js";

/**
 * Where the Sunday message's link goes. While the week it planned is this week
 * or next, the athlete wants the plan. After that, the reviewed week's Your week
 * page holds that week's read and plan together.
 */
export function weeklyReadLink(
  reviewed: Pick<WeekSession, "isoWeek" | "timezone">,
  now: Date,
): "plan" | "week" {
  const planWeek = nextIsoWeekBounds(reviewed.isoWeek, reviewed.timezone);
  return now.getTime() < Date.parse(planWeek.end) ? "plan" : "week";
}

/**
 * The plan behind a Sunday message: the stored plan for the week after
 * `reviewed`. Null when that plan is gone.
 */
export async function planBehindWeeklyRead(
  reviewed: Pick<WeekSession, "isoWeek" | "timezone">,
): Promise<PrescribedWeekRecord | null> {
  const planWeek = nextIsoWeekBounds(reviewed.isoWeek, reviewed.timezone);
  const session = await findWeekSession(planWeek.isoWeek, reviewed.timezone);
  if (!session) return null;
  return getPrescribedWeekBySessionId(session.id);
}

/**
 * The full read behind a Sunday message: the analysis on the plan for the week
 * after `reviewed`. Null when that plan is gone.
 */
export async function fullWeeklyRead(
  reviewed: Pick<WeekSession, "isoWeek" | "timezone">,
): Promise<string | null> {
  const plan = await planBehindWeeklyRead(reviewed);
  return plan?.analysis?.trim() || null;
}
