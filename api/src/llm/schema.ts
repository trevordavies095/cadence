import {
  isSafetyCalloutSeverity,
  MAX_SAFETY_CALLOUT_BODY,
  MAX_SAFETY_CALLOUT_TITLE,
  MAX_SAFETY_CALLOUTS,
} from "./safety.js";
import type {
  DayType,
  DossierAuditDraft,
  DossierCorrectionDraft,
  DossierV1Draft,
  MidWeekChatReply,
  PrescribedDay,
  PrescribedRun,
  PrescribedWeek,
  RunType,
  SafetyCallout,
  WeeklyReply,
} from "./types.js";

export const MAX_ANALYSIS_LENGTH = 4000;
export const MAX_SETTINGS_PROPOSAL_BULLETS = 8;
export const MAX_BULLET_LENGTH = 280;
export const MAX_DOSSIER_SUMMARY_BULLETS = 8;
export const MAX_DOSSIER_BODY_LENGTH = 12000;
export {
  MAX_SAFETY_CALLOUT_BODY,
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

export type SchemaOk<T> = { ok: true; value: T };
export type SchemaErr = { ok: false; error: string };
export type SchemaResult<T> = SchemaOk<T> | SchemaErr;

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
  return run.distanceM <= 0 && !run.structure && !run.paceOrHr;
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

  const distanceM = value.distanceM;
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
  if (structure.value !== undefined) run.structure = structure.value;
  if (paceOrHr.value !== undefined) run.paceOrHr = paceOrHr.value;
  if (shoes.value !== undefined) run.shoes = shoes.value;
  return { ok: true, value: run };
}

function parseDay(
  value: unknown,
  index: number,
  expectedDate: string,
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
    return { ok: false, error: `${path} (${dayType}) requires a run object` };
  }

  const day: PrescribedDay = { date, dayType };
  if (runResult.value !== undefined) day.run = runResult.value;
  if (strength.value !== undefined) day.strength = strength.value;
  if (notes.value !== undefined) day.notes = notes.value;
  return { ok: true, value: day };
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
  for (let i = 0; i < 7; i++) {
    const expected = addDaysYmd(weekStartMonday, i);
    const parsed = parseDay(daysRaw[i], i, expected);
    if (!parsed.ok) return parsed;
    days.push(parsed.value);
  }

  return { ok: true, value: { week, days } };
}

/**
 * Fail-closed validation for optional safety callouts on weekly/mid-week replies.
 */
export function validateSafetyCallouts(
  raw: unknown,
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
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const path = `safetyCallouts[${i}]`;
    if (!isPlainObject(item)) {
      return { ok: false, error: `${path} must be an object` };
    }
    const title = item.title;
    if (typeof title !== "string" || title.trim().length === 0) {
      return { ok: false, error: `${path}.title must be a non-empty string` };
    }
    if (title.length > MAX_SAFETY_CALLOUT_TITLE) {
      return {
        ok: false,
        error: `${path}.title must be at most ${MAX_SAFETY_CALLOUT_TITLE} characters`,
      };
    }
    const body = item.body;
    if (typeof body !== "string" || body.trim().length === 0) {
      return { ok: false, error: `${path}.body must be a non-empty string` };
    }
    if (body.length > MAX_SAFETY_CALLOUT_BODY) {
      return {
        ok: false,
        error: `${path}.body must be at most ${MAX_SAFETY_CALLOUT_BODY} characters`,
      };
    }
    const callout: SafetyCallout = {
      title: title.trim(),
      body: body.trim(),
    };
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
  return { ok: true, value: callouts };
}

/**
 * Fail-closed validation for a full weekly LLM reply.
 */
export function validateWeeklyReply(
  raw: unknown,
  weekStartMonday: string,
): SchemaResult<WeeklyReply> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "weekly reply must be an object" };
  }

  const analysis = raw.analysis;
  if (typeof analysis !== "string" || analysis.trim().length === 0) {
    return { ok: false, error: "analysis is required and must be non-empty" };
  }
  if (analysis.length > MAX_ANALYSIS_LENGTH) {
    return {
      ok: false,
      error: `analysis must be at most ${MAX_ANALYSIS_LENGTH} characters`,
    };
  }

  const prescribed = validatePrescribedWeek(raw.prescribedWeek, weekStartMonday);
  if (!prescribed.ok) return prescribed;

  const bullets = parseSettingsProposalBullets(raw.settingsProposalBullets);
  if (!bullets.ok) return bullets;

  const callouts = validateSafetyCallouts(raw.safetyCallouts);
  if (!callouts.ok) return callouts;

  const reply: WeeklyReply = {
    analysis: analysis.trim(),
    prescribedWeek: prescribed.value,
  };
  if (bullets.value !== undefined) {
    reply.settingsProposalBullets = bullets.value;
  }
  if (callouts.value !== undefined && callouts.value.length > 0) {
    reply.safetyCallouts = callouts.value;
  }
  return { ok: true, value: reply };
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
    const parsed = parseDay(raw[i], dayIndex, dateRaw);
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
  }
  return { ok: true, value: patches };
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
  return { ok: true, value: reply };
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
