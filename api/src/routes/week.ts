import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { resolveIsoWeek } from "../clock/isoWeek.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  getOrCreateCurrentWeekSession,
  listWeekSessions,
} from "../week/store.js";
import { composeWeekSummaries } from "../week/summaries.js";
import type { TempoPort } from "../tempo/port.js";

export function createWeekRoutes(
  clock: Clock,
  athleteTimezone: string,
  tempoPort: TempoPort,
): Hono {
  const routes = new Hono();

  /**
   * Current ISO week (Mon–Sun) for the injectable clock.
   * Optional ?timezone=IANA (default: athlete timezone). Used by future recap/session code and tests.
   */
  routes.get("/week", (c) => {
    const timezone = c.req.query("timezone")?.trim() || athleteTimezone;
    try {
      return c.json(resolveIsoWeek(clock, timezone));
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_timezone";
      return c.json({ error: "invalid_timezone", message }, 400);
    }
  });

  routes.use("/weeks", requireDisclaimer);
  routes.use("/weeks/*", requireDisclaimer);

  /**
   * List persisted week sessions, newest first, each with its local date range,
   * Tempo distance and run count, and the coach's headline for that week.
   */
  routes.get("/weeks", async (c) => {
    const sessions = await listWeekSessions();
    const { weeks, tempoUnavailable } = await composeWeekSummaries(
      sessions,
      tempoPort,
    );
    return c.json({ weeks, tempoUnavailable });
  });

  /**
   * Get-or-create the week session for the injectable clock's "now".
   * Optional ?timezone=IANA (default: athlete timezone).
   */
  routes.post("/weeks/current", async (c) => {
    const timezone = c.req.query("timezone")?.trim() || athleteTimezone;
    try {
      const { session, created } = await getOrCreateCurrentWeekSession(
        clock,
        timezone,
      );
      return c.json({ ...session, created }, created ? 201 : 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_timezone";
      return c.json({ error: "invalid_timezone", message }, 400);
    }
  });

  return routes;
}
