import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  isValidWorkoutId,
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type ListWorkoutsQuery,
  type TempoPort,
} from "../tempo/port.js";

export type TempoRouteOptions = {
  tempoPort: TempoPort;
};

function parseOptionalPositiveInt(
  raw: string | undefined,
): number | undefined | "invalid" {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) return "invalid";
  const n = Number.parseInt(raw.trim(), 10);
  if (n < 1) return "invalid";
  return n;
}

function parseListQuery(c: {
  req: { query: (key: string) => string | undefined };
}): { ok: ListWorkoutsQuery } | { error: string } {
  const query: ListWorkoutsQuery = {};
  const page = parseOptionalPositiveInt(c.req.query("page"));
  if (page === "invalid") return { error: "invalid_page" };
  if (page !== undefined) query.page = page;

  const pageSize = parseOptionalPositiveInt(c.req.query("pageSize"));
  if (pageSize === "invalid") return { error: "invalid_pageSize" };
  if (pageSize !== undefined) {
    if (pageSize > 100) return { error: "invalid_pageSize" };
    query.pageSize = pageSize;
  }

  const startDate = c.req.query("startDate")?.trim();
  if (startDate) query.startDate = startDate;
  const endDate = c.req.query("endDate")?.trim();
  if (endDate) query.endDate = endDate;
  const keyword = c.req.query("keyword");
  if (keyword !== undefined && keyword !== "") query.keyword = keyword;
  const runType = c.req.query("runType")?.trim();
  if (runType) query.runType = runType;
  const sortBy = c.req.query("sortBy")?.trim();
  if (sortBy) query.sortBy = sortBy;
  const sortOrder = c.req.query("sortOrder")?.trim();
  if (sortOrder) query.sortOrder = sortOrder;

  const minDistanceM = c.req.query("minDistanceM");
  if (minDistanceM !== undefined && minDistanceM.trim() !== "") {
    const n = Number(minDistanceM);
    if (!Number.isFinite(n)) return { error: "invalid_minDistanceM" };
    query.minDistanceM = n;
  }
  const maxDistanceM = c.req.query("maxDistanceM");
  if (maxDistanceM !== undefined && maxDistanceM.trim() !== "") {
    const n = Number(maxDistanceM);
    if (!Number.isFinite(n)) return { error: "invalid_maxDistanceM" };
    query.maxDistanceM = n;
  }

  return { ok: query };
}

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
    if (err.status === 400) {
      return {
        status: 400,
        body: { error: err.code, status: err.status, message: err.message },
      };
    }
    if (err.status === 404) {
      return {
        status: 404,
        body: { error: err.code, status: err.status, message: err.message },
      };
    }
    // Upstream auth / 5xx / other → bad gateway (coach API auth is separate).
    return {
      status: 502,
      body: { error: err.code, status: err.status, message: err.message },
    };
  }
  if (err instanceof TempoTransportError) {
    return { status: 502, body: { error: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : "tempo_error";
  return { status: 500, body: { error: "tempo_error", message } };
}

export function createTempoRoutes(options: TempoRouteOptions): Hono {
  const routes = new Hono();
  const { tempoPort } = options;

  routes.use("/tempo", requireDisclaimer);
  routes.use("/tempo/*", requireDisclaimer);

  routes.get("/tempo/workouts", async (c) => {
    const parsed = parseListQuery(c);
    if ("error" in parsed) {
      return c.json({ error: parsed.error }, 400);
    }
    try {
      const result = await tempoPort.listWorkouts(parsed.ok);
      return c.json(result);
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  routes.get("/tempo/workouts/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidWorkoutId(id)) {
      return c.json({ error: "invalid_workout_id" }, 400);
    }
    try {
      const workout = await tempoPort.getWorkout(id);
      if (!workout) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json(workout);
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  routes.get("/tempo/settings", async (c) => {
    try {
      return c.json(await tempoPort.getSettings());
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  routes.get("/tempo/shoes", async (c) => {
    const statusRaw = c.req.query("status")?.trim().toLowerCase();
    let status: "active" | "retired" | "all" | undefined;
    if (statusRaw !== undefined && statusRaw !== "") {
      if (
        statusRaw !== "active" &&
        statusRaw !== "retired" &&
        statusRaw !== "all"
      ) {
        return c.json({ error: "invalid_status" }, 400);
      }
      status = statusRaw;
    }
    try {
      return c.json(await tempoPort.listShoes(status ? { status } : {}));
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  routes.get("/tempo/best-efforts", async (c) => {
    try {
      return c.json(await tempoPort.getBestEfforts());
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
