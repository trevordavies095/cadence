import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { composeHome } from "../home/compose.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import type { RuntimeSources } from "../settings/sources.js";
import type { TempoPort } from "../tempo/port.js";

/** One read for Home: banner, today's session, the week strip and totals. */
export function createHomeRoutes(options: {
  clock: Clock;
  athleteTimezone: string;
  tempoPort: TempoPort;
  sources: RuntimeSources;
}): Hono {
  const routes = new Hono();
  routes.use("/home", requireDisclaimer);
  routes.get("/home", async (c) => c.json(await composeHome(options)));
  return routes;
}
