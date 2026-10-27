import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { getLatestRun, markLatestRunSeen } from "../replyRun/store.js";
import { getWeekSessionById } from "../week/store.js";
import type { Clock } from "../clock/clock.js";
import type { ReplyRunner } from "./weeklyReply.js";

/**
 * Read and retry the weekly reply run for a reviewed week. Runs are started by
 * finishing or skipping the check-in (and by an explicit redo), never from here
 * except to retry a failed one.
 */
export function createReplyRunRoutes(options: {
  runner: ReplyRunner;
  clock: Clock;
}): Hono {
  const routes = new Hono();
  const { runner } = options;

  routes.use("/weeks/:weekSessionId/reply-run", requireDisclaimer);
  routes.use("/weeks/:weekSessionId/reply-run/*", requireDisclaimer);

  routes.get("/weeks/:weekSessionId/reply-run", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    const session = await getWeekSessionById(weekSessionId);
    if (!session) return c.json({ error: "week_session_not_found" }, 404);
    return c.json({ run: await getLatestRun(session.id) });
  });

  // The athlete opened the plan: the "plan is ready" banner can go away.
  routes.post("/weeks/:weekSessionId/reply-run/seen", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    const session = await getWeekSessionById(weekSessionId);
    if (!session) return c.json({ error: "week_session_not_found" }, 404);
    return c.json({ run: await markLatestRunSeen(options.clock.now(), session.id) });
  });

  routes.post("/weeks/:weekSessionId/reply-run/retry", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    const session = await getWeekSessionById(weekSessionId);
    if (!session) return c.json({ error: "week_session_not_found" }, 404);

    const latest = await getLatestRun(session.id);
    if (latest?.status === "pending") {
      return c.json(
        {
          error: "reply_run_pending",
          message: "Coach Cade is already reading this week.",
          weekSessionId: session.id,
        },
        409,
      );
    }
    if (latest?.status !== "failed") {
      return c.json(
        {
          error: "reply_run_not_failed",
          message: "There is no failed run to retry.",
          weekSessionId: session.id,
        },
        409,
      );
    }

    const started = await runner.startInBackground(session.id);
    if (!started.ok) {
      return c.json(
        {
          error: started.reason === "pending" ? "reply_run_pending" : "week_session_not_found",
          weekSessionId: session.id,
        },
        409,
      );
    }
    return c.json({ run: started.run }, 202);
  });

  return routes;
}
