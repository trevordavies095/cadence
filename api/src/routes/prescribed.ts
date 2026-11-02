import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Hono } from "hono";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  getPrescribedWeekBySessionId,
  updatePrescribedPlan,
} from "../prescribed/store.js";
import { isoWeekMondayDate, nextIsoWeekBounds } from "../clock/isoWeek.js";
import type { Clock } from "../clock/clock.js";
import {
  expectedPlanDates,
  isoWeekOfDate,
  LlmHttpError,
  LlmNotConfiguredError,
  LlmSchemaError,
  LlmTransportError,
  type LlmPort,
  type PrescribedDay,
} from "../llm/index.js";
import { todayYmdForSession } from "../prescribed/patch.js";
import { parsePlanLines } from "../prescribed/planLines.js";
import { getLatestOkRunCallId } from "../replyRun/store.js";
import { coachNotConfiguredBody } from "../settings/coachSetup.js";
import { resolveUnitPreference } from "../settings/unitPreferenceStore.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import { ensureWeekSession, findWeekSession, getWeekSessionById } from "../week/store.js";

/** What the Plan page shows under a day Coach Cade could not fill in. */
export const PLAN_DAY_FIX_FAILED_MESSAGE =
  "Coach Cade couldn't fill in this day. The plan above still stands.";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why the day's stored line could not be read, re-read now: the failure for
 * the date, else the line's own failure (a line for a date outside the week),
 * else null. A day with no line is "no line".
 */
function failureReason(
  day: PrescribedDay,
  weekStartMonday: string,
  unit: TempoUnitPreference,
): string | null {
  if (day.line == null) return "no line";
  const { failures } = parsePlanLines({ text: day.line, weekStartMonday, unit });
  const own = failures.find((f) => f.date === day.date && f.reason !== "no line");
  if (own) return own.reason;
  const other = failures.find((f) => f.reason !== "no line");
  return other?.reason ?? null;
}

/**
 * The Sunday call that wrote this plan, when it can be found: the latest
 * successful reply run of the week before (the reviewed week; the plan is
 * stored on the week after it). Null for a plan written another way (a
 * packet-only reply, a demo restore) or a run that kept no call id.
 */
async function sundayCallId(
  weekStartMonday: string,
  timezone: string,
): Promise<string | null> {
  const [y, m, d] = weekStartMonday.split("-").map(Number) as [number, number, number];
  const reviewedMonday = new Date(Date.UTC(y, m - 1, d - 7)).toISOString().slice(0, 10);
  const reviewed = await findWeekSession(isoWeekOfDate(reviewedMonday), timezone);
  return reviewed ? getLatestOkRunCallId(reviewed.id) : null;
}

/**
 * Read persisted prescribed week for a week session, and fill in one unread
 * day of it ("Add the details").
 */
export function createPrescribedRoutes(options: {
  tempoPort: TempoPort;
  clock: Clock;
  llmPort: LlmPort;
}): Hono {
  const { tempoPort, clock, llmPort } = options;
  const routes = new Hono();

  routes.use("/weeks/:weekSessionId/prescribed", requireDisclaimer);

  routes.use("/weeks/:weekSessionId/prescribed/next", requireDisclaimer);

  routes.use("/weeks/:weekSessionId/prescribed/details", requireDisclaimer);

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
      clock.now(),
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

  /**
   * "Add the details" (plan-as-text ticket 09, rung 3 of the spec's
   * degradation ladder): body `{ date }`. Asks Coach Cade for one line for an
   * unread day of the week's stored plan and files it when it now reads.
   *
   * The request is a short fresh prompt, not the Sunday request replayed: the
   * coach's stance and the plan grammar as the system prompt, and a user turn
   * with the plan week's dates, the unit, the date, its stored line (or "no
   * line was written") and the reason, re-read from the line now. No packet
   * and no assistant turn: one line needs neither, the call costs a fraction
   * of the Sunday one, and it does not depend on the call log still holding
   * the Sunday request.
   *
   * The model and server are resolved now from the saved setting (ADR 0004),
   * not the Sunday call's: a model changed since Sunday is the one used. The
   * adapter's one retry applies as to every call. The call log row is
   * `plan_day_fix`, linked to the Sunday call when the reviewed week's reply
   * run kept its id.
   *
   * On success only that date's day is replaced, `parsed: true`; the plan's
   * week and the other six days are written back as they were read. A line
   * that still does not read, or reads for another date, stores nothing.
   *
   * 200 `{ prescribed, day, unitPreference, todayYmd }`. Refused: 400
   * `invalid_json` / `invalid_date` / `date_outside_plan_week`, 404
   * `week_session_not_found` / `prescribed_week_not_found`, 409
   * `plan_day_already_filed`, and 409 `plan_day_changed` when the day changed
   * while Coach Cade was asked. Coach Cade could not fill it in: 422
   * `plan_day_not_filed`, or 502 with the model error's code for a failed
   * call, each with PLAN_DAY_FIX_FAILED_MESSAGE; 400 when no model is set up.
   */
  routes.post("/weeks/:weekSessionId/prescribed/details", async (c) => {
    const weekSessionId = c.req.param("weekSessionId")?.trim();
    if (!weekSessionId) {
      return c.json({ error: "invalid_week_session_id" }, 400);
    }
    const session = await getWeekSessionById(weekSessionId);
    if (!session) {
      return c.json({ error: "week_session_not_found" }, 404);
    }
    let body: { date?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const date = typeof body?.date === "string" ? body.date.trim() : "";
    if (!DATE_RE.test(date)) {
      return c.json({ error: "invalid_date" }, 400);
    }
    const prescribed = await getPrescribedWeekBySessionId(weekSessionId);
    if (!prescribed) {
      return c.json({ error: "prescribed_week_not_found" }, 404);
    }
    const weekStartMonday = isoWeekMondayDate(session.isoWeek);
    const day = prescribed.plan.days.find((d) => d.date === date);
    if (!expectedPlanDates(weekStartMonday).includes(date) || !day) {
      return c.json({ error: "date_outside_plan_week", date }, 400);
    }
    if (day.parsed !== false) {
      return c.json({ error: "plan_day_already_filed", date }, 409);
    }

    const unit = await resolveUnitPreference(tempoPort);
    const callId = randomUUID();
    let filled: PrescribedDay;
    try {
      const fix = await llmPort.generatePlanDayFix(
        {
          weekStartMonday,
          unit,
          date,
          line: day.line ?? null,
          reason: failureReason(day, weekStartMonday, unit),
        },
        {
          callId,
          weekSessionId: session.id,
          parentCallId: await sundayCallId(weekStartMonday, session.timezone),
        },
      );
      filled = fix.day;
    } catch (err) {
      if (err instanceof LlmNotConfiguredError) {
        return c.json(await coachNotConfiguredBody(), 400);
      }
      if (err instanceof LlmSchemaError) {
        return c.json({ error: "plan_day_not_filed", message: PLAN_DAY_FIX_FAILED_MESSAGE }, 422);
      }
      if (err instanceof LlmHttpError || err instanceof LlmTransportError) {
        return c.json({ error: err.code, message: PLAN_DAY_FIX_FAILED_MESSAGE }, 502);
      }
      throw err;
    }

    // The plan as it is now: a change from the conversation while Coach Cade
    // was asked wins, and the other days are written back as read.
    const current = await getPrescribedWeekBySessionId(weekSessionId);
    const now = current?.plan.days.find((d) => d.date === date);
    if (!current || !now || !isDeepStrictEqual(now, day)) {
      return c.json({ error: "plan_day_changed", date, message: PLAN_DAY_FIX_FAILED_MESSAGE }, 409);
    }
    const saved = await updatePrescribedPlan({
      weekSessionId,
      plan: {
        ...current.plan,
        days: current.plan.days.map((d) => (d.date === date ? filled : d)),
      },
      at: clock.now(),
    });
    return c.json({
      prescribed: saved,
      day: filled,
      unitPreference: unit,
      todayYmd: todayYmdForSession(clock, session.timezone),
    });
  });

  return routes;
}
