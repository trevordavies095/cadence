import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { buildRecapRunByRun } from "../recap/buildRunByRun.js";
import { buildRecapSummary } from "../recap/buildSummary.js";
import { buildRecapZones } from "../recap/buildZones.js";
import { loadWeekGoalContext } from "../recap/weekGoalContext.js";
import {
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type TempoPort,
  type TempoUnitPreference,
} from "../tempo/port.js";
import { getWeekSessionById } from "../week/store.js";

export type RecapRouteOptions = {
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

export function createRecapRoutes(options: RecapRouteOptions): Hono {
  const { tempoPort } = options;
  const routes = new Hono();

  routes.use("/weeks/*/recap/*", requireDisclaimer);
  routes.use("/weeks/*/recap", requireDisclaimer);

  /**
   * Summary section for a week session (tempo-cli table shape).
   * Query: format=json|markdown (default json), optional unit=imperial|metric.
   */
  routes.get("/weeks/:weekSessionId/recap/summary", async (c) => {
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

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const { knobs } = await loadWeekGoalContext(session);
      const summary = await buildRecapSummary({
        session,
        tempoPort,
        unit: unitParsed,
        knobs,
      });

      if (formatRaw === "markdown") {
        return c.text(summary.markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      return c.json({
        weekSessionId: summary.weekSessionId,
        isoWeek: summary.isoWeek,
        timezone: summary.timezone,
        range: summary.range,
        unit: summary.unit,
        thisWeek: summary.thisWeek,
        comparison: summary.comparison,
        comparisonSource: summary.comparisonSource,
        rows: summary.rows,
        goalLines: summary.goalLines,
        markdown: summary.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  /**
   * HR zone distribution section for a week session (tempo-cli bar/target shape).
   * Query: format=json|markdown (default json).
   */
  routes.get("/weeks/:weekSessionId/recap/zones", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }

    const formatRaw = c.req.query("format")?.trim().toLowerCase() || "json";
    if (formatRaw !== "json" && formatRaw !== "markdown") {
      return c.json({ error: "invalid_format" }, 400);
    }

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const goalContext = await loadWeekGoalContext(session);
      const zones = await buildRecapZones({
        session,
        tempoPort,
        easyShareTarget: goalContext.knobs.thresholds.easyShareTarget,
      });

      if (formatRaw === "markdown") {
        return c.text(zones.markdown, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }

      return c.json({
        weekSessionId: zones.weekSessionId,
        isoWeek: zones.isoWeek,
        timezone: zones.timezone,
        range: zones.range,
        zones: zones.zones,
        zoneSource: zones.zoneSource,
        easyShareTarget: zones.easyShareTarget,
        distribution: zones.distribution,
        markdown: zones.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  /**
   * Run-by-run section for a week session (tempo-cli shape, data only).
   * Query: format=json|markdown (default json), optional unit=imperial|metric.
   */
  routes.get("/weeks/:weekSessionId/recap/run-by-run", async (c) => {
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

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    try {
      const goalContext = await loadWeekGoalContext(session);
      const section = await buildRecapRunByRun({
        session,
        tempoPort,
        unit: unitParsed,
        knobs: goalContext.knobs,
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
        runs: section.runs,
        markdown: section.markdown,
      });
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
