import { messagesHeaders, thinkingParams } from "../llm/anthropic.js";
import { readMessageStream, type StreamedMessage } from "../llm/anthropicStream.js";
import { selfHostedEndpoint } from "./selfHostedStore.js";

/**
 * Test connection for a self-hosted model server (#54). Two steps: the server
 * lists its models with the saved key, then the chosen model reads a prompt of
 * about 40k tokens. A server whose context window is too small may quietly cut
 * the prompt and still answer, so the probe checks both the input tokens the
 * server reports and that the reply carries a code word given only at the very
 * start of the prompt. Cadence's weekly packets reach about 36k tokens.
 */

/** The code word. It appears once, in the prompt's first line, and nowhere in the filler. */
export const PROBE_WORD = "PELICAN";

/** Filler lines in the probe prompt. Changing this changes PROBE_SENT_TOKENS. */
const PROBE_FILLER_LINES = 2_200;

/**
 * Tokens in the probe prompt (system plus user message), estimated as
 * characters / 4 rounded (the prompt is 161,893 characters of plain English;
 * the word-count rule of thumb, words x 4/3, gives about 38.5k, close by). No
 * tokenizer could be called when this was set: re-measure with the Opus 4.7
 * `count_tokens` endpoint and replace the number. A test keeps it in step with
 * the prompt text.
 */
export const PROBE_SENT_TOKENS = 40_473;

/** Reported input below this share of PROBE_SENT_TOKENS means the prompt was cut. */
export const PROBE_CUT_RATIO = 0.9;

/** Room for a short think and a one-word reply; thinking counts toward it. */
const PROBE_MAX_TOKENS = 4_096;

/** The listing is a quick question; a server that is up answers in seconds. */
const LISTING_TIMEOUT_MS = 10_000;

const SUBJECTS = [
  "The runner",
  "A steady easy run",
  "The long run",
  "A recovery jog",
  "The tempo session",
  "A hill repeat",
  "The cool-down",
];
const VERBS = [
  "builds",
  "protects",
  "sharpens",
  "tests",
  "rewards",
  "steadies",
  "stretches",
  "calms",
  "strengthens",
  "shapes",
  "settles",
];
const OBJECTS = [
  "aerobic fitness",
  "the legs for race day",
  "a relaxed stride",
  "patience on the climbs",
  "the habit of showing up",
  "an even breathing rhythm",
  "confidence over the distance",
  "form when tired",
  "the heart's easy range",
  "the feel for pace",
  "the rest of the week",
  "a light footfall",
  "recovery between hard days",
];
const WHENS = [
  "on a cool morning",
  "after a long week",
  "in light rain",
  "along the river path",
  "before breakfast",
];

export const PROBE_SYSTEM_PROMPT =
  "You are checking that a long document arrived whole. Read all of it, then follow the instruction on its last line.";

/**
 * The probe's user message: the code word first, numbered plain-English
 * sentences about running, then an instruction that names the word's place but
 * not the word. A server that drops the start loses the word; one that drops
 * the end loses the instruction. Deterministic, built once.
 */
function buildProbeUserPrompt(): string {
  const lines = [`The code word for this check is ${PROBE_WORD}. Remember it.`];
  for (let n = 1; n <= PROBE_FILLER_LINES; n++) {
    lines.push(
      `Line ${n}. ${SUBJECTS[n % SUBJECTS.length]} ${VERBS[n % VERBS.length]} ${OBJECTS[n % OBJECTS.length]} ${WHENS[n % WHENS.length]}.`,
    );
  }
  lines.push(
    "Last line: reply with the code word given in the first line of this document, and nothing else.",
  );
  return lines.join("\n");
}

export const PROBE_USER_PROMPT = buildProbeUserPrompt();

export type ListingFailure = "unreachable" | "unauthorized" | "http_error";
export type ProbeFailure = ListingFailure | "timeout" | "invalid_response" | "not_run";

export type SelfHostedTestResult = {
  listing: { ok: boolean; reason?: ListingFailure };
  probe: {
    ok: boolean;
    verdict?: "ok" | "cut";
    sentTokens: number;
    reportedTokens: number | null;
    wordFound: boolean;
    reason?: ProbeFailure;
  };
};

/**
 * Cut when the server reports under 90 percent of the tokens sent, or the
 * reply misses the code word. With no usage reported, the word alone decides.
 */
export function probeVerdict(reportedTokens: number | null, wordFound: boolean): "ok" | "cut" {
  if (!wordFound) return "cut";
  if (reportedTokens !== null && reportedTokens < PROBE_SENT_TOKENS * PROBE_CUT_RATIO) {
    return "cut";
  }
  return "ok";
}

function classifyStatus(status: number): ListingFailure {
  return status === 401 || status === 403 ? "unauthorized" : "http_error";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Input tokens the server says it read. Cache reads and writes count: a server
 * that cached the prompt from an earlier test reports most of it there.
 */
function reportedInputTokens(message: Record<string, unknown>): number | null {
  const usage = isObj(message.usage) ? message.usage : {};
  if (typeof usage.input_tokens !== "number") return null;
  const extra = (v: unknown) => (typeof v === "number" ? v : 0);
  return (
    usage.input_tokens +
    extra(usage.cache_read_input_tokens) +
    extra(usage.cache_creation_input_tokens)
  );
}

function replyText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((b): b is Record<string, unknown> => isObj(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** A server that ignored `stream: true` and answered with one JSON message. */
function parsePlainMessage(rawText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return isObj(parsed) && Array.isArray(parsed.content) ? parsed : null;
  } catch {
    return null;
  }
}

export async function testSelfHostedConnection(options: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fetchImpl: typeof globalThis.fetch;
  /** Cap on the probe call: the self-hosted idle limit. */
  timeoutMs: number;
}): Promise<SelfHostedTestResult> {
  const { baseUrl, apiKey, model, fetchImpl, timeoutMs } = options;
  const headers = messagesHeaders("self_hosted", apiKey);
  const probeBase = { sentTokens: PROBE_SENT_TOKENS, reportedTokens: null, wordFound: false };

  // Step one: the listing, with the same key headers a coach call sends.
  let listingFailure: ListingFailure | null = null;
  try {
    const res = await fetchImpl(selfHostedEndpoint(baseUrl, "models"), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(Math.min(LISTING_TIMEOUT_MS, timeoutMs)),
      credentials: "omit",
    });
    if (!res.ok) listingFailure = classifyStatus(res.status);
    await res.body?.cancel().catch(() => {});
  } catch {
    listingFailure = "unreachable";
  }
  if (listingFailure) {
    return {
      listing: { ok: false, reason: listingFailure },
      probe: { ok: false, ...probeBase, reason: "not_run" },
    };
  }

  // Step two: the probe, asked the way a coach call asks, minus the reply tool.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe timed out")), timeoutMs);
  const failed = (reason: ProbeFailure): SelfHostedTestResult => ({
    listing: { ok: true },
    probe: { ok: false, ...probeBase, reason },
  });
  try {
    let response: Response;
    try {
      response = await fetchImpl(selfHostedEndpoint(baseUrl, "messages"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: PROBE_MAX_TOKENS,
          system: PROBE_SYSTEM_PROMPT,
          ...thinkingParams("self_hosted", "low"),
          stream: true,
          messages: [{ role: "user", content: PROBE_USER_PROMPT }],
        }),
        signal: controller.signal,
        credentials: "omit",
      });
    } catch {
      return failed(controller.signal.aborted ? "timeout" : "unreachable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return failed(classifyStatus(response.status));
    }
    const read = await readMessageStream(response, {
      signal: controller.signal,
      onActivity: () => {},
    });
    if (controller.signal.aborted) return failed("timeout");
    let message: StreamedMessage | Record<string, unknown> | null = read.message;
    if (!message) message = parsePlainMessage(read.rawText);
    else if (read.streamError || !read.complete) message = null;
    if (!message) return failed("invalid_response");

    const reportedTokens = reportedInputTokens(message);
    const wordFound = replyText(message).toUpperCase().includes(PROBE_WORD);
    return {
      listing: { ok: true },
      probe: {
        ok: true,
        verdict: probeVerdict(reportedTokens, wordFound),
        sentTokens: PROBE_SENT_TOKENS,
        reportedTokens,
        wordFound,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
