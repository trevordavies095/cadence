import { Hono } from "hono";
import { privacyCopyFor } from "../privacy/copy.js";
import { getModelServer } from "../privacy/modelServer.js";

export const privacyRoutes = new Hono();

/**
 * Public privacy transparency copy — no disclaimer gate (linked from first-run).
 * Also says where coaching context goes: `host` and `onNetwork` are set only for
 * a self-hosted model server, and null for Anthropic.
 */
privacyRoutes.get("/privacy", async (c) => {
  const server = await getModelServer();
  return c.json({ ...privacyCopyFor(server.provider), ...server });
});
