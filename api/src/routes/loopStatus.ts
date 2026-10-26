import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { resolveLoopStatus } from "../loop/status.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";

/**
 * Single read for the This week dashboard state machine (#46).
 * Optional ?timezone=IANA (default: athlete timezone).
 */
export function createLoopStatusRoutes(
  clock: Clock,
  athleteTimezone: string,
): Hono {
  const routes = new Hono();

  routes.use("/loop-status", requireDisclaimer);

  routes.get("/loop-status", async (c) => {
    const timezone = c.req.query("timezone")?.trim() || athleteTimezone;
    try {
      const status = await resolveLoopStatus(clock, timezone);
      return c.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_timezone";
      return c.json({ error: "invalid_timezone", message }, 400);
    }
  });

  return routes;
}
