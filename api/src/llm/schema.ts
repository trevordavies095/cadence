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
import { parsePlanLines } from "../prescribed/planLines.js";
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

/** `repairs` notes soft fields the validator fixed instead of refusing. */
export type SchemaOk<T> = { ok: true; value: T; repairs?: string[] };
export type SchemaErr = { ok: false; error: string };
export type SchemaResult<T> = SchemaOk<T> | SchemaErr;

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
export function validateWeeklyReply(
  raw: unknown,
  weekStartMonday: string,
  context: WeeklyReplyContext = {},
): SchemaResult<WeeklyReply> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "weekly reply must be an object" };
  }
  if (!DATE_RE.test(weekStartMonday)) {
    return { ok: false, error: "weekStartMonday must be YYYY-MM-DD" };
  }
  const repairs: string[] = [];

  const headline = parseHeadline(raw.headline, repairs);
  if (!headline.ok) return headline;
  const analysis = parseAnalysis(raw.analysis);
  if (!analysis.ok) return analysis;

  const plan = parsePlanBox(raw.plan, weekStartMonday, context.unit ?? "imperial", repairs);
  if (!plan.ok) return plan;

  const bulletLines =
    raw.settingsProposalBullets === undefined || raw.settingsProposalBullets === null
      ? null
      : linesOf(raw.settingsProposalBullets, "settingsProposalBullets", MAX_SETTINGS_PROPOSAL_BULLETS, repairs);
  if (bulletLines && !bulletLines.ok) return bulletLines;
  const bullets = parseSettingsProposalBullets(bulletLines?.value);
  if (!bullets.ok) return bullets;

  const calloutObjects = calloutsFromLines(raw.safetyCallouts, repairs);
  if (!calloutObjects.ok) return calloutObjects;
  const callouts = validateSafetyCallouts(calloutObjects.value, { allowEmptyBody: true });
  if (!callouts.ok) return callouts;

  const flags = flagsFromLines(raw.flags, repairs);
  if (!flags.ok) return flags;
  const answers = answersFromLines(raw.answers, context.questions ?? [], repairs);
  if (!answers.ok) return answers;

  const reply: WeeklyReply = {
    headline: headline.value,
    flags: flags.value,
    answers: answers.value,
    analysis: analysis.value,
    prescribedWeek: plan.value,
  };
  if (bullets.value !== undefined) {
    reply.settingsProposalBullets = bullets.value;
  }
  if (callouts.value !== undefined && callouts.value.length > 0) {
    reply.safetyCallouts = callouts.value;
  }
  repairs.push(...(callouts.repairs ?? []));
  return withRepairs(reply, repairs.length > 0 ? repairs : undefined);
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
): SchemaResult<PrescribedWeek> {
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
    value: { week: isoWeekOfDate(weekStartMonday), days: parsed.days },
  };
}

/**
 * A list of lines. Absent or null is empty (some models send an optional box as
 * null); an entry that is not a string is refused; an empty or blank entry is
 * dropped and noted in `repairs`. The count is checked after the drop.
 */
function linesOf(
  raw: unknown,
  field: string,
  max: number,
  repairs: string[],
): SchemaResult<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${field} must be a list of strings` };
  }
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string") {
      return { ok: false, error: `${field}[${i}] must be a string` };
    }
    if (item.trim().length > 0) lines.push(item.trim());
    else repairs.push(`${field}[${i}] was empty and was dropped`);
  }
  if (lines.length > max) {
    return { ok: false, error: `${field} must have at most ${max} items` };
  }
  return { ok: true, value: lines };
}

/**
 * "Title: detail" lines, split on the first colon. A line with no colon (or
 * nothing on one side of it) is all title, kept to the detail's length.
 */
function flagsFromLines(raw: unknown, repairs: string[]): SchemaResult<ReadFlag[]> {
  const lines = linesOf(raw, "flags", MAX_READ_FLAGS, repairs);
  if (!lines.ok) return lines;
  return {
    ok: true,
    value: lines.value.map((line, i) => {
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
 * One answer per string. Coach Cade sends answers only; the stored question is
 * the athlete's check-in question when there are exactly as many answers as
 * check-in questions (answered in order), and empty otherwise, since Cadence
 * cannot tell then which answer is for which question.
 */
function answersFromLines(
  raw: unknown,
  questions: readonly string[],
  repairs: string[],
): SchemaResult<ReadAnswer[]> {
  const lines = linesOf(raw, "answers", MAX_READ_ANSWERS, repairs);
  if (!lines.ok) return lines;
  const paired = questions.length === lines.value.length;
  return {
    ok: true,
    value: lines.value.map((answer, i) => ({
      question: paired ? questions[i]!.trim() : "",
      answer,
    })),
  };
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
  const lines = linesOf(raw, "safetyCallouts", MAX_SAFETY_CALLOUTS, repairs);
  if (!lines.ok) return lines;
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
 * Fail-closed validation for optional mid-week prescribed day patches (#38).
 * Each patch must be a full PrescribedDay for a date in the plan week.
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
    const parsed = parseDay(raw[i], dayIndex, dateRaw, dayRepairs);
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

/**
 * Fail-closed validation for mid-week chat replies (body + optional
 * settings-proposal bullets + callouts + optional prescribed day patches).
 *
 * When patches are present, `weekStartMonday` is required (plan week Monday).
 */
export function validateMidWeekChatReply(
  raw: unknown,
  weekStartMonday?: string,
): SchemaResult<MidWeekChatReply> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "mid-week chat reply must be an object" };
  }
  const body = raw.body;
  if (typeof body !== "string" || body.trim().length === 0) {
    return { ok: false, error: "body is required and must be non-empty" };
  }
  if (body.length > MAX_ANALYSIS_LENGTH) {
    return {
      ok: false,
      error: `body must be at most ${MAX_ANALYSIS_LENGTH} characters`,
    };
  }
  const bullets = parseSettingsProposalBullets(raw.settingsProposalBullets);
  if (!bullets.ok) return bullets;
  const callouts = validateSafetyCallouts(raw.safetyCallouts);
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
    const checked = validatePrescribedDayPatches(
      raw.prescribedDayPatches,
      weekStartMonday,
    );
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

  const reply: MidWeekChatReply = { body: body.trim() };
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
