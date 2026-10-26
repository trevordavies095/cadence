import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createDossierProposal } from "../dossier/proposals.js";
import { getCurrentDossier } from "../dossier/store.js";
import {
  formatDossierProposalThreadBody,
  LlmSchemaError,
  type LlmPort,
} from "../llm/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { buildOnboardingPrefills } from "../onboarding/prefills.js";
import { resolveOnboardingGate } from "../onboarding/gate.js";
import { parseOnboardingAnswers } from "../onboarding/questionnaire.js";
import { saveOnboardingAnswers } from "../onboarding/store.js";
import { getAnthropicConnection } from "../settings/anthropicStore.js";
import type { TempoPort } from "../tempo/port.js";
import { createCoachMessage } from "../thread/store.js";
import { getWeekSessionById } from "../week/store.js";

export type OnboardingRouteOptions = {
  tempoPort: TempoPort;
  llmPort: LlmPort;
};

export function createOnboardingRoutes(options: OnboardingRouteOptions): Hono {
  const routes = new Hono();
  const { tempoPort, llmPort } = options;

  routes.use("/onboarding", requireDisclaimer);
  routes.use("/onboarding/*", requireDisclaimer);

  /**
   * Onboarding interview gate (needs_subjective-style).
   * New athlete (no dossier, no answers) → needs_onboarding + questionnaire + Tempo hints.
   */
  routes.get("/onboarding", async (c) => {
    const gate = await resolveOnboardingGate(tempoPort);
    return c.json(gate);
  });

  /**
   * Persist structured onboarding answers, then call LlmPort for a dossier v1
   * soft-gate proposal (summary bullets + proposed body). Accept installs v1.
   */
  routes.post("/onboarding/answers", async (c) => {
    const dossier = await getCurrentDossier();
    if (dossier) {
      return c.json(
        {
          error: "onboarding_complete",
          message: "Dossier already exists; onboarding answers are locked.",
          dossierVersionId: dossier.id,
        },
        409,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const rawAnswers =
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "answers" in body
        ? (body as { answers: unknown }).answers
        : body;

    const parsed = parseOnboardingAnswers(rawAnswers);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    let weekSessionId: string | null = null;
    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "weekSessionId" in body
    ) {
      const rawWeek = (body as { weekSessionId: unknown }).weekSessionId;
      if (rawWeek !== undefined && rawWeek !== null) {
        if (typeof rawWeek !== "string" || !rawWeek.trim()) {
          return c.json({ error: "invalid_week_session_id" }, 400);
        }
        weekSessionId = rawWeek.trim();
        const session = await getWeekSessionById(weekSessionId);
        if (!session) {
          return c.json({ error: "week_session_not_found" }, 404);
        }
      }
    }

    const stored = await saveOnboardingAnswers(parsed.answers);
    const prefills = await buildOnboardingPrefills(tempoPort);
    const anthropic = await getAnthropicConnection();

    const callId = randomUUID();
    let draft;
    try {
      draft = await llmPort.generateDossierV1(
        {
          answers: stored.answers,
          prefills,
        },
        { callId, weekSessionId },
      );
    } catch (err) {
      if (err instanceof LlmSchemaError) {
        return c.json({ error: err.code, message: err.message }, 502);
      }
      throw err;
    }

    const proposal = await createDossierProposal({
      summaryBullets: draft.summaryBullets,
      proposedBody: draft.proposedBody,
      kind: "onboarding",
    });

    const coachMessage = await createCoachMessage(
      formatDossierProposalThreadBody(draft),
      weekSessionId,
      callId,
      null,
      proposal.id,
    );

    const gate = await resolveOnboardingGate(tempoPort);
    return c.json(
      {
        status: "ready" as const,
        answers: stored.answers,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        gate,
        proposal,
        coachMessage,
        llm: {
          mode: "stub" as const,
          anthropicConfigured: anthropic.configured,
          systemStance: "coach_running_no_diagnose" as const,
        },
      },
      201,
    );
  });

  return routes;
}
