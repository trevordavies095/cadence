/**
 * Lean live model context (#34 / user story 36).
 *
 * Live LLM packets are assembled as:
 *   1. Current dossier (redacted)
 *   2. Small fixed recent history — last N prior weeks' recap/plan summaries only
 *   3. Current focus week thread only
 *
 * Archived mid-week chatter is never stuffed into live model context. Prior weeks
 * contribute only their durable summaries/plans within the N window. N is
 * configurable via `PACKET_RECENT_HISTORY_LIMIT` (sane default below).
 */

/** Default number of prior week summaries/plans included in live packets. */
export const DEFAULT_RECENT_HISTORY_LIMIT = 4;

const ENV_KEY = "PACKET_RECENT_HISTORY_LIMIT";

/**
 * Resolve the recent-history window size.
 * Prefer an explicit override, then env, then the sane default.
 * Non-finite / negative values fall back to the default.
 */
export function resolveRecentHistoryLimit(override?: number | null): number {
  if (
    typeof override === "number" &&
    Number.isFinite(override) &&
    override >= 0
  ) {
    return Math.floor(override);
  }
  const raw = process.env[ENV_KEY]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_RECENT_HISTORY_LIMIT;
}

/**
 * Keep only messages belonging to the focus week session.
 * Enforces the lean rule: archived / other-week mid-week chatter stays out.
 */
export function filterThreadToFocusWeek<
  T extends { weekSessionId?: string | null },
>(messages: T[], focusWeekSessionId: string): T[] {
  return messages.filter((m) => m.weekSessionId === focusWeekSessionId);
}
