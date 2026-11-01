/**
 * Smoke test for a self-hosted model server (ticket 11). Not a CI test: a
 * person runs it against a real server to see whether every coach operation
 * works there before trusting it with the athlete's weeks.
 *
 *   cd api
 *   SH_KEY=... npx tsx scripts/smoke-self-hosted.ts \
 *     --base-url http://macbook.local:8000 --key-env SH_KEY --model gpt-oss-20b
 *
 * Runs, one after another, through the live adapter with a target built from
 * the flags (the saved setting is never read, ADR 0004, and nothing is written
 * to a database):
 *
 *   weekly     the weekly reply, asked once more when refused for its shape (ADR 0002)
 *   midweek    a mid-week chat with no attachment
 *   attached   a mid-week question about an attached run
 *   aboutyou   the About you first draft
 *   correction an About you correction
 *   audit      an About you tidy-up
 *   probe      the Test connection probe (the ~40k-token code-word prompt)
 *
 * Inputs: the demo snapshot's call log (the latest weekly call, the first
 * mid-week call without an attachment, the one with an attachment, and the
 * About you first-draft call). The correction and the tidy-up are built here
 * from the snapshot's latest About you version, with a fixed athlete message.
 * Pass --weekly-packet <file> to send another weekly packet instead, such as a
 * season packet under tests/fixtures/seasons/season-packets.
 *
 * Prints a markdown table, one row per step: outcome (ok, retried, schema
 * failed, error), time to first token, total time, input/output/thinking
 * tokens, whether a thinking block came back, the stop reason, and whether the
 * idle or overall limit fired. Then the refusal reasons and errors, the probe's
 * numbers, and the server's version when the listing, a response header or
 * oMLX's /api/status reveals it.
 *
 * Flags:
 *   --base-url <url>      the model server (a trailing /v1 is not doubled)   required
 *   --model <id>          the model id the server lists                      required
 *   --key-env <VAR>       the env var holding the key, so it never appears on a
 *                         command line; without it no key is sent
 *   --effort <level>      low | medium | high | xhigh | max (default high)
 *   --only <steps>        comma-separated subset of the steps above, run in
 *                         the order given (Ctrl-C prints the steps finished so far)
 *   --weekly-packet <f>   a packet file (bare, or { "packet": ... }) for the weekly step
 *   --record <file.sse>   save the raw SSE bytes of the weekly reply (the last
 *                         attempt) to this file, with <file>.json (sidecar) and
 *                         <file>.packet.json (the packet sent) beside it
 *   --server <name>       server name for the sidecar (default "unknown")
 *   --hardware <text>     hardware note for the sidecar
 *   --context <tokens>    context length as configured, for the sidecar (default:
 *                         the listing's max_model_len for the model, if any)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAnthropicLlmPort,
  resolveAnthropicTimeoutMs,
  resolveSelfHostedIdleTimeoutMs,
} from "../src/llm/anthropic.js";
import { readMessageStream } from "../src/llm/anthropicStream.js";
import { askOnceMore } from "../src/llm/askOnceMore.js";
import type { CoachTarget } from "../src/llm/coachTarget.js";
import { ANTHROPIC_EFFORT_LEVELS, parseAnthropicEffort, type AnthropicEffort } from "../src/llm/effort.js";
import { LlmSchemaError } from "../src/llm/port.js";
import type { DossierAuditInput, DossierCorrectionInput, DossierV1Input } from "../src/llm/types.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import {
  PROBE_CUT_RATIO,
  testSelfHostedConnection,
} from "../src/settings/selfHostedConnectionTest.js";
import { normalizeSelfHostedBaseUrl, selfHostedEndpoint } from "../src/settings/selfHostedStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(here, "../../demo/snapshot.sql");

const STEPS = ["weekly", "midweek", "attached", "aboutyou", "correction", "audit", "probe"] as const;
type Step = (typeof STEPS)[number];

// ---- Flags --------------------------------------------------------------------

/** The value after a flag, or null when the flag is absent. */
function flagValue(flag: string, what: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return value;
}

function required(flag: string, what: string): string {
  const value = flagValue(flag, what)?.trim();
  if (!value) throw new Error(`${flag} is required: ${what}`);
  return value;
}

function flagEffort(): AnthropicEffort {
  const raw = flagValue("--effort", "a level");
  if (raw === null) return "high";
  const effort = parseAnthropicEffort(raw);
  if (!effort) throw new Error(`Invalid --effort "${raw}": expected one of ${ANTHROPIC_EFFORT_LEVELS.join(", ")}.`);
  return effort;
}

function flagSteps(): Step[] {
  const raw = flagValue("--only", "a comma-separated list of steps");
  if (raw === null) return [...STEPS];
  const steps = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of steps) {
    if (!(STEPS as readonly string[]).includes(s)) throw new Error(`Unknown step "${s}": expected ${STEPS.join(", ")}.`);
  }
  return steps as Step[];
}

/** The key, read from the named env var; an unset or empty var fails before any call. */
function flagKey(): string | null {
  const name = flagValue("--key-env", "an environment variable name");
  if (name === null) return null;
  const key = process.env[name]?.trim();
  if (!key) throw new Error(`--key-env ${name}: the environment variable ${name} is unset or empty.`);
  return key;
}

const rawBaseUrl = required("--base-url", "the model server's URL, such as http://macbook.local:8000");
const BASE_URL = normalizeSelfHostedBaseUrl(rawBaseUrl);
if (!BASE_URL) throw new Error(`Invalid --base-url "${rawBaseUrl}": expected an http(s) URL.`);
const MODEL = required("--model", "the model id the server lists");
const EFFORT = flagEffort();
const KEY = flagKey();
const ONLY = flagSteps();
const RECORD = flagValue("--record", "a file path");
const SERVER_NAME = flagValue("--server", "a server name") ?? "unknown";
const HARDWARE = flagValue("--hardware", "a hardware note");
const CONTEXT_FLAG = flagValue("--context", "a token count");
const WEEKLY_PACKET = flagValue("--weekly-packet", "a packet file");

// ---- Inputs from the demo snapshot ----------------------------------------------

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\" };

/** One field of a Postgres COPY text row (as in the replay script). */
function unescapeCopy(field: string): string | null {
  if (field === "\\N") return null;
  return field.replace(/\\(?:([ntrbfv\\])|([0-7]{1,3})|(.))/g, (_m, esc, oct, other) =>
    esc ? ESCAPES[esc]! : oct ? String.fromCharCode(parseInt(oct, 8)) : other,
  );
}

function copyTable(sql: string, table: string): Array<Record<string, string | null>> {
  const lines = sql.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`COPY public.${table} `));
  if (start < 0) throw new Error(`No ${table} table in the snapshot`);
  const header = lines[start]!;
  const columns = header.slice(header.indexOf("(") + 1, header.indexOf(")")).split(", ");
  const rows: Array<Record<string, string | null>> = [];
  for (let i = start + 1; lines[i] !== "\\."; i++) {
    const fields = lines[i]!.split("\t").map(unescapeCopy);
    rows.push(Object.fromEntries(columns.map((c, j) => [c, fields[j] ?? null])));
  }
  return rows;
}

/** The text after the line starting with `marker` in a logged call's user message. */
function afterLine(row: Record<string, string | null>, marker: string): string {
  const request = JSON.parse(row.request!) as { messages: Array<{ content: string }> };
  const content = request.messages[0]!.content;
  const at = content.indexOf(marker);
  if (at < 0) throw new Error(`Call at ${row.created_at} has no "${marker}" line`);
  return content.slice(content.indexOf("\n", at) + 1);
}

type Inputs = {
  weekly: { packet: ModelPacket; source: string };
  midweek: ModelPacket;
  attached: ModelPacket;
  aboutYou: DossierV1Input;
  correction: DossierCorrectionInput;
  audit: DossierAuditInput;
};

function loadInputs(): Inputs {
  const sql = readFileSync(SNAPSHOT, "utf8");
  const calls = copyTable(sql, "llm_call_log")
    .filter((r) => r.outcome !== "failed")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const packetOf = (r: Record<string, string | null>) => JSON.parse(afterLine(r, "Model packet")) as ModelPacket;

  const weeklyCalls = calls.filter((r) => r.operation === "weekly_reply");
  const lastWeekly = weeklyCalls.at(-1);
  if (!lastWeekly) throw new Error("No weekly call in the snapshot");
  let weekly: Inputs["weekly"] = { packet: packetOf(lastWeekly), source: `demo snapshot weekly call at ${lastWeekly.created_at}` };
  if (WEEKLY_PACKET) {
    const raw = JSON.parse(readFileSync(path.resolve(WEEKLY_PACKET), "utf8")) as Record<string, unknown>;
    const packet = (raw.packet && typeof raw.packet === "object" ? raw.packet : raw) as ModelPacket;
    weekly = { packet, source: path.basename(WEEKLY_PACKET) };
  }

  const midWeek = calls.filter((r) => r.operation === "mid_week_chat").map(packetOf);
  const midweek = midWeek.find((p) => !p.attachments?.length);
  const attached = midWeek.find((p) => (p.attachments?.length ?? 0) > 0);
  if (!midweek || !attached) throw new Error("The snapshot needs a mid-week call with and without an attachment");

  const v1Call = calls.find((r) => r.operation === "dossier_v1");
  if (!v1Call) throw new Error("No About you first-draft call in the snapshot");
  const aboutYou = JSON.parse(afterLine(v1Call, "Onboarding answers and running-log hints")) as DossierV1Input;

  const versions = copyTable(sql, "dossier_versions").sort((a, b) => Number(a.id) - Number(b.id));
  const latest = versions.at(-1);
  if (!latest?.body) throw new Error("No About you version in the snapshot");
  const currentDossier = { versionId: Number(latest.id), body: latest.body };
  return {
    weekly,
    midweek,
    attached,
    aboutYou,
    correction: {
      athleteMessage:
        "Please add that my right Achilles was noticeable for a few minutes on the medium-long run on Oct 14 and then settled. Until it has been quiet for two weeks I'd like the Thursday hill route swapped for the flat canal path.",
      currentDossier,
      week: { isoWeek: "2026-W42" },
    },
    audit: { currentDossier, week: { isoWeek: "2026-W42" }, nowIso: "2026-10-15T12:00:00.000Z", intervalWeeks: 5 },
  };
}

// ---- An instrumented fetch -------------------------------------------------------

/** One HTTP exchange as the script saw it: timings, headers and (for Messages) the raw bytes. */
type Exchange = {
  url: string;
  startedAt: number;
  headersAt: number | null;
  firstByteAt: number | null;
  /** First content_block_delta: the first token the model sent. */
  firstTokenAt: number | null;
  endedAt: number | null;
  status: number | null;
  headers: Record<string, string>;
  chunks: Uint8Array[];
  error: string | null;
};

const exchanges: Exchange[] = [];

const instrumentedFetch: typeof globalThis.fetch = async (input, init) => {
  const ex: Exchange = {
    url: String(input instanceof Request ? input.url : input),
    startedAt: Date.now(),
    headersAt: null,
    firstByteAt: null,
    firstTokenAt: null,
    endedAt: null,
    status: null,
    headers: {},
    chunks: [],
    error: null,
  };
  exchanges.push(ex);
  let response: Response;
  try {
    response = await globalThis.fetch(input, init);
  } catch (err) {
    ex.endedAt = Date.now();
    ex.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
  ex.headersAt = Date.now();
  ex.status = response.status;
  response.headers.forEach((v, k) => {
    ex.headers[k] = v;
  });
  if (!response.body) {
    ex.endedAt = Date.now();
    return response;
  }
  const decoder = new TextDecoder();
  let tail = "";
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const now = Date.now();
      ex.firstByteAt ??= now;
      ex.chunks.push(chunk);
      if (ex.firstTokenAt === null) {
        const text = tail + decoder.decode(chunk, { stream: true });
        if (text.includes("content_block_delta")) ex.firstTokenAt = now;
        tail = text.slice(-32);
      }
      controller.enqueue(chunk);
    },
    flush() {
      ex.endedAt = Date.now();
    },
  });
  return new Response(response.body.pipeThrough(tee), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

function bytesOf(ex: Exchange): Buffer {
  return Buffer.concat(ex.chunks.map((c) => Buffer.from(c)));
}

// ---- Running a step ----------------------------------------------------------------

/** Keeps the call log rows in memory: the smoke never writes to a database. */
function memoryRecorder(rows: LlmCallRecord[]): LlmCallRecorder {
  return {
    async record(row) {
      rows.push(row);
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
    async *exportAll() {},
  };
}

type Row = {
  step: Step;
  outcome: string;
  attempts: number;
  ttftMs: number | null;
  totalMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  /** Characters of thinking in the last attempt's reply; null when no thinking block came back. */
  thinkingChars: number | null;
  stopReason: string | null;
  timeout: "idle" | "overall" | null;
  notes: string[];
};

function timeoutKind(message: string): Row["timeout"] {
  if (/sent nothing for \d+ms/.test(message) || /idle for \d+ms/.test(message)) return "idle";
  if (/exceeded \d+ms overall/.test(message)) return "overall";
  return null;
}

function thinkingCharsOf(responseRaw: string | null): number | null {
  if (!responseRaw) return null;
  try {
    const message = JSON.parse(responseRaw) as { content?: Array<{ type?: string; thinking?: string }> };
    const blocks = (message.content ?? []).filter((b) => b?.type === "thinking");
    if (!blocks.length) return null;
    return blocks.reduce((n, b) => n + (b.thinking?.length ?? 0), 0);
  } catch {
    return null;
  }
}

/**
 * What a failed stream carried: a count per event type (and delta type), when
 * the last non-ping event arrived, and how long the stream ran after it.
 */
function streamSummary(ex: Exchange): string {
  const text = bytesOf(ex).toString("utf8");
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/^event: *(\S+)$|"delta": *\{"type": *"(\w+)"/gm)) {
    const key = m[1] ?? `delta:${m[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lastEvent = [...text.matchAll(/^event: *(\S+)$/gm)].map((m) => m[1]).filter((e) => e !== "ping").at(-1) ?? "none";
  const parts = [...counts].map(([k, n]) => `${k} ${n}`).join(", ");
  return `${text.length} bytes; ${parts || "no events"}; last non-ping event ${lastEvent}; tail ${JSON.stringify(text.replace(/(event: ping\ndata: \{"type":"ping"\}\n\n)+$/, "").slice(-200))}`;
}

/** Runs one coach step: one call, or for the weekly reply up to two (ADR 0002). */
async function runCoachStep(
  step: Step,
  log: LlmCallRecord[],
  ask: (callId: string) => Promise<unknown>,
  retries: boolean,
): Promise<{ row: Row; lastExchange: Exchange | null }> {
  const started = Date.now();
  const firstExchange = exchanges.length;
  const firstLog = log.length;
  const notes: string[] = [];
  let attempts = 0;
  let outcome = "ok";
  let errorMessage: string | null = null;
  const once = async (attempt: number) => {
    attempts = attempt;
    try {
      return { ok: true as const, value: await ask(randomUUID()) };
    } catch (err) {
      if (err instanceof LlmSchemaError) notes.push(`attempt ${attempt} refused: ${err.message}`);
      throw err;
    }
  };
  try {
    // Only the weekly reply is asked once more, as the app does (ADR 0002).
    const result = retries ? await askOnceMore(once) : await once(1);
    if (!result.ok) throw new LlmSchemaError(result.error);
    outcome = attempts > 1 ? "retried" : "ok";
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    outcome = err instanceof LlmSchemaError ? "schema failed" : "error";
    if (outcome === "error") notes.push(`error: ${errorMessage}`);
  }
  const rows = log.slice(firstLog);
  const last = rows.at(-1);
  if (last?.outcome === "repaired") notes.push(`repaired: ${last.errorMessage}`);
  if (outcome === "ok" && last?.outcome === "repaired") outcome = "ok (repaired)";
  const stepExchanges = exchanges.slice(firstExchange);
  const first = stepExchanges[0];
  const lastExchange = stepExchanges.at(-1) ?? null;
  for (const ex of stepExchanges) {
    if (ex.status !== null && ex.status >= 400) notes.push(`HTTP ${ex.status}: ${bytesOf(ex).toString("utf8").slice(0, 300)}`);
  }
  if (outcome === "error" && lastExchange) notes.push(`stream seen: ${streamSummary(lastExchange)}`);
  return {
    row: {
      step,
      outcome,
      attempts,
      ttftMs: first?.firstTokenAt ? first.firstTokenAt - first.startedAt : null,
      totalMs: Date.now() - started,
      inputTokens: last?.inputTokens ?? null,
      outputTokens: last?.outputTokens ?? null,
      thinkingTokens: last?.thinkingTokens ?? null,
      thinkingChars: thinkingCharsOf(last?.responseRaw ?? null),
      stopReason: last?.stopReason ?? null,
      timeout: errorMessage ? timeoutKind(errorMessage) : null,
      notes,
    },
    lastExchange,
  };
}

// ---- The probe -----------------------------------------------------------------------

type ProbeReport = {
  row: Row;
  sentTokens: number;
  reportedTokens: number | null;
  wordFound: boolean;
  verdict: string;
  /** Reported over sent; null when the server reported no usage. */
  ratio: number | null;
  /** True when the reply stopped at max_tokens (4096 was not enough). */
  hitMaxTokens: boolean | null;
};

async function runProbe(): Promise<ProbeReport> {
  const started = Date.now();
  const firstExchange = exchanges.length;
  const result = await testSelfHostedConnection({
    baseUrl: BASE_URL!,
    apiKey: KEY,
    model: MODEL,
    fetchImpl: instrumentedFetch,
    timeoutMs: resolveSelfHostedIdleTimeoutMs(),
  });
  const messages = exchanges.slice(firstExchange).find((ex) => ex.url.endsWith("/messages"));
  let stopReason: string | null = null;
  let outputTokens: number | null = null;
  let thinkingChars: number | null = null;
  const notes: string[] = [];
  if (messages) {
    const raw = bytesOf(messages).toString("utf8");
    if (messages.status !== null && messages.status >= 400) notes.push(`HTTP ${messages.status}: ${raw.slice(0, 300)}`);
    const read = await readMessageStream(new Response(raw), { signal: new AbortController().signal, onActivity: () => {} });
    if (read.message) {
      stopReason = read.message.stop_reason;
      const out = read.message.usage.output_tokens;
      outputTokens = typeof out === "number" ? out : null;
      thinkingChars = thinkingCharsOf(JSON.stringify(read.message));
      const text = read.message.content
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      notes.push(`reply text: ${JSON.stringify(text.slice(0, 120))}`);
    }
  }
  const { probe } = result;
  if (!result.listing.ok) notes.push(`listing failed: ${result.listing.reason}`);
  if (!probe.ok) notes.push(`probe failed: ${probe.reason}`);
  return {
    row: {
      step: "probe",
      outcome: probe.ok ? `ok (${probe.verdict})` : `error (${probe.reason})`,
      attempts: 1,
      ttftMs: messages?.firstTokenAt ? messages.firstTokenAt - messages.startedAt : null,
      totalMs: Date.now() - started,
      inputTokens: probe.reportedTokens,
      outputTokens,
      thinkingTokens: null,
      thinkingChars,
      stopReason,
      timeout: probe.reason === "timeout" ? "overall" : null,
      notes,
    },
    sentTokens: probe.sentTokens,
    reportedTokens: probe.reportedTokens,
    wordFound: probe.wordFound,
    verdict: probe.verdict ?? `failed (${probe.reason})`,
    ratio: probe.reportedTokens === null ? null : probe.reportedTokens / probe.sentTokens,
    hitMaxTokens: stopReason === null ? null : stopReason === "max_tokens",
  };
}

// ---- Server facts ----------------------------------------------------------------------

type ServerFacts = { version: string | null; versionSource: string | null; maxModelLen: number | null; listed: boolean };

const VERSION_HEADERS = ["x-server-version", "x-omlx-version", "x-version", "server"];

function versionFromHeaders(headers: Record<string, string>): string | null {
  for (const h of VERSION_HEADERS) {
    const v = headers[h];
    if (v && /\d/.test(v)) return `${h}: ${v}`;
  }
  return null;
}

async function serverFacts(): Promise<ServerFacts> {
  const headers: Record<string, string> = KEY ? { "x-api-key": KEY, authorization: `Bearer ${KEY}` } : {};
  const facts: ServerFacts = { version: null, versionSource: null, maxModelLen: null, listed: false };
  try {
    const res = await fetch(selfHostedEndpoint(BASE_URL!, "models"), { headers, signal: AbortSignal.timeout(10_000) });
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const body = (await res.json().catch(() => null)) as { version?: unknown; data?: Array<Record<string, unknown>> } | null;
    const entry = body?.data?.find((m) => m.id === MODEL);
    facts.listed = Boolean(entry);
    if (typeof entry?.max_model_len === "number") facts.maxModelLen = entry.max_model_len;
    if (typeof body?.version === "string") {
      facts.version = body.version;
      facts.versionSource = "/v1/models";
    } else {
      const fromHeader = versionFromHeaders(resHeaders);
      if (fromHeader) {
        facts.version = fromHeader;
        facts.versionSource = "/v1/models header";
      }
    }
  } catch {
    // Reported as unlisted; the coach steps will say why.
  }
  if (facts.version) return facts;
  // oMLX reports its version on /api/status; other servers 404 here, which is fine.
  try {
    const res = await fetch(new URL("/api/status", BASE_URL!).toString(), { headers, signal: AbortSignal.timeout(5_000) });
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
    if (typeof body?.version === "string") {
      facts.version = body.version;
      facts.versionSource = "/api/status";
    }
  } catch {
    // No version to report.
  }
  return facts;
}

// ---- Output --------------------------------------------------------------------------------

const secs = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const num = (n: number | null) => (n === null ? "–" : String(n));

function table(rows: Row[]): string {
  const lines = [
    "| step | outcome | first token | total | input tok | output tok | thinking tok | thinking block | stop | timeout |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.step} | ${r.outcome} | ${secs(r.ttftMs)} | ${secs(r.totalMs)} | ${num(r.inputTokens)} | ${num(r.outputTokens)} | ${num(r.thinkingTokens)} | ${r.thinkingChars === null ? "none" : `${r.thinkingChars} chars`} | ${r.stopReason ?? "–"} | ${r.timeout ?? "no"} |`,
    );
  }
  return lines.join("\n");
}

// ---- Main ----------------------------------------------------------------------------------

async function main(): Promise<void> {
  const inputs = loadInputs();
  const facts = await serverFacts();
  const log: LlmCallRecord[] = [];
  const target: CoachTarget = {
    provider: "self_hosted",
    messagesUrl: selfHostedEndpoint(BASE_URL!, "messages"),
    credentials: { apiKey: KEY },
    model: MODEL,
    effort: EFFORT,
  };
  const port = createAnthropicLlmPort({
    // Built from flags; the smoke never reads the saved setting (ADR 0004).
    resolveCoachTarget: async () => target,
    recorder: memoryRecorder(log),
    fetchImpl: instrumentedFetch,
  });
  const opts = (callId: string) => ({ callId, coachTarget: target });

  console.log(`# Smoke: ${MODEL} at ${EFFORT}`);
  console.log("");
  console.log(`- server: ${new URL(BASE_URL!).host}, ${SERVER_NAME}${facts.version ? ` ${facts.version} (from ${facts.versionSource})` : ", version not reported"}`);
  console.log(`- model listed: ${facts.listed ? "yes" : "no"}; max_model_len: ${facts.maxModelLen ?? "not reported"}`);
  console.log(`- limits: idle ${resolveSelfHostedIdleTimeoutMs() / 1000} s, overall ${resolveAnthropicTimeoutMs() / 1000} s`);
  console.log(`- started: ${new Date().toISOString()}`);
  console.log("");

  // Ctrl-C (or a kill) prints what has finished so far, so a slow model still leaves a table.
  const runStarted = Date.now();
  let current: Step | null = null;
  const interrupted = () => {
    console.log(`Stopped by signal during step "${current}" after ${secs(Date.now() - runStarted)}; unfinished steps are missing.`);
    console.log("");
    printReport();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  for (const step of ONLY) {
    current = step;
    console.error(`[smoke] ${step} …`);
    if (step === "probe") {
      probe = await runProbe();
      rows.push(probe.row);
    } else {
      const ask: Record<Exclude<Step, "probe">, (id: string) => Promise<unknown>> = {
        weekly: (id) => port.generateWeeklyReply(inputs.weekly.packet, opts(id)),
        midweek: (id) => port.generateMidWeekChatReply(inputs.midweek, opts(id)),
        attached: (id) => port.generateMidWeekChatReply(inputs.attached, opts(id)),
        aboutyou: (id) => port.generateDossierV1(inputs.aboutYou, opts(id)),
        correction: (id) => port.generateDossierCorrection(inputs.correction, opts(id)),
        audit: (id) => port.generateDossierAudit(inputs.audit, opts(id)),
      };
      const { row, lastExchange } = await runCoachStep(step, log, ask[step], step === "weekly");
      rows.push(row);
      if (step === "weekly" && RECORD && lastExchange) record(lastExchange, row, inputs, facts);
    }
    const r = rows.at(-1)!;
    console.error(`[smoke] ${step}: ${r.outcome} in ${secs(r.totalMs)}`);
  }
  printReport();
}

const rows: Row[] = [];
let probe: ProbeReport | null = null;

/** The table, the notes and the probe's numbers for every step finished so far. */
function printReport(): void {
  console.log(table(rows));
  console.log("");
  const notes = rows.filter((r) => r.notes.length);
  if (notes.length) {
    console.log("Notes:");
    for (const r of notes) for (const n of r.notes) console.log(`- ${r.step}: ${n.replace(/\s+/g, " ")}`);
    console.log("");
  }
  if (probe) {
    console.log(
      `Probe: sent ${probe.sentTokens} (estimated, chars/4), server reported ${num(probe.reportedTokens)}` +
        `${probe.ratio === null ? "" : ` (${(probe.ratio * 100).toFixed(1)}% of sent; cut below ${PROBE_CUT_RATIO * 100}%)`}` +
        `, word ${probe.wordFound ? "found" : "missing"}, verdict ${probe.verdict}` +
        `, 4096 max_tokens ${probe.hitMaxTokens === null ? "unknown" : probe.hitMaxTokens ? "NOT enough (stop_reason max_tokens)" : "enough"}.`,
    );
  }
}

/** Writes the weekly reply's raw stream, its sidecar and the packet sent. */
function record(ex: Exchange, row: Row, inputs: Inputs, facts: ServerFacts): void {
  const file = path.resolve(RECORD!);
  const stem = file.replace(/\.sse$/, "");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytesOf(ex));
  const contextFlag = CONTEXT_FLAG === null ? null : Number(CONTEXT_FLAG);
  writeFileSync(
    `${stem}.json`,
    JSON.stringify(
      {
        server: SERVER_NAME,
        serverVersion: facts.version,
        model: MODEL,
        effort: EFFORT,
        contextTokens: contextFlag ?? facts.maxModelLen,
        contextSource: contextFlag !== null ? "--context" : facts.maxModelLen !== null ? "listing max_model_len" : null,
        recordedAt: new Date().toISOString(),
        hardware: HARDWARE,
        input: inputs.weekly.source,
        httpStatus: ex.status,
        contentType: ex.headers["content-type"] ?? null,
        outcome: row.outcome,
        attempts: row.attempts,
        stopReason: row.stopReason,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        thinkingTokens: row.thinkingTokens,
        timeToFirstTokenMs: row.ttftMs,
        attemptMs: ex.endedAt === null ? null : ex.endedAt - ex.startedAt,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(`${stem}.packet.json`, JSON.stringify(inputs.weekly.packet, null, 2) + "\n");
  console.error(`[smoke] recorded ${path.basename(file)} (${bytesOf(ex).length} bytes) with its sidecar and packet`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
