import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { appendGoal, getCurrentGoal } from "../goal/store.js";
import { parseTrainingGoal } from "../goal/types.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";

export type GoalRouteOptions = {
  clock: Clock;
};

/** Read and replace the training goal. Replacing appends a row; nothing is updated. */
export function createGoalRoutes(options: GoalRouteOptions): Hono {
  const { clock } = options;
  const routes = new Hono();

  routes.use("/goal", requireDisclaimer);

  routes.get("/goal", async (c) => {
    const current = await getCurrentGoal();
    if (!current) return c.json({ error: "goal_not_found" }, 404);
    return c.json(current);
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

    const saved = await appendGoal(clock.now(), parsed.goal, "settings");
    return c.json(saved, 201);
  });

  return routes;
}
