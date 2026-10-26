import { resolveCheckInStatus, type CheckInStatus } from "./checkInStatus.js";

export const CHECK_IN_REQUIRED_ERROR = "check_in_required" as const;
export const CHECK_IN_REQUIRED_STATUS = 409 as const;

const CHECK_IN_REQUIRED_MESSAGE =
  "Finish or skip this week’s check-in before requesting a plan.";

export type CheckInRequiredBody = {
  error: typeof CHECK_IN_REQUIRED_ERROR;
  message: string;
  checkInStatus: "needed";
  weekSessionId: string;
};

export type CheckInGate =
  | { blocked: false; checkInStatus: Exclude<CheckInStatus, "needed"> }
  | {
      blocked: true;
      error: typeof CHECK_IN_REQUIRED_ERROR;
      message: string;
      checkInStatus: "needed";
      weekSessionId: string;
    };

/**
 * Plan hard-gate (#52): POST /week/reply unlocks only when check-in is
 * finished or explicitly skipped. Data-only while the interview is still
 * open does not unlock.
 */
export async function resolveCheckInPlanGate(
  weekSessionId: string,
): Promise<CheckInGate> {
  const checkInStatus = await resolveCheckInStatus(weekSessionId);
  if (checkInStatus === "needed") {
    return {
      blocked: true,
      error: CHECK_IN_REQUIRED_ERROR,
      message: CHECK_IN_REQUIRED_MESSAGE,
      checkInStatus: "needed",
      weekSessionId,
    };
  }
  return { blocked: false, checkInStatus };
}

/** JSON body for a check-in-required 409 (plan hard-gate). */
export function checkInRequiredBody(
  gate: Extract<CheckInGate, { blocked: true }>,
): CheckInRequiredBody {
  return {
    error: gate.error,
    message: gate.message,
    checkInStatus: gate.checkInStatus,
    weekSessionId: gate.weekSessionId,
  };
}
