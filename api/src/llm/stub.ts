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
import { wholeWeeksBetween } from "../goal/context.js";
import { goalDateLabel } from "../goal/sentence.js";
import type { GoalKind, TrainingGoal } from "../goal/types.js";
import { recentWeeklyDistanceM } from "../packet/recentTraining.js";
import type { ModelPacket } from "../packet/types.js";
import { LlmSchemaError, type LlmCallOptions, type LlmPort } from "./port.js";
import {
  buildStubJudgement,
  validateCoachingJudgement,
  type CoachingJudgeInput,
  type CoachingJudgement,
} from "./judge.js";
import {
  buildStubSafetyCallouts,
} from "./safety.js";
import {
  expectedPlanDates,
  MAX_BULLET_LENGTH,
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  planDateLabel,
  validateMidWeekChatReply,
  validatePlanDayFix,
  validateWeeklyReply,
} from "./schema.js";
import { COACH_STANCE_SUMMARY } from "./stance.js";
import type { TempoUnitPreference } from "../tempo/port.js";
import type {
  DayType,
  DossierAuditDraft,
  DossierAuditInput,
  DossierCorrectionDraft,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  MidWeekChatReplyForm,
  PlanDayFix,
  PlanDayFixInput,
  ReadFlag,
  SafetyCallout,
  WeeklyReply,
  WeeklyReplyForm,
} from "./types.js";
import { checkInQuestions, packetUnit, weeklyReplyContext } from "./weeklyContext.js";

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

/** The goal kind the stub plans for; no goal plans as fitness. */
function stubGoalKind(packet: ModelPacket): GoalKind {
  return packet.goal?.kind ?? "fitness";
}

const METERS_PER_MILE = 1609.344;

/** Weekly distance (meters) the stub plans when the report gives no history. */
const STUB_DEFAULT_WEEK_M: Record<Exclude<GoalKind, "return">, number> = {
  race: 40000,
  speed: 30000,
  fitness: 24000,
};

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

/**
 * Whole weeks since the return began: the packet's count, else from `since`
 * when the packet has no coaching block; 0 when unknown.
 */
function weeksIntoReturn(packet: ModelPacket, weekStartMonday: string): number {
  if (packet.coaching?.weeksIntoReturn !== undefined) return packet.coaching.weeksIntoReturn;
  const since = packet.goal?.since;
  return (since ? wholeWeeksBetween(since, weekStartMonday) : null) ?? 0;
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
    start + RETURN_WEEKLY_STEP_MIN * weeksIntoReturn(packet, weekStartMonday);
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

/** A planned distance as a coach writes it in the athlete's unit: "6.5 km", "4.5 mi" (half miles, never under 2). */
function stubDistanceText(m: number, unit: TempoUnitPreference): string {
  const rounded = roundRunM(m);
  if (unit === "metric") return `${rounded / 1000} km`;
  return `${Math.max(2, Math.round((rounded / METERS_PER_MILE) * 2) / 2)} mi`;
}

const STUB_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function weekdayShort(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return STUB_WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]!;
}

/** A sentence from a fragment: capitalised, ending in a full stop. */
function sentence(text: string): string {
  const t = text.trim();
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * One plan line in the plan grammar: "Tue 2026-10-27: easy, 4.5 mi. Easy
 * pace, daily trainer. Keep HR relaxed." The amount comes straight after the
 * day type and ends with a full stop, so a duration in the workout that
 * follows is never read as the day's.
 */
function stubPlanLine(
  date: string,
  p: StubDayPattern,
  weekM: number,
  unit: TempoUnitPreference,
): string {
  const amount =
    p.dayType === "rest"
      ? null
      : p.minutes != null
        ? `${p.minutes} min`
        : p.share != null
          ? stubDistanceText(p.share * weekM, unit)
          : null;
  const head = amount ? `${p.dayType}, ${amount}.` : `${p.dayType}.`;
  const how = [p.structure, p.paceOrHr, p.shoes].filter((s): s is string => Boolean(s?.trim()));
  const parts = [
    head,
    how.length > 0 ? sentence(how.join(", ")) : null,
    p.strength ? sentence(`Strength: ${p.strength}`) : null,
    p.notes ? sentence(p.notes) : null,
  ].filter((s): s is string => s !== null);
  return `${weekdayShort(date)} ${date}: ${parts.join(" ")}`;
}

/**
 * Deterministic 7-day plan (Mon–Sun) as seven plan lines, shaped by the goal
 * kind: race keeps the easy / rest / easy / quality / rest / easy / long week,
 * speed has one quality session and one longer run, fitness three easy runs
 * and an optional longer one, return walk-run sessions in minutes. No goal
 * plans as fitness. Distance kinds scale the week from the last four weeks,
 * else a modest default. Distances are written in the athlete's unit.
 */
function buildStubPlan(packet: ModelPacket, weekStartMonday: string): string {
  const dates = expectedPlanDates(weekStartMonday);
  const kind = stubGoalKind(packet);
  const unit = packetUnit(packet);
  let pattern: StubDayPattern[];
  let weekM = 0;
  if (kind === "return") {
    pattern = returnPattern(returnSessionMinutes(packet, weekStartMonday));
  } else {
    pattern =
      kind === "race" ? RACE_PATTERN : kind === "speed" ? SPEED_PATTERN : FITNESS_PATTERN;
    weekM = recentWeeklyDistanceM(packet) ?? STUB_DEFAULT_WEEK_M[kind];
  }
  return dates.map((date, i) => stubPlanLine(date, pattern[i]!, weekM, unit)).join("\n");
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

/** One plain answer to the check-in questions; none when they asked nothing. */
function buildStubAnswer(packet: ModelPacket): string | undefined {
  if (checkInQuestions(packet.recapMarkdown).length === 0) return undefined;
  return "Keep the week as planned and treat rest days as real rest. Ask me again during the week if it still feels off.";
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

/** A notice as one line of the weekly form: the severity word, the title as a sentence, the body. */
function calloutLine(c: SafetyCallout): string {
  const severity = c.severity ?? "caution";
  const word = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `${word}: ${sentence(c.title)} ${c.body}`.trim();
}

/**
 * The stub's weekly reply as Coach Cade's form: every box text or lines, the
 * plan as seven lines that parse fully. Pure; used by the stub port and as a
 * fake model reply in tests.
 */
export function buildStubWeeklyForm(packet: ModelPacket): WeeklyReplyForm {
  const weekStartMonday = resolveWeeklyPlanWeek(packet).weekStartMonday;
  const form: WeeklyReplyForm = {
    headline: buildStubHeadline(packet),
    flags: buildStubFlags(packet)
      .map((f) => `${f.title}: ${f.detail}`)
      .join("\n"),
    analysis: buildStubAnalysis(packet),
    plan: buildStubPlan(packet, weekStartMonday),
  };
  const answer = buildStubAnswer(packet);
  if (answer) form.answers = answer;
  const bullets = buildStubSettingsBullets(packet);
  if (bullets) form.settingsProposalBullets = bullets.join("\n");
  const callouts = buildStubSafetyCallouts(packet);
  if (callouts.length > 0) form.safetyCallouts = callouts.map(calloutLine).join("\n");
  return form;
}

/** The stub's weekly reply as Cadence stores it: its form, read like any model's. */
export function buildStubWeeklyReply(packet: ModelPacket): WeeklyReply {
  const checked = validateWeeklyReply(
    buildStubWeeklyForm(packet),
    resolveWeeklyPlanWeek(packet).weekStartMonday,
    weeklyReplyContext(packet),
  );
  if (!checked.ok) throw new LlmSchemaError(checked.error);
  return checked.value;
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
 * Deterministic remaining-day plan change for stub/CI (issue #38), as lines
 * in the plan grammar. When the athlete asks to change the plan and a plan is
 * present, rest the first quality day (else first easy) from Wednesday onward.
 */
export function buildStubPlanChangeLines(
  packet: ModelPacket,
): { date: string; line: string }[] | undefined {
  const plan = packet.prescribedWeek;
  if (!plan?.days?.length) return undefined;
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  if (!lastAthlete?.body || !PLAN_CHANGE_RE.test(lastAthlete.body)) {
    return undefined;
  }
  const dates = expectedPlanDates(resolvePlanWeekStartMonday(packet));
  const fromWed = dates[2]!;
  // Only this week's dates: a line for another week would be dropped.
  const remaining = plan.days.filter((d) => d.date >= fromWed && dates.includes(d.date));
  const target =
    remaining.find((d) => d.dayType === "quality") ??
    remaining.find((d) => d.dayType === "easy") ??
    remaining[0];
  if (!target) return undefined;
  return [
    {
      date: target.date,
      line: `${weekdayShort(target.date)} ${target.date}: rest. Changed this week: rest and recover. The quality session is moved out.`,
    },
  ];
}

/**
 * The stub's mid-week reply as Coach Cade's form: text and lines, any changed
 * days as plan lines that parse. Pure; used by the stub port and as a fake
 * model reply in tests.
 */
export function buildStubMidWeekForm(packet: ModelPacket): MidWeekChatReplyForm {
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
  const changes = buildStubPlanChangeLines(packet);
  const changeNote = changes?.length
    ? `Updated the plan for ${changes.map((c) => formatDayShort(c.date)).join(", ")}. Only the days still to come change.`
    : null;
  const form: MidWeekChatReplyForm = {
    body: [
      "Quick check-in for this week.",
      heard,
      dossierNote,
      attachNote,
      ...(changeNote ? [changeNote] : []),
    ].join(" "),
  };
  if (changes?.length) form.changes = changes.map((c) => c.line).join("\n");
  const bullets = buildStubMidWeekSettingsBullets(packet);
  if (bullets) form.settingsProposalBullets = bullets.join("\n");
  const callouts = buildStubSafetyCallouts(packet);
  if (callouts.length > 0) form.safetyCallouts = callouts.map(calloutLine).join("\n");
  return form;
}

/** The stub's mid-week reply as Cadence stores it: its form, read like any model's. */
export function buildStubMidWeekChatReply(packet: ModelPacket): MidWeekChatReply {
  const checked = validateMidWeekChatReply(
    buildStubMidWeekForm(packet),
    resolvePlanWeekStartMonday(packet),
    { unit: packetUnit(packet) },
  );
  if (!checked.ok) throw new LlmSchemaError(checked.error);
  return checked.value;
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
        serverHost: null,
        model: null,
        appVersion,
        weekSessionId: callOptions.weekSessionId ?? null,
        parentCallId: callOptions.parentCallId ?? null,
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
      const draft = buildStubWeeklyForm(packet);
      const weekStartMonday = resolveWeeklyPlanWeek(packet).weekStartMonday;
      const validated = validateWeeklyReply(draft, weekStartMonday, weeklyReplyContext(packet));
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
      const draft = buildStubMidWeekForm(packet);
      const weekStartMonday = resolvePlanWeekStartMonday(packet);
      const validated = validateMidWeekChatReply(draft, weekStartMonday, { unit: packetUnit(packet) });
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
    async generatePlanDayFix(
      input: PlanDayFixInput,
      callOptions?: LlmCallOptions,
    ): Promise<PlanDayFix> {
      const draft = { line: buildStubPlanDayLine(input) };
      const validated = validatePlanDayFix(draft, input);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("plan_day_fix", callOptions, input, validated.value);
      return validated.value;
    },
    async judgeCoachingDraft(
      input: CoachingJudgeInput,
      callOptions?: LlmCallOptions,
    ): Promise<CoachingJudgement> {
      const validated = validateCoachingJudgement(buildStubJudgement());
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("coaching_judge", callOptions, input, validated.value);
      return validated.value;
    },
  };
}

/** The stub's line for "Add the details": an easy run for the date, in the athlete's unit. */
export function buildStubPlanDayLine(input: PlanDayFixInput): string {
  const distance = input.unit === "metric" ? "6 km" : "4 mi";
  return `${planDateLabel(input.date)}: easy, ${distance}, relaxed and conversational.`;
}
