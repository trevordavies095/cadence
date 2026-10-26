import { SecretProtector } from "../crypto/secretProtector.js";
import { resolveAppVersion } from "../llmCallLog/appVersion.js";
import { createPostgresLlmCallRecorder } from "../llmCallLog/recorder.js";
import type {
  LlmCallOperation,
  LlmCallOutcome,
  LlmCallRecord,
  LlmCallRecorder,
} from "../llmCallLog/types.js";
import type { ModelPacket } from "../packet/types.js";
import { readAnthropicApiKey } from "../settings/anthropicStore.js";
import { resolveAnthropicEffort, type AnthropicEffort } from "./effort.js";
import { readMessageStream } from "./anthropicStream.js";
import {
  LlmHttpError,
  LlmNotConfiguredError,
  LlmSchemaError,
  LlmTransportError,
  type LlmCallOptions,
  type LlmPort,
} from "./port.js";
import { formatIsoWeekRangeShort } from "../clock/weekRangeShort.js";
import {
  DOSSIER_AUDIT_SYSTEM_PROMPT,
  DOSSIER_CORRECTION_SYSTEM_PROMPT,
  DOSSIER_V1_SYSTEM_PROMPT,
  MIDWEEK_SYSTEM_PROMPT,
  safetyCalloutsJsonSchema,
  WEEKLY_SYSTEM_PROMPT,
} from "./safety.js";
import {
  expectedPlanDates,
  MAX_BULLET_LENGTH,
  MAX_DOSSIER_BODY_LENGTH,
  MAX_DOSSIER_SUMMARY_BULLETS,
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  validateMidWeekChatReply,
  validateWeeklyReply,
} from "./schema.js";
import { COACH_STANCE_SUMMARY } from "./stance.js";
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
/** Thinking tokens count toward max_tokens; leave generous room for the reply. */
const MAX_OUTPUT_TOKENS = 64_000;
/** Match Claude app dogfood (Opus 4.7). Override with ANTHROPIC_MODEL. */
const DEFAULT_MODEL = "claude-opus-4-7";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
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

export type AnthropicLlmPortOptions = {
  /** Override wrapping key (tests). Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
  /** Injected fetch for tests (fake Anthropic HTTP). */
  fetchImpl?: typeof globalThis.fetch;
  /** Overall cap per call. Defaults to ANTHROPIC_TIMEOUT_MS or 15 minutes. */
  timeoutMs?: number;
  /** Abort after this long without stream data. Defaults to 60 seconds. */
  idleTimeoutMs?: number;
  /** Thinking effort. Defaults to ANTHROPIC_EFFORT or xhigh. */
  effort?: AnthropicEffort;
  /** Anthropic model id (defaults to ANTHROPIC_MODEL or claude-opus-4-7). */
  model?: string;
  /** Override Messages API URL (tests). */
  apiUrl?: string;
  /** Override credential loader (defaults to decrypting anthropic_connection). */
  readApiKey?: () => Promise<string | null>;
  /** LLM call log sink. Defaults to the Postgres recorder. */
  recorder?: LlmCallRecorder;
  /** Code version stamped on log rows. Defaults to APP_VERSION / `dev`. */
  appVersion?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function weeklyReplyToolSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["analysis", "prescribedWeek"],
    properties: {
      analysis: {
        type: "string",
        description:
          "Headline read, concerns/flags, and answers (markdown or plain prose).",
      },
      prescribedWeek: {
        type: "object",
        additionalProperties: false,
        required: ["week", "days"],
        properties: {
          week: {
            type: "string",
            description: "ISO week id, e.g. 2026-W43",
          },
          days: {
            type: "array",
            minItems: 7,
            maxItems: 7,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["date", "dayType"],
              properties: {
                date: {
                  type: "string",
                  description: "Local calendar date YYYY-MM-DD",
                },
                dayType: {
                  type: "string",
                  enum: ["rest", "easy", "quality", "long", "race", "other"],
                },
                run: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: ["easy", "quality", "long", "race", "other"],
                    },
                    distanceM: { type: "number" },
                    structure: { type: ["string", "null"] },
                    paceOrHr: { type: ["string", "null"] },
                    shoes: { type: ["string", "null"] },
                  },
                  required: ["type", "distanceM"],
                },
                strength: { type: ["string", "null"] },
                notes: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      settingsProposalBullets: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional soft-gate dossier/settings proposal bullets (short).",
      },
      safetyCallouts: safetyCalloutsJsonSchema(),
    },
  };
}

function prescribedDayJsonSchema(): Record<string, unknown> {
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
      },
      run: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["easy", "quality", "long", "race", "other"],
          },
          distanceM: { type: "number" },
          structure: { type: ["string", "null"] },
          paceOrHr: { type: ["string", "null"] },
          shoes: { type: ["string", "null"] },
        },
        required: ["type", "distanceM"],
      },
      strength: { type: ["string", "null"] },
      notes: { type: ["string", "null"] },
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
  planIsoWeek: string | null,
): string {
  const dates = expectedPlanDates(weekStartMonday);
  const reviewed = packet.week?.isoWeek?.trim();
  return [
    reviewed ? `Reviewed week (already happened): ${reviewed}` : null,
    `Plan week ISO label: ${planIsoWeek ?? reviewed ?? "unknown"}`,
    `Plan week Monday (YYYY-MM-DD): ${weekStartMonday}`,
    `prescribedWeek.days must use these exact dates Mon–Sun: ${dates.join(", ")}`,
    "Prescribe one coherent week of running training for this athlete.",
    "Call the submit_weekly_reply tool exactly once with your full answer.",
    "Include analysis with headline, concerns/flags, and answers.",
    "When red flags appear, populate safetyCallouts (escalate; do not diagnose).",
    "Model packet (redacted; no identity PII or GPS):",
    JSON.stringify(packet),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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

type AnthropicMessagesRequest = {
  model: string;
  max_tokens: number;
  system: string;
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  thinking: { type: "adaptive"; display: "summarized" };
  output_config: { effort: AnthropicEffort };
  tool_choice: { type: "auto" };
  stream: true;
  messages: Array<{ role: "user"; content: string }>;
};

type AnthropicUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingTokens: number | null;
};

type AnthropicCallResult = {
  toolInput: unknown;
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

function describeStopReason(body: unknown): string | null {
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
    return "Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens)";
  }
  return null;
}

async function callAnthropicMessages(options: {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  fetchImpl: typeof globalThis.fetch;
  requestBody: AnthropicMessagesRequest;
  toolName: string;
}): Promise<AnthropicCallResult> {
  const {
    apiKey,
    apiUrl,
    timeoutMs,
    idleTimeoutMs,
    fetchImpl,
    requestBody,
    toolName,
  } = options;

  const startedAt = Date.now();
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        controller.abort(
          new Error(`Anthropic stream idle for ${idleTimeoutMs}ms; aborted`),
        ),
      idleTimeoutMs,
    );
  };
  const totalTimer = setTimeout(
    () =>
      controller.abort(
        new Error(`Anthropic call exceeded ${timeoutMs}ms overall; aborted`),
      ),
    timeoutMs,
  );
  const cleanup = () => {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };
  const abortMessage = (err: unknown, fallback: string): string =>
    controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason.message
      : err instanceof Error
        ? err.message
        : fallback;

  try {
    armIdle();
    let response: Response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        credentials: "omit",
      });
    } catch (err) {
      throw failWith(
        new LlmTransportError(abortMessage(err, "anthropic_fetch_failed"), {
          cause: err,
        }),
        {
          httpStatus: null,
          responseText: null,
          latencyMs: Date.now() - startedAt,
          stopReason: null,
          usage: null,
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
        new LlmHttpError(
          response.status,
          `Anthropic Messages API returned ${response.status}`,
        ),
        {
          httpStatus: response.status,
          responseText: text,
          latencyMs: Date.now() - startedAt,
          stopReason: null,
          usage: null,
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
    };

    if (read.streamError) {
      throw failWith(
        new LlmTransportError(
          message && !controller.signal.aborted
            ? `Anthropic stream error: ${read.streamError}`
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
        new LlmTransportError("Anthropic stream ended before message_stop"),
        { ...base, ...partial },
      );
    }

    const stopProblem = describeStopReason(message);
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
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const effort = options?.effort ?? resolveAnthropicEffort();
  const model =
    options?.model?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    DEFAULT_MODEL;
  const apiUrl = options?.apiUrl?.trim() || ANTHROPIC_MESSAGES_URL;
  const readApiKey =
    options?.readApiKey ??
    (() => {
      const protector = new SecretProtector(options?.dataProtectionKey);
      return readAnthropicApiKey(protector);
    });
  const recorder = options?.recorder ?? createPostgresLlmCallRecorder();
  const appVersion = options?.appVersion ?? resolveAppVersion();
  /**
   * Adaptive thinking with readable summaries. tool_choice stays "auto": a
   * forced tool skips the thinking block, so the prompt asks for the tool call.
   */
  const REASONING_PARAMS = {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    tool_choice: { type: "auto" },
    stream: true,
  } as const;

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
   * One attempt = one row, on every branch. A missing key throws before this
   * runs, so it writes nothing.
   */
  async function attempt<T>(
    operation: LlmCallOperation,
    callOptions: LlmCallOptions | undefined,
    requestBody: AnthropicMessagesRequest,
    call: () => Promise<AnthropicCallResult>,
    validate: (
      toolInput: unknown,
    ) => { ok: true; value: T } | { ok: false; error: string },
  ): Promise<T> {
    const startedAt = Date.now();
    const callId = callOptions?.callId;
    const base = {
      operation,
      provider: "anthropic" as const,
      model,
      appVersion,
      weekSessionId: callOptions?.weekSessionId ?? null,
      parentCallId: null,
      request: requestBody,
    };
    let result: AnthropicCallResult | undefined;
    try {
      result = await call();
      const validated = validate(result.toolInput);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      if (callId) {
        await safeRecord({
          ...base,
          id: callId,
          responseRaw: result.responseText,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
          stopReason: result.stopReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          thinkingTokens: result.usage.thinkingTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          outcome: "ok",
          errorMessage: null,
        });
      }
      return validated.value;
    } catch (err) {
      if (callId) {
        const meta: AnthropicFailureMeta =
          (err instanceof Error ? failureMeta.get(err) : undefined) ??
          (result
            ? {
                httpStatus: result.httpStatus,
                responseText: result.responseText,
                latencyMs: result.latencyMs,
                stopReason: result.stopReason,
                usage: result.usage,
              }
            : {
                httpStatus: null,
                responseText: null,
                latencyMs: Date.now() - startedAt,
                stopReason: null,
                usage: null,
              });
        const outcome: LlmCallOutcome =
          err instanceof LlmHttpError
            ? "http_error"
            : err instanceof LlmSchemaError
              ? "schema_invalid"
              : "transport_error";
        await safeRecord({
          ...base,
          id: callId,
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

  /** One About you call: same key check, reasoning params, logging and validation as the coach replies. */
  async function aboutYou<T>(
    operation: LlmCallOperation,
    callOptions: LlmCallOptions | undefined,
    system: string,
    toolDescription: string,
    userPrompt: string,
    validate: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
  ): Promise<T> {
    const apiKey = await readApiKey();
    if (!apiKey) {
      throw new LlmNotConfiguredError();
    }
    const requestBody: AnthropicMessagesRequest = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: [aboutYouToolSchema(toolDescription)],
      ...REASONING_PARAMS,
      messages: [{ role: "user", content: userPrompt }],
    };
    return attempt(
      operation,
      callOptions,
      requestBody,
      () =>
        callAnthropicMessages({
          apiKey,
          apiUrl,
          timeoutMs,
          idleTimeoutMs,
          fetchImpl,
          toolName: ABOUT_YOU_TOOL_NAME,
          requestBody,
        }),
      validate,
    );
  }

  return {
    async generateWeeklyReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<WeeklyReply> {
      const apiKey = await readApiKey();
      if (!apiKey) {
        throw new LlmNotConfiguredError();
      }

      const planWeek = resolveWeeklyPlanWeek(packet);
      const weekStartMonday = planWeek.weekStartMonday;
      const requestBody: AnthropicMessagesRequest = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: WEEKLY_SYSTEM_PROMPT,
        tools: [
          {
            name: WEEKLY_TOOL_NAME,
            description:
              "Submit the weekly coaching analysis and structured 7-day prescribed week.",
            input_schema: weeklyReplyToolSchema(),
          },
        ],
        ...REASONING_PARAMS,
        messages: [
          {
            role: "user",
            content: buildWeeklyUserPrompt(
              packet,
              weekStartMonday,
              planWeek.isoWeek,
            ),
          },
        ],
      };
      return attempt(
        "weekly_reply",
        callOptions,
        requestBody,
        () =>
          callAnthropicMessages({
            apiKey,
            apiUrl,
            timeoutMs,
            idleTimeoutMs,
            fetchImpl,
            toolName: WEEKLY_TOOL_NAME,
            requestBody,
          }),
        (input) => validateWeeklyReply(input, weekStartMonday),
      );
    },

    async generateMidWeekChatReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<MidWeekChatReply> {
      const apiKey = await readApiKey();
      if (!apiKey) {
        throw new LlmNotConfiguredError();
      }

      const weekStartMonday = resolvePlanWeekStartMonday(packet);
      const requestBody: AnthropicMessagesRequest = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: MIDWEEK_SYSTEM_PROMPT,
        tools: [
          {
            name: MIDWEEK_TOOL_NAME,
            description:
              "Submit the mid-week coach reply (attached-run feedback and optional remaining-day plan patches when present).",
            input_schema: midWeekChatReplyToolSchema(),
          },
        ],
        ...REASONING_PARAMS,
        messages: [
          {
            role: "user",
            content: buildMidWeekUserPrompt(packet, weekStartMonday),
          },
        ],
      };
      return attempt(
        "mid_week_chat",
        callOptions,
        requestBody,
        () =>
          callAnthropicMessages({
            apiKey,
            apiUrl,
            timeoutMs,
            idleTimeoutMs,
            fetchImpl,
            toolName: MIDWEEK_TOOL_NAME,
            requestBody,
          }),
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
  const provider = (env.LLM_PROVIDER ?? "stub").trim().toLowerCase();
  if (provider === "anthropic" || provider === "live") {
    return createAnthropicLlmPort(options);
  }
  return createStubLlmPort({
    recorder: options?.recorder,
    appVersion: options?.appVersion,
  });
}
