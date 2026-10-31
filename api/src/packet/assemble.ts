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
import { isoWeekMondayDate, nextIsoWeekBounds } from "../clock/isoWeek.js";
import { resolveGoalContext } from "../goal/context.js";
import { getCurrentGoal } from "../goal/store.js";
import type { TrainingGoal } from "../goal/types.js";
import { resolveConfiguredMaxHr } from "../recap/maxHr.js";
import type { TempoAthleteSettings, TempoPort } from "../tempo/port.js";
import type {
  IdentityHints,
  ModelPacketCoaching,
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
  /**
   * Source of the athlete settings behind the coaching block's thresholds and
   * max heart rate. Omitted, or failing, leaves those fields unset.
   */
  tempoPort?: Pick<TempoPort, "getSettings">;
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
 * The packet's coaching block for the week starting `weekMonday`, or null with
 * no goal stored. With athlete settings it also carries the running log's
 * thresholds and max heart rate.
 */
export function packetCoaching(
  goal: TrainingGoal | null,
  weekMonday: string,
  settings?: TempoAthleteSettings | null,
): ModelPacketCoaching | null {
  if (!goal) return null;
  const context = resolveGoalContext(goal, weekMonday);
  const coaching: ModelPacketCoaching = { phase: context.phase };
  if (context.weeksToRace !== null) coaching.weeksToRace = context.weeksToRace;
  if (context.racePassed) coaching.racePassed = true;
  if (settings) Object.assign(coaching, settingsCoaching(settings));
  return coaching;
}

function settingsCoaching(
  settings: TempoAthleteSettings,
): Partial<ModelPacketCoaching> {
  const out: Partial<ModelPacketCoaching> = {
    unitPreference: settings.unitPreference,
  };
  const t = settings.thresholds;
  if (t) {
    if (t.thresholdPaceS !== null) out.thresholdPaceS = t.thresholdPaceS;
    if (t.thresholdHeartRateBpm !== null) {
      out.thresholdHeartRateBpm = t.thresholdHeartRateBpm;
    }
    if (t.suggestedThresholdPaceS !== null) {
      out.suggestedThresholdPaceS = t.suggestedThresholdPaceS;
      if (t.suggestedFrom) {
        out.suggestedThresholdFrom = {
          distance: t.suggestedFrom.distance,
          timeS: t.suggestedFrom.timeS,
          workoutDate: t.suggestedFrom.workoutDate,
        };
      }
    }
  }
  const maxHr = resolveConfiguredMaxHr(settings.heartRateZones);
  if (maxHr !== undefined) out.maxHeartRateBpm = maxHr;
  const observed = settings.heartRateZones.observedMaxHeartRateBpm;
  if (typeof observed === "number" && observed > 0) {
    out.observedMaxHeartRateBpm = Math.round(observed);
  }
  return out;
}

/** Athlete settings for the coaching block; null when unavailable. */
async function loadCoachingSettings(
  port: Pick<TempoPort, "getSettings"> | undefined,
): Promise<TempoAthleteSettings | null> {
  if (!port) return null;
  try {
    return await port.getSettings();
  } catch {
    // Thresholds are context, not a precondition: a Tempo hiccup must not
    // block the reply.
    return null;
  }
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

  // With no goal the coaching block is null, so the settings are not fetched.
  const goalAndSettings = getCurrentGoal().then(async (current) => {
    const goal = current?.goal ?? null;
    return {
      goal,
      settings: goal ? await loadCoachingSettings(input.tempoPort) : null,
    };
  });
  const [dossier, recentHistory, threadMessages, { goal, settings }] =
    await Promise.all([
      getCurrentDossier(),
      loadRecentWeekSummaries({ focusWeekSessionId: focusId, limit }),
      listThreadMessages(focusId),
      goalAndSettings,
    ]);
  const planWeek = input.includePlanWeek
    ? toPacketPlanWeek(input.focusSession)
    : undefined;
  // The weekly read prescribes N+1, so its coaching block is for that week;
  // the conversation stays on the focus week.
  const coaching = packetCoaching(
    goal,
    planWeek?.startDate ?? isoWeekMondayDate(input.focusSession.isoWeek),
    settings,
  );

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
    planWeek,
    prescribedWeek: input.prescribedWeek,
    recentHistory,
    recentHistoryLimit: limit,
    identityHints: input.identityHints,
    goal,
    coaching,
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
