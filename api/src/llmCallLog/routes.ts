import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import type { LlmCallRecorder } from "./types.js";

export type LlmCallLogRouteOptions = {
  recorder: LlmCallRecorder;
};

export function createLlmCallLogRoutes(options: LlmCallLogRouteOptions) {
  const routes = new Hono();

  routes.use("/llm-calls", requireDisclaimer);
  routes.use("/llm-calls/*", requireDisclaimer);

  routes.get("/llm-calls", async (c) => {
    const rows = await options.recorder.list({
      weekSessionId: c.req.query("weekSessionId"),
      operation: c.req.query("operation"),
      outcome: c.req.query("outcome"),
    });
    return c.json(rows);
  });

  // Must be registered before "/llm-calls/:id" or "export" is captured as an id.
  routes.get("/llm-calls/export", (c) => {
    const encoder = new TextEncoder();
    const iterator = options.recorder.exportAll()[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else
            controller.enqueue(
              encoder.encode(`${JSON.stringify(next.value)}\n`),
            );
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson" },
    });
  });

  routes.get("/llm-calls/:id", async (c) => {
    const row = await options.recorder.get(c.req.param("id"));
    if (!row) {
      return c.json({ error: "llm_call_not_found" }, 404);
    }
    return c.json(row);
  });

  return routes;
}
