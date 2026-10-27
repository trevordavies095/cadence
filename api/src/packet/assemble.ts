import type { Clock } from "../clock/clock.js";
import { getCurrentDossier } from "../dossier/store.js";
import type { PrescribedWeek } from "../llm/types.js";
import { listThreadMessages } from "../thread/store.js";
import { fullWeeklyRead } from "../thread/weeklyRead.js";
import {
  getOrCreateCurrentWeekSession,
  getWeekSessionById,
  type WeekSession,
} from "../week/store.js";
import { buildModelPacket } from "./build.js";
import {
  filterThreadToFocusWeek,
  resolveRecentHistoryLimit,
} from "./lean.js";
import { loadRecentWeekSummaries } from "./recentHistory.js";
import { nextIsoWeekBounds } from "../clock/isoWeek.js";
import type {
  IdentityHints,
  ModelPacketPlanWeek,
  ModelPacket,
  ModelPacketWeek,
} from "./types.js";

export type AssembleLeanLiveContextInput = {
  /** Include planWeek (N+1) for the weekly reply; mid-week omits it. */
  includePlanWeek?: boolean;
  /** Focus week session (current live week for mid-week / reply). */
  focusSession: WeekSession;
  /** Optional override; else env / default (#34). */
  recentHistoryLimit?: number | null;
  /** Current-week recap markdown when already known (weekly reply / packet). */
  recapMarkdown?: string | null;
  attachments?: unknown[];
  /** Current prescribed week for mid-week patch context. */
  prescribedWeek?: PrescribedWeek | null;
  identityHints?: IdentityHints;
};

export function toPacketPlanWeek(session: WeekSession): ModelPacketPlanWeek {
  return nextIsoWeekBounds(session.isoWeek, session.timezone);
}

function toPacketWeek(session: WeekSession): ModelPacketWeek {
  return {
    isoWeek: session.isoWeek,
    start: session.start,
    end: session.end,
    weekSessionId: session.id,
  };
}

/**
 * Assemble a lean live ModelPacket for LlmPort (#34).
 *
 * Enforces: dossier + last N prior week summaries/plans + focus week thread only.
 * Prior-week mid-week chatter is never loaded into `thread`.
 */
export async function assembleLeanLiveContext(
  input: AssembleLeanLiveContextInput,
): Promise<ModelPacket> {
  const limit = resolveRecentHistoryLimit(input.recentHistoryLimit);
  const focusId = input.focusSession.id;

  const [dossier, recentHistory, threadMessages] = await Promise.all([
    getCurrentDossier(),
    loadRecentWeekSummaries({ focusWeekSessionId: focusId, limit }),
    listThreadMessages(focusId),
  ]);

  // Defense in depth: even if listThreadMessages were widened, drop other weeks.
  const leanThread = filterThreadToFocusWeek(threadMessages, focusId);

  // The athlete sees one paragraph of the Sunday read in the conversation; the
  // model gets the whole read behind the latest one, so a Sunday-evening question
  // about the new plan is answered with its reasoning in view.
  const lastRead = leanThread.map((m) => m.kind).lastIndexOf("weekly_read");
  const fullRead =
    lastRead >= 0 ? await fullWeeklyRead(input.focusSession) : null;

  return buildModelPacket({
    dossier: dossier
      ? { versionId: dossier.id, body: dossier.body }
      : null,
    recapMarkdown: input.recapMarkdown ?? null,
    thread: leanThread.map((m, i) => ({
      role: m.role,
      body: i === lastRead && fullRead ? fullRead : m.body,
      createdAt: m.createdAt,
      weekSessionId: m.weekSessionId,
    })),
    attachments: input.attachments,
    week: toPacketWeek(input.focusSession),
    planWeek: input.includePlanWeek
      ? toPacketPlanWeek(input.focusSession)
      : undefined,
    prescribedWeek: input.prescribedWeek,
    recentHistory,
    recentHistoryLimit: limit,
    identityHints: input.identityHints,
  });
}

/**
 * Resolve the focus week session for live packet assembly.
 * Explicit id → load; else get-or-create current (archives prior weeks).
 */
export async function resolveFocusWeekSession(
  clock: Clock,
  weekSessionId: string | null | undefined,
  timezone: string,
): Promise<
  | { ok: true; session: WeekSession }
  | { ok: false; status: 400 | 404; body: Record<string, unknown> }
> {
  const id = weekSessionId?.trim();
  if (id) {
    const session = await getWeekSessionById(id);
    if (!session) {
      return {
        ok: false,
        status: 404,
        body: { error: "week_session_not_found" },
      };
    }
    return { ok: true, session };
  }
  try {
    const { session } = await getOrCreateCurrentWeekSession(
      clock,
      timezone,
    );
    return { ok: true, session };
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_timezone";
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_timezone", message },
    };
  }
}
