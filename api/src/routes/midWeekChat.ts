import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { resolveIsoWeek } from "../clock/isoWeek.js";
import {
  DEFAULT_AUDIT_INTERVAL_WEEKS,
  getDossierAuditMeta,
  isDossierAuditRequest,
} from "../dossier/auditMeta.js";
import { createProposalFromAudit } from "../dossier/fromAudit.js";
import { createProposalFromMidWeekChat } from "../dossier/fromMidWeekChat.js";
import { getCurrentDossier } from "../dossier/store.js";
import {
  formatDossierAuditThreadBody,
  LlmHttpError,
  LlmNotConfiguredError,
  LlmSchemaError,
  LlmTransportError,
  resolvePlanWeekStartMonday,
  validateMidWeekChatReply,
  type LlmPort,
  type SafetyCallout,
} from "../llm/index.js";
import { recordRouteRejection, type LlmCallRecorder } from "../llmCallLog/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  assembleLeanLiveContext,
  assertPacketHasNoPiiOrGps,
  rememberLastOutboundPacket,
  toAttachment,
  type ModelPacketAttachment,
} from "../packet/index.js";
import {
  applyPrescribedDayPatches,
  todayYmdForSession,
} from "../prescribed/patch.js";
import {
  getPrescribedWeekBySessionId,
  savePrescribedWeek,
  type PrescribedWeekRecord,
} from "../prescribed/store.js";
import {
  isValidWorkoutId,
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type TempoPort,
} from "../tempo/port.js";
import {
  createAthleteMessage,
  createCoachMessage,
  deleteThreadMessage,
  listThreadMessages,
} from "../thread/store.js";
import { getWeekSessionById, type WeekSession } from "../week/store.js";
import type { PrescribedWeekArtifact } from "./thread.js";

export type MidWeekChatRouteOptions = {
  llmPort: LlmPort;
  tempoPort: TempoPort;
  clock: Clock;
  llmCallRecorder?: LlmCallRecorder;
};

/**
 * A week is writable for mid-week chat only while it is live (not archived)
 * and still the clock's current ISO week (+ session timezone). Starting the
 * next week session sets archived_at on prior weeks (#33).
 */
export function isWeekWritableForMidWeekChat(
  session: WeekSession,
  clock: Clock,
): boolean {
  if (session.archived) return false;
  const current = resolveIsoWeek(clock, session.timezone);
  return session.isoWeek === current.isoWeek;
}

function tempoErrorResponse(err: unknown): Response | null {
  if (err instanceof TempoNotConfiguredError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: 400 },
    );
  }
  if (err instanceof TempoHttpError) {
    return Response.json(
      { error: err.code, status: err.status, message: err.message },
      { status: 502 },
    );
  }
  if (err instanceof TempoTransportError || err instanceof TempoExportError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: 502 },
    );
  }
  return null;
}

function collectThreadAttachments(
  messages: Array<{ attachment: ModelPacketAttachment | null }>,
): ModelPacketAttachment[] {
  const out: ModelPacketAttachment[] = [];
  for (const m of messages) {
    if (m.attachment) out.push(m.attachment);
  }
  return out;
}

function toPrescribedArtifact(
  record: PrescribedWeekRecord,
): PrescribedWeekArtifact {
  return {
    kind: "prescribed_week",
    weekSessionId: record.weekSessionId,
    plan: record.plan,
    safetyCallouts: (record.safetyCallouts ?? []) as SafetyCallout[],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Mid-week free chat: athlete message (+ optional Tempo workout attach) →
 * lean redacted packet → LlmPort → coach reply (attach feedback + optional
 * remaining-day plan patches) on the current week thread.
 */
export function createMidWeekChatRoutes(
  options: MidWeekChatRouteOptions,
): Hono {
  const routes = new Hono();
  const { llmPort, tempoPort, clock, llmCallRecorder } = options;

  routes.use("/weeks/:weekSessionId/chat", requireDisclaimer);

  routes.post("/weeks/:weekSessionId/chat", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim();
    if (!weekSessionId) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    if (!isWeekWritableForMidWeekChat(session, clock)) {
      return c.json(
        {
          error: "week_archived",
          message: "Mid-week chat is only writable on the current week session.",
          weekSessionId: session.id,
          isoWeek: session.isoWeek,
        },
        409,
      );
    }

    let body: { body?: unknown; attachmentWorkoutId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) {
      return c.json({ error: "body_required" }, 400);
    }

    let attachment: ModelPacketAttachment | null = null;
    const rawAttachId = body.attachmentWorkoutId;
    if (rawAttachId !== undefined && rawAttachId !== null) {
      if (typeof rawAttachId !== "string" || !isValidWorkoutId(rawAttachId)) {
        return c.json({ error: "invalid_workout_id", id: rawAttachId }, 400);
      }
      try {
        const detail = await tempoPort.getWorkout(rawAttachId.trim());
        if (!detail) {
          return c.json({ error: "workout_not_found", id: rawAttachId }, 404);
        }
        attachment = toAttachment(detail);
        if (!attachment) {
          return c.json(
            {
              error: "attachment_invalid",
              message: "Workout lacks coaching summary fields.",
            },
            422,
          );
        }
        assertPacketHasNoPiiOrGps(
          {
            dossier: null,
            recapMarkdown: null,
            thread: [],
            attachments: [attachment],
            week: null,
          },
          {
            forbiddenSubstrings: ["LineString", "rawGpxData", "rawFitData"],
          },
        );
      } catch (err) {
        const res = tempoErrorResponse(err);
        if (res) return res;
        throw err;
      }
    }

    const athleteMessage = await createAthleteMessage(
      clock.now(),
      text,
      session.id,
      attachment,
    );

    // A reply that fails takes the athlete's message with it, so a resend
    // is the only copy (#5).
    let answered = false;
    try {
      // Ask-in-chat dossier audit/trim (#40 / US-38) — same soft-gate Accept UX.
      if (isDossierAuditRequest(text)) {
        const current = await getCurrentDossier();
        if (!current) {
          return c.json(
            {
              error: "dossier_required",
              message:
                "A current dossier is required before an audit/trim proposal can be created.",
            },
            409,
          );
        }
        try {
          const now = clock.now();
          const auditMeta = await getDossierAuditMeta(now);
          const draft = await llmPort.generateDossierAudit({
            currentDossier: { versionId: current.id, body: current.body },
            week: { isoWeek: session.isoWeek },
            nowIso: now.toISOString(),
            intervalWeeks:
              auditMeta.intervalWeeks || DEFAULT_AUDIT_INTERVAL_WEEKS,
          });
          const dossierProposal = await createProposalFromAudit({
            summaryBullets: draft.summaryBullets,
            proposedBody: draft.proposedBody,
            at: clock.now(),
          });
          const coachMessage = await createCoachMessage(
            clock.now(),
            formatDossierAuditThreadBody(draft),
            session.id,
            null,
            null,
            dossierProposal.id,
          );
          answered = true;
          const existingPrescribed = await getPrescribedWeekBySessionId(
            session.id,
          );
          return c.json(
            {
              athleteMessage,
              coachMessage,
              safetyCallouts: [],
              dossierProposal,
              prescribed: existingPrescribed,
              threadArtifact: existingPrescribed
                ? toPrescribedArtifact(existingPrescribed)
                : null,
              weekSessionId: session.id,
              audit: auditMeta,
              triggeredBy: "ask_in_chat",
            },
            201,
          );
        } catch (err) {
          if (err instanceof LlmSchemaError) {
            return c.json({ error: err.code, message: err.message }, 502);
          }
          throw err;
        }
      }

      // Reload thread after athlete message so the lean packet includes it.
      const thread = await listThreadMessages(session.id);
      const attachments = collectThreadAttachments(thread);
      const existingPrescribed = await getPrescribedWeekBySessionId(session.id);

      // Lean live context (#34): dossier + last N summaries/plans + this week only.
      const packet = await assembleLeanLiveContext({
        focusSession: session,
        recapMarkdown: null,
        attachments,
        prescribedWeek: existingPrescribed?.plan ?? null,
      });
      assertPacketHasNoPiiOrGps(packet, {
        forbiddenSubstrings: ["LineString", "rawGpxData", "rawFitData"],
      });
      await rememberLastOutboundPacket(packet);

      try {
        const callId = randomUUID();
        const rawReply = await llmPort.generateMidWeekChatReply(packet, {
          callId,
          weekSessionId: session.id,
        });
        const weekStartMonday = resolvePlanWeekStartMonday(packet);
        const checked = validateMidWeekChatReply(rawReply, weekStartMonday);
        if (!checked.ok) {
          await recordRouteRejection(llmCallRecorder, {
            parentCallId: callId,
            operation: "mid_week_chat",
            weekSessionId: session.id,
            errorMessage: checked.error,
          });
          return c.json(
            { error: "llm_schema_invalid", message: checked.error },
            502,
          );
        }
        const reply = checked.value;
        const coachBody = reply.body?.trim() ?? "";
        if (!coachBody) {
          await recordRouteRejection(llmCallRecorder, {
            parentCallId: callId,
            operation: "mid_week_chat",
            weekSessionId: session.id,
            errorMessage: "mid_week_chat_body_empty",
          });
          return c.json(
            { error: "llm_schema_invalid", message: "mid_week_chat_body_empty" },
            502,
          );
        }
        // The note comes first so the reply's message can point at it.
        const dossierProposal = await createProposalFromMidWeekChat({
          settingsProposalBullets: reply.settingsProposalBullets,
          isoWeek: session.isoWeek,
          at: clock.now(),
        });
        // Work out which days actually change (past days stay put) before the
        // message is written, so it can carry them as a card.
        const patches = reply.prescribedDayPatches ?? [];
        const applied =
          patches.length > 0 && existingPrescribed
            ? applyPrescribedDayPatches(existingPrescribed.plan, patches, {
                todayYmd: todayYmdForSession(clock, session.timezone),
                allowPastDayPatches: reply.allowPastDayPatches === true,
              })
            : null;
        const changedDays = applied
          ? applied.plan.days.filter((d) => applied.appliedDates.includes(d.date))
          : [];

        const coachMessage = await createCoachMessage(
          clock.now(),
          coachBody,
          session.id,
          callId,
          reply.safetyCallouts,
          dossierProposal?.id ?? null,
          "chat",
          changedDays,
        );
        answered = true;

        let prescribed: PrescribedWeekRecord | null = existingPrescribed;
        let threadArtifact: PrescribedWeekArtifact | null = existingPrescribed
          ? toPrescribedArtifact(existingPrescribed)
          : null;
        if (applied && existingPrescribed) {
          if (applied.appliedDates.length > 0) {
            prescribed = await savePrescribedWeek({
              weekSessionId: session.id,
              plan: applied.plan,
              analysis: existingPrescribed.analysis,
              settingsProposalBullets:
                existingPrescribed.settingsProposalBullets,
              safetyCallouts: existingPrescribed.safetyCallouts,
              readSections: existingPrescribed.readSections,
              at: clock.now(),
            });
            threadArtifact = toPrescribedArtifact(prescribed);
          }
        }

        return c.json(
          {
            athleteMessage,
            coachMessage,
            safetyCallouts: reply.safetyCallouts ?? [],
            dossierProposal,
            prescribed,
            threadArtifact,
            weekSessionId: session.id,
          },
          201,
        );
      } catch (err) {
        if (err instanceof LlmNotConfiguredError) {
          return c.json({ error: err.code, message: err.message }, 400);
        }
        if (err instanceof LlmHttpError) {
          return c.json(
            { error: err.code, status: err.status, message: err.message },
            502,
          );
        }
        if (err instanceof LlmTransportError) {
          return c.json({ error: err.code, message: err.message }, 502);
        }
        if (err instanceof LlmSchemaError) {
          return c.json({ error: err.code, message: err.message }, 502);
        }
        throw err;
      }
    } finally {
      if (!answered) {
        await deleteThreadMessage(athleteMessage.id).catch((err) => {
          console.error("[mid-week-chat] unanswered message not removed", err);
        });
      }
    }
  });

  return routes;
}
