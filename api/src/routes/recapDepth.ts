import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { buildRecapLongRun } from "../recap/buildLongRun.js";
import { buildRecapNotable } from "../recap/buildNotable.js";
import { buildRecapSkeleton } from "../recap/buildSkeleton.js";
import { buildRecapTrends } from "../recap/buildTrends.js";
import {
  parseRecapGoal,
  parseRecapPhase,
  type RecapGoal,
  type RecapPhase,
} from "../recap/phase.js";
import {
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type TempoPort,
  type TempoUnitPreference,
} from "../tempo/port.js";
import { getWeekSessionById } from "../week/store.js";

export type RecapDepthRouteOptions = {
  tempoPort: TempoPort;
};

const WEEK_SESSION_ID_RE =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function mapPortError(err: unknown): {
  status: 400 | 404 | 500 | 502;
  body: Record<string, unknown>;
} {
  if (err instanceof TempoNotConfiguredError) {
    return { status: 400, body: { error: err.code, message: err.message } };
  }
  if (err instanceof TempoExportError) {
    return { status: 500, body: { error: err.code, message: err.message } };
  }
  if (err instanceof TempoHttpError) {
    const status = err.status === 404 ? 404 : err.status >= 500 ? 502 : 400;
    return {
      status,
      body: { error: err.code, message: err.message, status: err.status },
    };
  }
  if (err instanceof TempoTransportError) {
    return { status: 502, body: { error: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : "recap_failed";
  return { status: 500, body: { error: "recap_failed", message } };
}

function parseUnit(
  raw: string | undefined,
): TempoUnitPreference | undefined | "invalid" {
  if (raw === undefined || raw.trim() === "") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "imperial" || t === "metric") return t;
  return "invalid";
}

type PhaseGoalParse =
  | { ok: true; phase?: RecapPhase; goal?: RecapGoal }
  | { ok: false; error: string };

function parsePhaseGoal(c: {
  req: { query: (k: string) => string | undefined };
}): PhaseGoalParse {
  const phaseParsed = parseRecapPhase(c.req.query("phase"));
  if (phaseParsed === "invalid") return { ok: false, error: "invalid_phase" };
  const goalParsed = parseRecapGoal(c.req.query("goal"));
  if (goalParsed === "invalid") return { ok: false, error: "invalid_goal" };
  return {
    ok: true,
    phase: phaseParsed,
    goal: goalParsed,
  };
}

/**
 * Long-run / trends / notable / skeleton routes (issue #22).
 * Separate from summary/zones/run-by-run so parallel subjective work can append elsewhere.
 */
export function createRecapDepthRoutes(options: RecapDepthRouteOptions): Hono {
  const { tempoPort } = options;
  const routes = new Hono();

  routes.use("/weeks/*/recap/*", requireDisclaimer);
  routes.use("/weeks/*/recap", requireDisclaimer);

  routes.get("/weeks/:weekSessionId/recap/long-run", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }

    const formatRaw = c.req.query("format")?.trim().toLowerCase() || "json";
    if (formatRaw !== "json" && formatRaw !== "markdown") {
      return c.json({ error: "invalid_format" }, 400);
    }

    const unitParsed = parseUnit(c.req.query("unit"));
    if (unitParsed === "invalid") {
      return c.json({ error: "invalid_unit" }, 400);
    }

    const pg = parsePhaseGoal(c);
    if (!pg.ok) return c.json({ error: pg.error }, 400);

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const section = await buildRecapLongRun({
        session,
        tempoPort,
        unit: unitParsed,
        phase: pg.phase,
        goal: pg.goal,
      });

      if (formatRaw === "markdown") {
        return c.text(section.markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      return c.json({
        weekSessionId: section.weekSessionId,
        isoWeek: section.isoWeek,
        timezone: section.timezone,
        range: section.range,
        unit: section.unit,
        phase: section.phase,
        goal: section.goal,
        knobs: section.knobs,
        included: section.included,
        reason: section.reason,
        longRun: section.longRun,
        markdown: section.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  routes.get("/weeks/:weekSessionId/recap/trends", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }

    const formatRaw = c.req.query("format")?.trim().toLowerCase() || "json";
    if (formatRaw !== "json" && formatRaw !== "markdown") {
      return c.json({ error: "invalid_format" }, 400);
    }

    const unitParsed = parseUnit(c.req.query("unit"));
    if (unitParsed === "invalid") {
      return c.json({ error: "invalid_unit" }, 400);
    }

    const pg = parsePhaseGoal(c);
    if (!pg.ok) return c.json({ error: pg.error }, 400);

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const section = await buildRecapTrends({
        session,
        tempoPort,
        unit: unitParsed,
        phase: pg.phase,
        goal: pg.goal,
      });

      if (formatRaw === "markdown") {
        return c.text(section.markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      return c.json({
        weekSessionId: section.weekSessionId,
        isoWeek: section.isoWeek,
        timezone: section.timezone,
        range: section.range,
        unit: section.unit,
        phase: section.phase,
        goal: section.goal,
        knobs: section.knobs,
        trends: section.trends,
        markdown: section.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  routes.get("/weeks/:weekSessionId/recap/notable", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }

    const formatRaw = c.req.query("format")?.trim().toLowerCase() || "json";
    if (formatRaw !== "json" && formatRaw !== "markdown") {
      return c.json({ error: "invalid_format" }, 400);
    }

    const unitParsed = parseUnit(c.req.query("unit"));
    if (unitParsed === "invalid") {
      return c.json({ error: "invalid_unit" }, 400);
    }

    const pg = parsePhaseGoal(c);
    if (!pg.ok) return c.json({ error: pg.error }, 400);

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const section = await buildRecapNotable({
        session,
        tempoPort,
        unit: unitParsed,
        phase: pg.phase,
        goal: pg.goal,
      });

      if (formatRaw === "markdown") {
        return c.text(section.markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      return c.json({
        weekSessionId: section.weekSessionId,
        isoWeek: section.isoWeek,
        timezone: section.timezone,
        range: section.range,
        unit: section.unit,
        phase: section.phase,
        goal: section.goal,
        knobs: section.knobs,
        notable: section.notable,
        markdown: section.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  /**
   * Full skeleton markdown/JSON in stable section order.
   * Query: phase, goal, format, unit.
   */
  routes.get("/weeks/:weekSessionId/recap/skeleton", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }

    const formatRaw = c.req.query("format")?.trim().toLowerCase() || "json";
    if (formatRaw !== "json" && formatRaw !== "markdown") {
      return c.json({ error: "invalid_format" }, 400);
    }

    const unitParsed = parseUnit(c.req.query("unit"));
    if (unitParsed === "invalid") {
      return c.json({ error: "invalid_unit" }, 400);
    }

    const pg = parsePhaseGoal(c);
    if (!pg.ok) return c.json({ error: pg.error }, 400);

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const skeleton = await buildRecapSkeleton({
        session,
        tempoPort,
        unit: unitParsed,
        phase: pg.phase,
        goal: pg.goal,
      });

      if (formatRaw === "markdown") {
        return c.text(skeleton.markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      return c.json({
        weekSessionId: skeleton.weekSessionId,
        isoWeek: skeleton.isoWeek,
        timezone: skeleton.timezone,
        range: skeleton.range,
        unit: skeleton.unit,
        phase: skeleton.phase,
        goal: skeleton.goal,
        knobs: skeleton.knobs,
        sectionOrder: skeleton.sectionOrder,
        gradingIncluded: skeleton.gradingIncluded,
        sections: skeleton.sections,
        markdown: skeleton.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
