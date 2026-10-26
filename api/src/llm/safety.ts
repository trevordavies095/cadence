import type { ModelPacket } from "../packet/types.js";
import { COACH_SYSTEM_STANCE } from "./stance.js";
import type { SafetyCallout, SafetyCalloutSeverity } from "./types.js";

export const MAX_SAFETY_CALLOUTS = 5;
export const MAX_SAFETY_CALLOUT_TITLE = 120;
export const MAX_SAFETY_CALLOUT_BODY = 600;

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
  "- Keep the training plan/reply conservative when callouts are present.",
].join(" ");

/** How the model names things when it speaks to the athlete. */
export const ATHLETE_VOCABULARY_PROMPT =
  "Speak to the athlete in plain running language. Never use internal terms such as dossier, proposal, soft-gate, packet, recap, subjective or artifact. Say \"what I know about you\", \"your weekly report\", \"your check-in\" or \"the plan\" instead, and never tell the athlete to open a page by name.";

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
    description:
      "Visible safety callouts when red flags appear — escalate to professionals; do not diagnose.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
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
