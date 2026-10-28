import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { createProposalFromWeeklyReply } from "../dossier/fromWeeklyReply.js";
import {
  LlmHttpError,
  LlmNotConfiguredError,
  LlmSchemaError,
  LlmTransportError,
  type LlmPort,
  resolveWeeklyPlanWeek,
  validateWeeklyReply,
} from "../llm/index.js";
import { recordRouteRejection, type LlmCallRecorder } from "../llmCallLog/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  assembleLeanLiveContext,
  assertPacketHasNoPiiOrGps,
  rememberLastOutboundPacket,
  resolveFocusWeekSession,
  resolveRecentHistoryLimit,
  toPacketPlanWeek,
  type ModelPacket,
} from "../packet/index.js";
import {
  checkInRequiredBody,
  CHECK_IN_REQUIRED_STATUS,
  resolveCheckInPlanGate,
} from "../recap/checkInGate.js";
import {
  isValidWorkoutId,
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type TempoPort,
} from "../tempo/port.js";
import { savePrescribedWeek } from "../prescribed/store.js";
import { getWeekRecapBySessionId } from "../recap/recapStore.js";
import { createCoachMessage } from "../thread/store.js";
import { nextIsoWeekBounds } from "../clock/isoWeek.js";
import { trackReplyRun } from "../replyRun/inflight.js";
import {
  createPendingRun,
  finishRun,
  type ReplyRun,
} from "../replyRun/store.js";
import {
  ensureWeekSession,
  getWeekSessionById,
  type WeekSession,
} from "../week/store.js";

export type WeeklyReplyRouteOptions = {
  llmPort: LlmPort;
  tempoPort: TempoPort;
  clock: Clock;
  athleteTimezone: string;
  llmCallRecorder?: LlmCallRecorder;
};

type ReplyBody = {
  /** Pre-built redacted packet (skips assembly). */
  packet?: ModelPacket;
  weekSessionId?: string;
  recapMarkdown?: string | null;
  attachmentWorkoutIds?: string[];
  /** Override lean recent-history window N (#34). */
  recentHistoryLimit?: number;
  identityHints?: {
    names?: string[];
    emails?: string[];
  };
};

function tempoErrorResponse(err: unknown): Response | null {
  if (err instanceof TempoNotConfiguredError) {
    return Response.json({ error: err.code, message: err.message }, { status: 400 });
  }
  if (err instanceof TempoHttpError) {
    return Response.json(
      { error: err.code, status: err.status, message: err.message },
      { status: 502 },
    );
  }
  if (err instanceof TempoTransportError || err instanceof TempoExportError) {
    return Response.json({ error: err.code, message: err.message }, { status: 502 });
  }
  return null;
}

function safeNextWeek(isoWeek: string, timezone: string) {
  try {
    return nextIsoWeekBounds(isoWeek, timezone);
  } catch {
    return null;
  }
}

async function assemblePacket(
  body: ReplyBody,
  tempoPort: TempoPort,
  clock: Clock,
  athleteTimezone: string,
): Promise<{ packet: ModelPacket } | Response> {
  const focus = await resolveFocusWeekSession(
    clock,
    body.weekSessionId,
    athleteTimezone,
  );
  if (!focus.ok) {
    return Response.json(focus.body, { status: focus.status });
  }

  const attachmentIds = Array.isArray(body.attachmentWorkoutIds)
    ? body.attachmentWorkoutIds
    : [];
  const attachments: unknown[] = [];
  for (const rawId of attachmentIds) {
    if (typeof rawId !== "string" || !isValidWorkoutId(rawId)) {
      return Response.json({ error: "invalid_workout_id", id: rawId }, { status: 400 });
    }
    try {
      const detail = await tempoPort.getWorkout(rawId);
      if (detail) attachments.push(detail);
    } catch (err) {
      const res = tempoErrorResponse(err);
      if (res) return res;
      throw err;
    }
  }

  // Explicit recapMarkdown wins; otherwise use the focus week's stored recap
  // (which already embeds subjective answers). No stored recap -> null.
  const explicitRecap =
    typeof body.recapMarkdown === "string" && body.recapMarkdown.trim()
      ? body.recapMarkdown
      : null;
  const recapMarkdown =
    explicitRecap ??
    (await getWeekRecapBySessionId(focus.session.id))?.markdown ??
    null;

  const packet = await assembleLeanLiveContext({
    focusSession: focus.session,
    recentHistoryLimit: resolveRecentHistoryLimit(body.recentHistoryLimit),
    recapMarkdown,
    includePlanWeek: true,
    attachments,
    identityHints: body.identityHints,
  });

  assertPacketHasNoPiiOrGps(packet, {
    identityHints: body.identityHints,
    forbiddenSubstrings: [
      ...(body.identityHints?.emails ?? []),
      ...(body.identityHints?.names ?? []),
      "LineString",
      "rawGpxData",
      "rawFitData",
    ],
  });

  return { packet };
}

type Outcome = {
  status: number;
  body: Record<string, unknown>;
  /** LLM call that produced (or failed to produce) the reply, when one ran. */
  callId?: string;
};

async function outcomeFromResponse(res: Response): Promise<Outcome> {
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

type PrepareResult =
  | { ok: true; session: WeekSession }
  | { ok: false; status: number; body: Record<string, unknown> };

export type StartResult =
  | { ok: true; run: ReplyRun }
  | { ok: false; reason: "pending" | "not_found" };

/**
 * Runs the weekly reply for a reviewed week and records each execution in
 * `weekly_reply_runs`. Shared by the synchronous `POST /week/reply` and the
 * background run started when a check-in finishes or is skipped.
 */
export type ReplyRunner = {
  /** Week resolution and the check-in gate. */
  prepare(body: ReplyBody): Promise<PrepareResult>;
  /** Run to completion and record it; 409 `reply_run_pending` when one is running. */
  runNow(body: ReplyBody, session: WeekSession): Promise<Outcome>;
  /** Record a pending run and execute it without making the caller wait. */
  startInBackground(weekSessionId: string): Promise<StartResult>;
};

function failureText(outcome: Outcome): string {
  const message = outcome.body.message;
  const error = outcome.body.error;
  if (typeof message === "string" && message) return message;
  if (typeof error === "string" && error) return error;
  return `Reply failed (${outcome.status})`;
}

export function createReplyRunner(options: WeeklyReplyRouteOptions): ReplyRunner {
  const { llmPort, tempoPort, clock, athleteTimezone, llmCallRecorder } =
    options;

  async function prepare(body: ReplyBody): Promise<PrepareResult> {
    // Gate on the request's week (or current). Packet-only callers still
    // unlock against the live focus week — synthetic packet ids are ignored.
    const weekIdForGate =
      (typeof body.weekSessionId === "string" && body.weekSessionId.trim()) ||
      null;
    const focus = await resolveFocusWeekSession(
      clock,
      weekIdForGate,
      athleteTimezone,
    );
    if (!focus.ok) {
      return {
        ok: false,
        status: focus.status,
        body: focus.body as Record<string, unknown>,
      };
    }
    const checkInGate = await resolveCheckInPlanGate(focus.session.id);
    if (checkInGate.blocked) {
      return {
        ok: false,
        status: CHECK_IN_REQUIRED_STATUS,
        body: checkInRequiredBody(checkInGate) as Record<string, unknown>,
      };
    }
    return { ok: true, session: focus.session };
  }

  async function produce(
    body: ReplyBody,
    focusSession: WeekSession,
  ): Promise<Outcome> {
    let packet: ModelPacket;
    if (body.packet && typeof body.packet === "object") {
      packet = body.packet;
      // Packet-only callers: never plan the reviewed week.
      if (!packet.planWeek) {
        const reviewed = packet.week?.isoWeek?.trim();
        const planWeek = reviewed
          ? safeNextWeek(reviewed, athleteTimezone)
          : null;
        packet = {
          ...packet,
          planWeek: planWeek ?? toPacketPlanWeek(focusSession),
        };
      }
    } else {
      const assembled = await assemblePacket(
        { ...body, weekSessionId: body.weekSessionId ?? focusSession.id },
        tempoPort,
        clock,
        athleteTimezone,
      );
      if (assembled instanceof Response) {
        return outcomeFromResponse(assembled);
      }
      packet = assembled.packet;
      await rememberLastOutboundPacket(packet);
    }

    const callId = randomUUID();
    try {
      const reply = await llmPort.generateWeeklyReply(packet, {
        callId,
        weekSessionId: focusSession.id,
      });
      const weekStartMonday = resolveWeeklyPlanWeek(packet).weekStartMonday;
      const checked = validateWeeklyReply(reply, weekStartMonday);
      if (!checked.ok) {
        await recordRouteRejection(llmCallRecorder, {
          parentCallId: callId,
          operation: "weekly_reply",
          weekSessionId: focusSession.id,
          errorMessage: checked.error,
        });
        return {
          status: 502,
          body: { error: "llm_schema_invalid", message: checked.error },
          callId,
        };
      }

      // Plan lands on N+1's session; the analysis stays in N's thread.
      const reviewedSessionId =
        (typeof body.weekSessionId === "string" && body.weekSessionId.trim()) ||
        packet.week?.weekSessionId?.trim() ||
        null;

      // The note comes first so the reply's message can point at it.
      const dossierProposal = await createProposalFromWeeklyReply({
        settingsProposalBullets: checked.value.settingsProposalBullets,
        isoWeek:
          checked.value.prescribedWeek.week || packet.week?.isoWeek || null,
        at: clock.now(),
      });

      let prescribed = null;
      let coachMessage = null;
      if (reviewedSessionId) {
        const reviewed = await getWeekSessionById(reviewedSessionId);
        if (reviewed) {
          const planIso =
            packet.planWeek?.isoWeek ?? toPacketPlanWeek(reviewed).isoWeek;
          const { session: planSession } = await ensureWeekSession(
            clock.now(),
            planIso,
            reviewed.timezone,
          );
          prescribed = await savePrescribedWeek({
            weekSessionId: planSession.id,
            plan: checked.value.prescribedWeek,
            analysis: checked.value.analysis,
            settingsProposalBullets:
              checked.value.settingsProposalBullets ?? null,
            safetyCallouts: checked.value.safetyCallouts ?? null,
            readSections: { headline: checked.value.headline },
            at: clock.now(),
          });
          // The headline and a link; the full read is on the plan, not repeated here.
          coachMessage = await createCoachMessage(
            clock.now(),
            checked.value.headline,
            reviewedSessionId,
            callId,
            checked.value.safetyCallouts,
            dossierProposal?.id ?? null,
            "weekly_read",
          );
        }
      }

      return {
        status: 200,
        callId,
        body: {
          reply: checked.value,
          packetWeek: packet.week,
          prescribed,
          coachMessage,
          dossierProposal,
          planWeek: packet.planWeek ?? null,
          threadArtifact: prescribed
            ? {
                kind: "prescribed_week" as const,
                weekSessionId: prescribed.weekSessionId,
                plan: prescribed.plan,
                safetyCallouts: prescribed.safetyCallouts ?? [],
                createdAt: prescribed.createdAt,
                updatedAt: prescribed.updatedAt,
              }
            : null,
        },
      };
    } catch (err) {
      if (err instanceof LlmNotConfiguredError) {
        return { status: 400, body: { error: err.code, message: err.message }, callId };
      }
      if (err instanceof LlmHttpError) {
        return {
          status: 502,
          body: { error: err.code, status: err.status, message: err.message },
          callId,
        };
      }
      if (err instanceof LlmTransportError || err instanceof LlmSchemaError) {
        return { status: 502, body: { error: err.code, message: err.message }, callId };
      }
      throw err;
    }
  }

  async function record(run: ReplyRun, execute: () => Promise<Outcome>) {
    let outcome: Outcome;
    try {
      outcome = await execute();
    } catch (err) {
      await finishRun(run.id, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        at: clock.now(),
      }).catch(() => undefined);
      throw err;
    }
    await finishRun(run.id, {
      status: outcome.status >= 200 && outcome.status < 300 ? "ok" : "failed",
      llmCallId: outcome.callId ?? null,
      errorMessage:
        outcome.status >= 200 && outcome.status < 300
          ? null
          : failureText(outcome),
      at: clock.now(),
    });
    return outcome;
  }

  return {
    prepare,

    async runNow(body, session) {
      const run = await createPendingRun(clock.now(), session.id);
      if (!run) {
        return {
          status: 409,
          body: {
            error: "reply_run_pending",
            message: "Coach Cade is already reading this week.",
            weekSessionId: session.id,
          },
        };
      }
      return record(run, () => produce(body, session));
    },

    async startInBackground(weekSessionId) {
      const session = await getWeekSessionById(weekSessionId);
      if (!session) return { ok: false, reason: "not_found" };
      const run = await createPendingRun(clock.now(), session.id);
      if (!run) return { ok: false, reason: "pending" };

      // Not awaited: the caller answers the athlete immediately. Every failure
      // is captured into the run row, so nothing here may throw out.
      void trackReplyRun((async () => {
        try {
          const body: ReplyBody = { weekSessionId: session.id };
          await record(run, async () => {
            const prep = await prepare(body);
            if (!prep.ok) return { status: prep.status, body: prep.body };
            return produce(body, prep.session);
          });
        } catch (err) {
          console.error("weekly reply run failed", err);
        }
      })());

      return { ok: true, run };
    },
  };
}

/**
 * Weekly reply flow: ModelPacket → LlmPort → validated analysis + prescribed week.
 */
export function createWeeklyReplyRoutes(
  options: WeeklyReplyRouteOptions & { runner: ReplyRunner },
): Hono {
  const routes = new Hono();
  const { runner } = options;

  routes.use("/week/reply", requireDisclaimer);

  routes.post("/week/reply", async (c) => {
    let body: ReplyBody = {};
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = (await c.req.json()) as ReplyBody;
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
    }

    const prep = await runner.prepare(body);
    if (!prep.ok) {
      return c.json(prep.body, prep.status as 400 | 403 | 404 | 409 | 502);
    }
    const outcome = await runner.runNow(body, prep.session);
    return c.json(outcome.body, outcome.status as 200 | 400 | 409 | 502);
  });

  return routes;
}
