import { resolveAppVersion } from "../llmCallLog/appVersion.js";
import type {
  LlmCallOperation,
  LlmCallRecorder,
} from "../llmCallLog/types.js";
import { nextIsoWeekBounds } from "../clock/isoWeek.js";
import {
  formatDayShort,
  formatIsoWeekRangeShort,
  formatWeekRangeShort,
} from "../clock/weekRangeShort.js";
import { goalDateLabel } from "../goal/sentence.js";
import type { GoalKind, TrainingGoal } from "../goal/types.js";
import type { ModelPacket } from "../packet/types.js";
import { LlmSchemaError, type LlmCallOptions, type LlmPort } from "./port.js";
import {
  buildStubSafetyCallouts,
} from "./safety.js";
import {
  expectedPlanDates,
  MAX_BULLET_LENGTH,
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  validateMidWeekChatReply,
  validateWeeklyReply,
} from "./schema.js";
import { COACH_STANCE_SUMMARY } from "./stance.js";
import type {
  DayType,
  DossierAuditDraft,
  DossierAuditInput,
  DossierCorrectionDraft,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  PrescribedDay,
  PrescribedRun,
  PrescribedWeek,
  ReadAnswer,
  ReadFlag,
  WeeklyReply,
} from "./types.js";

/**
 * Resolve the plan week's Monday (YYYY-MM-DD) from a model packet.
 * Prefer `week.start` (week session Monday); fall back to a fixed test Monday.
 */
export function resolvePlanWeekStartMonday(packet: ModelPacket): string {
  const start = packet.week?.start?.trim();
  if (start && /^\d{4}-\d{2}-\d{2}/.test(start)) {
    return start.slice(0, 10);
  }
  return "2026-10-19";
}

/**
 * Resolve the week the WEEKLY reply plans (N+1): Monday date + ISO label.
 * Prefers `packet.planWeek`; otherwise derives the week after `packet.week`.
 * Without either, falls back to {@link resolvePlanWeekStartMonday}.
 * Mid-week chat keeps using {@link resolvePlanWeekStartMonday} (current week).
 */
export function resolveWeeklyPlanWeek(packet: ModelPacket): {
  weekStartMonday: string;
  isoWeek: string | null;
} {
  const pw = packet.planWeek;
  if (
    pw &&
    /^\d{4}-\d{2}-\d{2}$/.test(pw.startDate ?? "") &&
    /^\d{4}-W\d{2}$/.test(pw.isoWeek ?? "")
  ) {
    return { weekStartMonday: pw.startDate, isoWeek: pw.isoWeek };
  }
  const label = packet.week?.isoWeek?.trim();
  if (label && /^\d{4}-W\d{2}$/.test(label)) {
    try {
      const next = nextIsoWeekBounds(label, "UTC");
      return { weekStartMonday: next.startDate, isoWeek: next.isoWeek };
    } catch {
      // fall through
    }
  }
  return {
    weekStartMonday: resolvePlanWeekStartMonday(packet),
    isoWeek: null,
  };
}

function resolveIsoWeekLabel(packet: ModelPacket, weekStartMonday: string): string {
  const label = packet.week?.isoWeek?.trim();
  if (label && /^\d{4}-W\d{2}$/.test(label)) return label;

  // Derive ISO week from the Monday calendar date (UTC noon).
  const [y, m, d] = weekStartMonday.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const isoYear = date.getUTCFullYear();
  const week1 = new Date(Date.UTC(isoYear, 0, 4));
  const isoWeek =
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

/** The goal kind the stub plans for; no goal plans as fitness. */
function stubGoalKind(packet: ModelPacket): GoalKind {
  return packet.goal?.kind ?? "fitness";
}

/** Weekly distance (meters) the stub plans when the report gives no history. */
const STUB_DEFAULT_WEEK_M: Record<Exclude<GoalKind, "return">, number> = {
  race: 40000,
  speed: 30000,
  fitness: 24000,
};

const METERS_PER_MILE = 1609.344;

/** Meters from a report cell such as "42.00 km" or "26.10 mi"; null otherwise. */
function parseDistanceCell(cell: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(km|mi)\s*$/.exec(cell ?? "");
  if (!m) return null;
  const value = Number(m[1]);
  return m[2] === "mi" ? value * METERS_PER_MILE : value * 1000;
}

/** The Mileage row of a report's Summary table: this week and the 3-week average. */
function parseMileageRow(
  md: string | null | undefined,
): { thisWeekM: number | null; threeWkAvgM: number | null } | null {
  const row = /^\|\s*Mileage\s*\|([^\n]*)$/m.exec(md ?? "");
  if (!row) return null;
  const cells = row[1]!.split("|").map((c) => c.trim());
  return {
    thisWeekM: parseDistanceCell(cells[0]),
    threeWkAvgM: parseDistanceCell(cells[2]),
  };
}

/**
 * Average weekly distance (meters) over the last four weeks, from the report's
 * Mileage row (this week plus the 3-week average of the weeks before), else
 * from this week and the recent weeks' reports. Null when nothing says.
 */
export function recentWeeklyDistanceM(packet: ModelPacket): number | null {
  const current = parseMileageRow(packet.recapMarkdown);
  if (current?.thisWeekM != null && current.threeWkAvgM != null) {
    const avg = (current.thisWeekM + 3 * current.threeWkAvgM) / 4;
    return avg > 0 ? avg : null;
  }
  const weeks: number[] = [];
  if (current?.thisWeekM != null) weeks.push(current.thisWeekM);
  for (const w of packet.recentHistory ?? []) {
    if (weeks.length >= 4) break;
    const m = parseMileageRow(w.recapMarkdown)?.thisWeekM;
    if (m != null) weeks.push(m);
  }
  if (weeks.length === 0) return null;
  const avg = weeks.reduce((a, b) => a + b, 0) / weeks.length;
  return avg > 0 ? avg : null;
}

type StubDayPattern = {
  dayType: DayType;
  /** Share of the week's distance (distance-based kinds). */
  share?: number;
  /** Planned minutes (return weeks: duration only). */
  minutes?: number;
  structure?: string | null;
  paceOrHr?: string | null;
  shoes?: string | null;
  strength?: string | null;
  notes?: string | null;
};

const REST: StubDayPattern = { dayType: "rest", notes: "Full rest or easy walk." };

/** Race: today's shape, easy / rest / easy / quality / rest / easy / long. */
const RACE_PATTERN: StubDayPattern[] = [
  {
    dayType: "easy",
    share: 8 / 56,
    paceOrHr: "easy pace / conversational",
    shoes: "daily trainer",
    notes: "Keep HR relaxed.",
  },
  REST,
  {
    dayType: "easy",
    share: 10 / 56,
    paceOrHr: "easy pace",
    shoes: "daily trainer",
    strength: "20–30 min core + hip stability",
  },
  {
    dayType: "quality",
    share: 12 / 56,
    structure: "2 mi warm-up + 4×3 min threshold w/ 2 min jog + cool-down",
    paceOrHr: "threshold effort / controlled breathing",
    shoes: "lighter trainer or race flat",
    notes: "Stop if form falls apart.",
  },
  { dayType: "rest", strength: "Optional mobility only." },
  { dayType: "easy", share: 8 / 56, paceOrHr: "easy pace", shoes: "daily trainer" },
  {
    dayType: "long",
    share: 18 / 56,
    paceOrHr: "easy–steady; finish feeling you could do 2 more easy miles",
    shoes: "cushioned long-run shoe",
    notes: "Fuel early; no heroics.",
  },
];

/** Speed: one quality session and one longer run, easy days around them. */
const SPEED_PATTERN: StubDayPattern[] = [
  REST,
  {
    dayType: "quality",
    share: 0.25,
    structure: "15 min easy warm-up, 5 x 3 min at 5K effort with 2 min jog, 10 min cool-down",
    paceOrHr: "5K effort / hard but controlled",
    shoes: "lighter trainer",
    notes: "The one hard session this week. Stop if form falls apart.",
  },
  {
    dayType: "easy",
    share: 0.2,
    paceOrHr: "easy pace / conversational",
    shoes: "daily trainer",
    notes: "Easy the day after the session.",
  },
  { dayType: "rest", strength: "20–30 min core + hip stability" },
  { dayType: "easy", share: 0.2, paceOrHr: "easy pace", shoes: "daily trainer" },
  REST,
  {
    dayType: "long",
    share: 0.35,
    paceOrHr: "easy pace throughout",
    shoes: "daily trainer",
    notes: "Longer, never harder.",
  },
];

/** Fitness: three easy runs and one optional longer run. */
const FITNESS_PATTERN: StubDayPattern[] = [
  REST,
  { dayType: "easy", share: 0.22, paceOrHr: "easy pace / conversational", shoes: "daily trainer" },
  REST,
  {
    dayType: "easy",
    share: 0.22,
    paceOrHr: "easy pace / conversational",
    shoes: "daily trainer",
    strength: "Optional 20 min core + mobility",
  },
  REST,
  { dayType: "easy", share: 0.22, paceOrHr: "easy pace / conversational", shoes: "daily trainer" },
  {
    dayType: "long",
    share: 0.34,
    paceOrHr: "easy pace throughout",
    shoes: "daily trainer",
    notes: "Optional. Skip it or keep it short if the week has been full.",
  },
];

/** Minutes a return session starts from when the starting point gives no number. */
const RETURN_DEFAULT_START_MIN = 15;
/** Minutes added per week since the return began. */
const RETURN_WEEKLY_STEP_MIN = 3;
const RETURN_MAX_MIN = 45;

/** Whole weeks from `since` (YYYY-MM-DD) to the plan week's Monday; 0 when unknown. */
function weeksSince(since: string | undefined, weekStartMonday: string): number {
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) return 0;
  const days =
    (Date.parse(`${weekStartMonday}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) /
    86400000;
  return Number.isFinite(days) && days > 0 ? Math.floor(days / 7) : 0;
}

/**
 * Session minutes for a return week: the number in the starting point (else
 * 15), plus a little for each whole week since the return began, capped.
 */
export function returnSessionMinutes(packet: ModelPacket, weekStartMonday: string): number {
  const m = /(\d+)\s*-?\s*(?:min|mins|minute|minutes)\b/i.exec(
    packet.goal?.startingPoint ?? "",
  );
  const parsed = m ? Number(m[1]) : NaN;
  const start =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, RETURN_MAX_MIN)
      : RETURN_DEFAULT_START_MIN;
  const built =
    start + RETURN_WEEKLY_STEP_MIN * weeksSince(packet.goal?.since, weekStartMonday);
  return Math.min(built, RETURN_MAX_MIN);
}

function walkRunStructure(minutes: number): string {
  const intervals =
    minutes < 20
      ? "1 min run, 2 min walk"
      : minutes < 30
        ? "2 min run, 1 min walk"
        : "4 min run, 1 min walk";
  return `${minutes} min walk-run: ${intervals}, repeated`;
}

/** Return: three walk-run sessions in minutes, rest between. */
function returnPattern(minutes: number): StubDayPattern[] {
  const session = (notes: string): StubDayPattern => ({
    dayType: "easy",
    minutes,
    structure: walkRunStructure(minutes),
    paceOrHr: "very easy; walk whenever you need to",
    shoes: "daily trainer",
    notes,
  });
  return [
    session("Stop and walk home if anything hurts."),
    REST,
    session("Same as Monday. Note how you feel the next morning."),
    { dayType: "rest", strength: "Optional 15 min mobility" },
    REST,
    session("Only if Wednesday felt fine the next day."),
    REST,
  ];
}

/** Round to the nearest 500 m, never under 3 km. */
function roundRunM(m: number): number {
  return Math.max(3000, Math.round(m / 500) * 500);
}

/**
 * Deterministic 7-day plan (Mon–Sun) shaped by the goal kind: race keeps the
 * easy / rest / easy / quality / rest / easy / long week, speed has one quality
 * session and one longer run, fitness three easy runs and an optional longer
 * one, return walk-run sessions in minutes. No goal plans as fitness. Distance
 * kinds scale the week from the last four weeks, else a modest default.
 */
function buildStubDays(packet: ModelPacket, weekStartMonday: string): PrescribedDay[] {
  const dates = expectedPlanDates(weekStartMonday);
  const kind = stubGoalKind(packet);
  let pattern: StubDayPattern[];
  let weekM = 0;
  if (kind === "return") {
    pattern = returnPattern(returnSessionMinutes(packet, weekStartMonday));
  } else {
    pattern =
      kind === "race" ? RACE_PATTERN : kind === "speed" ? SPEED_PATTERN : FITNESS_PATTERN;
    weekM = recentWeeklyDistanceM(packet) ?? STUB_DEFAULT_WEEK_M[kind];
  }

  return dates.map((date, i) => {
    const p = pattern[i]!;
    const day: PrescribedDay = { date, dayType: p.dayType };
    if (p.dayType !== "rest" && (p.share != null || p.minutes != null)) {
      const run: PrescribedRun = {
        type: p.dayType === "quality" || p.dayType === "long" ? p.dayType : "easy",
        distanceM: p.share != null ? roundRunM(p.share * weekM) : 0,
        structure: p.structure ?? null,
        paceOrHr: p.paceOrHr ?? null,
        shoes: p.shoes ?? null,
      };
      if (p.minutes != null) run.durationS = p.minutes * 60;
      day.run = run;
    } else {
      day.run = null;
    }
    if (p.strength !== undefined) day.strength = p.strength;
    if (p.notes !== undefined) day.notes = p.notes;
    return day;
  });
}

/** The second sentence of the headline, by goal kind. */
const STUB_HEADLINE_FOCUS: Record<GoalKind, string> = {
  race: "Protect easy days and land the long run.",
  speed: "Make the one quality session count and keep the rest easy.",
  fitness: "Three easy runs keep you fit, and the longer run is optional.",
  return: "Walk-run sessions, a little longer than last week, and stop if anything hurts.",
};

/** The stub's headline: the same sentence its read opens with. */
function buildStubHeadline(packet: ModelPacket): string {
  const hasRecap = Boolean(packet.recapMarkdown?.trim());
  const kind = stubGoalKind(packet);
  const planRange = packet.planWeek
    ? formatWeekRangeShort(packet.planWeek.startDate, packet.planWeek.endDate)
    : null;
  const weekLabel = planRange ? `Next week (${planRange})` : "Next week";
  if (hasRecap) return `${weekLabel} looks workable. ${STUB_HEADLINE_FOCUS[kind]}`;
  const week = weekLabel.toLowerCase();
  return kind === "return"
    ? `I don't have much to go on for ${week}, so this is a gentle walk-run week.`
    : `I don't have much to go on for ${week}, so this is a conservative base week.`;
}

/** The flag the stub watches when nothing else stands out, by goal kind. */
const STUB_DEFAULT_FLAG: Record<GoalKind, ReadFlag> = {
  race: { title: "Heart rate drift", detail: "Nothing major. Watch drift on easy days." },
  speed: {
    title: "The day after the session",
    detail: "Nothing major. Keep the day after the quality session truly easy.",
  },
  fitness: {
    title: "Easy means easy",
    detail: "Nothing major. Every run this week should feel conversational.",
  },
  return: {
    title: "Pain over pace",
    detail: "Walk or stop if anything hurts, and tell me in your check-in.",
  },
};

/** What the stub watches: the same concerns its read used to list. */
function buildStubFlags(packet: ModelPacket): ReadFlag[] {
  const hasRecap = Boolean(packet.recapMarkdown?.trim());
  const hasDossier = Boolean(packet.dossier?.body?.trim());
  const attachmentCount = packet.attachments?.length ?? 0;
  const flags: ReadFlag[] = [];
  if (hasDossier && /achilles|niggle|pain|sore/i.test(packet.dossier!.body)) {
    flags.push({
      title: "Soft-tissue concern",
      detail: "Your profile mentions one. Cap quality and keep volume honest.",
    });
  }
  if (!hasRecap) {
    flags.push({
      title: "No weekly report",
      detail: "There is no report for this week, so the plan follows a standard template.",
    });
  }
  if (attachmentCount === 0) {
    flags.push({
      title: "No runs attached",
      detail: "I am working from your profile and weekly report only.",
    });
  }
  const kind = stubGoalKind(packet);
  // A return week always watches for pain; other kinds only when nothing else stands out.
  if (flags.length === 0 || kind === "return") {
    flags.push(STUB_DEFAULT_FLAG[kind]);
  }
  return flags;
}

/** The athlete's check-in questions, as they wrote them, from the weekly report. */
function stubQuestions(packet: ModelPacket): string[] {
  const md = packet.recapMarkdown ?? "";
  const section = /^## Questions for coach\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(md);
  if (!section) return [];
  return section[1]!
    .split("\n")
    .map((line) => /^\s*\d+\.\s+(.*\S)\s*$/.exec(line)?.[1] ?? null)
    .filter((q): q is string => q !== null);
}

/** One plain answer per question the athlete asked; none when they asked nothing. */
function buildStubAnswers(packet: ModelPacket): ReadAnswer[] {
  return stubQuestions(packet)
    .slice(0, 8)
    .map((question) => ({
      question,
      answer: "Keep the week as planned and treat rest days as real rest. Ask me again during the week if it still feels off.",
    }));
}

/** The stub's reasoning; the headline, flags and answers are shown above it. */
const STUB_ANALYSIS: Record<GoalKind, string> = {
  race: "Keep quality to one session, shoes as listed, and treat rest days as real rest.",
  speed:
    "One quality session carries the week. The longer run stays easy and rest days are real rest.",
  fitness:
    "Three easy runs hold your fitness. The longer run is a bonus, not a test, and rest days are real rest.",
  return:
    "Walk-run sessions in minutes, not distance, a little longer each week. Rest days are part of the return.",
};

function buildStubAnalysis(packet: ModelPacket): string {
  return ["## Why this plan", STUB_ANALYSIS[stubGoalKind(packet)]].join("\n");
}

function buildStubSettingsBullets(packet: ModelPacket): string[] | undefined {
  const body = packet.dossier?.body?.trim();
  if (!body) return undefined;
  return [
    "Add how this week felt and any lingering niggles to what Coach Cade knows about you.",
  ];
}

/** Pure builder used by the stub port (and tests). */
export function buildStubWeeklyReply(packet: ModelPacket): WeeklyReply {
  const planWeek = resolveWeeklyPlanWeek(packet);
  const weekStartMonday = planWeek.weekStartMonday;
  const week =
    planWeek.isoWeek ?? resolveIsoWeekLabel(packet, weekStartMonday);
  const prescribedWeek: PrescribedWeek = {
    week,
    days: buildStubDays(packet, weekStartMonday),
  };
  const reply: WeeklyReply = {
    headline: buildStubHeadline(packet),
    flags: buildStubFlags(packet),
    answers: buildStubAnswers(packet),
    analysis: buildStubAnalysis(packet),
    prescribedWeek,
  };
  const bullets = buildStubSettingsBullets(packet);
  if (bullets) reply.settingsProposalBullets = bullets;
  const callouts = buildStubSafetyCallouts(packet);
  if (callouts.length > 0) reply.safetyCallouts = callouts;
  return reply;
}

function formatPaceMinPerKm(avgPaceS: number): string {
  const total = Math.max(0, Math.round(avgPaceS));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}/km`;
}

function formatDurationClock(durationS: number): string {
  const total = Math.max(0, Math.round(durationS));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Deterministic attach feedback for stub/CI (issue #37).
 * Uses the latest attachment's coaching metrics only.
 */
export function buildStubAttachedRunFeedback(
  packet: ModelPacket,
): string | null {
  const attachments = packet.attachments ?? [];
  if (attachments.length === 0) return null;
  const run = attachments[attachments.length - 1]!;
  const km = (run.distanceM / 1000).toFixed(1);
  const parts = [
    `${km} km in ${formatDurationClock(run.durationS)}`,
    `avg pace ${formatPaceMinPerKm(run.avgPaceS)}`,
  ];
  if (run.avgHeartRateBpm != null) {
    parts.push(`avg HR ${run.avgHeartRateBpm} bpm`);
  }
  if (run.splitsCount != null && run.splitsCount > 0) {
    parts.push(`${run.splitsCount} splits`);
  }
  const label =
    run.activityName?.trim() ||
    run.runType?.trim() ||
    "Attached run";
  const countNote =
    attachments.length > 1
      ? ` (${attachments.length} attachments in thread; feedback on latest)`
      : "";
  return (
    `Attached run feedback${countNote}: ${label} — ${parts.join(", ")}. ` +
    "Looks usable for coaching from metrics/splits only; keep the rest of the week honest. " +
    "Reminder: do not diagnose — see a clinician if something feels off."
  );
}

/**
 * Significant mid-week memory signals in the athlete's latest note (#39).
 * Kept narrower than packet-wide safety callouts so casual check-ins stay clean.
 */
const STUB_MIDWEEK_MEMORY_RE =
  /\b(achilles|niggle|pain|sore|injury|injured|swelling|flare|skip|skipping|travel|traveling|travelling|sick|illness|constraint|can't run|cannot run)\b/i;

/** Soft-gate bullets when the athlete's mid-week note is memory-worthy (#39). */
function buildStubMidWeekSettingsBullets(
  packet: ModelPacket,
): string[] | undefined {
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  const note = lastAthlete?.body?.trim().replace(/\s+/g, " ");
  if (!note || !STUB_MIDWEEK_MEMORY_RE.test(note)) return undefined;
  // The line lands in About you, so it keeps the athlete's words, whole
  // sentences only and never cut off with an ellipsis (#9).
  const prefix = "You told me: ";
  return [`${prefix}${wholeSentencesUpTo(note, MAX_BULLET_LENGTH - prefix.length)}`];
}

/** Leading sentences of `text` that fit in `max` characters; else whole words. */
function wholeSentencesUpTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let kept = "";
  for (const s of sentences) {
    if ((kept + s).trimEnd().length > max) break;
    kept += s;
  }
  if (kept.trim()) return kept.trimEnd();
  const words = text.slice(0, max + 1).split(" ");
  return words.slice(0, -1).join(" ") || text.slice(0, max);
}

const PLAN_CHANGE_RE =
  /\b(cut|skip|shorten|move|swap|patch|change)\b/i;

/**
 * Deterministic remaining-day plan patch for stub/CI (issue #38).
 * When the athlete asks to change the plan and a prescribed week is present,
 * rest the first quality day (else first easy) from Wednesday onward.
 */
export function buildStubPrescribedDayPatches(
  packet: ModelPacket,
): PrescribedDay[] | undefined {
  const plan = packet.prescribedWeek;
  if (!plan?.days?.length) return undefined;
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  if (!lastAthlete?.body || !PLAN_CHANGE_RE.test(lastAthlete.body)) {
    return undefined;
  }
  const weekStartMonday = resolvePlanWeekStartMonday(packet);
  const fromWed = expectedPlanDates(weekStartMonday)[2]!;
  const remaining = plan.days.filter((d) => d.date >= fromWed);
  const target =
    remaining.find((d) => d.dayType === "quality") ??
    remaining.find((d) => d.dayType === "easy") ??
    remaining[0];
  if (!target) return undefined;
  return [
    {
      date: target.date,
      dayType: "rest",
      run: null,
      notes: "Changed this week: rest and recover. The quality session is moved out.",
    },
  ];
}

/** Pure builder for mid-week free chat + attach/plan patch (issues #35–#39). */
export function buildStubMidWeekChatReply(packet: ModelPacket): MidWeekChatReply {
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  // Acknowledge the note without quoting it back (#9).
  const heard = lastAthlete?.body?.trim()
    ? "Got your note."
    : "Nothing new from you yet.";
  const dossierNote = packet.dossier?.body?.trim()
    ? "I'll keep what I know about you in mind."
    : "I don't have much on file about you yet, so keep easy days honest.";
  const attachFeedback = buildStubAttachedRunFeedback(packet);
  const attachNote =
    attachFeedback ??
    "No run attached. Say more if something needs to change.";
  const patches = buildStubPrescribedDayPatches(packet);
  const patchNote = patches?.length
    ? `Updated the plan for ${patches.map((p) => formatDayShort(p.date)).join(", ")}. Only the days still to come change.`
    : null;
  const reply: MidWeekChatReply = {
    body: [
      "Quick check-in for this week.",
      heard,
      dossierNote,
      attachNote,
      ...(patchNote ? [patchNote] : []),
    ].join(" "),
  };
  if (patches?.length) reply.prescribedDayPatches = patches;
  const bullets = buildStubMidWeekSettingsBullets(packet);
  if (bullets) reply.settingsProposalBullets = bullets;
  const callouts = buildStubSafetyCallouts(packet);
  if (callouts.length > 0) reply.safetyCallouts = callouts;
  return reply;
}
function formatDistanceHint(
  meters: number,
  unit?: "metric" | "imperial",
): string {
  if (unit === "imperial") {
    return `${(meters / 1609.344).toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Soft-gate summary line, at most MAX_BULLET_LENGTH. Long answers keep their
 * leading whole sentences, never an ellipsis (#9); the full text lives in proposedBody.
 */
function dossierSummaryBullet(label: string, value: string): string {
  const prefix = `${label}: `;
  const text = value.trim().replace(/\s+/g, " ");
  return `${prefix}${wholeSentencesUpTo(text, MAX_BULLET_LENGTH - prefix.length)}`;
}

/**
 * A returning runner's own account of where they are now, which the running log cannot
 * tell: kept word for word under Running history. Nothing for other goals.
 */
function returnHistoryLines(goal: TrainingGoal | undefined): string[] {
  if (goal?.kind !== "return") return [];
  const words = goal.startingPoint?.trim();
  if (!words && !goal.since) return [];
  const lines = ["## Running history"];
  lines.push(
    goal.since
      ? `You are getting back to running, since ${goalDateLabel(goal.since)}.`
      : "You are getting back to running.",
  );
  if (words) lines.push(`Where you are now, in your words: ${words}`);
  lines.push("");
  return lines;
}

/** Pure builder for onboarding → dossier v1 (issue #17). */
export function buildStubDossierV1(input: DossierV1Input): DossierV1Draft {
  const { answers, prefills } = input;
  const summaryBullets: string[] = [
    dossierSummaryBullet("Goal", answers.goal),
    dossierSummaryBullet("Schedule", answers.schedule),
  ];
  if (answers.injuries_constraints) {
    summaryBullets.push(
      dossierSummaryBullet("Constraints", answers.injuries_constraints),
    );
  }
  if (answers.preferences) {
    summaryBullets.push(
      dossierSummaryBullet("Preferences", answers.preferences),
    );
  }
  if (prefills.available) {
    const z2 = prefills.heartRateZones?.zones.find((z) => z.zoneNumber === 2);
    if (z2) {
      summaryBullets.push(
        `Easy heart rate zone about ${z2.minBpm}–${z2.maxBpm} bpm (from your running log)`,
      );
    }
    const shoe = prefills.shoes?.[0];
    if (shoe) {
      summaryBullets.push(`Main shoe: ${shoe.brand} ${shoe.model}`);
    }
  } else {
    summaryBullets.push("Your running log was not available, so this comes from your answers only");
  }

  const tempoLines: string[] = [];
  if (prefills.available) {
    if (prefills.unitPreference) {
      tempoLines.push(`- Units: ${prefills.unitPreference}`);
    }
    const zones = prefills.heartRateZones?.zones ?? [];
    if (zones.length > 0) {
      const zoneText = zones
        .map((z) => `Z${z.zoneNumber} ${z.minBpm}–${z.maxBpm}`)
        .join("; ");
      tempoLines.push(`- HR zones: ${zoneText}`);
    }
    if (prefills.shoes && prefills.shoes.length > 0) {
      const shoeText = prefills.shoes
        .slice(0, 5)
        .map((s) => `${s.brand} ${s.model}`)
        .join(", ");
      tempoLines.push(`- Shoes: ${shoeText}`);
    }
    if (prefills.recentTraining && prefills.recentTraining.length > 0) {
      const recent = prefills.recentTraining
        .slice(0, 5)
        .map(
          (r) =>
            `${r.name ?? r.runType ?? "run"} (${formatDistanceHint(r.distanceM, prefills.unitPreference)})`,
        )
        .join("; ");
      tempoLines.push(`- Recent training: ${recent}`);
    }
  } else {
    tempoLines.push("- Your running log was not available when this was written.");
  }

  const proposedBody = [
    "# About you",
    "",
    "## Stance",
    COACH_STANCE_SUMMARY,
    "",
    "## Goal",
    answers.goal,
    "",
    "## Schedule",
    answers.schedule,
    "",
    ...returnHistoryLines(input.goal),
    "## Constraints",
    answers.injuries_constraints?.trim() ||
      "_None volunteered — ask again if niggles appear._",
    "",
    "## Preferences",
    answers.preferences?.trim() || "_None volunteered._",
    "",
    "## From your running log",
    ...tempoLines,
    "",
    "## Coaching notes",
    "Protect easy days. Cap quality when constraints are present. Revisit this after week one.",
  ].join("\n");

  return { summaryBullets, proposedBody };
}

/** Athlete-facing coach thread summary for a pending dossier soft-gate. */
export function formatDossierProposalThreadBody(_draft: {
  summaryBullets: string[];
}): string {
  // The note card under this message lists the bullets and holds the actions (#19).
  return [
    "Here's what I understood from your answers, and from your running log where I could see it.",
    "If it looks right, say so below. If something's off, tell me what to fix.",
    "The full text is under About you.",
  ].join(" ");
}

/** Athlete-facing coach thread summary for a pending correction rewrite (#18). */
export function formatDossierCorrectionThreadBody(_draft: {
  summaryBullets: string[];
}): string {
  // The note card under this message lists the bullets and holds the actions (#19).
  return [
    "I've updated what I know about you, based on your correction.",
    "If that isn't right, you can undo it.",
    "The full text is under About you.",
  ].join(" ");
}

/**
 * Deterministic athlete correction → dossier rewrite (issue #18).
 * Keeps prior body and appends an Athlete correction section.
 */
export function buildStubDossierCorrection(
  input: DossierCorrectionInput,
): DossierCorrectionDraft {
  const note = input.athleteMessage.trim().replace(/\s+/g, " ");
  const weekLabel = input.week?.isoWeek?.trim()
    ? formatIsoWeekRangeShort(input.week.isoWeek)
    : "this week";
  const base = input.currentDossier.body.trimEnd();
  const summaryBullets = [
    dossierSummaryBullet(`Your correction (${weekLabel})`, note),
    "Saved to what I know about you.",
  ];
  const proposedBody = [
    base || "# About you",
    "",
    `## Athlete correction (${weekLabel})`,
    note,
    "",
    "_Added from your correction._",
    "",
  ].join("\n");
  return { summaryBullets, proposedBody };
}

type MdSection = { title: string; body: string };

/** Split markdown on `## ` headings (keeps preface before the first heading). */
function splitMarkdownSections(markdown: string): {
  preface: string;
  sections: MdSection[];
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: MdSection[] = [];
  let prefaceLines: string[] = [];
  let current: MdSection | null = null;

  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1]!.trim(), body: "" };
      continue;
    }
    if (!current) {
      prefaceLines.push(line);
    } else {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  if (current) sections.push(current);

  return {
    preface: prefaceLines.join("\n").trimEnd(),
    sections: sections.map((s) => ({
      title: s.title,
      body: s.body.replace(/^\n+/, "").replace(/\n+$/, ""),
    })),
  };
}

function ymdFromIso(iso: string | null | undefined): string {
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  return "2026-10-20";
}

function addWeeksYmd(ymd: string, weeks: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic dossier audit/trim (issue #40).
 * Collapses Coach update sections into Current Status; rewrites status; stamps cadence.
 */
export function buildStubDossierAudit(
  input: DossierAuditInput,
): DossierAuditDraft {
  const weekLabel = input.week?.isoWeek?.trim()
    ? formatIsoWeekRangeShort(input.week.isoWeek)
    : "this week";
  const updatedYmd = ymdFromIso(input.nowIso);
  const intervalWeeks = input.intervalWeeks ?? 5;
  const nextDueYmd = addWeeksYmd(updatedYmd, intervalWeeks);
  const updatedDay = formatDayShort(updatedYmd);
  const nextDueDay = formatDayShort(nextDueYmd);

  const { preface, sections } = splitMarkdownSections(
    input.currentDossier.body,
  );
  const coachUpdates = sections.filter((s) =>
    /^coach update\b/i.test(s.title),
  );
  const kept = sections.filter((s) => !/^coach update\b/i.test(s.title));

  const consolidatedBullets: string[] = [];
  for (const u of coachUpdates) {
    for (const line of u.body.split("\n")) {
      const bullet = line.replace(/^\s*[-*]\s+/, "").trim();
      if (bullet) consolidatedBullets.push(bullet);
    }
  }

  const statusIdx = kept.findIndex((s) => /^current status\b/i.test(s.title));
  const statusLines = [
    `**Tidied ${updatedDay} (${weekLabel}).** Older update lines are folded into this status.`,
    "",
  ];
  if (consolidatedBullets.length > 0) {
    statusLines.push("Active notes from recent coach updates:");
    for (const b of consolidatedBullets) {
      statusLines.push(`- ${b}`);
    }
    statusLines.push("");
  }
  if (statusIdx >= 0) {
    const prior = kept[statusIdx]!.body.trim();
    if (prior) {
      statusLines.push("_Prior status (kept for continuity):_");
      statusLines.push(prior);
    }
    kept[statusIdx] = {
      title: "Current Status",
      body: statusLines.join("\n").trimEnd(),
    };
  } else {
    kept.unshift({
      title: "Current Status",
      body: statusLines.join("\n").trimEnd(),
    });
  }

  // Drop a prior tidy-up section (or its old "Settings audit" name); we rewrite it below.
  const withoutAuditMeta = kept.filter(
    (s) => !/^(settings audit|tidy-ups)\b/i.test(s.title),
  );
  withoutAuditMeta.push({
    title: "Tidy-ups",
    body: [
      `- Last tidy-up: ${updatedDay}`,
      `- Next one around ${nextDueDay} (every ${intervalWeeks} weeks)`,
    ].join("\n"),
  });

  const parts: string[] = [];
  if (preface.trim()) parts.push(preface.trimEnd());
  for (const s of withoutAuditMeta) {
    parts.push(`## ${s.title}\n\n${s.body}`.trimEnd());
  }
  const proposedBody = `${parts.join("\n\n")}\n`;

  const removed = coachUpdates.length;
  const summaryBullets = [
    `Rewrite Current Status (${weekLabel}).`,
    removed > 0
      ? `Fold ${removed} older update section(s) into Current Status and remove superseded log entries.`
      : "No older update sections to fold in. Current Status is rewritten.",
    `Next tidy-up around ${nextDueDay} (every ${intervalWeeks} weeks). Accept to apply.`,
  ];

  return { summaryBullets, proposedBody };
}

/** Athlete-facing coach thread summary for a pending dossier audit (#40). */
export function formatDossierAuditThreadBody(_draft: {
  summaryBullets: string[];
}): string {
  // The note card under this message lists the bullets and holds the actions (#19).
  return [
    "I've drafted a tidy-up of what I know about you. Nothing changes until you say it looks right.",
    "If something's off, tell me what to fix.",
    "The full text is under About you.",
  ].join(" ");
}

/**
 * Deterministic LlmPort — no network. Validates schema before returning.
 */
export type StubLlmPortOptions = {
  /** LLM call log sink; rows are only written when a call supplies a callId. */
  recorder?: LlmCallRecorder;
  appVersion?: string;
};

export function createStubLlmPort(options?: StubLlmPortOptions): LlmPort {
  const recorder = options?.recorder;
  const appVersion = options?.appVersion ?? resolveAppVersion();

  /** Append the `ok` row for a stub call. Best-effort: never fails the call. */
  async function recordOk(
    operation: LlmCallOperation,
    callOptions: LlmCallOptions | undefined,
    request: unknown,
    output: unknown,
  ): Promise<void> {
    if (!recorder || !callOptions?.callId) return;
    try {
      await recorder.record({
        id: callOptions.callId,
        operation,
        provider: "stub",
        model: null,
        appVersion,
        weekSessionId: callOptions.weekSessionId ?? null,
        parentCallId: null,
        request,
        responseRaw: JSON.stringify(output),
        httpStatus: null,
        latencyMs: null,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        outcome: "ok",
        errorMessage: null,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[llm-call-log] row dropped (id=${callOptions.callId} operation=${operation}): ${reason}`,
      );
    }
  }

  return {
    async generateWeeklyReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<WeeklyReply> {
      const draft = buildStubWeeklyReply(packet);
      const weekStartMonday = resolveWeeklyPlanWeek(packet).weekStartMonday;
      const validated = validateWeeklyReply(draft, weekStartMonday);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("weekly_reply", callOptions, packet, validated.value);
      return validated.value;
    },
    async generateMidWeekChatReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<MidWeekChatReply> {
      const draft = buildStubMidWeekChatReply(packet);
      const weekStartMonday = resolvePlanWeekStartMonday(packet);
      const validated = validateMidWeekChatReply(draft, weekStartMonday);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("mid_week_chat", callOptions, packet, validated.value);
      return validated.value;
    },
    async generateDossierV1(
      input: DossierV1Input,
      callOptions?: LlmCallOptions,
    ): Promise<DossierV1Draft> {
      const draft = buildStubDossierV1(input);
      const validated = validateDossierV1Draft(draft);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("dossier_v1", callOptions, input, validated.value);
      return validated.value;
    },
    async generateDossierCorrection(
      input: DossierCorrectionInput,
      callOptions?: LlmCallOptions,
    ): Promise<DossierCorrectionDraft> {
      const draft = buildStubDossierCorrection(input);
      const validated = validateDossierCorrectionDraft(draft);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("dossier_correction", callOptions, input, validated.value);
      return validated.value;
    },
    async generateDossierAudit(
      input: DossierAuditInput,
      callOptions?: LlmCallOptions,
    ): Promise<DossierAuditDraft> {
      const draft = buildStubDossierAudit(input);
      const validated = validateDossierAuditDraft(draft);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("dossier_audit", callOptions, input, validated.value);
      return validated.value;
    },
  };
}
