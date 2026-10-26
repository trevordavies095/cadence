import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import {
  DEFAULT_AUDIT_INTERVAL_WEEKS,
  getDossierAuditMeta,
  isDossierAuditRequest,
} from "../dossier/auditMeta.js";
import { createProposalFromAudit } from "../dossier/fromAudit.js";
import { getCurrentDossier } from "../dossier/store.js";
import {
  formatDossierAuditThreadBody,
  LlmSchemaError,
  type LlmPort,
} from "../llm/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  createAthleteMessage,
  createCoachMessage,
} from "../thread/store.js";
import { getWeekSessionById } from "../week/store.js";

export type DossierAuditRouteOptions = {
  llmPort: LlmPort;
  clock: Clock;
};

/**
 * Coach-initiated (cadence) dossier audit/trim → soft-gate proposal (#40).
 * Athlete ask-in-chat is handled on mid-week chat when the note matches
 * {@link isDossierAuditRequest}; this route is the scheduled/force path.
 */
export function createDossierAuditRoutes(
  options: DossierAuditRouteOptions,
): Hono {
  const routes = new Hono();
  const { llmPort, clock } = options;

  routes.use("/dossier/audits", requireDisclaimer);
  routes.use("/dossier/audit", requireDisclaimer);

  routes.get("/dossier/audit", async (c) => {
    const audit = await getDossierAuditMeta(clock.now());
    return c.json({ audit });
  });

  routes.post("/dossier/audits", async (c) => {
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

    let body: { force?: unknown; weekSessionId?: unknown } = {};
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
    }

    const force = body.force === true;
    const now = clock.now();
    const audit = await getDossierAuditMeta(now);
    if (!force && !audit.due) {
      return c.json(
        {
          error: "audit_not_due",
          message:
            "Dossier audit is not due yet. Pass force: true to create a proposal anyway.",
          audit,
        },
        409,
      );
    }

    let weekSessionId: string | null = null;
    let isoWeek: string | null = null;
    if (body.weekSessionId !== undefined && body.weekSessionId !== null) {
      if (typeof body.weekSessionId !== "string" || !body.weekSessionId.trim()) {
        return c.json({ error: "invalid_week_session_id" }, 400);
      }
      weekSessionId = body.weekSessionId.trim();
      const session = await getWeekSessionById(weekSessionId);
      if (!session) {
        return c.json({ error: "week_session_not_found" }, 404);
      }
      isoWeek = session.isoWeek;
    }

    const callId = randomUUID();
    let draft;
    try {
      draft = await llmPort.generateDossierAudit(
        {
          currentDossier: { versionId: current.id, body: current.body },
          week: isoWeek ? { isoWeek } : null,
          nowIso: now.toISOString(),
          intervalWeeks: audit.intervalWeeks || DEFAULT_AUDIT_INTERVAL_WEEKS,
        },
        { callId, weekSessionId },
      );
    } catch (err) {
      if (err instanceof LlmSchemaError) {
        return c.json({ error: err.code, message: err.message }, 502);
      }
      throw err;
    }

    const dossierProposal = await createProposalFromAudit({
      summaryBullets: draft.summaryBullets,
      proposedBody: draft.proposedBody,
    });

    const coachMessage = await createCoachMessage(
      formatDossierAuditThreadBody(draft),
      weekSessionId,
      callId,
      null,
      dossierProposal.id,
    );

    return c.json(
      {
        coachMessage,
        dossierProposal,
        dossierVersionId: current.id,
        audit,
        triggeredBy: force ? "force" : "cadence",
      },
      201,
    );
  });

  return routes;
}

export { isDossierAuditRequest };
