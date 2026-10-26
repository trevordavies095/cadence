import { Hono } from "hono";
import type { PrescribedWeek, SafetyCallout } from "../llm/types.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import { getWeekRecapBySessionId } from "../recap/recapStore.js";
import { createAthleteMessage, listThreadMessages } from "../thread/store.js";
import { getWeekSessionById } from "../week/store.js";

export type PrescribedWeekArtifact = {
  kind: "prescribed_week";
  weekSessionId: string;
  plan: PrescribedWeek;
  /** Structured safety callouts for visible thread rendering (#32). */
  safetyCallouts: SafetyCallout[];
  createdAt: string;
  updatedAt: string;
};

/** Weekly recap markdown document posted into the week thread (#25). */
export type WeeklyRecapArtifact = {
  kind: "weekly_recap";
  weekSessionId: string;
  markdown: string;
  subjective: "skipped" | "present";
  createdAt: string;
  updatedAt: string;
};

export type ThreadArtifact = PrescribedWeekArtifact | WeeklyRecapArtifact;

export const threadRoutes = new Hono();

threadRoutes.use("/thread", requireDisclaimer);
threadRoutes.use("/thread/*", requireDisclaimer);

threadRoutes.get("/thread", async (c) => {
  const weekSessionId = c.req.query("weekSessionId")?.trim() || undefined;
  if (weekSessionId) {
    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }
  }
  const messages = await listThreadMessages(weekSessionId);
  const artifacts: ThreadArtifact[] = [];
  if (weekSessionId) {
    const recap = await getWeekRecapBySessionId(weekSessionId);
    if (recap) {
      artifacts.push({
        kind: "weekly_recap",
        weekSessionId: recap.weekSessionId,
        markdown: recap.markdown,
        subjective: recap.subjective,
        createdAt: recap.createdAt,
        updatedAt: recap.updatedAt,
      });
    }
    const prescribed = await getPrescribedWeekBySessionId(weekSessionId);
    if (prescribed) {
      artifacts.push({
        kind: "prescribed_week",
        weekSessionId: prescribed.weekSessionId,
        plan: prescribed.plan,
        safetyCallouts: prescribed.safetyCallouts ?? [],
        createdAt: prescribed.createdAt,
        updatedAt: prescribed.updatedAt,
      });
    }
  }
  return c.json({ messages, artifacts });
});

threadRoutes.post("/thread/messages", async (c) => {
  let body: { body?: unknown; role?: unknown; weekSessionId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return c.json({ error: "body_required" }, 400);
  }
  if (body.role !== undefined && body.role !== "athlete") {
    return c.json({ error: "only_athlete_messages_allowed" }, 400);
  }

  let weekSessionId: string | null = null;
  if (body.weekSessionId !== undefined && body.weekSessionId !== null) {
    if (typeof body.weekSessionId !== "string" || !body.weekSessionId.trim()) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }
    weekSessionId = body.weekSessionId.trim();
    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }
  }

  const message = await createAthleteMessage(text, weekSessionId);
  return c.json(message, 201);
});
