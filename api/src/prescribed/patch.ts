import type { Clock } from "../clock/clock.js";
import { localCalendarDateYmd } from "../clock/isoWeek.js";
import type { PrescribedDay, PrescribedWeek } from "../llm/types.js";

export type ApplyPrescribedDayPatchesResult = {
  plan: PrescribedWeek;
  /** Dates that were replaced. */
  appliedDates: string[];
  /** Past-day patch dates skipped (stable unless allowPastDayPatches). */
  skippedPastDates: string[];
  /** Patch dates not present on the current plan. */
  unknownDates: string[];
};

/**
 * Remaining-day rule (#38): a plan day is patchable when
 * `date >= todayYmd` (today + future in the session timezone).
 * Past days (`date < todayYmd`) stay stable unless `allowPastDayPatches`.
 */
export function isPrescribedDayPatchable(
  dayDateYmd: string,
  todayYmd: string,
  allowPastDayPatches = false,
): boolean {
  if (allowPastDayPatches) return true;
  return dayDateYmd >= todayYmd;
}

export function todayYmdForSession(
  clock: Clock,
  timezone: string,
): string {
  return localCalendarDateYmd(clock, timezone);
}

/**
 * Merge structured day patches into a persisted prescribed week.
 * Unknown dates are ignored; past dates are skipped unless allowed.
 */
export function applyPrescribedDayPatches(
  plan: PrescribedWeek,
  patches: PrescribedDay[],
  options: {
    todayYmd: string;
    allowPastDayPatches?: boolean;
  },
): ApplyPrescribedDayPatchesResult {
  const allowPast = options.allowPastDayPatches === true;
  const byDate = new Map(plan.days.map((d) => [d.date, d]));
  const appliedDates: string[] = [];
  const skippedPastDates: string[] = [];
  const unknownDates: string[] = [];

  for (const patch of patches) {
    if (!byDate.has(patch.date)) {
      unknownDates.push(patch.date);
      continue;
    }
    if (!isPrescribedDayPatchable(patch.date, options.todayYmd, allowPast)) {
      skippedPastDates.push(patch.date);
      continue;
    }
    byDate.set(patch.date, patch);
    appliedDates.push(patch.date);
  }

  return {
    plan: {
      week: plan.week,
      days: plan.days.map((d) => byDate.get(d.date) ?? d),
    },
    appliedDates,
    skippedPastDates,
    unknownDates,
  };
}
