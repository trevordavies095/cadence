import {
  cutAtSentence,
  cutAtWord,
  fitSafetyCalloutBody,
  isSafetyCalloutSeverity,
  MAX_SAFETY_CALLOUT_BODY,
  MAX_SAFETY_CALLOUT_BODY_HARD,
  MAX_SAFETY_CALLOUT_TITLE,
  MAX_SAFETY_CALLOUTS,
  SAFETY_ESCALATION_LINE,
} from "./safety.js";
import { parsePlanLines, splitLines, type PlanLineFailure } from "../prescribed/planLines.js";
import type { TempoUnitPreference } from "../tempo/port.js";
import type {
  DayType,
  DossierAuditDraft,
  DossierCorrectionDraft,
  DossierV1Draft,
  MidWeekChatReply,
  PrescribedDay,
  PrescribedRun,
  PrescribedWeek,
  ReadAnswer,
  ReadFlag,
  RunType,
  SafetyCallout,
  SafetyCalloutSeverity,
  WeeklyReply,
} from "./types.js";

export const MAX_ANALYSIS_LENGTH = 4000;
/** The headline is cut at a word past this, never refused (see the reading-flow spec). */
export const MAX_HEADLINE_LENGTH = 280;
/** Flags and answers: the counts fail closed; flag text is cut at a word and logged. */
export const MAX_READ_FLAGS = 5;
export const MAX_READ_ANSWERS = 8;
export const MAX_FLAG_TITLE_LENGTH = 80;
export const MAX_FLAG_DETAIL_LENGTH = 280;
/** Day notes carry the reason for a session: asked for 200, kept to 400 at a sentence. */
export const DAY_NOTES_TARGET = 200;
export const MAX_DAY_NOTES_LENGTH = 400;
export const MAX_SETTINGS_PROPOSAL_BULLETS = 8;
export const MAX_BULLET_LENGTH = 280;
export const MAX_DOSSIER_SUMMARY_BULLETS = 8;
export const MAX_DOSSIER_BODY_LENGTH = 12000;
export {
  MAX_SAFETY_CALLOUT_BODY,
  MAX_SAFETY_CALLOUT_BODY_HARD,
  MAX_SAFETY_CALLOUT_TITLE,
  MAX_SAFETY_CALLOUTS,
} from "./safety.js";

const DAY_TYPES = new Set<DayType>([
  "rest",
  "easy",
  "quality",
  "long",
  "race",
  "other",
]);

const RUN_TYPES = new Set<RunType>([
  "easy",
  "quality",
  "long",
  "race",
  "other",
]);

const ISO_WEEK_RE = /^\d{4}-W\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `repairs` notes soft fields the validator fixed instead of refusing.
 * `planRetry`, when present, says the reply was accepted with plan lines
 * Cadence could not read, and how to take a retry's fixes for them: the
 * adapter's retry (askAtMostTwice) is driven by it, whatever the operation.
 */
export type SchemaOk<T> = {
  ok: true;
  value: T;
  repairs?: string[];
  planRetry?: PlanRetry<T>;
};
export type SchemaErr = { ok: false; error: string };
export type SchemaResult<T> = SchemaOk<T> | SchemaErr;

/**
 * A reply accepted with plan lines that did not parse. The adapter sends one
 * more request quoting `failures` and reads the retry's tool input with
 * `takeFixes`: only the failed dates are taken from it, and everything else
 * stays as the first reply had it.
 */
export type PlanRetry<T> = {
  /** The box the lines came from, as the retry names it: "plan" (weekly) or "changes" (mid-week). */
  box: string;
  /** Every failed line, in date order, as the retry quotes them. */
  failures: PlanLineFailure[];
  /** The failed dates the retry may replace (dates inside the plan week). */
  dates: string[];
  /**
   * The first reply with the failed dates taken from the retry's tool input
   * where they now parse; a date that fails again stays as it was. `fixed`
   * names the dates replaced; `repairs` names each date fixed and each still
   * unparsed. Refused when the retry has no box to read.
   */
  takeFixes(retryInput: unknown): PlanFixResult<T>;
};

export type PlanFixResult<T> = (SchemaOk<T> & { fixed: string[] }) | SchemaErr;

/**
 * The PlanRetry for a box parsed with parsePlanLines: `boxOf` reads the box
 * from the retry's tool input, which is parsed against the same week and
 * unit; `withDays` builds the first reply with the replaced days. Undefined
 * when no date inside `dates` failed. Mid-week's changes box can use this too.
 */
export function planLineRetry<T>(options: {
  /** The box's name in the tool and in the repair notes: "plan" or "changes". */
  box: string;
  failures: PlanLineFailure[];
  /** The dates the reply's box covers; a failure outside them is quoted, never taken. */
  dates: readonly string[];
  weekStartMonday: string;
  unit: TempoUnitPreference;
  boxOf: (retryInput: unknown) => SchemaResult<string>;
  withDays: (replaced: ReadonlyMap<string, PrescribedDay>) => T;
}): PlanRetry<T> | undefined {
  const covered = new Set(options.dates);
  const failedDates = options.failures.map((f) => f.date).filter((d) => covered.has(d));
  if (failedDates.length === 0) return undefined;
  const box = options.box;
  return {
    box,
    failures: options.failures,
    dates: failedDates,
    takeFixes(retryInput) {
      const text = options.boxOf(retryInput);
      if (!text.ok) return text;
      const parsed = parsePlanLines({
        text: text.value,
        weekStartMonday: options.weekStartMonday,
        unit: options.unit,
      });
      const stillFailing = new Map(parsed.failures.map((f) => [f.date, f.reason]));
      const replaced = new Map<string, PrescribedDay>();
      const repairs: string[] = [];
      for (const date of failedDates) {
        const day = parsed.days.find((d) => d.date === date);
        const reason = stillFailing.get(date);
        if (day && reason === undefined) {
          replaced.set(date, day);
          repairs.push(`${box} ${date} filed by the retry`);
        } else {
          repairs.push(`${box} ${date} still not filed: ${reason ?? "no line"}`);
        }
      }
      return {
        ok: true,
        value: options.withDays(replaced),
        repairs,
        fixed: [...replaced.keys()],
      };
    },
  };
}

function withRepairs<T>(value: T, repairs: string[] | undefined): SchemaOk<T> {
  return repairs ? { ok: true, value, repairs } : { ok: true, value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function isRestRun(run: PrescribedRun): boolean {
  return (
    run.distanceM <= 0 &&
    !(run.durationS != null && run.durationS > 0) &&
    !run.structure &&
    !run.paceOrHr
  );
}

function parseOptionalString(
  value: unknown,
  path: string,
): SchemaResult<string | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: `${path} must be a string or null` };
  }
  return { ok: true, value: value };
}

function parseRun(
  value: unknown,
  path: string,
): SchemaResult<PrescribedRun | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) {
    return { ok: false, error: `${path} must be an object or null` };
  }

  const typeRaw = value.type;
  if (typeof typeRaw !== "string" || !RUN_TYPES.has(typeRaw as RunType)) {
    return {
      ok: false,
      error: `${path}.type must be easy|quality|long|race|other`,
    };
  }

  const durationS = value.durationS;
  if (
    durationS !== undefined &&
    durationS !== null &&
    (typeof durationS !== "number" || !Number.isFinite(durationS) || durationS <= 0)
  ) {
    return { ok: false, error: `${path}.durationS must be a number > 0 or null` };
  }
  const timed = typeof durationS === "number";

  // A run prescribed by duration may leave distance out; it is stored as 0.
  const distanceM = value.distanceM === undefined && timed ? 0 : value.distanceM;
  if (typeof distanceM !== "number" || !Number.isFinite(distanceM) || distanceM < 0) {
    return { ok: false, error: `${path}.distanceM must be a number >= 0` };
  }

  const structure = parseOptionalString(value.structure, `${path}.structure`);
  if (!structure.ok) return structure;
  const paceOrHr = parseOptionalString(value.paceOrHr, `${path}.paceOrHr`);
  if (!paceOrHr.ok) return paceOrHr;
  const shoes = parseOptionalString(value.shoes, `${path}.shoes`);
  if (!shoes.ok) return shoes;

  const run: PrescribedRun = {
    type: typeRaw as RunType,
    distanceM,
  };
  if (timed) run.durationS = durationS;
  if (structure.value !== undefined) run.structure = structure.value;
  if (paceOrHr.value !== undefined) run.paceOrHr = paceOrHr.value;
  if (shoes.value !== undefined) run.shoes = shoes.value;
  return { ok: true, value: run };
}

function parseDay(
  value: unknown,
  index: number,
  expectedDate: string,
  repairs: string[],
  /** Keep the plan-line fields (`line`, `parsed`): stored plans only, never day patches. */
  keepLine = false,
): SchemaResult<PrescribedDay> {
  const path = `prescribedWeek.days[${index}]`;
  if (!isPlainObject(value)) {
    return { ok: false, error: `${path} must be an object` };
  }

  const date = value.date;
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    return { ok: false, error: `${path}.date must be YYYY-MM-DD` };
  }
  if (date !== expectedDate) {
    return {
      ok: false,
      error: `${path}.date must be ${expectedDate} (got ${date})`,
    };
  }

  const dayTypeRaw = value.dayType;
  if (typeof dayTypeRaw !== "string" || !DAY_TYPES.has(dayTypeRaw as DayType)) {
    return {
      ok: false,
      error: `${path}.dayType must be rest|easy|quality|long|race|other`,
    };
  }
  const dayType = dayTypeRaw as DayType;

  const runResult = parseRun(value.run, `${path}.run`);
  if (!runResult.ok) return runResult;

  const strength = parseOptionalString(value.strength, `${path}.strength`);
  if (!strength.ok) return strength;
  const notes = parseOptionalString(value.notes, `${path}.notes`);
  if (!notes.ok) return notes;

  if (dayType === "rest") {
    if (runResult.value != null && !isRestRun(runResult.value)) {
      return {
        ok: false,
        error: `${path} is rest but has a non-rest run`,
      };
    }
  } else if (runResult.value == null) {
    // An other day may be strength, cross-training or a walk: no run, with the
    // notes saying what the day is. Missing notes are noted, not refused (ADR 0002).
    if (dayType !== "other") {
      return { ok: false, error: `${path} (${dayType}) requires a run object` };
    }
    if (!notes.value?.trim()) {
      repairs.push(`${path} (other) with no run has no notes saying what the day is`);
    }
  }

  const day: PrescribedDay = { date, dayType };
  if (runResult.value !== undefined) day.run = runResult.value;
  if (strength.value !== undefined) day.strength = strength.value;
  // A stored day read from a plan line keeps its notes as derived: the line holds the text.
  const fromLine = keepLine && typeof value.line === "string";
  if (notes.value !== undefined) {
    day.notes = fromLine ? notes.value : fitDayNotes(notes.value, `${path}.notes`, repairs);
  }
  if (keepLine && (value.line === null || fromLine)) day.line = value.line as string | null;
  if (keepLine && typeof value.parsed === "boolean") day.parsed = value.parsed;
  return { ok: true, value: day };
}

/**
 * Day notes hold the reason for a session, shown beside it. Past the ceiling they
 * are cut at a sentence; past the target they are kept. Either way it is noted.
 */
function fitDayNotes(
  notes: string | null,
  path: string,
  repairs: string[],
): string | null {
  if (notes == null) return notes;
  const text = notes.trim();
  if (text.length > MAX_DAY_NOTES_LENGTH) {
    const cut = cutAtSentence(text, MAX_DAY_NOTES_LENGTH);
    repairs.push(`${path} cut from ${text.length} to ${cut.length} chars`);
    return cut;
  }
  if (text.length > DAY_NOTES_TARGET) {
    repairs.push(`${path} over target: ${text.length} chars kept`);
  }
  return notes;
}

/**
 * Fail-closed validation for a structured prescribed week.
 * `weekStartMonday` is YYYY-MM-DD for the plan week's Monday.
 */
export function validatePrescribedWeek(
  raw: unknown,
  weekStartMonday: string,
): SchemaResult<PrescribedWeek> {
  if (!DATE_RE.test(weekStartMonday)) {
    return {
      ok: false,
      error: "weekStartMonday must be YYYY-MM-DD",
    };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: "prescribedWeek must be an object" };
  }

  const week = raw.week;
  if (typeof week !== "string" || !ISO_WEEK_RE.test(week)) {
    return {
      ok: false,
      error: "prescribedWeek.week must be an ISO week id (YYYY-Www)",
    };
  }

  const daysRaw = raw.days;
  if (!Array.isArray(daysRaw) || daysRaw.length !== 7) {
    return {
      ok: false,
      error: "prescribedWeek.days must contain exactly 7 entries (Mon–Sun)",
    };
  }

  const days: PrescribedDay[] = [];
  const repairs: string[] = [];
  for (let i = 0; i < 7; i++) {
    const expected = addDaysYmd(weekStartMonday, i);
    const parsed = parseDay(daysRaw[i], i, expected, repairs, true);
    if (!parsed.ok) return parsed;
    days.push(parsed.value);
  }

  return withRepairs({ week, days }, repairs.length > 0 ? repairs : undefined);
}

/**
 * Validation for optional safety callouts on weekly/mid-week replies.
 * Shape errors fail closed. Length does not (#4): a long title or body is
 * kept or cut so the reply still reaches the athlete, and each fix is noted
 * in `repairs` for the call log.
 */
export function validateSafetyCallouts(
  raw: unknown,
  /** A weekly notice written as one sentence is all title; its stored body is empty. */
  options?: { allowEmptyBody?: boolean },
): SchemaResult<SafetyCallout[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "safetyCallouts must be an array" };
  }
  if (raw.length > MAX_SAFETY_CALLOUTS) {
    return {
      ok: false,
      error: `safetyCallouts must have at most ${MAX_SAFETY_CALLOUTS} items`,
    };
  }
  const callouts: SafetyCallout[] = [];
  const repairs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const path = `safetyCallouts[${i}]`;
    if (!isPlainObject(item)) {
      return { ok: false, error: `${path} must be an object` };
    }
    const titleRaw = item.title;
    if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
      return { ok: false, error: `${path}.title must be a non-empty string` };
    }
    let title = titleRaw.trim();
    if (title.length > MAX_SAFETY_CALLOUT_TITLE) {
      const cut = cutAtWord(title, MAX_SAFETY_CALLOUT_TITLE);
      repairs.push(`${path}.title cut from ${title.length} to ${cut.length} chars`);
      title = cut;
    }
    const bodyRaw = item.body;
    if (
      typeof bodyRaw !== "string" ||
      (bodyRaw.trim().length === 0 && !options?.allowEmptyBody)
    ) {
      return { ok: false, error: `${path}.body must be a non-empty string` };
    }
    let body = bodyRaw.trim();
    if (body.length > MAX_SAFETY_CALLOUT_BODY_HARD) {
      const cut = fitSafetyCalloutBody(body, MAX_SAFETY_CALLOUT_BODY_HARD);
      const added =
        cut.endsWith(SAFETY_ESCALATION_LINE) &&
        !body.endsWith(SAFETY_ESCALATION_LINE);
      repairs.push(
        `${path}.body cut from ${body.length} to ${cut.length} chars` +
          (added ? ", escalation line added" : ""),
      );
      body = cut;
    } else if (body.length > MAX_SAFETY_CALLOUT_BODY) {
      repairs.push(`${path}.body over target: ${body.length} chars kept`);
    }
    const callout: SafetyCallout = { title, body };
    if (item.severity !== undefined) {
      if (!isSafetyCalloutSeverity(item.severity)) {
        return {
          ok: false,
          error: `${path}.severity must be info|caution|urgent`,
        };
      }
      callout.severity = item.severity;
    }
    callouts.push(callout);
  }
  return withRepairs(callouts, repairs.length > 0 ? repairs : undefined);
}

/** The ISO week id (YYYY-Www) of a calendar date YYYY-MM-DD: the week holding its Thursday. */
export function isoWeekOfDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** What Cadence knows beside Coach Cade's form when it reads it. */
export type WeeklyReplyContext = {
  /** The athlete's distance unit; labels the plan, never resolves a bare number. Default imperial. */
  unit?: TempoUnitPreference;
  /** The athlete's check-in questions, as they wrote them, in order. */
  questions?: readonly string[];
};

/** How many characters of a dropped plan line the call log quotes. */
const IGNORED_LINE_QUOTE = 60;

/**
 * Coach Cade's weekly form (every box text or lines, "The forms" in
 * .scratch/plan-as-text/spec.md) turned into the reply Cadence stores.
 *
 * - The plan box is parsed line by line. A day that does not parse is stored
 *   unparsed (`parsed: false`, its line in notes) and the reply stays valid;
 *   each such date is noted as a repair, so the call log row reads `repaired`
 *   and names it. A plan box that is missing, empty, or has no line for any
 *   date of the plan week is refused.
 * - The plan's week id is the plan week's, set here; Coach Cade is not asked for it.
 * - Flags, answers and notices become today's stored shapes, so the read page
 *   and the stored read sections do not change.
 */
/**
 * The first field holding tool-call markup, if any. Opus 4.7 sometimes leaks
 * its own call syntax into a text box (`<parameter name="0">Workload spike...`,
 * 6 of 20 first attempts in the 2026-11-02 gate). Such a box must never reach
 * the athlete, so the reply is refused and the retry names the field.
 */
const TOOL_MARKUP_RE = /<\/?(?:parameter|invoke|function_calls|antml:[a-z_]+)\b/i;

function fieldWithToolMarkup(raw: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(raw)) {
    const texts = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    if (texts.some((t) => TOOL_MARKUP_RE.test(t))) return key;
  }
  return null;
}

function toolMarkupError(field: string): SchemaErr {
  return {
    ok: false,
    error: `${field} contains tool-call markup (<parameter ...>); write every box as plain text, one item per line`,
  };
}

export function validateWeeklyReply(
  raw: unknown,
  weekStartMonday: string,
  context: WeeklyReplyContext = {},
): SchemaResult<WeeklyReply> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "weekly reply must be an object" };
  }
  const markupField = fieldWithToolMarkup(raw);
  if (markupField) return toolMarkupError(markupField);
  if (!DATE_RE.test(weekStartMonday)) {
    return { ok: false, error: "weekStartMonday must be YYYY-MM-DD" };
  }
  const repairs: string[] = [];

  const headline = parseHeadline(raw.headline, repairs);
  if (!headline.ok) return headline;
  const analysis = parseAnalysis(raw.analysis);
  if (!analysis.ok) return analysis;

  const unit = context.unit ?? "imperial";
  const plan = parsePlanBox(raw.plan, weekStartMonday, unit, repairs);
  if (!plan.ok) return plan;

  const bullets = bulletsFromLines(raw.settingsProposalBullets, repairs);
  if (!bullets.ok) return bullets;

  const calloutObjects = calloutsFromLines(raw.safetyCallouts, repairs);
  if (!calloutObjects.ok) return calloutObjects;
  const callouts = validateSafetyCallouts(calloutObjects.value, { allowEmptyBody: true });
  if (!callouts.ok) return callouts;

  const flags = flagsFromLines(raw.flags, repairs);
  if (!flags.ok) return flags;
  const answers = answersFromText(raw.answers, context.questions ?? [], repairs);
  if (!answers.ok) return answers;

  const reply: WeeklyReply = {
    headline: headline.value,
    flags: flags.value,
    answers: answers.value,
    analysis: analysis.value,
    prescribedWeek: plan.value.week,
  };
  if (bullets.value !== undefined) {
    reply.settingsProposalBullets = bullets.value;
  }
  if (callouts.value !== undefined && callouts.value.length > 0) {
    reply.safetyCallouts = callouts.value;
  }
  repairs.push(...(callouts.repairs ?? []));
  const result = withRepairs(reply, repairs.length > 0 ? repairs : undefined);
  // Days that did not parse: the adapter asks once for those dates alone, and
  // takes only them from the retry; the read and every other day stay as sent.
  const planRetry = planLineRetry<WeeklyReply>({
    box: "plan",
    failures: plan.value.failures,
    dates: expectedPlanDates(weekStartMonday),
    weekStartMonday,
    unit,
    boxOf: (retry) =>
      isPlainObject(retry) && typeof retry.plan === "string" && retry.plan.trim().length > 0
        ? { ok: true, value: retry.plan }
        : { ok: false, error: "plan is required: seven lines, one per day" },
    withDays: (replaced) => ({
      ...reply,
      prescribedWeek: {
        ...reply.prescribedWeek,
        days: reply.prescribedWeek.days.map((d) => replaced.get(d.date) ?? d),
      },
    }),
  });
  if (planRetry) result.planRetry = planRetry;
  return result;
}

/**
 * The final check on a weekly reply in the stored shape, as any port hands it
 * to the route: the read's parts, a plan of seven days for the plan week, and
 * the notices. It never reshapes; a reply that fails it is refused.
 */
export function checkWeeklyReply(
  raw: unknown,
  weekStartMonday: string,
): SchemaResult<WeeklyReply> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "weekly reply must be an object" };
  }
  const repairs: string[] = [];
  const headline = parseHeadline(raw.headline, repairs);
  if (!headline.ok) return headline;
  const analysis = parseAnalysis(raw.analysis);
  if (!analysis.ok) return analysis;

  const prescribed = validatePrescribedWeek(raw.prescribedWeek, weekStartMonday);
  if (!prescribed.ok) return prescribed;

  const bullets = parseSettingsProposalBullets(raw.settingsProposalBullets);
  if (!bullets.ok) return bullets;
  const callouts = validateSafetyCallouts(raw.safetyCallouts, { allowEmptyBody: true });
  if (!callouts.ok) return callouts;

  const flags = parseReadFlags(raw.flags, repairs);
  if (!flags.ok) return flags;
  const answers = parseReadAnswers(raw.answers);
  if (!answers.ok) return answers;

  const reply: WeeklyReply = {
    headline: headline.value,
    flags: flags.value,
    answers: answers.value,
    analysis: analysis.value,
    prescribedWeek: prescribed.value,
  };
  if (bullets.value !== undefined) {
    reply.settingsProposalBullets = bullets.value;
  }
  if (callouts.value !== undefined && callouts.value.length > 0) {
    reply.safetyCallouts = callouts.value;
  }
  repairs.push(...(prescribed.repairs ?? []), ...(callouts.repairs ?? []));
  return withRepairs(reply, repairs.length > 0 ? repairs : undefined);
}

function parseHeadline(raw: unknown, repairs: string[]): SchemaResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "headline is required and must be non-empty" };
  }
  let headline = raw.trim();
  if (headline.length > MAX_HEADLINE_LENGTH) {
    const cut = cutAtWord(headline, MAX_HEADLINE_LENGTH);
    repairs.push(`headline cut from ${headline.length} to ${cut.length} chars`);
    headline = cut;
  }
  return { ok: true, value: headline };
}

function parseAnalysis(raw: unknown): SchemaResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "analysis is required and must be non-empty" };
  }
  if (raw.length > MAX_ANALYSIS_LENGTH) {
    return {
      ok: false,
      error: `analysis must be at most ${MAX_ANALYSIS_LENGTH} characters`,
    };
  }
  return { ok: true, value: raw.trim() };
}

/**
 * The plan box parsed into the stored week. Each date that failed, each
 * dropped out-of-week line and each line with no day is noted in `repairs`.
 */
function parsePlanBox(
  raw: unknown,
  weekStartMonday: string,
  unit: TempoUnitPreference,
  repairs: string[],
): SchemaResult<{ week: PrescribedWeek; failures: PlanLineFailure[] }> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "plan is required: seven lines, one per day" };
  }
  const parsed = parsePlanLines({ text: raw, weekStartMonday, unit });
  const dates = new Set(expectedPlanDates(weekStartMonday));
  const withLine = parsed.days.filter((d) => d.line != null);
  if (withLine.length === 0) {
    return {
      ok: false,
      error: `plan has no line for any day from ${weekStartMonday} to ${addDaysYmd(weekStartMonday, 6)}`,
    };
  }
  for (const f of parsed.failures) {
    repairs.push(
      dates.has(f.date)
        ? `plan ${f.date} not filed: ${f.reason}`
        : `plan line for ${f.date} dropped: ${f.reason}`,
    );
  }
  for (const line of parsed.ignoredLines) {
    const quoted =
      line.length > IGNORED_LINE_QUOTE ? `${line.slice(0, IGNORED_LINE_QUOTE)}…` : line;
    repairs.push(`plan line with no day ignored: ${JSON.stringify(quoted)}`);
  }
  return {
    ok: true,
    value: {
      week: { week: isoWeekOfDate(weekStartMonday), days: parsed.days },
      failures: parsed.failures,
    },
  };
}

/**
 * A box of lines as Coach Cade sends it: one string, one item per line. Absent
 * or null is absent. A list of strings (the form before every box was text) is
 * joined with `joiner` and noted in `repairs`, so a model that still sends a
 * list is not refused; anything else is refused.
 */
function boxText(
  raw: unknown,
  field: string,
  repairs: string[],
  joiner = "\n",
): SchemaResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    repairs.push(`${field} sent as a list of ${raw.length}, read as lines`);
    return { ok: true, value: raw.join(joiner) };
  }
  return { ok: false, error: `${field} must be a string, one per line` };
}

/**
 * A box's lines, split as the plan box is (real and escaped newlines; see
 * {@link splitLines}), trimmed, blank lines dropped.
 */
function linesOf(raw: unknown, field: string, repairs: string[]): SchemaResult<string[]> {
  const text = boxText(raw, field, repairs);
  if (!text.ok) return text;
  if (text.value === null) return { ok: true, value: [] };
  return {
    ok: true,
    value: splitLines(text.value)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

/**
 * "Title: detail" lines, split on the first colon. A line with no colon (or
 * nothing on one side of it) is all title, kept to the detail's length. Past
 * {@link MAX_READ_FLAGS} lines the rest are dropped and noted.
 */
function flagsFromLines(raw: unknown, repairs: string[]): SchemaResult<ReadFlag[]> {
  const lines = linesOf(raw, "flags", repairs);
  if (!lines.ok) return lines;
  let kept = lines.value;
  if (kept.length > MAX_READ_FLAGS) {
    repairs.push(
      `flags had ${kept.length} lines: the first ${MAX_READ_FLAGS} kept, ${kept.length - MAX_READ_FLAGS} dropped`,
    );
    kept = kept.slice(0, MAX_READ_FLAGS);
  }
  return {
    ok: true,
    value: kept.map((line, i) => {
      const colon = line.indexOf(":");
      const title = colon > 0 ? line.slice(0, colon).trim() : "";
      const detail = colon > 0 ? line.slice(colon + 1).trim() : "";
      if (!title || !detail) {
        return { title: fitText(line, MAX_FLAG_DETAIL_LENGTH, `flags[${i}]`, repairs), detail: "" };
      }
      return {
        title: fitText(title, MAX_FLAG_TITLE_LENGTH, `flags[${i}].title`, repairs),
        detail: fitText(detail, MAX_FLAG_DETAIL_LENGTH, `flags[${i}].detail`, repairs),
      };
    }),
  };
}

/**
 * The answer box: one markdown string, stored as one answer. Its question is
 * the athlete's check-in question when they asked exactly one, and empty
 * otherwise, since Cadence cannot tell which part answers which question.
 * Empty, absent or null: no answer. A list (the earlier form) is joined into
 * paragraphs and noted.
 */
function answersFromText(
  raw: unknown,
  questions: readonly string[],
  repairs: string[],
): SchemaResult<ReadAnswer[]> {
  const text = boxText(raw, "answers", repairs, "\n\n");
  if (!text.ok) return text;
  const answer = text.value?.trim() ?? "";
  if (!answer) return { ok: true, value: [] };
  return {
    ok: true,
    value: [{ question: questions.length === 1 ? questions[0]!.trim() : "", answer }],
  };
}

const BULLET_MARKER_RE = /^[-*]\s+/;

/**
 * About you suggestion lines into the stored bullets: a leading "- " or "* "
 * is stripped, then the stored check applies (count and length). Absent,
 * null or no lines: absent.
 */
function bulletsFromLines(raw: unknown, repairs: string[]): SchemaResult<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const lines = linesOf(raw, "settingsProposalBullets", repairs);
  if (!lines.ok) return lines;
  const bullets = lines.value
    .map((line) => line.replace(BULLET_MARKER_RE, "").trim())
    .filter((line) => line.length > 0);
  if (bullets.length > MAX_SETTINGS_PROPOSAL_BULLETS) {
    return {
      ok: false,
      error: `settingsProposalBullets must have at most ${MAX_SETTINGS_PROPOSAL_BULLETS} lines`,
    };
  }
  return parseSettingsProposalBullets(bullets);
}

const CALLOUT_SEVERITY_RE = /^\s*(urgent|caution|info)\s*:\s*/i;
const FIRST_SENTENCE_RE = /^([\s\S]+?[.!?])(?:\s+([\s\S]*))?$/;

/**
 * Notice lines into today's callout shape: a leading "Urgent:", "Caution:"
 * or "Info:" sets the severity (else caution); the first sentence is the
 * title and the rest the body. A first sentence too long for a title is cut
 * for the title and kept whole in the body, so nothing is lost.
 */
function calloutsFromLines(
  raw: unknown,
  repairs: string[],
): SchemaResult<SafetyCallout[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const lines = linesOf(raw, "safetyCallouts", repairs);
  if (!lines.ok) return lines;
  if (lines.value.length > MAX_SAFETY_CALLOUTS) {
    return { ok: false, error: `safetyCallouts must have at most ${MAX_SAFETY_CALLOUTS} lines` };
  }
  return {
    ok: true,
    value: lines.value.flatMap((line): SafetyCallout[] => {
      const severityMatch = CALLOUT_SEVERITY_RE.exec(line);
      const severity = (severityMatch?.[1]?.toLowerCase() ?? "caution") as SafetyCalloutSeverity;
      const text = severityMatch ? line.slice(severityMatch[0].length).trim() : line;
      if (!text) return [];
      const sentence = FIRST_SENTENCE_RE.exec(text);
      const first = sentence ? sentence[1]!.trim() : text;
      const rest = sentence ? (sentence[2] ?? "").trim() : "";
      if (first.length > MAX_SAFETY_CALLOUT_TITLE) {
        return [{ title: cutAtWord(first, MAX_SAFETY_CALLOUT_TITLE), body: text, severity }];
      }
      return [{ title: first, body: rest, severity }];
    }),
  };
}

/** A text field cut at a word past `max`, with the cut noted in `repairs`. */
function fitText(text: string, max: number, path: string, repairs: string[]): string {
  if (text.length <= max) return text;
  const cut = cutAtWord(text, max);
  repairs.push(`${path} cut from ${text.length} to ${cut.length} chars`);
  return cut;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Stored flags: a non-empty title; the detail may be empty (a line with no colon). */
function parseReadFlags(raw: unknown, repairs: string[]): SchemaResult<ReadFlag[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "flags must be an array" };
  if (raw.length > MAX_READ_FLAGS) {
    return { ok: false, error: `flags must have at most ${MAX_READ_FLAGS} items` };
  }
  const flags: ReadFlag[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const title = isPlainObject(item) ? nonEmptyString(item.title) : null;
    const detail = isPlainObject(item) && typeof item.detail === "string" ? item.detail.trim() : null;
    if (!title || detail === null) {
      return { ok: false, error: `flags[${i}] needs a non-empty title and a detail` };
    }
    flags.push({
      title: fitText(title, MAX_FLAG_DETAIL_LENGTH, `flags[${i}].title`, repairs),
      detail: fitText(detail, MAX_FLAG_DETAIL_LENGTH, `flags[${i}].detail`, repairs),
    });
  }
  return { ok: true, value: flags };
}

/** Stored answers: a non-empty answer; the question may be empty. */
function parseReadAnswers(raw: unknown): SchemaResult<ReadAnswer[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "answers must be an array" };
  if (raw.length > MAX_READ_ANSWERS) {
    return { ok: false, error: `answers must have at most ${MAX_READ_ANSWERS} items` };
  }
  const answers: ReadAnswer[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const question =
      isPlainObject(item) && typeof item.question === "string" ? item.question.trim() : null;
    const answer = isPlainObject(item) ? nonEmptyString(item.answer) : null;
    if (question === null || !answer) {
      return { ok: false, error: `answers[${i}] needs a question and a non-empty answer` };
    }
    answers.push({ question, answer });
  }
  return { ok: true, value: answers };
}

function parseSettingsProposalBullets(
  raw: unknown,
): SchemaResult<string[] | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "settingsProposalBullets must be an array of strings",
    };
  }
  if (raw.length > MAX_SETTINGS_PROPOSAL_BULLETS) {
    return {
      ok: false,
      error: `settingsProposalBullets must have at most ${MAX_SETTINGS_PROPOSAL_BULLETS} items`,
    };
  }
  const settingsProposalBullets: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const bullet = raw[i];
    if (typeof bullet !== "string" || bullet.trim().length === 0) {
      return {
        ok: false,
        error: `settingsProposalBullets[${i}] must be a non-empty string`,
      };
    }
    if (bullet.length > MAX_BULLET_LENGTH) {
      return {
        ok: false,
        error: `settingsProposalBullets[${i}] must be at most ${MAX_BULLET_LENGTH} characters`,
      };
    }
    settingsProposalBullets.push(bullet.trim());
  }
  return { ok: true, value: settingsProposalBullets };
}

export function expectedPlanDates(weekStartMonday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStartMonday, i));
}

/**
 * The stored check on mid-week changed days (#38): each a full PrescribedDay
 * for a distinct date in the plan week, keeping its plan-line fields (`line`,
 * `parsed`). It reads the reply as Cadence stores it, never Coach Cade's form;
 * the form's `changes` lines are read by {@link validateMidWeekChatReply}.
 */
export function validatePrescribedDayPatches(
  raw: unknown,
  weekStartMonday: string,
): SchemaResult<PrescribedDay[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "prescribedDayPatches must be an array" };
  }
  if (raw.length === 0) return { ok: true, value: undefined };
  if (raw.length > 7) {
    return {
      ok: false,
      error: "prescribedDayPatches must have at most 7 entries",
    };
  }
  if (!DATE_RE.test(weekStartMonday)) {
    return { ok: false, error: "weekStartMonday must be YYYY-MM-DD" };
  }
  const expected = expectedPlanDates(weekStartMonday);
  const expectedIndex = new Map(expected.map((d, i) => [d, i]));
  const seen = new Set<string>();
  const patches: PrescribedDay[] = [];
  const repairs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const dateRaw =
      isPlainObject(raw[i]) && typeof raw[i].date === "string"
        ? raw[i].date
        : null;
    if (!dateRaw || !DATE_RE.test(dateRaw)) {
      return {
        ok: false,
        error: `prescribedDayPatches[${i}].date must be YYYY-MM-DD`,
      };
    }
    const dayIndex = expectedIndex.get(dateRaw);
    if (dayIndex === undefined) {
      return {
        ok: false,
        error: `prescribedDayPatches[${i}].date ${dateRaw} is outside the plan week`,
      };
    }
    if (seen.has(dateRaw)) {
      return {
        ok: false,
        error: `prescribedDayPatches duplicate date ${dateRaw}`,
      };
    }
    seen.add(dateRaw);
    const dayRepairs: string[] = [];
    const parsed = parseDay(raw[i], dayIndex, dateRaw, dayRepairs, true);
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error.replace(
          `prescribedWeek.days[${dayIndex}]`,
          `prescribedDayPatches[${i}]`,
        ),
      };
    }
    patches.push(parsed.value);
    repairs.push(
      ...dayRepairs.map((r) =>
        r.replace(`prescribedWeek.days[${dayIndex}]`, `prescribedDayPatches[${i}]`),
      ),
    );
  }
  return withRepairs(patches, repairs.length > 0 ? repairs : undefined);
}

/** What Cadence knows beside Coach Cade's mid-week form when it reads it. */
export type MidWeekReplyContext = {
  /** The athlete's distance unit; labels the plan, never resolves a bare number. Default imperial. */
  unit?: TempoUnitPreference;
};

/**
 * A mid-week form read into the stored reply. `planFailures` lists each date
 * of the plan week whose `changes` line did not parse, with the reason, so a
 * retry can quote them; the day is stored unparsed meanwhile. Absent when
 * every line parsed.
 */
export type MidWeekReplyOk = SchemaOk<MidWeekChatReply> & {
  planFailures?: PlanLineFailure[];
};

/**
 * Coach Cade's mid-week form (every box text, lines or a boolean, "The forms"
 * in .scratch/plan-as-text/spec.md) turned into the reply Cadence stores.
 *
 * - The `changes` box is read line by line against the plan week. Only dates
 *   with a line change: a line that parses is the new day; one that does not
 *   is stored unparsed (`parsed: false`, its line in notes), noted as a repair
 *   and listed in `planFailures`, and the reply stays valid. A date with no
 *   line is not a change. A line for a date outside the week, and a line with
 *   no day, are dropped and noted as repairs. Empty or absent: no change.
 * - Whether a changed day is in the past is the route's call (it knows the
 *   athlete's today), as is honouring `allowPastDayPatches`.
 * - Notices and settings bullets are read as on the weekly form: lines, null
 *   reads as absent, blank entries dropped.
 *
 * `weekStartMonday` is needed only when the `changes` box has text.
 */
export function validateMidWeekChatReply(
  raw: unknown,
  weekStartMonday?: string,
  context: MidWeekReplyContext = {},
): MidWeekReplyOk | SchemaErr {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "mid-week chat reply must be an object" };
  }
  const markupField = fieldWithToolMarkup(raw);
  if (markupField) return toolMarkupError(markupField);
  const repairs: string[] = [];
  const body = parseMidWeekBody(raw.body);
  if (!body.ok) return body;

  const bullets = bulletsFromLines(raw.settingsProposalBullets, repairs);
  if (!bullets.ok) return bullets;

  const calloutObjects = calloutsFromLines(raw.safetyCallouts, repairs);
  if (!calloutObjects.ok) return calloutObjects;
  const callouts = validateSafetyCallouts(calloutObjects.value, { allowEmptyBody: true });
  if (!callouts.ok) return callouts;

  if (
    raw.allowPastDayPatches !== undefined &&
    raw.allowPastDayPatches !== null &&
    typeof raw.allowPastDayPatches !== "boolean"
  ) {
    return { ok: false, error: "allowPastDayPatches must be a boolean" };
  }

  const changes = parseChangesBox(raw.changes, weekStartMonday, context.unit ?? "imperial", repairs);
  if (!changes.ok) return changes;

  const reply: MidWeekChatReply = { body: body.value };
  if (bullets.value !== undefined) {
    reply.settingsProposalBullets = bullets.value;
  }
  if (callouts.value !== undefined && callouts.value.length > 0) {
    reply.safetyCallouts = callouts.value;
  }
  if (changes.value.days.length > 0) {
    reply.prescribedDayPatches = changes.value.days;
  }
  if (raw.allowPastDayPatches === true) {
    reply.allowPastDayPatches = true;
  }
  repairs.push(...(callouts.repairs ?? []));
  const ok: MidWeekReplyOk = withRepairs(reply, repairs.length > 0 ? repairs : undefined);
  if (changes.value.failures.length > 0) ok.planFailures = changes.value.failures;
  return ok;
}

/**
 * The final check on a mid-week reply in the stored shape, as any port hands
 * it to the route: the body, settings bullets, notices and the changed days.
 * It never reshapes; a reply that fails it is refused.
 */
export function checkMidWeekChatReply(
  raw: unknown,
  weekStartMonday?: string,
): SchemaResult<MidWeekChatReply> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "mid-week chat reply must be an object" };
  }
  const body = parseMidWeekBody(raw.body);
  if (!body.ok) return body;
  const bullets = parseSettingsProposalBullets(raw.settingsProposalBullets);
  if (!bullets.ok) return bullets;
  const callouts = validateSafetyCallouts(raw.safetyCallouts, { allowEmptyBody: true });
  if (!callouts.ok) return callouts;

  let patches: PrescribedDay[] | undefined;
  let patchRepairs: string[] | undefined;
  if (raw.prescribedDayPatches !== undefined) {
    if (!weekStartMonday) {
      return {
        ok: false,
        error: "prescribedDayPatches require weekStartMonday for validation",
      };
    }
    const checked = validatePrescribedDayPatches(raw.prescribedDayPatches, weekStartMonday);
    if (!checked.ok) return checked;
    patches = checked.value;
    patchRepairs = checked.repairs;
  }

  if (
    raw.allowPastDayPatches !== undefined &&
    typeof raw.allowPastDayPatches !== "boolean"
  ) {
    return { ok: false, error: "allowPastDayPatches must be a boolean" };
  }

  const reply: MidWeekChatReply = { body: body.value };
  if (bullets.value !== undefined) {
    reply.settingsProposalBullets = bullets.value;
  }
  if (callouts.value !== undefined && callouts.value.length > 0) {
    reply.safetyCallouts = callouts.value;
  }
  if (patches && patches.length > 0) {
    reply.prescribedDayPatches = patches;
  }
  if (raw.allowPastDayPatches === true) {
    reply.allowPastDayPatches = true;
  }
  const repairs = [...(patchRepairs ?? []), ...(callouts.repairs ?? [])];
  return withRepairs(reply, repairs.length > 0 ? repairs : undefined);
}

function parseMidWeekBody(raw: unknown): SchemaResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "body is required and must be non-empty" };
  }
  if (raw.length > MAX_ANALYSIS_LENGTH) {
    return {
      ok: false,
      error: `body must be at most ${MAX_ANALYSIS_LENGTH} characters`,
    };
  }
  return { ok: true, value: raw.trim() };
}

/**
 * The mid-week `changes` box read against the plan week: the days that have a
 * line (parsed or not), and the dates of the week whose line did not parse.
 * Dates with no line are not changes. Dropped and failed lines are noted in
 * `repairs`.
 */
function parseChangesBox(
  raw: unknown,
  weekStartMonday: string | undefined,
  unit: TempoUnitPreference,
  repairs: string[],
): SchemaResult<{ days: PrescribedDay[]; failures: PlanLineFailure[] }> {
  const none = { ok: true as const, value: { days: [], failures: [] } };
  if (raw === undefined || raw === null) return none;
  if (typeof raw !== "string") {
    return { ok: false, error: "changes must be a string of plan lines" };
  }
  if (raw.trim().length === 0) return none;
  if (!weekStartMonday || !DATE_RE.test(weekStartMonday)) {
    return { ok: false, error: "changes require weekStartMonday (YYYY-MM-DD) for validation" };
  }
  const parsed = parsePlanLines({ text: raw, weekStartMonday, unit });
  const dates = new Set(expectedPlanDates(weekStartMonday));
  const failures: PlanLineFailure[] = [];
  for (const f of parsed.failures) {
    if (f.reason === "no line") continue;
    if (dates.has(f.date)) {
      failures.push(f);
      repairs.push(`changes ${f.date} not filed: ${f.reason}`);
    } else {
      repairs.push(`changes line for ${f.date} dropped: ${f.reason}`);
    }
  }
  for (const line of parsed.ignoredLines) {
    const quoted =
      line.length > IGNORED_LINE_QUOTE ? `${line.slice(0, IGNORED_LINE_QUOTE)}…` : line;
    repairs.push(`changes line with no day ignored: ${JSON.stringify(quoted)}`);
  }
  return {
    ok: true,
    value: { days: parsed.days.filter((d) => d.line != null), failures },
  };
}

/**
 * The retry for a mid-week reply whose `changes` lines did not all parse,
 * driven by the validator's `planFailures`: the retry's `changes` box is read
 * for those dates alone, and each one that now parses replaces that date's
 * changed day; every other change, the body and the notices stay as sent.
 * Undefined when every line parsed.
 */
export function midWeekPlanRetry(
  ok: MidWeekReplyOk,
  weekStartMonday: string,
  unit: TempoUnitPreference = "imperial",
): PlanRetry<MidWeekChatReply> | undefined {
  const failures = ok.planFailures ?? [];
  if (failures.length === 0) return undefined;
  const reply = ok.value;
  return planLineRetry<MidWeekChatReply>({
    box: "changes",
    failures,
    dates: failures.map((f) => f.date),
    weekStartMonday,
    unit,
    boxOf: (retry) =>
      isPlainObject(retry) && typeof retry.changes === "string" && retry.changes.trim().length > 0
        ? { ok: true, value: retry.changes }
        : { ok: false, error: "changes are required: one line for each date asked about" },
    withDays: (replaced) => ({
      ...reply,
      ...(reply.prescribedDayPatches
        ? { prescribedDayPatches: reply.prescribedDayPatches.map((d) => replaced.get(d.date) ?? d) }
        : {}),
    }),
  });
}

function validateDossierSoftGateDraft(
  raw: unknown,
  label: string,
): SchemaResult<DossierV1Draft> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `${label} must be an object` };
  }

  if (!Array.isArray(raw.summaryBullets)) {
    return { ok: false, error: "summaryBullets must be an array of strings" };
  }
  if (raw.summaryBullets.length === 0) {
    return { ok: false, error: "summaryBullets must be non-empty" };
  }
  if (raw.summaryBullets.length > MAX_DOSSIER_SUMMARY_BULLETS) {
    return {
      ok: false,
      error: `summaryBullets must have at most ${MAX_DOSSIER_SUMMARY_BULLETS} items`,
    };
  }

  const summaryBullets: string[] = [];
  for (let i = 0; i < raw.summaryBullets.length; i++) {
    const bullet = raw.summaryBullets[i];
    if (typeof bullet !== "string" || bullet.trim().length === 0) {
      return {
        ok: false,
        error: `summaryBullets[${i}] must be a non-empty string`,
      };
    }
    if (bullet.length > MAX_BULLET_LENGTH) {
      return {
        ok: false,
        error: `summaryBullets[${i}] must be at most ${MAX_BULLET_LENGTH} characters`,
      };
    }
    summaryBullets.push(bullet.trim());
  }

  const proposedBody = raw.proposedBody;
  if (typeof proposedBody !== "string" || proposedBody.trim().length === 0) {
    return { ok: false, error: "proposedBody is required and must be non-empty" };
  }
  if (proposedBody.length > MAX_DOSSIER_BODY_LENGTH) {
    return {
      ok: false,
      error: `proposedBody must be at most ${MAX_DOSSIER_BODY_LENGTH} characters`,
    };
  }

  return {
    ok: true,
    value: {
      summaryBullets,
      proposedBody: proposedBody.trim(),
    },
  };
}

/**
 * Fail-closed validation for onboarding → dossier v1 soft-gate draft.
 */
export function validateDossierV1Draft(raw: unknown): SchemaResult<DossierV1Draft> {
  return validateDossierSoftGateDraft(raw, "dossier v1 draft");
}

/**
 * Fail-closed validation for athlete correction → dossier rewrite draft (#18).
 */
export function validateDossierCorrectionDraft(
  raw: unknown,
): SchemaResult<DossierCorrectionDraft> {
  return validateDossierSoftGateDraft(raw, "dossier correction draft");
}

/**
 * Fail-closed validation for dossier audit/trim soft-gate draft (#40).
 */
export function validateDossierAuditDraft(
  raw: unknown,
): SchemaResult<DossierAuditDraft> {
  return validateDossierSoftGateDraft(raw, "dossier audit draft");
}
