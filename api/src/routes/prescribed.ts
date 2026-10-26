import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import { nextIsoWeekBounds } from "../clock/isoWeek.js";
import type { Clock } from "../clock/clock.js";
import { todayYmdForSession } from "../prescribed/patch.js";
import { resolveUnitPreference } from "../settings/unitPreferenceStore.js";
import type { TempoPort } from "../tempo/port.js";
import { ensureWeekSession, getWeekSessionById } from "../week/store.js";

/**
 * Read persisted prescribed week for a week session.
 */
export function createPrescribedRoutes(options: {
  tempoPort: TempoPort;
  clock: Clock;
}): Hono {
  const { tempoPort, clock } = options;
  const routes = new Hono();

  routes.use("/weeks/:weekSessionId/prescribed", requireDisclaimer);

  routes.use("/weeks/:weekSessionId/prescribed/next", requireDisclaimer);

  // Plan for the ISO week after this one (N+1). Creates N+1's session without
  // touching other weeks; `prescribed` is null until a weekly reply saves one.
  routes.get("/weeks/:weekSessionId/prescribed/next", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim();
    if (!weekSessionId) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }
    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }
    const next = nextIsoWeekBounds(session.isoWeek, session.timezone);
    const { session: weekSession } = await ensureWeekSession(
      next.isoWeek,
      session.timezone,
    );
    const prescribed = await getPrescribedWeekBySessionId(weekSession.id);
    return c.json({
      weekSession,
      prescribed: prescribed ?? null,
      unitPreference: await resolveUnitPreference(tempoPort),
      todayYmd: todayYmdForSession(clock, session.timezone),
    });
  });

  routes.get("/weeks/:weekSessionId/prescribed", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim();
    if (!weekSessionId) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }
    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }
    const prescribed = await getPrescribedWeekBySessionId(weekSessionId);
    if (!prescribed) {
      return c.json({ error: "prescribed_week_not_found" }, 404);
    }
    return c.json({
      prescribed,
      unitPreference: await resolveUnitPreference(tempoPort),
      todayYmd: todayYmdForSession(clock, session.timezone),
    });
  });

  return routes;
}
