import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import {
  draftAthleteCorrection,
  loadCorrectionBase,
  writeAthleteCorrection,
  type AthleteCorrectionDraft,
} from "../dossier/athleteCorrection.js";
import {
  goalChangeMessage,
  goalSentence,
  goalSentenceProblem,
} from "../goal/sentence.js";
import { pool } from "../db.js";
import { appendGoal, getCurrentGoal, type GoalVersion } from "../goal/store.js";
import { parseTrainingGoal } from "../goal/types.js";
import { LlmNotConfiguredError, LlmSchemaError, type LlmPort } from "../llm/index.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { coachNotConfiguredBody } from "../settings/coachSetup.js";

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
 * here. The model drafts the rewrite first, with no transaction open. Then the goal row,
 * the sentence, the applied note and the coach's note message are written in one
 * transaction, so a goal change is stored whole or not at all: the goal and About you
 * never disagree, and a failed change leaves nothing in the thread.
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

    const base = await loadCorrectionBase();
    if (base) {
      const problem = goalSentenceProblem(parsed.goal);
      if (problem) return c.json({ error: problem }, 400);
    }

    let rewrite: { text: string; drafted: AthleteCorrectionDraft } | null = null;
    if (base) {
      const text = goalChangeMessage(parsed.goal);
      try {
        const drafted = await draftAthleteCorrection({
          text,
          base,
          weekSessionId: null,
          isoWeek: null,
          llmPort,
        });
        rewrite = { text, drafted };
      } catch (err) {
        if (err instanceof LlmNotConfiguredError) {
          return c.json(await coachNotConfiguredBody(), 400);
        }
        if (err instanceof LlmSchemaError) {
          return c.json({ error: err.code, message: err.message }, 502);
        }
        throw err;
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await appendGoal(clock.now(), parsed.goal, "settings", client);
      const correction = rewrite
        ? await writeAthleteCorrection(
            { ...rewrite, weekSessionId: null, clock },
            client,
          )
        : null;
      await client.query("COMMIT");
      return c.json({ ...withSentence(saved), correction }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  return routes;
}
