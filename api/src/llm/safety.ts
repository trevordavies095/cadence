import type { ModelPacket } from "../packet/types.js";
import { COACH_SYSTEM_STANCE } from "./stance.js";
import type { SafetyCallout, SafetyCalloutSeverity } from "./types.js";

export const MAX_SAFETY_CALLOUTS = 5;
export const MAX_SAFETY_CALLOUT_TITLE = 120;
/** Target the model is asked for; a longer body is kept and logged. */
export const MAX_SAFETY_CALLOUT_BODY = 600;
/** Ceiling a stored body is cut to (#4). */
export const MAX_SAFETY_CALLOUT_BODY_HARD = 1200;

/** Added when cutting a body drops its pointer to a professional. */
export const SAFETY_ESCALATION_LINE =
  "If it gets worse or does not settle, see a qualified clinician.";

const ESCALATION_RE =
  /\b(clinician|doctor|physio|physiotherapist|physical therapist|professional|GP|urgent care|emergency|ER|911)\b/i;

const SENTENCE_END_RE = /[.!?](?=\s|$)/g;

/** Cut at the last word that fits in `max` characters, ending in an ellipsis. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ", max - 1);
  const kept = (space > 0 ? head.slice(0, space) : head.slice(0, max - 1)).trimEnd();
  return `${kept}…`;
}

/**
 * Cut an over-long callout body to at most `max` characters at the last
 * sentence that fits, and keep an escalation line in it.
 */
export function fitSafetyCalloutBody(body: string, max: number): string {
  const text = body.trim();
  if (text.length <= max) return text;
  const full = cutAtSentence(text, max);
  if (ESCALATION_RE.test(full)) return full;
  const kept = cutAtSentence(text, max - SAFETY_ESCALATION_LINE.length - 1);
  return `${kept} ${SAFETY_ESCALATION_LINE}`;
}

function cutAtSentence(text: string, max: number): string {
  const head = text.slice(0, max + 1);
  let end = -1;
  for (const match of head.matchAll(SENTENCE_END_RE)) {
    if (match.index < max) end = match.index;
  }
  return end >= 0 ? head.slice(0, end + 1) : cutAtWord(text, max);
}

const SEVERITIES = new Set<SafetyCalloutSeverity>([
  "info",
  "caution",
  "urgent",
]);

/**
 * How the model should emit structured safety callouts (weekly + mid-week).
 * Product stance: coach training; do not diagnose; escalate when appropriate.
 */
export const SAFETY_CALLOUT_PROMPT = [
  "Safety callouts:",
  "- Never diagnose injury, illness, or medical conditions; do not prescribe treatment.",
  "- Coach running from the athlete's volunteered context and Tempo-derived training data.",
  "- When red flags appear (pain that worsens, chest pain, dizziness, sudden injury, illness), emit safetyCallouts and urge a qualified professional.",
  "- Each callout needs a short title, athlete-facing body (escalate, do not diagnose), and optional severity (info|caution|urgent).",
  `- Keep each callout body under ${MAX_SAFETY_CALLOUT_BODY} characters: one or two short paragraphs.`,
  "- Keep the training plan/reply conservative when callouts are present.",
].join(" ");

/** How the model names things when it speaks to the athlete. */
export const ATHLETE_VOCABULARY_PROMPT =
  "Speak to the athlete in plain running language. Never use internal terms such as dossier, proposal, soft-gate, packet, recap, subjective or artifact. Say \"what I know about you\", \"your weekly report\", \"your check-in\" or \"the plan\" instead, and never tell the athlete to open a page by name. " +
  "Week ids such as 2026-W43 are internal: never write them or a short form such as W43 or W43's. Name a week the way the athlete reads it: \"this week\", \"next week\", \"the week of Oct 19\", \"Oct 19 – 25\" or \"4 weeks out from the race\".";

/** Writing rules for anything the athlete reads (see CONTEXT.md, "Writing rules"). */
export const ATHLETE_WRITING_PROMPT =
  "Write plain sentences. No exclamation marks, no sentences that open with \"Let's\", and no emoji or decorative symbols. " +
  "Write dates as \"Mon Oct 19\" and ranges as \"Oct 19 – 25\", never as 2026-10-19.";

/** The About you document the model writes for onboarding, corrections and tidy-ups. */
const ABOUT_YOU_FORMAT_PROMPT = [
  "proposedBody is the athlete's About you document in Markdown. You read it before every reply, and the athlete reads it too.",
  "Start with \"# About you\", then \"## \" sections with short plain headings, for example Goal, Schedule, Running history, Injuries and constraints, Preferences, Current Status.",
  "Write to the athlete in the second person (\"You run five days a week\"). Use only what the athlete told you and what their running log shows; never invent facts.",
  "Keep it short and specific: numbers, days, shoes, paces and heart rates where they are known.",
  "Do not write a Stance section; it is added for you.",
  "summaryBullets are the lines on the athlete's note card: 2 to 6 short lines, one fact or change each.",
].join(" ");

const ABOUT_YOU_SYSTEM_BASE = [
  COACH_SYSTEM_STANCE,
  ATHLETE_VOCABULARY_PROMPT,
  ATHLETE_WRITING_PROMPT,
  ABOUT_YOU_FORMAT_PROMPT,
  "Think it through first, then call the submit_about_you tool exactly once with your full answer. Do not write the answer as plain text.",
];

/** System prompt for the first About you draft after onboarding (live adapters). */
export const DOSSIER_V1_SYSTEM_PROMPT = [
  "You are Coach Cade, a running coach writing down what you know about a new athlete from their first answers and their running log.",
  ...ABOUT_YOU_SYSTEM_BASE,
].join(" ");

/** System prompt for a Fix something request (live adapters). */
export const DOSSIER_CORRECTION_SYSTEM_PROMPT = [
  "You are Coach Cade, a running coach updating what you know about an athlete after they asked you to fix or add something.",
  ...ABOUT_YOU_SYSTEM_BASE,
  "Rewrite the whole document with the athlete's change applied. Keep everything else as it is unless the change makes it wrong.",
  "summaryBullets say what changed.",
].join(" ");

/** System prompt for the periodic tidy-up of About you (live adapters). */
export const DOSSIER_AUDIT_SYSTEM_PROMPT = [
  "You are Coach Cade, a running coach tidying up what you know about an athlete.",
  ...ABOUT_YOU_SYSTEM_BASE,
  "Fold the dated \"Coach update\" sections into one Current Status section that says where the athlete is now: training, injuries and how they are going, and the race plan.",
  "Remove what is superseded or no longer true. Keep the goal, schedule, constraints and preferences unless a later update replaced them, and keep injury history that still matters.",
  "summaryBullets say in plain words what you changed. The last one says when the next tidy-up is due, using the date you are given.",
].join(" ");

/** System prompt for weekly plan generation (live Anthropic + docs). */
export const WEEKLY_SYSTEM_PROMPT = [
  "You are Coach Cade, a running coach producing a weekly training plan.",
  COACH_SYSTEM_STANCE,
  ATHLETE_VOCABULARY_PROMPT,
  SAFETY_CALLOUT_PROMPT,
  "Think it through first, then call the submit_weekly_reply tool exactly once with your full answer. Do not write the answer as plain text.",
].join(" ");

/** System prompt for mid-week free chat + attached-run feedback (live adapters). */
export const MIDWEEK_SYSTEM_PROMPT = [
  "You are Coach Cade, a running coach answering a mid-week check-in.",
  COACH_SYSTEM_STANCE,
  ATHLETE_VOCABULARY_PROMPT,
  SAFETY_CALLOUT_PROMPT,
  "When workout attachments are present, give concrete coaching feedback on those runs using metrics and splits only (no GPS or route geometry).",
  "When the athlete asks to change remaining plan days, emit prescribedDayPatches with full day objects for those dates only (do not rewrite past days unless allowPastDayPatches is true).",
  "Do not rewrite the full week plan unless asked.",
  "For significant memory updates, emit settingsProposalBullets (soft-gate); never silent-apply dossier changes.",
  "Think it through first, then call the submit_mid_week_chat_reply tool exactly once with your full answer. Do not write the answer as plain text.",
].join(" ");

/** Soft signals the stub uses to emit a deterministic callout for tests/UI. */
const STUB_RED_FLAG_RE =
  /\b(achilles|niggle|pain|sore|injury|injured|swelling|fracture|chest|dizzy|dizziness|fever|doctor|physio|pt|surgeon|ER|emergency)\b/i;

/**
 * JSON Schema fragment for Anthropic tool input (optional safetyCallouts).
 */
export function safetyCalloutsJsonSchema(): Record<string, unknown> {
  return {
    type: "array",
    maxItems: MAX_SAFETY_CALLOUTS,
    description:
      "Visible safety callouts when red flags appear — escalate to professionals; do not diagnose.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: {
        title: { type: "string", maxLength: MAX_SAFETY_CALLOUT_TITLE },
        body: {
          type: "string",
          maxLength: MAX_SAFETY_CALLOUT_BODY,
          description: `At most ${MAX_SAFETY_CALLOUT_BODY} characters. One or two short paragraphs; the reply carries the detail.`,
        },
        severity: {
          type: "string",
          enum: ["info", "caution", "urgent"],
        },
      },
    },
  };
}

function packetSafetyCorpus(packet: ModelPacket): string {
  const parts: string[] = [];
  if (packet.dossier?.body) parts.push(packet.dossier.body);
  if (packet.recapMarkdown) parts.push(packet.recapMarkdown);
  for (const m of packet.thread ?? []) {
    if (m.body) parts.push(m.body);
  }
  for (const week of packet.recentHistory ?? []) {
    if (week.recapMarkdown) parts.push(week.recapMarkdown);
    if (week.analysis) parts.push(week.analysis);
  }
  return parts.join("\n");
}

/**
 * Deterministic stub callouts when packet text mentions soft red flags.
 * Empty when nothing matches — keeps happy-path replies clean.
 */
export function buildStubSafetyCallouts(packet: ModelPacket): SafetyCallout[] {
  const corpus = packetSafetyCorpus(packet);
  if (!corpus.trim() || !STUB_RED_FLAG_RE.test(corpus)) {
    return [];
  }
  return [
    {
      title: "See a professional",
      body:
        "Your notes mention a concern that may be outside running coaching. " +
        "This coach does not diagnose. If pain persists, worsens, or limits daily life, " +
        "check in with a qualified clinician or physical therapist. Training stays conservative until then.",
      severity: "caution",
    },
  ];
}

export function isSafetyCalloutSeverity(
  value: unknown,
): value is SafetyCalloutSeverity {
  return typeof value === "string" && SEVERITIES.has(value as SafetyCalloutSeverity);
}
