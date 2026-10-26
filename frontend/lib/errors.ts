/**
 * Turns anything thrown while talking to the API into a sentence the athlete
 * can act on. Raw JSON and error codes never reach the screen directly: known
 * codes get their own sentence, unknown ones get a generic sentence with the
 * technical text kept behind a "Details" disclosure.
 */

/** Thrown for any non-2xx API response that is not one of the special gates. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly apiMessage: string | null;
  readonly raw: string;

  constructor(status: number, raw: string) {
    let code: string | null = null;
    let apiMessage: string | null = null;
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string") apiMessage = body.message;
    } catch {
      // Not JSON (for example a proxy error page).
    }
    super(apiMessage ?? code ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.apiMessage = apiMessage;
    this.raw = raw;
  }
}

export type UiError = string | { message: string; details?: string };

export const GENERIC_ERROR =
  "Something went wrong. Try again, and if it keeps happening, ask whoever set up the app.";

const COACH_UNAVAILABLE =
  "Coach Cade couldn’t reply just now. Try again in a minute.";
const LOG_UNAVAILABLE =
  "Couldn’t reach your running log. Try again in a minute.";
const CHECK_YOUR_ANSWER =
  "That didn’t look right. Check what you entered and try again.";

const BY_CODE: Record<string, string> = {
  week_archived:
    "This week has ended. Open this week’s chat to keep talking.",
  check_in_required:
    "Finish or skip this week’s check-in first, then ask for the plan.",
  reply_run_pending:
    "Coach Cade is already reading your week. Check back in a couple of minutes.",
  nothing_to_restore: "There is nothing earlier to go back to.",
  not_applied: "That change was already handled.",
  llm_not_configured:
    "Coach Cade isn’t connected yet. Add the Anthropic key in Settings.",
  llm_http_error: COACH_UNAVAILABLE,
  llm_transport_error: COACH_UNAVAILABLE,
  llm_schema_invalid: COACH_UNAVAILABLE,
  tempo_not_configured:
    "Your running log isn’t connected yet. Connect Tempo in Settings.",
  tempo_http_error: LOG_UNAVAILABLE,
  tempo_transport_error: LOG_UNAVAILABLE,
  tempo_export_error: LOG_UNAVAILABLE,
  tempo_error: LOG_UNAVAILABLE,
  invalid_timezone:
    "The time zone setting isn’t valid. Ask whoever set up the app to check it.",
  disclaimer_required: "Please accept the product disclaimer first.",
  week_session_not_found: "We couldn’t find that week.",
  prescribed_week_not_found: "There is no plan for that week yet.",
  workout_not_found: "We couldn’t find that run in your running log.",
  attachment_invalid: "That run can’t be attached because it is missing details.",
  body_required: "Write something first.",
  dossier_required:
    "Coach Cade needs your answers to the first questions before doing that.",
  onboarding_complete: "Your first questions are already answered.",
  not_pending: "That change was already handled.",
  audit_not_due: "There is nothing to tidy up yet.",
  recap_failed: "Couldn’t build your weekly report. Try again in a minute.",
  encrypt_failed:
    "Couldn’t save that securely. Ask whoever set up the app to check the server settings.",
  goal_required: "Tell Coach Cade what you are training for.",
  schedule_required: "Tell Coach Cade which days you can run.",
};

function isValidationCode(code: string): boolean {
  return /^invalid_/.test(code) || /_required$/.test(code);
}

function isNetworkFailure(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /fetch|network|load failed/i.test(err.message)
  );
}

/**
 * @param fallback Sentence to use when the cause is unknown, in context
 *   (for example "Couldn’t save your settings. Try again.").
 */
export function describeError(err: unknown, fallback?: string): UiError {
  if (err instanceof ApiError) {
    if (err.code && BY_CODE[err.code]) return BY_CODE[err.code];
    if (err.code && isValidationCode(err.code)) return CHECK_YOUR_ANSWER;
    if (err.status === 502 || err.status === 503 || err.status === 504) {
      return "Can’t reach Coach Cade right now. Check the connection and try again.";
    }
    return {
      message: fallback ?? GENERIC_ERROR,
      details: `${err.status}${err.code ? ` ${err.code}` : ""}${
        err.apiMessage ? `: ${err.apiMessage}` : ""
      }`,
    };
  }
  if (isNetworkFailure(err)) {
    return "Can’t reach Coach Cade right now. Check the connection and try again.";
  }
  const name = err instanceof Error ? err.name : "";
  // The gate errors carry their own code on the instance.
  const gateCode =
    err instanceof Error && "error" in err && typeof err.error === "string"
      ? err.error
      : null;
  if (gateCode && BY_CODE[gateCode]) return BY_CODE[gateCode];
  return {
    message: fallback ?? GENERIC_ERROR,
    details: err instanceof Error ? `${name ? `${name}: ` : ""}${err.message}` : String(err),
  };
}

/**
 * True when a send may well have worked even though no answer came back: the
 * connection dropped, or a proxy gave up on a slow reply. A real answer from the
 * API, with a reason, is never "still running".
 */
export function mayStillBeRunning(err: unknown): boolean {
  if (isNetworkFailure(err)) return true;
  return (
    err instanceof ApiError &&
    !err.code &&
    (err.status === 502 || err.status === 503 || err.status === 504)
  );
}

export function uiErrorMessage(error: UiError): string {
  return typeof error === "string" ? error : error.message;
}
