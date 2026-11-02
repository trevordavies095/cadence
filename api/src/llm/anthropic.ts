import { randomUUID } from "node:crypto";
import { resolveAppVersion } from "../llmCallLog/appVersion.js";
import { createPostgresLlmCallRecorder } from "../llmCallLog/recorder.js";
import type {
  LlmCallOperation,
  LlmCallOutcome,
  LlmCallRecord,
  LlmCallRecorder,
} from "../llmCallLog/types.js";
import type { ModelPacket } from "../packet/types.js";
import { selfHostedHost } from "../settings/selfHostedStore.js";
import { resolveLlmProvider } from "../settings/sources.js";
import type { CoachModel } from "./coachModel.js";
import {
  createCoachTargetResolver,
  type CoachProvider,
  type CoachTarget,
  type CoachTargetResolver,
} from "./coachTarget.js";
import type { AnthropicEffort } from "./effort.js";
import { readMessageStream } from "./anthropicStream.js";
import {
  LlmHttpError,
  LlmNotConfiguredError,
  LlmSchemaError,
  LlmTransportError,
  type AttemptRequest,
  type LlmCallOptions,
  type LlmPort,
} from "./port.js";
import type { PlanLineFailure } from "../prescribed/planLines.js";
import { formatIsoWeekRangeShort } from "../clock/weekRangeShort.js";
import { goalPromptLines } from "./goalLines.js";
import {
  DOSSIER_AUDIT_SYSTEM_PROMPT,
  DOSSIER_CORRECTION_SYSTEM_PROMPT,
  DOSSIER_V1_SYSTEM_PROMPT,
  midWeekSystemPrompt,
  safetyCalloutsJsonSchema,
  weeklySystemPrompt,
} from "./safety.js";
import {
  DAY_NOTES_TARGET,
  MAX_FLAG_DETAIL_LENGTH,
  MAX_FLAG_TITLE_LENGTH,
  MAX_HEADLINE_LENGTH,
  MAX_READ_ANSWERS,
  MAX_READ_FLAGS,
  MAX_SAFETY_CALLOUT_BODY,
  MAX_SAFETY_CALLOUTS,
  expectedPlanDates,
  MAX_BULLET_LENGTH,
  MAX_DOSSIER_BODY_LENGTH,
  MAX_DOSSIER_SUMMARY_BULLETS,
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  validateMidWeekChatReply,
  validateWeeklyReply,
  type PlanFixResult,
  type PlanRetry,
  type SchemaResult,
} from "./schema.js";
import { COACH_STANCE_SUMMARY } from "./stance.js";
import type { TempoUnitPreference } from "../tempo/port.js";
import { packetUnit, weeklyReplyContext } from "./weeklyContext.js";
import {
  createStubLlmPort,
  resolvePlanWeekStartMonday,
  resolveWeeklyPlanWeek,
} from "./stub.js";
import type {
  DossierAuditDraft,
  DossierAuditInput,
  DossierCorrectionDraft,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  WeeklyReply,
} from "./types.js";

/** Overall cap for one streamed coach call (adaptive thinking can run minutes). */
const DEFAULT_TIMEOUT_MS = 900_000;
/** Abort when the stream goes quiet this long (pings keep a live stream active). */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/**
 * Self-hosted silence limit: home hardware can read a 30k-token prompt for
 * more than a minute before the first token.
 */
const DEFAULT_SELF_HOSTED_IDLE_TIMEOUT_MS = 600_000;
/** How much of a non-JSON error body a self-hosted error message carries. */
const SERVER_MESSAGE_MAX_CHARS = 200;
/**
 * The output cap on every coach call, Anthropic and self-hosted alike. Over 60
 * valid Opus 4.7 replies at xhigh in the saved replay runs, the median output
 * was 3,843 tokens, the highest weekly read 6,690 and the highest reply of any
 * kind 9,264 (a mid-week chat). Thinking tokens count toward the cap on
 * Anthropic (adaptive thinking is on there). Twice the maximum, floored at
 * 16,000, is 20,000. A reply that stops at the cap is refused like a schema
 * refusal and gets the same one retry; the old 64,000 let a runaway bill the
 * full limit.
 */
export const MAX_OUTPUT_TOKENS = 20_000;
const ANTHROPIC_VERSION = "2023-06-01";
const WEEKLY_TOOL_NAME = "submit_weekly_reply";
const MIDWEEK_TOOL_NAME = "submit_mid_week_chat_reply";
const ABOUT_YOU_TOOL_NAME = "submit_about_you";

/**
 * Overall cap for an Anthropic call: ANTHROPIC_TIMEOUT_MS (positive integer
 * milliseconds), else 15 minutes. The frontend proxy timeout must stay above it.
 */
export function resolveAnthropicTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ANTHROPIC_TIMEOUT_MS?.trim();
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Silence limit for a self-hosted call: SELF_HOSTED_IDLE_TIMEOUT_MS (positive
 * integer milliseconds), else 10 minutes. Anthropic calls keep 60 seconds.
 */
export function resolveSelfHostedIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SELF_HOSTED_IDLE_TIMEOUT_MS?.trim();
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return DEFAULT_SELF_HOSTED_IDLE_TIMEOUT_MS;
}

export type AnthropicLlmPortOptions = {
  /** Override wrapping key (tests). Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
  /** Injected fetch for tests (fake Anthropic HTTP). */
  fetchImpl?: typeof globalThis.fetch;
  /** Overall cap per call. Defaults to ANTHROPIC_TIMEOUT_MS or 15 minutes. */
  timeoutMs?: number;
  /**
   * Abort after this long without stream data, for both providers. Defaults
   * to 60 seconds for Anthropic and SELF_HOSTED_IDLE_TIMEOUT_MS or 10 minutes
   * for a self-hosted server.
   */
  idleTimeoutMs?: number;
  /**
   * The target for a call that is not handed one: URL, key, model and effort,
   * resolved once per call. Defaults to createCoachTargetResolver, built from
   * the three options below.
   */
  resolveCoachTarget?: CoachTargetResolver;
  /** Model and effort the default resolver reads (tests). Defaults to resolveCoachModel. */
  readCoachModel?: () => Promise<CoachModel>;
  /** Messages API URL the default resolver uses (tests). */
  apiUrl?: string;
  /** Key loader the default resolver uses (defaults to decrypting anthropic_connection). */
  readApiKey?: () => Promise<string | null>;
  /** LLM call log sink. Defaults to the Postgres recorder. */
  recorder?: LlmCallRecorder;
  /** Code version stamped on log rows. Defaults to APP_VERSION / `dev`. */
  appVersion?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reason for a session, shown beside it on the plan. */
const DAY_NOTES_DESCRIPTION = `Why this session, this week: one or two sentences, under ${DAY_NOTES_TARGET} characters. Shown beside the session.`;

/** Day types; every type but rest and other carries a run. */
const DAY_TYPE_DESCRIPTION =
  "Every type but rest needs a run, except other: an other day with no run (run null) is strength, cross-training or a walk, and its notes must say what it is (\"30 min strength: squats, lunges, core\"). It is not counted or graded as a run.";

/** A planned run, prescribed by distance, by duration, or by both. */
export function prescribedRunJsonSchema(): Record<string, unknown> {
  return {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: ["easy", "quality", "long", "race", "other"],
      },
      distanceM: {
        type: "number",
        description:
          "Planned distance in meters. 0 when the run is prescribed by duration only.",
      },
      durationS: {
        type: ["number", "null"],
        description:
          "Planned duration in seconds, for a run prescribed by time (2400 for 40 minutes). Set it with distanceM 0 for a time-only run, or beside a distance to give both.",
      },
      structure: { type: ["string", "null"] },
      paceOrHr: { type: ["string", "null"] },
      shoes: { type: ["string", "null"] },
    },
    required: ["type", "distanceM"],
  };
}

/** "miles" or "kilometres": the word the weekly form and prompt use for the athlete's unit. */
function unitWord(unit: TempoUnitPreference): string {
  return unit === "metric" ? "kilometres" : "miles";
}

/**
 * One example plan line, dated the plan week's Tuesday, in the athlete's unit.
 * The same line is in the tool description and the prompt.
 */
export function examplePlanLine(weekStartMonday: string, unit: TempoUnitPreference): string {
  const tuesday = expectedPlanDates(weekStartMonday)[1]!;
  const distance = unit === "metric" ? "8 km" : "5 mi";
  return `Tue ${tuesday}: easy, ${distance}, heart rate under 150, flat route. Loosens the legs after the long run.`;
}

/**
 * The weekly form: every box a string or a list of strings, each with a
 * description, nothing nested (.scratch/plan-as-text/spec.md, "The forms").
 * Built per call: the plan box names the athlete's unit and the plan week.
 */
export function weeklyReplyToolSchema(weekStartMonday: string, unit: TempoUnitPreference) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["headline", "analysis", "plan"],
    properties: {
      headline: {
        type: "string",
        description:
          `One or two plain sentences, at most ${MAX_HEADLINE_LENGTH} characters: what you would say if you could say only one thing about the week and the plan. No markdown, no label.`,
      },
      flags: {
        type: "array",
        maxItems: MAX_READ_FLAGS,
        items: { type: "string" },
        description:
          `What you are watching, not a summary of the week, shown under "Watching". One line each: a few-word title (at most ${MAX_FLAG_TITLE_LENGTH} characters), a colon, then one line of detail (at most ${MAX_FLAG_DETAIL_LENGTH} characters).`,
      },
      answers: {
        type: "array",
        maxItems: MAX_READ_ANSWERS,
        items: { type: "string" },
        description:
          "One answer per question the athlete asked in the check-in or the conversation, check-in questions first, in the order asked. The answer only, in markdown if it needs more than a paragraph. Empty when they asked nothing.",
      },
      analysis: {
        type: "string",
        description:
          "The rest of your read in markdown: your reasoning about the week and the plan. The athlete sees the headline, flags and answers above it, and the plan lines beside each day, so do not restate the plan day by day.",
      },
      plan: {
        type: "string",
        description:
          `Next week's plan as seven lines, one per day Monday to Sunday, each written as "weekday date: day type, distance in ${unitWord(unit)} or time in minutes, then how to run it and why", where the day type is rest, easy, quality, long, race or other (strength, cross-training or a walk), a rest day needs no amount, and every number carries its unit. Example: ${examplePlanLine(weekStartMonday, unit)}`,
      },
      settingsProposalBullets: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional soft-gate dossier/settings proposal bullets (short).",
      },
      safetyCallouts: {
        type: "array",
        maxItems: MAX_SAFETY_CALLOUTS,
        items: { type: "string" },
        description:
          `Notices when red flags appear: escalate to a professional, do not diagnose. One line each: start with Urgent:, Caution: or Info:, then a short title as the first sentence, then one or two short sentences for the athlete, under ${MAX_SAFETY_CALLOUT_BODY} characters.`,
      },
    },
  };
}

export function prescribedDayJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["date", "dayType"],
    properties: {
      date: {
        type: "string",
        description: "Local calendar date YYYY-MM-DD within the plan week",
      },
      dayType: {
        type: "string",
        enum: ["rest", "easy", "quality", "long", "race", "other"],
        description: DAY_TYPE_DESCRIPTION,
      },
      run: prescribedRunJsonSchema(),
      strength: { type: ["string", "null"] },
      notes: { type: ["string", "null"], description: DAY_NOTES_DESCRIPTION },
    },
  };
}

function midWeekChatReplyToolSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: {
      body: {
        type: "string",
        description:
          "Athlete-facing mid-week coach prose. When attachments are present, include concrete run feedback from metrics/splits.",
      },
      settingsProposalBullets: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional soft-gate dossier/settings proposal bullets when the mid-week note is a significant memory update. Never silent-apply.",
      },
      prescribedDayPatches: {
        type: "array",
        description:
          "Optional day replacements for remaining plan days (date >= local today). Full PrescribedDay objects.",
        items: prescribedDayJsonSchema(),
      },
      allowPastDayPatches: {
        type: "boolean",
        description:
          "When true, past-day patches may be applied. Default false — past days stay stable.",
      },
      safetyCallouts: safetyCalloutsJsonSchema(),
    },
  };
}

/** One tool for onboarding, Fix something and tidy-ups: note-card lines + the full document. */
function aboutYouToolSchema(description: string) {
  return {
    name: ABOUT_YOU_TOOL_NAME,
    description,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["summaryBullets", "proposedBody"],
      properties: {
        summaryBullets: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DOSSIER_SUMMARY_BULLETS,
          items: { type: "string", maxLength: MAX_BULLET_LENGTH },
          description: "Lines on the athlete's note card, one fact or change each.",
        },
        proposedBody: {
          type: "string",
          description: "The whole About you document in Markdown (# About you, then ## sections).",
        },
      },
    },
  };
}

/**
 * The Stance section is product text, not the model's: drop any the model wrote and
 * put the canonical one straight after the title.
 */
export function withCanonicalStance(body: string): string {
  const parts = body.replace(/\r\n/g, "\n").split(/^(?=## )/m);
  const preface = parts[0]!.startsWith("## ") ? "" : parts.shift()!.trim();
  const sections = parts.filter((p) => !/^## +Stance\b/i.test(p)).map((p) => p.trim());
  return [
    preface || "# About you",
    `## Stance\n${COACH_STANCE_SUMMARY}`,
    ...sections,
  ].join("\n\n");
}

/** Validate a draft, then enforce the Stance section and the length cap on the result. */
function validateAboutYou<T extends DossierV1Draft>(
  validate: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
): (raw: unknown) => { ok: true; value: T } | { ok: false; error: string } {
  return (raw) => {
    const checked = validate(raw);
    if (!checked.ok) return checked;
    const proposedBody = withCanonicalStance(checked.value.proposedBody);
    if (proposedBody.length > MAX_DOSSIER_BODY_LENGTH) {
      return { ok: false, error: `proposedBody must be at most ${MAX_DOSSIER_BODY_LENGTH} characters` };
    }
    return { ok: true, value: { ...checked.value, proposedBody } };
  };
}

/** "Wed Oct 14" for an ISO instant (UTC calendar day). */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${weekday} ${month} ${d.getUTCDate()}`;
}

function weekLabelOf(week: { isoWeek?: string | null } | null | undefined): string | null {
  const iso = week?.isoWeek?.trim();
  return iso ? formatIsoWeekRangeShort(iso) : null;
}

function buildDossierV1UserPrompt(input: DossierV1Input): string {
  return [
    "Write the athlete's first About you document from their onboarding answers and what their running log shows.",
    "Call the submit_about_you tool exactly once.",
    "Onboarding answers and running-log hints (no identity PII or GPS):",
    JSON.stringify(input),
  ].join("\n");
}

function buildDossierCorrectionUserPrompt(input: DossierCorrectionInput): string {
  const week = weekLabelOf(input.week);
  return [
    week ? `This week: ${week}` : null,
    "The athlete asked you to fix or add this:",
    input.athleteMessage.trim(),
    "Call the submit_about_you tool exactly once with the whole updated document.",
    "Current About you document:",
    input.currentDossier.body,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildDossierAuditUserPrompt(input: DossierAuditInput): string {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const intervalWeeks = input.intervalWeeks ?? 5;
  const next = new Date(Date.parse(nowIso) + intervalWeeks * 7 * 86_400_000).toISOString();
  const week = weekLabelOf(input.week);
  return [
    `Today: ${dayLabel(nowIso)}${week ? ` (week of ${week})` : ""}`,
    `Next tidy-up due: ${dayLabel(next)} (every ${intervalWeeks} weeks)`,
    "Tidy the document below. Call the submit_about_you tool exactly once with the whole tidied document.",
    "Current About you document:",
    input.currentDossier.body,
  ].join("\n");
}

function buildWeeklyUserPrompt(
  packet: ModelPacket,
  weekStartMonday: string,
): string {
  const dates = expectedPlanDates(weekStartMonday);
  const reviewed = packet.week?.isoWeek?.trim();
  const unit = packetUnit(packet);
  return [
    ...goalPromptLines(packet, weekStartMonday),
    reviewed ? `Reviewed week (already happened): ${reviewed}` : null,
    `Plan week Monday (YYYY-MM-DD): ${weekStartMonday}`,
    `The plan box has one line per day, for these dates Mon–Sun: ${dates.join(", ")}`,
    `Write distances in ${unitWord(unit)}.`,
    `Example plan line: ${examplePlanLine(weekStartMonday, unit)}`,
    "Prescribe one coherent week of running training for this athlete.",
    "The plan box is the plan: the athlete sees each line beside its day. The analysis explains the week; do not restate the plan in it day by day.",
    "Call the submit_weekly_reply tool exactly once with your full answer.",
    "Include a headline (the one or two sentences you would say if you could say only one thing), flags (what you are watching), answers (one per question the athlete asked, the answer only), the analysis (your reasoning) and the plan.",
    "When red flags appear, populate safetyCallouts (escalate; do not diagnose).",
    "Model packet (redacted; no identity PII or GPS):",
    JSON.stringify(packet),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** The weekly read's user prompt exactly as {@link createAnthropicLlmPort} sends it. */
export function weeklyUserPromptFor(packet: ModelPacket): string {
  return buildWeeklyUserPrompt(packet, resolveWeeklyPlanWeek(packet).weekStartMonday);
}

function buildMidWeekUserPrompt(
  packet: ModelPacket,
  weekStartMonday: string,
): string {
  const attachCount = packet.attachments?.length ?? 0;
  const attachLine =
    attachCount > 0
      ? `Packet includes ${attachCount} workout attachment${attachCount === 1 ? "" : "s"}. Give concrete coaching feedback on the attached run(s) using metrics/splits only.`
      : "No workout attachments — answer the athlete's mid-week note.";
  const dates = expectedPlanDates(weekStartMonday);
  const hasPlan = Boolean(packet.prescribedWeek?.days?.length);
  const planLine = hasPlan
    ? `Current prescribed week is in the packet. To change remaining days, emit prescribedDayPatches using only these dates: ${dates.join(", ")}. Past days stay stable unless allowPastDayPatches is true.`
    : "No prescribed week in packet — reply in prose only (no prescribedDayPatches).";
  return [
    ...goalPromptLines(packet, weekStartMonday),
    "Call the submit_mid_week_chat_reply tool exactly once with your full answer.",
    attachLine,
    planLine,
    "Do not rewrite the full prescribed week unless the athlete asks.",
    "When the athlete reports a significant memory update (new constraint, niggle, schedule change), populate settingsProposalBullets for soft-gate Accept — never mutate the dossier directly.",
    "When red flags appear, populate safetyCallouts (escalate; do not diagnose).",
    "Model packet (redacted; no identity PII or GPS):",
    JSON.stringify(packet),
  ].join("\n");
}

function extractToolInput(body: unknown, toolName: string): unknown {
  if (!isPlainObject(body)) {
    throw new LlmSchemaError("Anthropic response must be a JSON object");
  }
  const content = body.content;
  if (!Array.isArray(content)) {
    throw new LlmSchemaError("Anthropic response missing content array");
  }
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  throw new LlmSchemaError(
    `Anthropic response missing ${toolName} tool_use block`,
  );
}

/**
 * The assistant message's content blocks, copied as the stream assembled them
 * (anthropicStream.ts keeps every field of each block: a thinking block's text
 * and signature, a redacted block's data, a tool call's id, name and input).
 * Sent back unchanged on a retry: Anthropic refuses a thinking block altered.
 */
function contentAsReceived(message: unknown): MessageBlock[] {
  if (!isPlainObject(message) || !Array.isArray(message.content)) return [];
  return (message.content as unknown[])
    .filter(isPlainObject)
    .map((block) => structuredClone(block));
}

/** The second request's wording, fixed: quoted by the tests and the spec. */
export const RETRY_FIX_LINES_INSTRUCTION =
  "Send the plan box again with these lines fixed. Change nothing else.";
export const RETRY_NO_TOOL_CALL_TEXT =
  "You did not call the tool. Call it now with your full answer.";
export const RETRY_ERROR_INSTRUCTION =
  "Call the tool again with your full answer, with this fixed.";

/** "Thu 2026-11-12: no distance unit." one per line, in date order. */
export function planFailureLines(failures: readonly PlanLineFailure[]): string {
  return failures
    .map((f) => {
      const weekday = new Date(`${f.date}T00:00:00.000Z`).toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: "UTC",
      });
      return `${weekday} ${f.date}: ${f.reason}.`;
    })
    .join("\n");
}

/** A validator as the adapter calls it: SchemaResult, with planRetry when lines did not parse. */
type Validate<T> = (toolInput: unknown) => SchemaResult<T> | PlanFixResult<T>;

/** What the first attempt got back, as the second request is built from it. */
type FirstReply = {
  content: MessageBlock[] | null;
  stopReason: string | null;
  /** The refusal's message; null when the reply was accepted. */
  error: string | null;
  /** Set when the reply was accepted with plan lines that did not parse. */
  failures: PlanLineFailure[] | null;
};

/**
 * The second request, built from the first and what it got back (ADR 0002, the
 * spec's "Degradation ladder"). The system prompt, tools, model, effort and
 * thinking are the first request's; only the turns grow.
 *
 * - A stop at the output cap or a model refusal, or no message at all: the
 *   assistant turn is incomplete or absent, and Anthropic will not take a cut
 *   tool call back, so the first request is sent again unchanged (`resend`).
 * - No call to the tool: the assistant turn as received, then a plain
 *   "call the tool" turn (`no_tool_call`). A call to some other tool still
 *   needs its tool result, so that is answered with the same words as an error.
 * - Plan lines that did not parse: the assistant turn as received, then an
 *   error tool result for the call listing each failed date and its reason
 *   and the fix-only instruction (`fix_lines`).
 * - Any other refusal: the same, carrying the validator's message (`error_result`).
 */
export function secondRequest(
  first: AnthropicMessagesRequest,
  toolName: string,
  reply: FirstReply,
): { body: AnthropicMessagesRequest; kind: AttemptRequest["kind"] } {
  const content = reply.content ?? [];
  const cut =
    reply.stopReason === "max_tokens" ||
    reply.stopReason === "refusal" ||
    content.length === 0;
  if (cut) return { body: first, kind: "resend" };

  const toolUses = content.filter((b) => b.type === "tool_use");
  const ours = toolUses.find((b) => b.name === toolName);
  const withTurn = (
    user: AnthropicMessage,
    kind: AttemptRequest["kind"],
  ): { body: AnthropicMessagesRequest; kind: AttemptRequest["kind"] } => ({
    body: {
      ...first,
      messages: [...first.messages, { role: "assistant", content }, user],
    },
    kind,
  });
  /** An error tool result for every tool call, `text` on each; plain text when a call has no id. */
  const answer = (text: string, kind: AttemptRequest["kind"]) =>
    toolUses.length > 0 && toolUses.every((b) => typeof b.id === "string")
      ? withTurn(
          {
            role: "user",
            content: toolUses.map((b) => ({
              type: "tool_result",
              tool_use_id: b.id,
              is_error: true,
              content: text,
            })),
          },
          kind,
        )
      : withTurn({ role: "user", content: text }, kind);

  if (!ours) return answer(RETRY_NO_TOOL_CALL_TEXT, "no_tool_call");
  if (reply.failures) {
    return answer(
      `${planFailureLines(reply.failures)}\n\n${RETRY_FIX_LINES_INSTRUCTION}`,
      "fix_lines",
    );
  }
  const said = (reply.error ?? "the reply was refused").trim();
  return answer(
    `${/[.!?]$/.test(said) ? said : `${said}.`}\n\n${RETRY_ERROR_INSTRUCTION}`,
    "error_result",
  );
}

/** Each message's role and block types, for the replay and the smoke script. */
export function turnsOf(messages: readonly AnthropicMessage[]): string[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return `${m.role}: text`;
    const kinds = m.content.map((b) =>
      b.type === "tool_result" && b.is_error === true
        ? "tool_result (error)"
        : String(b.type),
    );
    return `${m.role}: ${kinds.join(", ")}`;
  });
}

export type AnthropicMessagesRequest = {
  model: string;
  max_tokens: number;
  system: string;
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config: { effort: AnthropicEffort };
  tool_choice: { type: "auto" };
  stream: true;
  messages: AnthropicMessage[];
};

/** A content block as the server sent it, or as Cadence sends one back. */
export type MessageBlock = Record<string, unknown>;

/**
 * One turn of a request: the user's prompt, or on a retry the assistant turn
 * as received (thinking blocks with their signatures, text, the tool call with
 * its id) and the user turn answering it (a tool result, or plain text).
 */
export type AnthropicMessage =
  | { role: "user"; content: string | MessageBlock[] }
  | { role: "assistant"; content: MessageBlock[] };

type AnthropicUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingTokens: number | null;
};

type AnthropicCallResult = {
  toolInput: unknown;
  /** The assistant message's content blocks as received. */
  content: MessageBlock[];
  responseText: string;
  httpStatus: number;
  stopReason: string | null;
  usage: AnthropicUsage;
  latencyMs: number;
};

/** What a failed call knew when it failed; carried beside the thrown Llm*Error. */
type AnthropicFailureMeta = {
  httpStatus: number | null;
  responseText: string | null;
  latencyMs: number;
  stopReason: string | null;
  usage: AnthropicUsage | null;
  /** The assistant message's content blocks as received; null when no message came. */
  content: MessageBlock[] | null;
};

const failureMeta = new WeakMap<object, AnthropicFailureMeta>();

function failWith<E extends Error>(err: E, meta: AnthropicFailureMeta): E {
  failureMeta.set(err, meta);
  return err;
}

function readStopReason(body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  return typeof body.stop_reason === "string" ? body.stop_reason : null;
}

function readUsage(body: unknown): AnthropicUsage {
  const usage = isPlainObject(body) && isPlainObject(body.usage) ? body.usage : {};
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    thinkingTokens: num(
      isPlainObject(usage.output_tokens_details)
        ? usage.output_tokens_details.thinking_tokens
        : undefined,
    ),
  };
}

function describeStopReason(body: unknown, maxTokens: number): string | null {
  if (!isPlainObject(body)) return null;
  if (body.stop_reason === "refusal") {
    const details = isPlainObject(body.stop_details) ? body.stop_details : null;
    const category =
      details && typeof details.category === "string" ? details.category : null;
    return category
      ? `Anthropic refused the request (stop_reason=refusal, category=${category})`
      : "Anthropic refused the request (stop_reason=refusal)";
  }
  if (body.stop_reason === "max_tokens") {
    return `Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens, output cap ${maxTokens} tokens)`;
  }
  return null;
}

/**
 * The self-hosted server's own words from an error body: `error.message` when
 * the body is an Anthropic-shaped error, else the start of the body.
 */
function serverErrorMessage(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  try {
    const body: unknown = JSON.parse(trimmed);
    if (isPlainObject(body) && isPlainObject(body.error)) {
      const message = body.error.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return trimmed.slice(0, SERVER_MESSAGE_MAX_CHARS);
}

/**
 * Wording for HTTP and transport failures. Anthropic: as it always was.
 * Self-hosted: names the model server, so the athlete does not blame Anthropic.
 */
function failureWording(provider: CoachProvider) {
  if (provider === "anthropic") {
    return {
      idle: (ms: number) => `Anthropic stream idle for ${ms}ms; aborted`,
      overall: (ms: number) => `Anthropic call exceeded ${ms}ms overall; aborted`,
      fetchFailed: (reason: string | null) => reason ?? "anthropic_fetch_failed",
      http: (status: number, _text: string | null) =>
        `Anthropic Messages API returned ${status}`,
      streamError: (error: string) => `Anthropic stream error: ${error}`,
      incomplete: "Anthropic stream ended before message_stop",
    };
  }
  return {
    idle: (ms: number) => `The model server sent nothing for ${ms}ms; aborted`,
    overall: (ms: number) => `The model server call exceeded ${ms}ms overall; aborted`,
    fetchFailed: (reason: string | null) =>
      reason
        ? `Could not reach the model server: ${reason}`
        : "Could not reach the model server",
    http: (status: number, text: string | null) => {
      const said = serverErrorMessage(text);
      return said
        ? `The model server returned ${status}: ${said}`
        : `The model server returned ${status}`;
    },
    streamError: (error: string) => `The model server sent a stream error: ${error}`,
    incomplete: "The model server's stream ended before message_stop",
  };
}

/**
 * Request headers. Anthropic: the key in `x-api-key`, as always. Self-hosted:
 * the key, when there is one, in both `x-api-key` and `Authorization: Bearer`,
 * so the athlete need not know which their server checks; no key, neither.
 */
export function messagesHeaders(
  provider: CoachProvider,
  apiKey: string | null,
): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey ?? "",
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }
  return {
    "content-type": "application/json",
    ...(apiKey ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` } : {}),
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/**
 * The thinking half of a request. Anthropic: adaptive thinking with readable
 * summaries. Self-hosted: thinking enabled, with no `display`, since a local
 * server may not know adaptive mode or summaries. Shared with the self-hosted
 * connection test, so it asks the way a coach call does.
 */
/**
 * Thinking for the provider. Anthropic gets adaptive thinking with summaries. A self-hosted
 * call leaves `thinking` out and sends only the effort: the field is optional in the
 * Messages spec, and servers disagree on it (vLLM refuses `enabled` without a budget, then
 * refuses the budget unless the server has a reasoning config; Ollama has no adaptive mode).
 * Reasoning models think by the server's own default, with the effort as a hint.
 */
export function thinkingParams(provider: CoachProvider, effort: AnthropicEffort) {
  if (provider === "self_hosted") return { output_config: { effort } } as const;
  return {
    thinking: { type: "adaptive", display: "summarized" } as const,
    output_config: { effort },
  } as const;
}

async function callAnthropicMessages(options: {
  provider: CoachProvider;
  apiKey: string | null;
  apiUrl: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  fetchImpl: typeof globalThis.fetch;
  requestBody: AnthropicMessagesRequest;
  toolName: string;
}): Promise<AnthropicCallResult> {
  const {
    provider,
    apiKey,
    apiUrl,
    timeoutMs,
    idleTimeoutMs,
    fetchImpl,
    requestBody,
    toolName,
  } = options;

  const wording = failureWording(provider);
  const startedAt = Date.now();
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        controller.abort(
          new Error(wording.idle(idleTimeoutMs)),
        ),
      idleTimeoutMs,
    );
  };
  const totalTimer = setTimeout(
    () =>
      controller.abort(
        new Error(wording.overall(timeoutMs)),
      ),
    timeoutMs,
  );
  const cleanup = () => {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };
  const abortMessage = (err: unknown): string =>
    controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason.message
      : wording.fetchFailed(err instanceof Error ? err.message : null);

  try {
    armIdle();
    let response: Response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: messagesHeaders(provider, apiKey),
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        credentials: "omit",
      });
    } catch (err) {
      throw failWith(
        new LlmTransportError(abortMessage(err), {
          cause: err,
        }),
        {
          httpStatus: null,
          responseText: null,
          latencyMs: Date.now() - startedAt,
          stopReason: null,
          usage: null,
          content: null,
        },
      );
    }

    if (!response.ok) {
      let text: string | null = null;
      try {
        text = await response.text();
      } catch {
        // Error body unreadable; the status alone is still logged.
      }
      throw failWith(
        new LlmHttpError(response.status, wording.http(response.status, text)),
        {
          httpStatus: response.status,
          responseText: text,
          latencyMs: Date.now() - startedAt,
          stopReason: null,
          usage: null,
          content: null,
        },
      );
    }

    const read = await readMessageStream(response, {
      signal: controller.signal,
      onActivity: armIdle,
    });
    const latencyMs = Date.now() - startedAt;
    const message = read.message;
    const responseText = message ? JSON.stringify(message) : read.rawText || null;
    const base = { httpStatus: response.status, responseText, latencyMs };
    const partial = {
      stopReason: message ? readStopReason(message) : null,
      usage: message ? readUsage(message) : null,
      content: message ? contentAsReceived(message) : null,
    };

    if (read.streamError) {
      throw failWith(
        new LlmTransportError(
          message && !controller.signal.aborted
            ? wording.streamError(read.streamError)
            : read.streamError,
        ),
        { ...base, ...partial },
      );
    }
    if (!message) {
      throw failWith(
        new LlmSchemaError("Anthropic response was not a valid event stream"),
        { ...base, ...partial },
      );
    }
    if (!read.complete) {
      throw failWith(
        new LlmTransportError(wording.incomplete),
        { ...base, ...partial },
      );
    }

    const stopProblem = describeStopReason(message, requestBody.max_tokens);
    if (stopProblem) {
      throw failWith(new LlmSchemaError(stopProblem), { ...base, ...partial });
    }

    let toolInput: unknown;
    try {
      toolInput = extractToolInput(message, toolName);
    } catch (err) {
      if (err instanceof Error) failWith(err, { ...base, ...partial });
      throw err;
    }

    return {
      toolInput,
      content: partial.content ?? [],
      responseText: responseText ?? "",
      httpStatus: response.status,
      stopReason: readStopReason(message),
      usage: readUsage(message),
      latencyMs,
    };
  } finally {
    cleanup();
  }
}

/** Attempts at most for one coach call: the reply, and once more if it is refused or has unread plan lines (ADR 0002). */
export const COACH_CALL_ATTEMPTS = 2;

/** One attempt as askAtMostTwice hands it to the code that sends it. */
export type CoachAttempt = {
  /** 1 or 2. */
  attempt: number;
  /** True when no attempt follows this one, whatever it ends with. */
  last: boolean;
  /**
   * The id this attempt's row is written under when it is not refused: the
   * caller's call id, except on a retry that fixes lines of an accepted reply,
   * which gets a fresh id (the caller's names the accepted first reply).
   */
  callId: string | undefined;
  /** A fresh id: the row's when this attempt is refused for its shape and another follows. */
  refusedCallId: string | undefined;
  /** The row this one follows (a refused attempt, or the accepted reply it fixes); null on the first. */
  parentCallId: string | null;
  /** How `once` built this attempt's request; reported to onAttempt. Set by the live adapter. */
  request?: AttemptRequest;
};

/**
 * An attempt's reply accepted, but with plan lines that did not parse: the
 * loop asks once more, for those lines alone, and keeps this value if that
 * second attempt fails in any way.
 */
export class Unfinished<T> {
  constructor(readonly value: T) {}
}

/**
 * The id an attempt's call log row is written under. The caller's call id
 * names the reply it gets back (or the failure it is handed), so the messages
 * it links stay on the attempt that counted; a refused attempt that is asked
 * for again is written under its own id, and the next one links to it.
 */
export function attemptRowId(a: CoachAttempt, err: unknown): string | undefined {
  return !a.last && err instanceof LlmSchemaError ? a.refusedCallId : a.callId;
}

/**
 * The one attempt loop every coach call goes through: the five operations of
 * the live adapter, the replay harness's dry run and the smoke script. `once`
 * sends one attempt. Two attempts at most, on the target resolved before the
 * loop, never inside it (ADR 0004):
 * - an attempt refused for its shape (LlmSchemaError: validation, the plan's
 *   dates, a missing tool call, a stop at the output cap) is followed by one
 *   more; the last one's error is thrown as it came; any other error is thrown
 *   at once;
 * - an attempt returned as Unfinished (accepted with plan lines that did not
 *   parse) is followed by one more, whose value is returned when it succeeds;
 *   when it fails in any way the first value is returned, and the first row
 *   (the caller's call id) stays the reply that counted.
 * `once` decides what the second request holds (secondRequest in the live
 * adapter); the loop only decides whether there is one.
 */
export async function askAtMostTwice<T>(
  callOptions: LlmCallOptions | undefined,
  once: (attempt: CoachAttempt) => Promise<T | Unfinished<T>>,
): Promise<T> {
  const callId = callOptions?.callId;
  let parentCallId: string | null = null;
  let accepted: { value: T } | null = null;
  for (let n = 1; ; n++) {
    const a: CoachAttempt = {
      attempt: n,
      last: n >= COACH_CALL_ATTEMPTS,
      // The retry of an accepted reply is its own row; the caller's id stays on the reply.
      callId: accepted && callId ? randomUUID() : callId,
      refusedCallId: callId ? randomUUID() : undefined,
      parentCallId,
    };
    const report = (rowId: string | undefined, error: unknown) =>
      callOptions?.onAttempt?.({
        attempt: n,
        callId: rowId ?? null,
        error,
        ...(a.request ? { request: a.request } : {}),
      });
    try {
      const out = await once(a);
      report(a.callId, null);
      if (!(out instanceof Unfinished)) return out;
      if (a.last || accepted) return out.value;
      accepted = { value: out.value };
      parentCallId = a.callId ?? null;
    } catch (err) {
      const rowId = attemptRowId(a, err);
      report(rowId, err);
      if (accepted) return accepted.value;
      if (a.last || !(err instanceof LlmSchemaError)) throw err;
      parentCallId = rowId ?? null;
    }
  }
}

/**
 * Live LlmPort against Anthropic Messages API using the encrypted BYO key.
 * Weekly plan, mid-week chat/attach feedback and the About you drafts (onboarding,
 * Fix something, tidy-up) are all live.
 */
export function createAnthropicLlmPort(
  options?: AnthropicLlmPortOptions,
): LlmPort {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options?.timeoutMs ?? resolveAnthropicTimeoutMs();
  /** The silence limit for one call: the option when given, else per provider. */
  const idleTimeoutFor = (provider: CoachProvider): number =>
    options?.idleTimeoutMs ??
    (provider === "self_hosted"
      ? resolveSelfHostedIdleTimeoutMs()
      : DEFAULT_IDLE_TIMEOUT_MS);
  const resolveCoachTarget =
    options?.resolveCoachTarget ??
    createCoachTargetResolver({
      dataProtectionKey: options?.dataProtectionKey,
      readApiKey: options?.readApiKey,
      readCoachModel: options?.readCoachModel,
      messagesUrl: options?.apiUrl,
    });
  const recorder = options?.recorder ?? createPostgresLlmCallRecorder();
  const appVersion = options?.appVersion ?? resolveAppVersion();
  /**
   * Thinking as thinkingParams sends it. tool_choice stays "auto": a forced
   * tool skips the thinking block, so the prompt asks for the tool call.
   */
  function reasoningParams(target: CoachTarget) {
    return {
      ...thinkingParams(target.provider, target.effort),
      tool_choice: { type: "auto" },
      stream: true,
    } as const;
  }

  /**
   * The target the call was handed, else the one in force now: read once, and
   * the request is built from it and nothing else. Anthropic with no key, no
   * call; a self-hosted server may need no key.
   */
  async function targetFor(
    callOptions: LlmCallOptions | undefined,
  ): Promise<CoachTarget> {
    const target = callOptions?.coachTarget ?? (await resolveCoachTarget());
    if (target.provider === "anthropic" && !target.credentials.apiKey) {
      throw new LlmNotConfiguredError();
    }
    return target;
  }

  /** The HTTP side of one call, sent to the target. */
  function send(
    target: CoachTarget,
    toolName: string,
    requestBody: AnthropicMessagesRequest,
  ) {
    return () =>
      callAnthropicMessages({
        provider: target.provider,
        apiKey: target.credentials.apiKey,
        apiUrl: target.messagesUrl,
        timeoutMs,
        idleTimeoutMs: idleTimeoutFor(target.provider),
        fetchImpl,
        toolName,
        requestBody,
      });
  }

  /** Append one row; a failing recorder never changes the caller's outcome. */
  async function safeRecord(row: LlmCallRecord): Promise<void> {
    try {
      await recorder.record(row);
    } catch (err) {
      // Logging is best-effort: never fail a coaching reply over the audit log.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[llm-call-log] row dropped (id=${row.id} operation=${row.operation}): ${reason}`,
      );
    }
  }

  /**
   * One attempt = one row, on every branch, under the id attemptRowId names. A
   * missing key throws before this runs, so it writes nothing. `seen` is told
   * what came back (content, stop reason), so a second request can be built
   * from it; `validate`'s planRetry, when present, comes back with the value.
   */
  async function attempt<T>(
    operation: LlmCallOperation,
    a: CoachAttempt,
    callOptions: LlmCallOptions | undefined,
    target: CoachTarget,
    requestBody: AnthropicMessagesRequest,
    call: () => Promise<AnthropicCallResult>,
    validate: Validate<T>,
    seen: FirstReply,
  ): Promise<{ value: T; planRetry?: PlanRetry<T>; fixed?: string[] }> {
    const startedAt = Date.now();
    const base = {
      operation,
      provider: target.provider,
      serverHost:
        target.provider === "self_hosted" ? selfHostedHost(target.messagesUrl) : null,
      model: requestBody.model,
      appVersion,
      weekSessionId: callOptions?.weekSessionId ?? null,
      parentCallId: a.parentCallId,
      request: requestBody,
    };
    let result: AnthropicCallResult | undefined;
    try {
      result = await call();
      seen.content = result.content;
      seen.stopReason = result.stopReason;
      const validated = validate(result.toolInput);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      if (a.callId) {
        await safeRecord({
          ...base,
          id: a.callId,
          responseRaw: result.responseText,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
          stopReason: result.stopReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          thinkingTokens: result.usage.thinkingTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          outcome: validated.repairs ? "repaired" : "ok",
          errorMessage: validated.repairs?.join("; ") ?? null,
        });
      }
      return {
        value: validated.value,
        ...(validated.planRetry ? { planRetry: validated.planRetry } : {}),
        ...("fixed" in validated && Array.isArray(validated.fixed)
          ? { fixed: validated.fixed as string[] }
          : {}),
      };
    } catch (err) {
      const meta: AnthropicFailureMeta =
        (err instanceof Error ? failureMeta.get(err) : undefined) ??
        (result
          ? {
              httpStatus: result.httpStatus,
              responseText: result.responseText,
              latencyMs: result.latencyMs,
              stopReason: result.stopReason,
              usage: result.usage,
              content: result.content,
            }
          : {
              httpStatus: null,
              responseText: null,
              latencyMs: Date.now() - startedAt,
              stopReason: null,
              usage: null,
              content: null,
            });
      seen.content = meta.content;
      seen.stopReason = meta.stopReason;
      seen.error = err instanceof Error ? err.message : String(err);
      const rowId = attemptRowId(a, err);
      if (rowId) {
        const outcome: LlmCallOutcome =
          err instanceof LlmHttpError
            ? "http_error"
            : err instanceof LlmSchemaError
              ? "schema_invalid"
              : "transport_error";
        await safeRecord({
          ...base,
          id: rowId,
          responseRaw: meta.responseText,
          httpStatus: meta.httpStatus,
          latencyMs: meta.latencyMs,
          stopReason: meta.stopReason,
          inputTokens: meta.usage?.inputTokens ?? null,
          outputTokens: meta.usage?.outputTokens ?? null,
          thinkingTokens: meta.usage?.thinkingTokens ?? null,
          cacheReadTokens: meta.usage?.cacheReadTokens ?? null,
          cacheCreationTokens: meta.usage?.cacheCreationTokens ?? null,
          outcome,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  /**
   * One coach call, every operation: the caller resolved the target once and
   * built the request once from it, so both attempts go to the identical
   * server with the identical key, model, effort, system prompt and tools.
   * The second request is the first plus the turns secondRequest adds; when
   * the first reply was accepted with plan lines that did not parse, the
   * second reply is read by its planRetry, which takes only the failed dates.
   */
  function ask<T>(
    operation: LlmCallOperation,
    callOptions: LlmCallOptions | undefined,
    target: CoachTarget,
    toolName: string,
    requestBody: AnthropicMessagesRequest,
    validate: Validate<T>,
  ): Promise<T> {
    let first: FirstReply | null = null;
    let firstRetry: PlanRetry<T> | null = null;
    return askAtMostTwice<T>(callOptions, async (a) => {
      const seen: FirstReply = { content: null, stopReason: null, error: null, failures: null };
      let body = requestBody;
      let check: Validate<T> = validate;
      if (a.attempt === 1 || !first) {
        a.request = { kind: "first", turns: turnsOf(body.messages) };
      } else {
        const next = secondRequest(requestBody, toolName, first);
        body = next.body;
        a.request = { kind: next.kind, turns: turnsOf(body.messages) };
        if (firstRetry) {
          const retry = firstRetry;
          check = (input) => retry.takeFixes(input);
          a.request.fixDates = [...retry.dates];
        }
      }
      try {
        const out = await attempt(
          operation,
          a,
          callOptions,
          target,
          body,
          send(target, toolName, body),
          check,
          seen,
        );
        if (out.fixed && a.request) a.request.fixed = out.fixed;
        if (out.planRetry && !a.last) {
          first = { ...seen, failures: out.planRetry.failures };
          firstRetry = out.planRetry;
          return new Unfinished(out.value);
        }
        return out.value;
      } catch (err) {
        first = seen;
        throw err;
      }
    });
  }

  /** One About you call: same key check, reasoning params, logging and validation as the coach replies. */
  async function aboutYou<T>(
    operation: LlmCallOperation,
    callOptions: LlmCallOptions | undefined,
    system: string,
    toolDescription: string,
    userPrompt: string,
    validate: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
  ): Promise<T> {
    const target = await targetFor(callOptions);
    const requestBody: AnthropicMessagesRequest = {
      model: target.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: [aboutYouToolSchema(toolDescription)],
      ...reasoningParams(target),
      messages: [{ role: "user", content: userPrompt }],
    };
    return ask(
      operation,
      callOptions,
      target,
      ABOUT_YOU_TOOL_NAME,
      requestBody,
      validate,
    );
  }

  return {
    resolveCoachTarget,

    async generateWeeklyReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<WeeklyReply> {
      const target = await targetFor(callOptions);

      const weekStartMonday = resolveWeeklyPlanWeek(packet).weekStartMonday;
      const context = weeklyReplyContext(packet);
      const requestBody: AnthropicMessagesRequest = {
        model: target.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: weeklySystemPrompt(packet.goal),
        tools: [
          {
            name: WEEKLY_TOOL_NAME,
            description:
              "Submit the weekly read and next week's plan as seven lines.",
            input_schema: weeklyReplyToolSchema(weekStartMonday, context.unit ?? "imperial"),
          },
        ],
        ...reasoningParams(target),
        messages: [
          {
            role: "user",
            content: buildWeeklyUserPrompt(packet, weekStartMonday),
          },
        ],
      };
      // The plan box is parsed against the plan week here: days that do not
      // parse are stored unparsed; a box with no line for the week is refused
      // and asked for once more like any other refusal.
      return ask(
        "weekly_reply",
        callOptions,
        target,
        WEEKLY_TOOL_NAME,
        requestBody,
        (input) => validateWeeklyReply(input, weekStartMonday, context),
      );
    },

    async generateMidWeekChatReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<MidWeekChatReply> {
      const target = await targetFor(callOptions);

      const weekStartMonday = resolvePlanWeekStartMonday(packet);
      const requestBody: AnthropicMessagesRequest = {
        model: target.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: midWeekSystemPrompt(packet.goal),
        tools: [
          {
            name: MIDWEEK_TOOL_NAME,
            description:
              "Submit the mid-week coach reply (attached-run feedback and optional remaining-day plan patches when present).",
            input_schema: midWeekChatReplyToolSchema(),
          },
        ],
        ...reasoningParams(target),
        messages: [
          {
            role: "user",
            content: buildMidWeekUserPrompt(packet, weekStartMonday),
          },
        ],
      };
      return ask(
        "mid_week_chat",
        callOptions,
        target,
        MIDWEEK_TOOL_NAME,
        requestBody,
        (input) => validateMidWeekChatReply(input, weekStartMonday),
      );
    },

    async generateDossierV1(
      input: DossierV1Input,
      callOptions?: LlmCallOptions,
    ): Promise<DossierV1Draft> {
      return aboutYou(
        "dossier_v1",
        callOptions,
        DOSSIER_V1_SYSTEM_PROMPT,
        "Submit the athlete's first About you document and the note-card summary.",
        buildDossierV1UserPrompt(input),
        validateAboutYou(validateDossierV1Draft),
      );
    },

    async generateDossierCorrection(
      input: DossierCorrectionInput,
      callOptions?: LlmCallOptions,
    ): Promise<DossierCorrectionDraft> {
      return aboutYou(
        "dossier_correction",
        callOptions,
        DOSSIER_CORRECTION_SYSTEM_PROMPT,
        "Submit the corrected About you document and what changed.",
        buildDossierCorrectionUserPrompt(input),
        validateAboutYou(validateDossierCorrectionDraft),
      );
    },

    async generateDossierAudit(
      input: DossierAuditInput,
      callOptions?: LlmCallOptions,
    ): Promise<DossierAuditDraft> {
      return aboutYou(
        "dossier_audit",
        callOptions,
        DOSSIER_AUDIT_SYSTEM_PROMPT,
        "Submit the tidied About you document and what changed.",
        buildDossierAuditUserPrompt(input),
        validateAboutYou(validateDossierAuditDraft),
      );
    },
  };
}

/** Resolve default LlmPort from LLM_PROVIDER (stub | anthropic). */
export function resolveDefaultLlmPort(
  options?: AnthropicLlmPortOptions & {
    env?: NodeJS.ProcessEnv;
  },
): LlmPort {
  const env = options?.env ?? process.env;
  if (resolveLlmProvider(env) === "anthropic") {
    return createAnthropicLlmPort(options);
  }
  return createStubLlmPort({
    recorder: options?.recorder,
    appVersion: options?.appVersion,
  });
}
