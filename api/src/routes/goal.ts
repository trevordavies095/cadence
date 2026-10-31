import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import {
  applyAthleteCorrection,
  loadCorrectionBase,
  type AthleteCorrectionResult,
} from "../dossier/athleteCorrection.js";
import {
  goalChangeMessage,
  goalSentence,
  goalSentenceProblem,
} from "../goal/sentence.js";
import { appendGoal, getCurrentGoal, type GoalVersion } from "../goal/store.js";
import { parseTrainingGoal } from "../goal/types.js";
import { LlmSchemaError, type LlmPort } from "../llm/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";

export type GoalRouteOptions = {
  clock: Clock;
  llmPort: LlmPort;
};

/** The stored goal plus the sentence Settings shows (null when it cannot be worded). */
function withSentence(version: GoalVersion): GoalVersion & { sentence: string | null } {
  return {
    ...version,
    sentence: goalSentenceProblem(version.goal) ? null : goalSentence(version.goal),
  };
}

/**
 * Read and replace the training goal. Replacing appends a row; nothing is updated.
 *
 * Once there is an About you to rewrite, replacing the goal also tells Coach Cade
 * "My goal is now …" through Fix something, in the same request: the sentence is written
 * here, and the goal is stored only after the correction succeeds, so the goal and
 * About you never disagree.
 */
export function createGoalRoutes(options: GoalRouteOptions): Hono {
  const { clock, llmPort } = options;
  const routes = new Hono();

  routes.use("/goal", requireDisclaimer);

  routes.get("/goal", async (c) => {
    const current = await getCurrentGoal();
    if (!current) return c.json({ error: "goal_not_found" }, 404);
    return c.json(withSentence(current));
  });

  routes.put("/goal", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const raw =
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "goal" in body
        ? (body as { goal: unknown }).goal
        : body;

    const parsed = parseTrainingGoal(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    let correction: AthleteCorrectionResult | null = null;
    const base = await loadCorrectionBase();
    if (base) {
      const problem = goalSentenceProblem(parsed.goal);
      if (problem) return c.json({ error: problem }, 400);
      try {
        correction = await applyAthleteCorrection({
          text: goalChangeMessage(parsed.goal),
          base,
          weekSessionId: null,
          isoWeek: null,
          llmPort,
          clock,
        });
      } catch (err) {
        if (err instanceof LlmSchemaError) {
          return c.json({ error: err.code, message: err.message }, 502);
        }
        throw err;
      }
    }

    const saved = await appendGoal(clock.now(), parsed.goal, "settings");
    return c.json({ ...withSentence(saved), correction }, 201);
  });

  return routes;
}
