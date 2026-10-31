import { resolveGoalContext, type GoalContext } from "../goal/context.js";
import { getCurrentGoal } from "../goal/store.js";
import type { WeekSession } from "../week/store.js";

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
function ymdInZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/**
 * The coaching context for a week: the current goal resolved for the week's
 * Monday in the athlete's timezone. No goal stored: general fitness in base.
 */
export async function loadWeekGoalContext(
  session: WeekSession,
): Promise<GoalContext> {
  const current = await getCurrentGoal();
  return resolveGoalContext(
    current?.goal ?? null,
    ymdInZone(session.start, session.timezone),
  );
}
