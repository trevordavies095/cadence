import { getWeekRecapBySessionId } from "./recapStore.js";
import { getSubjectiveAnswers } from "./subjectiveStore.js";

/**
 * Weekly check-in disposition for plan hard-gate (#49 / #52).
 * - needed: interview still open (no answers, no durable Skip)
 * - finished: athlete completed POST /recap/subjective
 * - skipped: athlete explicitly Skip'd (durable week_recaps.subjective=skipped)
 *
 * A data-only recap while the interview is still open does not count as
 * finished or skipped — only answers or an explicit Skip unlock plan.
 */
export type CheckInStatus = "needed" | "finished" | "skipped";

/**
 * Resolve check-in status for a week session.
 * Finished wins over skipped if both somehow exist (answers are source of truth).
 */
export async function resolveCheckInStatus(
  weekSessionId: string,
): Promise<CheckInStatus> {
  const answers = await getSubjectiveAnswers(weekSessionId);
  if (answers) return "finished";

  const recap = await getWeekRecapBySessionId(weekSessionId);
  if (recap?.subjective === "skipped") return "skipped";

  return "needed";
}
