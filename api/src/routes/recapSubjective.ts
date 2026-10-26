import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import type { DataOnlyRecapResult } from "../recap/buildDataOnlyRecap.js";
import { applyApiRpeDefaults } from "../recap/formatSubjective.js";
import {
  saveWeekRecap,
  type WeekRecapRecord,
} from "../recap/recapStore.js";
import { resolveRecapGate } from "../recap/subjectiveGate.js";
import { parseSubjectiveAnswers } from "../recap/subjectiveQuestionnaire.js";
import { buildNeedsSubjectiveRuns } from "../recap/subjectiveRuns.js";
import { saveSubjectiveAnswers } from "../recap/subjectiveStore.js";
import {
  TempoExportError,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type TempoPort,
  type TempoUnitPreference,
} from "../tempo/port.js";
import { resolveCheckInStatus } from "../recap/checkInStatus.js";
import { hasPendingRun } from "../replyRun/store.js";
import { getWeekSessionById } from "../week/store.js";
import type { ReplyRunner } from "./weeklyReply.js";

type WeeklyRecapArtifact = {
  kind: "weekly_recap";
  weekSessionId: string;
  markdown: string;
  subjective: "skipped" | "present";
  createdAt: string;
  updatedAt: string;
};

export type RecapSubjectiveRouteOptions = {
  tempoPort: TempoPort;
  /** Starts the weekly reply when the check-in is finished or skipped. */
  runner: ReplyRunner;
};

const REPLY_RUN_PENDING = {
  error: "reply_run_pending",
  message: "Coach Cade is already reading this week.",
} as const;

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

function parseTruthyQuery(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const t = raw.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

function toWeeklyRecapArtifact(record: WeekRecapRecord): WeeklyRecapArtifact {
  return {
    kind: "weekly_recap",
    weekSessionId: record.weekSessionId,
    markdown: record.markdown,
    subjective: record.subjective,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Persist report markdown as the week's recap thread artifact (replace on regen). */
async function publishRecapArtifact(
  report: DataOnlyRecapResult,
): Promise<WeeklyRecapArtifact> {
  const record = await saveWeekRecap({
    weekSessionId: report.weekSessionId,
    markdown: report.reportMarkdown,
    subjective: report.subjective,
  });
  return toWeeklyRecapArtifact(record);
}

/**
 * Weekly recap needs_subjective gate + subjective save (append-only surface).
 * Keeps section routes in createRecapRoutes untouched for parallel slices.
 */
export function createRecapSubjectiveRoutes(
  options: RecapSubjectiveRouteOptions,
): Hono {
  const { tempoPort, runner } = options;
  const routes = new Hono();

  routes.use("/weeks/*/recap", requireDisclaimer);
  routes.use("/weeks/*/recap/subjective", requireDisclaimer);

  /**
   * Full-week recap gate (tempo-cli MCP shape).
   * Query: skip_subjective, refresh_subjective, optional unit=imperial|metric.
   */
  routes.get("/weeks/:weekSessionId/recap", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
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
      const skipSubjective = parseTruthyQuery(c.req.query("skip_subjective"));
      // Skipping is a transition only the first time: later reads of an
      // already-skipped or finished check-in must not start another run.
      const skipStartsRun =
        skipSubjective && (await resolveCheckInStatus(session.id)) === "needed";
      const result = await resolveRecapGate({
        session,
        tempoPort,
        unit: unitParsed,
        skipSubjective,
        refreshSubjective: parseTruthyQuery(c.req.query("refresh_subjective")),
      });
      if (result.status === "report") {
        const threadArtifact = await publishRecapArtifact(result);
        if (skipStartsRun) await runner.startInBackground(session.id);
        return c.json({ ...result, threadArtifact });
      }
      return c.json(result);
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  /**
   * Persist subjective interview answers, then return updated gate (report when ready).
   */
  routes.post("/weeks/:weekSessionId/recap/subjective", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim() ?? "";
    if (!WEEK_SESSION_ID_RE.test(weekSessionId)) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }

    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }

    // A new check-in while the coach is still reading the last one would race it.
    if (await hasPendingRun(session.id)) {
      return c.json({ ...REPLY_RUN_PENDING, weekSessionId: session.id }, 409);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const parsed = parseSubjectiveAnswers(body, session.isoWeek);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    try {
      // Prefer Tempo apiRpe when the athlete omits RPE for a date.
      const { runs: gateRuns } = await buildNeedsSubjectiveRuns({
        session,
        tempoPort,
      });
      const answers = applyApiRpeDefaults(parsed.answers, gateRuns);
      const stored = await saveSubjectiveAnswers(weekSessionId, answers);

      const gate = await resolveRecapGate({
        session,
        tempoPort,
      });
      if (gate.status === "report") {
        const threadArtifact = await publishRecapArtifact(gate);
        await runner.startInBackground(session.id);
        return c.json(
          {
            status: "saved" as const,
            weekSessionId: stored.weekSessionId,
            answers: stored.answers,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            gate: { ...gate, threadArtifact },
            threadArtifact,
          },
          201,
        );
      }
      return c.json(
        {
          status: "saved" as const,
          weekSessionId: stored.weekSessionId,
          answers: stored.answers,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
          gate,
          threadArtifact: null,
        },
        201,
      );
    } catch (err) {
      const mapped = mapPortError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
