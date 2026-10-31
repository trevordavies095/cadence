import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import {
  applyAthleteCorrection,
  loadCorrectionBase,
} from "../dossier/athleteCorrection.js";
import { LlmSchemaError, type LlmPort } from "../llm/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { getWeekSessionById } from "../week/store.js";

export type DossierCorrectionRouteOptions = {
  llmPort: LlmPort;
  clock: Clock;
};

/**
 * Athlete fix/add request → LLM dossier rewrite → applied proposal (#18, #102).
 * Posts athlete + coach summary to the thread; the change can be undone.
 */
export function createDossierCorrectionRoutes(
  options: DossierCorrectionRouteOptions,
): Hono {
  const routes = new Hono();
  const { llmPort, clock } = options;

  routes.use("/dossier/corrections", requireDisclaimer);

  routes.post("/dossier/corrections", async (c) => {
    // With no profile yet, a correction fixes the first draft that is waiting.
    const base = await loadCorrectionBase();
    if (!base) {
      return c.json(
        {
          error: "dossier_required",
          message:
            "A current dossier is required before athlete corrections can rewrite it.",
        },
        409,
      );
    }

    let body: { body?: unknown; weekSessionId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) {
      return c.json({ error: "body_required" }, 400);
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

    try {
      const result = await applyAthleteCorrection({
        text,
        base,
        weekSessionId,
        isoWeek,
        llmPort,
        clock,
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof LlmSchemaError) {
        return c.json({ error: err.code, message: err.message }, 502);
      }
      throw err;
    }
  });

  return routes;
}
