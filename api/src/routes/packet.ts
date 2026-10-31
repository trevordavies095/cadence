import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  assembleLeanLiveContext,
  assertPacketHasNoPiiOrGps,
  resolveFocusWeekSession,
  resolveRecentHistoryLimit,
  saveLastOutboundPacket,
  type ModelPacket,
} from "../packet/index.js";
import {
  isValidWorkoutId,
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type TempoPort,
} from "../tempo/port.js";

export type PacketRouteOptions = {
  tempoPort: TempoPort;
  clock: Clock;
  athleteTimezone: string;
};

type AssembleBody = {
  weekSessionId?: string;
  recapMarkdown?: string | null;
  attachmentWorkoutIds?: string[];
  /** Override lean recent-history window N (#34). */
  recentHistoryLimit?: number;
  /** Optional identity hints for free-text scrubbing (tests / future profile). */
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

/**
 * Week-loop seam: assemble the lean redacted model packet LlmPort will receive.
 * Lean rule (#34): current dossier + last N prior week summaries/plans +
 * focus-week thread only (archived mid-week chatter excluded).
 */
export function createPacketRoutes(options: PacketRouteOptions): Hono {
  const routes = new Hono();
  const { tempoPort, clock, athleteTimezone } = options;

  routes.use("/packet", requireDisclaimer);
  routes.use("/packet/*", requireDisclaimer);

  routes.post("/packet", async (c) => {
    let body: AssembleBody = {};
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = (await c.req.json()) as AssembleBody;
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
    }

    const focus = await resolveFocusWeekSession(
      clock,
      body.weekSessionId,
      athleteTimezone,
    );
    if (!focus.ok) {
      return c.json(focus.body, focus.status);
    }

    const attachmentIds = Array.isArray(body.attachmentWorkoutIds)
      ? body.attachmentWorkoutIds
      : [];
    const attachments: unknown[] = [];
    for (const rawId of attachmentIds) {
      if (typeof rawId !== "string" || !isValidWorkoutId(rawId)) {
        return c.json({ error: "invalid_workout_id", id: rawId }, 400);
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

    const packet: ModelPacket = await assembleLeanLiveContext({
      focusSession: focus.session,
      recentHistoryLimit: resolveRecentHistoryLimit(body.recentHistoryLimit),
      recapMarkdown: body.recapMarkdown ?? null,
      attachments,
      identityHints: body.identityHints,
      tempoPort,
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

    // Persist redacted outbound packet for settings/privacy transparency (#42).
    // Same store seam LlmPort should call once model sends are wired.
    const lastPacket = await saveLastOutboundPacket(packet);

    return c.json({ packet, lastPacket });
  });

  return routes;
}
