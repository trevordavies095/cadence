import { Hono } from "hono";
import { canConnect } from "../db.js";

export const healthRoutes = new Hono();

/** Liveness: the API process is accepting HTTP. */
healthRoutes.get("/health", (c) => c.json({ status: "healthy" }));

/**
 * Readiness: Postgres answers within 2 seconds.
 * Intentionally omits exception details (Npgsql/pg messages often include host).
 */
healthRoutes.get("/ready", async (c) => {
  try {
    const ok = await canConnect();
    if (ok) {
      return c.json({
        status: "ready",
        checks: { database: "ok" },
      });
    }
  } catch {
    // Swallow — do not leak connection details.
  }

  console.warn("Readiness check failed: database");
  return c.json(
    {
      status: "not_ready",
      checks: { database: "fail" },
    },
    503,
  );
});
