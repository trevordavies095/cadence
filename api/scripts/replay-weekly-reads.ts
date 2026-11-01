/**
 * Replay gate for the reading-flow work (ticket 09).
 *
 * Re-sends every coach call in the demo snapshot's call log to the live model
 * with today's prompt and tool schema, through the app's own Anthropic port, and
 * writes the old and new replies side by side with a first-pass coverage report.
 * A person still reads the report: the checks only point at what to look at.
 *
 *   cd api
 *   ANTHROPIC_API_KEY=sk-ant-... npm run replay
 *
 * Calls run one at a time, on the model each original call used. A call whose
 * output file already exists is skipped, so an interrupted run can be resumed.
 * Pass --report-only to rebuild the report from the saved replies, or
 * --dry-run to exercise the whole run with the offline stub, at no cost, into a
 * separate folder.
 *
 * Pass --model <id> for calls with no model of their own, and --effort <level>
 * for every call. Without them, the tested default (Opus 4.7 at xhigh) applies.
 *
 * Pass --packets <dir> to replay a folder of packets instead of the demo
 * snapshot, such as the synthetic seasons that are not marathon blocks:
 *
 *   npm run replay -- --packets tests/fixtures/replay-packets --dry-run
 *
 * The folder holds one JSON file per weekly call, replayed in file-name order.
 * Each file is a model packet as the app builds it, with the athlete's goal in
 * its `goal` field, or `{ "packet": {...}, "model": "..." }` to pin the model
 * (otherwise --model, else the tested default). A packet has no old reply,
 * so its report shows the new reply only. Replies and the report go under
 * .scratch/replay-packets/<folder name> (with -dry-run on a dry run).
 * Pass --out <dir> to write somewhere else, with either source.
 *
 * Every input carries its operation, one of the five coach calls: weekly_reply,
 * mid_week_chat (with or without a run attached), and the three About you
 * drafts, dossier_v1 (the first draft), dossier_correction (Fix something) and
 * dossier_audit (the tidy-up). A plain packet is a weekly read. A wrapped file
 * names its operation, `{ "operation": "mid_week_chat", "packet": {...} }`; the
 * About you drafts carry their port input instead of a packet, with the
 * athlete's goal beside it for the goal checks, `{ "operation":
 * "dossier_audit", "goal": {...}, "input": {...} }`. Each input is sent to its
 * own port method, which runs that operation's validator. Only the weekly read
 * is asked for once more when refused for its shape, as in the app.
 *
 * The demo snapshot run replays the call log's weekly reads first, then its
 * mid-week replies and About you first draft, then the three inputs the log
 * lacks (a question with a run attached, a correction and a tidy-up), written
 * from the demo database into tests/fixtures/demo-operations/ by
 * scripts/generate-demo-operation-fixtures.ts.
 *
 * The output folder is a root holding one folder per configuration, named
 * <provider>--<model>--<effort> (the model id with anything but letters, digits,
 * dots, underscores and hyphens turned into "_"). Each holds a config.json
 * (provider, base URL host, model, effort, repeats, note, started at, harness
 * git commit) and one reply per input and repeat, <input id>.<repeat>.json,
 * such as 01.1.json, or 01.1.failed.json when refused. Running several
 * configurations into the same --out builds a matrix.
 *
 * Matrix flags (all optional; a run without them is an Anthropic run as above):
 *
 *   --provider anthropic|self_hosted  who serves the calls (default anthropic)
 *   --base-url <url>    the model server, self_hosted only, such as
 *                       http://macbook.local:8000 (a trailing /v1 is not doubled)
 *   --key-env <VAR>     the env var holding the key, so it never appears on a
 *                       command line. Anthropic defaults to ANTHROPIC_API_KEY;
 *                       self_hosted sends no key without it. A named var that is
 *                       unset or empty fails the run before any call.
 *   --repeats <N>       replies per input (default 1)
 *   --note "<text>"     free text for config.json, such as the hardware and server
 *
 * Self-hosted needs --base-url and --model, and every call uses that model
 * (models pinned in packets are Anthropic ids). An Anthropic call pinned to a
 * model keeps it, as before. The target is built from the flags only; the
 * saved setting is never read (ADR 0004).
 *
 *   SH_KEY=... npm run replay -- --packets tests/fixtures/replay-packets \
 *     --provider self_hosted --base-url http://macbook.local:8000 --key-env SH_KEY \
 *     --model gemma-4 --effort high --repeats 2 --note "M4 Pro 24 GB, oMLX, 64k" \
 *     --out ../.scratch/local-models
 *
 * --report-only with --out <root> reads every configuration folder under the
 * root; every run (report-only or not) writes one report.md at the root with a
 * summary table across configurations (schema outcomes: first try, after
 * retry, failed, then every measure) and a section per configuration.
 *
 * Measures (scripts/replayMeasures.ts): every run, report-only included, writes
 * a measures.json into each configuration folder, recomputed from its reply
 * files: schema outcomes, soft repairs and length caps hit by field, goal-check
 * failures, banned words, plan sanity for weekly reads (flagged within a
 * documented band, not failed), latency (time to first token and total, median
 * and worst, and the wall clock over every call), median tokens (thinking
 * characters beside thinking tokens, which oMLX never reports), the prompt-cut
 * flag by the probe's rule, and for Anthropic rows a cost from a dated price
 * table. What only a live call can measure (time to first token, through the
 * same instrumented fetch as the smoke script) is saved in each reply file's
 * `timing`. On a dry run, a wrapped input's `stubPatch` lays fields over the
 * stub's reply before the validator runs, and its `stubUsage` sets the usage
 * the call reports, so the measures can be tested offline.
 *
 * A reply refused for its shape is asked for once more, as the app does (ADR
 * 0002). The saved reply lists the refused attempt in `refusedAttempts`, and the
 * report lists retried calls apart from failed ones. On a dry run, a wrapped
 * packet's `stubRefusals` (a count) makes the stub refuse that many attempts
 * first, so the retry can be tested offline; a live run ignores it.
 *
 * Every report opens with three goal checks, each naming the reply that failed:
 * a packet with no goal line (no goal, or the rebuilt prompt does not open with
 * "Athlete goal:"; About you prompts carry no goal line, so this one is skipped
 * for them); "marathon" in a reply whose goal is not a marathon; and a long-run
 * verdict in a reply whose goal is stay fit. A refused reply also fails, since
 * it leaves a reply unchecked. The checks, and the internal-words count in each
 * call's table, read every athlete-facing word of the operation: for a weekly
 * read the headline, flags, answers, the read, the days, safety callouts and
 * About you suggestions; for a mid-week reply its text, About you suggestions,
 * plan changes and safety callouts; for an About you draft its summary bullets
 * and body. The script exits non-zero when any check fails, in any
 * configuration. The dry run over tests/fixtures/replay-packets runs in the API
 * test suite (tests/replay-weekly-reads.test.ts).
 *
 * Blind review packs (scripts/replayReview.ts): --review-pack sets a candidate
 * configuration's replies (repeat 1) beside the baseline's, input by input,
 * over one or more output roots, and makes no calls:
 *
 *   npm run replay -- --review-pack \
 *     --roots ../.scratch/benchmark/snapshot,../.scratch/benchmark/seasons \
 *     --baseline anthropic--claude-opus-4-7--xhigh \
 *     --candidate self_hosted--gpt-oss-20b-MXFP4-Q8--high \
 *     --candidate self_hosted--gpt-oss-120b--high --seed 1
 *
 * --roots takes a comma-separated list (--out alone names one root);
 * --candidate repeats or takes a list; --seed defaults to 1. Each candidate
 * gets a pack in <review>/<candidate>/, where <review> is --review <dir>, else
 * a "review" folder beside the first root: README.md (how to score and the
 * pairs), one <root folder name>-<input id>.md per pair (what the coach was
 * given in plain words, then Reply A and Reply B as the athlete reads them,
 * in an order drawn per pair from the seed, with nothing that names the
 * model), key.json (which configuration is A, kept apart) and
 * scores.template.json (the rubric, and an empty entry per pair). A side with
 * no reply, or a refused one, is shown as such. The sample rule is
 * pickSample's; --sample <root>/<id>,... (such as seasons/09,snapshot/10)
 * names the inputs instead. The reviewer copies the template to scores.json
 * and fills it; --report-only (with --review <dir>, else the "review" folder
 * beside --out) adds the review results to report.md: per pack, the mean of
 * each rubric item for baseline and candidate, the preference rate, and the
 * two pairs with the largest margin each way, quoted. Missing, partial or
 * malformed scores are reported, never fatal.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainingGoal } from "../src/goal/types.js";
import { createAnthropicLlmPort } from "../src/llm/anthropic.js";
import { askOnceMore, type AskResult } from "../src/llm/askOnceMore.js";
import { TESTED_COACH_MODEL } from "../src/llm/coachModel.js";
import { anthropicCoachTarget, type CoachProvider, type CoachTarget } from "../src/llm/coachTarget.js";
import { ANTHROPIC_EFFORT_LEVELS, parseAnthropicEffort, type AnthropicEffort } from "../src/llm/effort.js";
import { LlmSchemaError, type LlmCallOptions, type LlmPort } from "../src/llm/port.js";
import {
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  validateMidWeekChatReply,
  validateWeeklyReply,
  type SchemaResult,
} from "../src/llm/schema.js";
import {
  buildStubDossierAudit,
  buildStubDossierCorrection,
  buildStubDossierV1,
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  createStubLlmPort,
  recentWeeklyDistanceM,
  resolvePlanWeekStartMonday,
  resolveWeeklyPlanWeek,
} from "../src/llm/stub.js";
import type {
  DossierV1Draft,
  MidWeekChatReply,
  PrescribedDay,
  SafetyCallout,
  WeeklyReply,
} from "../src/llm/types.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import { normalizeSelfHostedBaseUrl, selfHostedEndpoint, selfHostedHost } from "../src/settings/selfHostedStore.js";
import { createInstrumentedFetch, thinkingCharsOf, timeToFirstTokenMs } from "./instrumentedFetch.js";
import { replayCheckFailures, type ReplayCheckFailure } from "./replayChecks.js";
import { reviewResults, writeReviewPacks, type ReviewInput } from "./replayReview.js";
import {
  configurationInputs,
  folderCalls,
  OPERATION_LABELS,
  OPERATIONS,
  promptHead,
  storedDemoCalls,
  type Operation,
  type StoredCall,
} from "./replayInputs.js";
import {
  configurationMeasures,
  estimatePromptTokens,
  measuresNote,
  measuresTable,
  planSanity,
  SUMMARY_MEASURE_HEADERS,
  summaryMeasureCells,
  type Measures,
  type PlanExpectation,
  type ReplyRecord,
  type Usage,
} from "./replayMeasures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const reportOnly = process.argv.includes("--report-only");
const dryRun = process.argv.includes("--dry-run");

/** The value after a flag such as --model, or null when the flag is absent. */
function flagValue(flag: string, what: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return value;
}

/** The value after a flag such as --packets, resolved from the working directory. */
function flagPath(flag: string): string | null {
  const value = flagValue(flag, "a folder");
  return value === null ? null : path.resolve(value);
}

/** --effort, checked against the five levels; the tested default when absent. */
function flagEffort(): AnthropicEffort {
  const raw = flagValue("--effort", "a level");
  if (raw === null) return TESTED_COACH_MODEL.effort;
  const effort = parseAnthropicEffort(raw);
  if (!effort) {
    throw new Error(`Invalid --effort "${raw}": expected one of ${ANTHROPIC_EFFORT_LEVELS.join(", ")}.`);
  }
  return effort;
}

/** --provider, anthropic when absent. */
function flagProvider(): CoachProvider {
  const raw = flagValue("--provider", "a provider") ?? "anthropic";
  if (raw !== "anthropic" && raw !== "self_hosted") {
    throw new Error(`Invalid --provider "${raw}": expected anthropic or self_hosted.`);
  }
  return raw;
}

/** --repeats, a whole number from 1; 1 when absent. */
function flagRepeats(): number {
  const raw = flagValue("--repeats", "a number");
  if (raw === null) return 1;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --repeats "${raw}": expected a whole number from 1.`);
  }
  return n;
}

const PROVIDER = flagProvider();
const MODEL_FLAG = flagValue("--model", "a model id")?.trim() || null;
const MODEL = MODEL_FLAG ?? TESTED_COACH_MODEL.model;
const EFFORT = flagEffort();
const REPEATS = flagRepeats();
const NOTE = flagValue("--note", "some text");
const KEY_ENV = flagValue("--key-env", "an environment variable name");

/** The self-hosted server's base URL, checked; null for Anthropic. */
function flagBaseUrl(): string | null {
  const raw = flagValue("--base-url", "a URL");
  if (PROVIDER === "anthropic") {
    if (raw !== null) throw new Error("--base-url is for --provider self_hosted.");
    return null;
  }
  if (raw === null) throw new Error("--provider self_hosted needs --base-url, such as http://macbook.local:8000.");
  const baseUrl = normalizeSelfHostedBaseUrl(raw);
  if (!baseUrl) throw new Error(`Invalid --base-url "${raw}": expected an http(s) URL.`);
  if (!MODEL_FLAG) throw new Error("--provider self_hosted needs --model, the id the server lists.");
  return baseUrl;
}

const BASE_URL = flagBaseUrl();

const reviewPack = process.argv.includes("--review-pack");

/** Every value of a flag that may repeat or take a comma-separated list, such as --candidate. */
function flagValues(flag: string, what: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg !== flag) return;
    const value = process.argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
    values.push(...value.split(",").map((v) => v.trim()).filter(Boolean));
  });
  return values;
}

/** --seed, a whole number; 1 when absent. */
function flagSeed(): number {
  const raw = flagValue("--seed", "a number");
  if (raw === null) return 1;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid --seed "${raw}": expected a whole number.`);
  return Number(raw);
}

/** The model id as a folder-name part: anything but letters, digits, ".", "_" and "-" becomes "_". */
function folderSafe(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, "_");
}

const CONFIGURATION = `${PROVIDER}--${folderSafe(MODEL)}--${EFFORT}`;

const PACKETS = flagPath("--packets");
const ROOT =
  flagPath("--out") ??
  (PACKETS
    ? path.resolve(here, `../../.scratch/replay-packets/${path.basename(PACKETS)}${dryRun ? "-dry-run" : ""}`)
    : path.resolve(here, `../../.scratch/reading-flow/${dryRun ? "replay-dry-run" : "replay"}`));

// ---- Replaying --------------------------------------------------------------

/** Keeps the call's log row in memory, for its repairs and token counts. */
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

/** One attempt refused for its shape. */
type Refusal = {
  attempt: number;
  error: string;
  outcome: string | null;
  stopReason: string | null;
  outputTokens: number | null;
  /** Missing on refusals saved before the measures (ticket 15). */
  inputTokens?: number | null;
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  responseRaw: unknown;
};

/** One attempt's timing: time to first token (null on a dry run or when none came) and its wall-clock. */
type AttemptTiming = { attempt: number; ttftMs: number | null; totalMs: number };

/** A call's timing as its reply file saves it: only measurable while the call runs. */
type Timing = {
  /** The first attempt's time to first token. */
  ttftMs: number | null;
  /** The whole call, a retry included. */
  totalMs: number;
  attempts: AttemptTiming[];
};

/** The usage and size measures a reply file saves from the call log's last row. */
function usageFields(row: LlmCallRecord | undefined) {
  return {
    inputTokens: row?.inputTokens ?? null,
    outputTokens: row?.outputTokens ?? null,
    thinkingTokens: row?.thinkingTokens ?? null,
    cacheReadTokens: row?.cacheReadTokens ?? null,
    cacheCreationTokens: row?.cacheCreationTokens ?? null,
    // oMLX never reports thinking tokens; the thinking block's length stands in.
    thinkingChars: thinkingCharsOf(row?.responseRaw ?? null),
    // The harness's own count of the prompt sent, for the prompt-cut flag.
    estimatedInputTokens: estimatePromptTokens(row?.request ?? null),
  };
}

/**
 * The key the run sends, read before any call. A --key-env var that is unset
 * or empty fails here, dry run included. Without --key-env, Anthropic reads
 * ANTHROPIC_API_KEY (required on a live run) and self-hosted sends no key.
 */
function runKey(): string | null {
  if (KEY_ENV !== null) {
    const key = process.env[KEY_ENV]?.trim();
    if (!key) throw new Error(`--key-env ${KEY_ENV}: the environment variable ${KEY_ENV} is unset or empty.`);
    return key;
  }
  if (PROVIDER === "self_hosted") return null;
  const key = process.env.ANTHROPIC_API_KEY?.trim() || null;
  if (!key && !dryRun) {
    throw new Error("Set ANTHROPIC_API_KEY (or name another variable with --key-env) to run the replay, or pass --dry-run or --report-only.");
  }
  return key;
}

/** The target one call is sent to, from flags only; the saved setting is never read (ADR 0004). */
function coachTargetFor(call: StoredCall, apiKey: string | null): CoachTarget {
  if (PROVIDER === "self_hosted") {
    return {
      provider: "self_hosted",
      messagesUrl: selfHostedEndpoint(BASE_URL!, "messages"),
      credentials: { apiKey },
      model: MODEL,
      effort: EFFORT,
    };
  }
  return anthropicCoachTarget({ model: call.model ?? MODEL, effort: EFFORT }, apiKey);
}

/** What config.json records about a configuration. */
type ConfigFile = {
  configuration: string;
  provider: CoachProvider;
  /** The model server's host; null for Anthropic. */
  baseUrlHost: string | null;
  model: string;
  effort: AnthropicEffort;
  repeats: number;
  note: string | null;
  startedAt: string;
  /** The harness's git commit, or null outside a checkout. */
  harnessCommit: string | null;
  dryRun: boolean;
  /** The packet folder, or "demo snapshot". */
  inputs: string;
  /** When a later run added to this folder, oldest first. */
  resumedAt?: string[];
};

function harnessCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Writes the configuration's config.json, or updates it on a resumed run
 * (keeping when it started). A folder holding a different configuration under
 * the same name, such as another server's host, is refused.
 */
function writeConfig(dir: string): void {
  const file = path.join(dir, "config.json");
  const now = new Date().toISOString();
  const fresh: ConfigFile = {
    configuration: CONFIGURATION,
    provider: PROVIDER,
    baseUrlHost: BASE_URL ? selfHostedHost(BASE_URL) : null,
    model: MODEL,
    effort: EFFORT,
    repeats: REPEATS,
    note: NOTE,
    startedAt: now,
    harnessCommit: harnessCommit(),
    dryRun,
    inputs: PACKETS ?? "demo snapshot",
  };
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(fresh, null, 2));
    return;
  }
  const saved = JSON.parse(readFileSync(file, "utf8")) as ConfigFile;
  for (const key of ["provider", "baseUrlHost", "model", "effort", "inputs"] as const) {
    if (saved[key] !== fresh[key]) {
      throw new Error(
        `${file} holds ${key} ${JSON.stringify(saved[key])}, not ${JSON.stringify(fresh[key])}; pass another --out to keep both.`,
      );
    }
  }
  const updated: ConfigFile = {
    ...fresh,
    repeats: Math.max(saved.repeats, REPEATS),
    note: NOTE ?? saved.note,
    startedAt: saved.startedAt,
    resumedAt: [...(saved.resumedAt ?? []), now],
  };
  writeFileSync(file, JSON.stringify(updated, null, 2));
}

/** One reply's file stem: the input id and the repeat, such as 01.2. */
function replyStem(inputIndex: number, repeat: number): string {
  return `${String(inputIndex + 1).padStart(2, "0")}.${repeat}`;
}

async function replay(calls: StoredCall[]): Promise<void> {
  const apiKey = runKey();
  const dir = path.join(ROOT, CONFIGURATION);
  mkdirSync(dir, { recursive: true });
  writeConfig(dir);
  for (const [i, call] of calls.entries()) {
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      await replayOne(call, path.join(dir, `${replyStem(i, repeat)}.json`), apiKey);
    }
  }
}

/** What a port method returns; the About you drafts share one shape. */
type CoachReply = WeeklyReply | MidWeekChatReply | DossierV1Draft;

/** The refusal a dry run's stub gives, per operation: the field its validator requires first. */
const STUB_REFUSALS: Record<Operation, string> = {
  weekly_reply: "analysis is required and must be non-empty",
  mid_week_chat: "body is required and must be non-empty",
  dossier_v1: "proposedBody is required and must be non-empty",
  dossier_correction: "proposedBody is required and must be non-empty",
  dossier_audit: "proposedBody is required and must be non-empty",
};

/** Sends one input to its operation's port method, which validates the reply with that operation's validator. */
function sendToPort(port: LlmPort, call: StoredCall, options: LlmCallOptions): Promise<CoachReply> {
  switch (call.operation) {
    case "weekly_reply":
      return port.generateWeeklyReply(call.packet, options);
    case "mid_week_chat":
      return port.generateMidWeekChatReply(call.packet, options);
    case "dossier_v1":
      return port.generateDossierV1(call.input, options);
    case "dossier_correction":
      return port.generateDossierCorrection(call.input, options);
    case "dossier_audit":
      return port.generateDossierAudit(call.input, options);
  }
}

/** What the athlete sent with the call, as the report shows it; null for a weekly read. */
function askedFor(call: StoredCall): string | null {
  switch (call.operation) {
    case "weekly_reply":
      return null;
    case "mid_week_chat": {
      const last = [...(call.packet.thread ?? [])].reverse().find((m) => m.role === "athlete");
      const attached = call.packet.attachments?.length ?? 0;
      const runs = attached ? ` (${attached} run${attached === 1 ? "" : "s"} attached in the thread)` : "";
      return `${last?.body ?? "(no athlete message in the thread)"}${runs}`;
    }
    case "dossier_v1":
      return `Onboarding answers: ${call.input.answers.goal}`;
    case "dossier_correction":
      return call.input.athleteMessage;
    case "dossier_audit":
      return `A tidy-up of About you (${call.input.currentDossier.body.length} characters)`;
  }
}

/**
 * The dry run's port: the offline stub, logging into `log`. An input with a
 * `stubPatch` gets the stub's reply with the patch laid over it, through the
 * operation's own validator, so a reply over a cap is cut and noted as in the app.
 */
function dryRunPort(call: StoredCall, log: LlmCallRecord[]): LlmPort {
  const recorder = memoryRecorder(log);
  const stub = createStubLlmPort({ recorder });
  const patch = call.stubPatch;
  if (!patch) return stub;
  async function patched<T>(
    operation: Operation,
    request: unknown,
    draft: object,
    validate: (raw: unknown) => SchemaResult<T>,
    options?: LlmCallOptions,
  ): Promise<T> {
    const validated = validate({ ...draft, ...patch });
    if (!validated.ok) throw new LlmSchemaError(validated.error);
    await recorder.record({
      id: options?.callId ?? randomUUID(),
      operation,
      provider: "stub",
      serverHost: null,
      model: null,
      appVersion: "replay-dry-run",
      weekSessionId: null,
      parentCallId: null,
      request,
      responseRaw: JSON.stringify(validated.value),
      httpStatus: null,
      latencyMs: null,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      outcome: validated.repairs ? "repaired" : "ok",
      errorMessage: validated.repairs?.join("; ") ?? null,
    });
    return validated.value;
  }
  return {
    generateWeeklyReply: (packet, o) =>
      patched("weekly_reply", packet, buildStubWeeklyReply(packet), (d) => validateWeeklyReply(d, resolveWeeklyPlanWeek(packet).weekStartMonday), o),
    generateMidWeekChatReply: (packet, o) =>
      patched("mid_week_chat", packet, buildStubMidWeekChatReply(packet), (d) => validateMidWeekChatReply(d, resolvePlanWeekStartMonday(packet)), o),
    generateDossierV1: (input, o) => patched("dossier_v1", input, buildStubDossierV1(input), validateDossierV1Draft, o),
    generateDossierCorrection: (input, o) =>
      patched("dossier_correction", input, buildStubDossierCorrection(input), validateDossierCorrectionDraft, o),
    generateDossierAudit: (input, o) => patched("dossier_audit", input, buildStubDossierAudit(input), validateDossierAuditDraft, o),
  };
}

/** What a weekly reply's plan is checked against, from its packet; null for other operations. */
function planExpectation(call: StoredCall): PlanExpectation | null {
  if (call.operation !== "weekly_reply") return null;
  const { weekStartMonday, isoWeek } = resolveWeeklyPlanWeek(call.packet);
  return { weekStartMonday, isoWeek, recentWeeklyM: recentWeeklyDistanceM(call.packet) };
}

/** Replays one input once into its reply file, skipped when the file exists. */
async function replayOne(call: StoredCall, file: string, apiKey: string | null): Promise<void> {
  const failedFile = file.replace(/\.json$/, ".failed.json");
  if (existsSync(file)) {
    console.log(`${path.basename(file)} exists, skipped`);
    return;
  }
  const log: LlmCallRecord[] = [];
  const target = coachTargetFor(call, apiKey);
  // Times each request from outside the adapter: time to first token is only measurable here.
  const timed = createInstrumentedFetch({ keepBodies: false });
  const port = dryRun
    ? dryRunPort(call, log)
    : createAnthropicLlmPort({
        // Built from flags; the replay never reads the saved setting (ADR 0004).
        resolveCoachTarget: async () => target,
        recorder: memoryRecorder(log),
        fetchImpl: timed.fetch,
      });
  const started = Date.now();
  const attemptTimings: AttemptTiming[] = [];
  const timing = (): Timing => ({
    ttftMs: attemptTimings[0]?.ttftMs ?? null,
    totalMs: Date.now() - started,
    attempts: attemptTimings,
  });
  // Each attempt refused for its shape, with what the model sent for it.
  const refusals: Refusal[] = [];
  let stubRefusalsLeft = dryRun ? (call.stubRefusals ?? 0) : 0;
  let reply: CoachReply;
  try {
    const ask = async (attempt: number): Promise<AskResult<CoachReply>> => {
      const logged = log.length;
      const exchanged = timed.exchanges.length;
      const attemptStarted = Date.now();
      const newRow = () => {
        const row = log.length > logged ? log.at(-1) : undefined;
        // A dry run reports the input's stubUsage, so the token and cost measures can be tested offline.
        if (row && dryRun && call.stubUsage) Object.assign(row, call.stubUsage);
        return row;
      };
      try {
        if (stubRefusalsLeft > 0) {
          stubRefusalsLeft--;
          throw new LlmSchemaError(`stub refusal: ${STUB_REFUSALS[call.operation]}`);
        }
        // The port writes its log row, with any repairs and token counts, only for a call with an id.
        const value = await sendToPort(port, call, { callId: randomUUID() });
        newRow();
        return { ok: true as const, value };
      } catch (err) {
        const row = newRow();
        if (err instanceof LlmSchemaError) {
          refusals.push({
            attempt,
            error: err.message,
            outcome: row?.outcome ?? null,
            stopReason: row?.stopReason ?? null,
            outputTokens: row?.outputTokens ?? null,
            inputTokens: row?.inputTokens ?? null,
            thinkingTokens: row?.thinkingTokens ?? null,
            cacheReadTokens: row?.cacheReadTokens ?? null,
            cacheCreationTokens: row?.cacheCreationTokens ?? null,
            responseRaw: row?.responseRaw ?? null,
          });
        }
        throw err;
      } finally {
        const messages = timed.exchanges.slice(exchanged).filter((ex) => ex.url.endsWith("/messages"));
        attemptTimings.push({ attempt, ttftMs: timeToFirstTokenMs(messages.at(-1)), totalMs: Date.now() - attemptStarted });
      }
    };
    // The weekly read is asked for once more when refused for its shape, as the
    // app does (ADR 0002); the app sends every other operation once.
    const result = call.operation === "weekly_reply" ? await askOnceMore(ask) : await ask(1);
    if (!result.ok) throw new LlmSchemaError(result.error);
    reply = result.value;
  } catch (err) {
    // A refused reply is a finding, not a reason to stop: keep what the model sent and move on.
    const failed = log.at(-1);
    writeFileSync(
      failedFile,
      JSON.stringify(
        {
          operation: call.operation,
          source: call.source,
          originalCallAt: call.createdAt,
          model: target.model,
          replayedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          outcome: failed?.outcome ?? null,
          stopReason: failed?.stopReason ?? null,
          ...usageFields(failed),
          timing: timing(),
          responseRaw: failed?.responseRaw ?? null,
          // Every attempt refused for its shape, the last one included.
          refusedAttempts: refusals,
        },
        null,
        2,
      ),
    );
    console.log(`${path.basename(file)} refused: ${err instanceof Error ? err.message : err}; saved ${path.basename(failedFile)}`);
    return;
  }
  const row = log.at(-1);
  writeFileSync(
    file,
    JSON.stringify(
      {
        operation: call.operation,
        source: call.source,
        originalCallAt: call.createdAt,
        model: target.model,
        replayedAt: new Date().toISOString(),
        // What the goal checks read: the goal and the rebuilt prompt's first line (null for About you).
        goal: call.goal,
        promptHead: promptHead(call),
        // What the athlete sent with the call, for the report.
        asked: askedFor(call),
        outcome: row?.outcome ?? null,
        repairs: row?.errorMessage ?? null,
        stopReason: row?.stopReason ?? null,
        ...usageFields(row),
        timing: timing(),
        // What a weekly plan is checked against (week, recent distance); null for other operations.
        planCheck: planExpectation(call),
        // Attempts refused for their shape before this reply came back; empty when none.
        refusedAttempts: refusals,
        old: call.old,
        new: reply,
      },
      null,
      2,
    ),
  );
  const retriedNote = refusals.length ? ` after asking once more (${refusals[0]!.error})` : "";
  console.log(`${path.basename(file)} done in ${Math.round((Date.now() - started) / 1000)} s${retriedNote}`);
}

// ---- Inputs for the review pack -------------------------------------------------

/** A configuration folder's inputs rebuilt from its config.json, in input-id order; null when they cannot be. */
function loadReviewInputs(configDir: string): ReviewInput[] | null {
  const calls = configurationInputs(configDir);
  if (!calls) return null;
  return calls.map((call, i) => {
    const sent = "packet" in call ? { packet: call.packet, aboutYou: null } : { packet: null, aboutYou: call.input };
    return {
      id: String(i + 1).padStart(2, "0"),
      operation: call.operation,
      source: call.source,
      goal: call.goal,
      ...sent,
      asked: askedFor(call),
    };
  });
}

/** Writes the blind review packs (--review-pack); no calls, no report. */
function reviewPacks(): void {
  const roots = flagValues("--roots", "a comma-separated list of output roots").map((r) => path.resolve(r));
  if (roots.length === 0) roots.push(...flagValues("--out", "a folder").map((r) => path.resolve(r)));
  if (roots.length === 0) throw new Error("--review-pack needs --roots <dir>,<dir> (or --out <dir>), the output roots holding the configuration folders.");
  for (const r of roots) if (!existsSync(r)) throw new Error(`--roots: ${r} does not exist.`);
  const baseline = flagValue("--baseline", "a configuration folder name");
  if (!baseline) throw new Error("--review-pack needs --baseline <configuration folder name>, such as anthropic--claude-opus-4-7--xhigh.");
  const candidates = flagValues("--candidate", "a configuration folder name");
  if (candidates.length === 0) throw new Error("--review-pack needs at least one --candidate <configuration folder name>.");
  const sample = flagValues("--sample", "a comma-separated list of <root>/<input id>");
  const lines = writeReviewPacks({
    roots,
    baseline,
    candidates,
    seed: flagSeed(),
    sample: sample.length ? sample : null,
    reviewDir: flagPath("--review") ?? path.resolve(roots[0]!, "..", "review"),
    loadInputs: loadReviewInputs,
  });
  for (const line of lines) console.log(line);
}

// ---- The first-pass coverage report -------------------------------------------

type Saved = {
  /** Missing on replies saved before every operation was replayed: a weekly read. */
  operation?: Operation;
  /** Missing on replies saved before packet folders existed. */
  source?: string;
  originalCallAt: string | null;
  model: string | null;
  goal?: TrainingGoal | null;
  /** Null for the About you drafts, whose prompts carry no goal line. */
  promptHead?: string | null;
  /** What the athlete sent with the call; null or missing for a weekly read. */
  asked?: string | null;
  outcome: string | null;
  repairs: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Missing on replies saved before the replay asked once more. */
  refusedAttempts?: Refusal[];
  /** The original reply, from the snapshot's call log; null for an input from a folder. */
  old: Record<string, unknown> | null;
  new: CoachReply;
} & SavedMeasures;

/** The measure inputs a reply file saves; missing on files saved before the measures (ticket 15). */
type SavedMeasures = {
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  thinkingChars?: number | null;
  estimatedInputTokens?: number | null;
  timing?: Timing;
  planCheck?: PlanExpectation | null;
};

/** What a refused reply's file holds. */
type SavedFailure = {
  operation?: Operation;
  source?: string;
  originalCallAt: string | null;
  model?: string | null;
  error: string;
  stopReason: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Missing on failures saved before the replay asked once more. */
  refusedAttempts?: Refusal[];
} & SavedMeasures;

/** A saved reply's or refusal's usage, for the measures. */
function savedUsage(s: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}): Usage {
  return {
    inputTokens: s.inputTokens ?? null,
    outputTokens: s.outputTokens ?? null,
    thinkingTokens: s.thinkingTokens ?? null,
    cacheReadTokens: s.cacheReadTokens ?? null,
    cacheCreationTokens: s.cacheCreationTokens ?? null,
  };
}

/** One reply file's part of the measures. */
function replyRecord(
  id: string,
  operation: Operation,
  s: Saved | SavedFailure,
  accepted: boolean,
  extra: Pick<ReplyRecord, "goalCheckFailures" | "bannedTerms" | "plan">,
): ReplyRecord {
  const refusals = s.refusedAttempts ?? [];
  const usage = savedUsage(s);
  // A failure whose last attempt was refused for its shape already lists it among the
  // refusals; one that ended another way (a timeout, a transport error) adds its usage.
  const attempts = s.timing?.attempts.length ?? refusals.length;
  const lastWasRefusal = !accepted && refusals.length > 0 && refusals.at(-1)!.attempt === attempts;
  const attemptUsages = [...refusals.map(savedUsage), ...(lastWasRefusal ? [] : [usage])];
  return {
    id,
    operation,
    accepted,
    retried: accepted && refusals.length > 0,
    model: s.model ?? null,
    repairs: accepted ? (s as Saved).repairs : null,
    refusalErrors: refusals.map((r) => r.error),
    usage,
    attemptUsages,
    thinkingChars: s.thinkingChars ?? null,
    estimatedInputTokens: s.estimatedInputTokens ?? null,
    ttftMs: s.timing?.ttftMs ?? null,
    totalMs: s.timing?.totalMs ?? null,
    ...extra,
  };
}

/** Figures worth tracking: anything with a decimal point or colon, or two or more digits. */
function figures(text: string): string[] {
  const found = text.replace(/[–—]/g, "-").match(/\d+(?:[.:]\d+)*/g) ?? [];
  return [...new Set(found.filter((f) => /[.:]/.test(f) || f.length >= 2))];
}

function dayText(days: PrescribedDay[]): string {
  return days
    .map((d) => [d.notes, d.strength, d.run?.structure, d.run?.paceOrHr, d.run?.shoes].filter(Boolean).join(" "))
    .join("\n");
}

/** Questions the old read answered: bold numbered lines, or "Your question — …" headings. */
function oldQuestions(analysis: string): string[] {
  const bold = [...analysis.matchAll(/^\*\*\d+\.\s*(.+?)\*\*/gm)].map((m) => m[1]!);
  const headed = [...analysis.matchAll(/^##+\s*(?:Your question|Answer to your question)\s*[—–-]?\s*(.*)$/gim)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
  return [...bold, ...headed];
}

/** Bullets under the old read's per-session heading. */
function oldSessionReasons(analysis: string): string[] {
  const section = /^##+\s*(?:Why (?:each session|these sessions)|How to read this week)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(analysis);
  return section ? [...section[1]!.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1]!) : [];
}

/**
 * Reply files in a configuration folder, such as 01.1.json (or 01.1.failed.json
 * for the suffix ".failed.json"), ordered by input then repeat.
 */
function numbered(dir: string, suffix: string): string[] {
  const pattern = new RegExp(`^(\\d+)\\.(\\d+)${suffix.replace(/\./g, "\\.")}$`);
  return readdirSync(dir)
    .map((f) => ({ f, m: pattern.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((x, y) => Number(x.m[1]) - Number(y.m[1]) || Number(x.m[2]) - Number(y.m[2]))
    .map((x) => path.join(dir, x.f));
}

/** One configuration's part of the report. */
type ConfigurationReport = {
  folder: string;
  config: ConfigFile;
  /** Its section, headed at level 2. */
  lines: string[];
  checkFailures: ReplayCheckFailure[];
  replies: number;
  /** Every measure, as written to its measures.json. */
  measures: Measures;
};

/** One call's part of its section: every athlete-facing word, and the operation's own table and fields. */
type CallSection = { readText: string; lines: string[] };

/** A markdown blockquote of a reply's text. */
function quoted(text: string): string[] {
  return text.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
}

function bulletList(items: string[] | undefined, none = "- none"): string[] {
  return items?.length ? items.map((b) => `- ${b}`) : [none];
}

/** The weekly read: headline, flags, answers, the read, the days, safety callouts and About you suggestions. */
function weeklySection(n: WeeklyReply, oldRaw: Record<string, unknown> | null): CallSection {
  const old = oldRaw as { analysis: string; prescribedWeek: { days: PrescribedDay[] } } | null;
  const readText = [
    n.headline,
    ...(n.flags ?? []).flatMap((f) => [f.title, f.detail]),
    ...(n.answers ?? []).flatMap((a) => [a.question, a.answer]),
    n.analysis,
    dayText(n.prescribedWeek.days),
    ...(n.safetyCallouts ?? []).map((c) => JSON.stringify(c)),
    ...(n.settingsProposalBullets ?? []),
  ].join("\n");
  const normalized = readText.replace(/[–—]/g, "-");
  const missing = old ? figures(old.analysis).filter((f) => !normalized.includes(f)) : [];
  const questions = old ? oldQuestions(old.analysis) : [];
  const reasons = old ? oldSessionReasons(old.analysis) : [];
  const daysWithNotes = n.prescribedWeek.days.filter((d) => d.notes?.trim()).length;
  const repeatsHeadline = n.analysis.includes(n.headline.slice(0, 60));
  const listsDays =
    /^\s*[-*]\s+\**(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/m.test(n.analysis) ||
    /^\|\s*\**(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/m.test(n.analysis);
  const standAlone = [...(n.flags ?? []).map((f) => f.detail), ...(n.answers ?? []).map((a) => a.answer)];
  // A reference to another part, such as "the table above" or "see below", not "below the 80% target".
  const pointsAcross = standAlone.some((t) =>
    /\b(?:table|list|section|chart|plan|notes?)\s+(?:above|below)\b|\b(?:see|as)\s+(?:above|below)\b|\b(?:above|below)\s*[.,;)]/i.test(t),
  );
  const tableRows = (text: string) =>
    text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") && !/^\|[\s|:-]+\|$/.test(l) && l.length > 20);
  const analysisRows = new Set(tableRows(n.analysis));
  const repeatsAnswerTable = (n.answers ?? []).some((a) => tableRows(a.answer).some((r) => analysisRows.has(r)));
  const banned = bannedTermsIn(readText);
  return {
    readText,
    lines: [
      "| Check | Old | New |",
      "|---|---|---|",
      `| Read length (characters) | ${old?.analysis.length ?? ""} | ${n.analysis.length} |`,
      `| Headline | | ${n.headline.length} chars |`,
      `| Flags | | ${n.flags?.length ?? 0} |`,
      `| Questions answered | ${old ? questions.length : ""} | ${n.answers?.length ?? 0} |`,
      `| Session reasons | ${old ? `${reasons.length} in the read` : ""} | ${daysWithNotes} days with notes |`,
      `| Read repeats the headline | | ${repeatsHeadline ? "yes" : "no"} |`,
      `| Read lists the days (as a list or a table) | | ${listsDays ? "yes" : "no"} |`,
      `| A flag or answer points "above" or "below" | | ${pointsAcross ? "yes" : "no"} |`,
      `| Read repeats an answer's table | | ${repeatsAnswerTable ? "yes" : "no"} |`,
      `| Internal words | | ${banned.length ? banned.join(", ") : "none"} |`,
      "",
      ...(old
        ? [
            `Figures in the old read not found anywhere in the new reply: ${missing.length ? missing.join(", ") : "none"}`,
            "",
            "Old questions:",
            ...(questions.length ? questions.map((q) => `- ${q}`) : ["- none found"]),
            "",
          ]
        : []),
      "New answers to:",
      ...((n.answers ?? []).length ? n.answers!.map((a) => `- ${a.question}`) : ["- none"]),
      "",
    ],
  };
}

function calloutText(callouts: SafetyCallout[] | undefined): string[] {
  return (callouts ?? []).map((c) => JSON.stringify(c));
}

/** The mid-week reply: its text, About you suggestions, plan changes and safety callouts. */
function midWeekSection(n: MidWeekChatReply, oldRaw: Record<string, unknown> | null): CallSection {
  const old = oldRaw as MidWeekChatReply | null;
  const patches = n.prescribedDayPatches ?? [];
  const readText = [
    n.body,
    ...(n.settingsProposalBullets ?? []),
    dayText(patches),
    ...calloutText(n.safetyCallouts),
  ].join("\n");
  const banned = bannedTermsIn(readText);
  const count = (items: unknown[] | undefined) => (old ? String(items?.length ?? 0) : "");
  return {
    readText,
    lines: [
      "| Check | Old | New |",
      "|---|---|---|",
      `| Reply length (characters) | ${old?.body?.length ?? ""} | ${n.body.length} |`,
      `| About you suggestions | ${count(old?.settingsProposalBullets)} | ${n.settingsProposalBullets?.length ?? 0} |`,
      `| Plan changes (days) | ${count(old?.prescribedDayPatches)} | ${patches.length} |`,
      `| Safety callouts | ${count(old?.safetyCallouts)} | ${n.safetyCallouts?.length ?? 0} |`,
      `| Internal words | | ${banned.length ? banned.join(", ") : "none"} |`,
      "",
      "Reply:",
      "",
      ...quoted(n.body),
      "",
      "About you suggestions:",
      ...bulletList(n.settingsProposalBullets),
      "",
      "Plan changes:",
      ...bulletList(
        patches.map((d) => `${d.date} ${d.dayType}${d.run?.structure ? `: ${d.run.structure}` : ""}${d.notes ? ` (${d.notes})` : ""}`),
      ),
      "",
      ...(n.safetyCallouts?.length ? ["Safety callouts:", ...n.safetyCallouts.map((c) => `- ${c.title}: ${c.body}`), ""] : []),
    ],
  };
}

/** An About you draft (first draft, correction or tidy-up): its summary bullets and body. */
function aboutYouSection(n: DossierV1Draft, oldRaw: Record<string, unknown> | null): CallSection {
  const old = oldRaw as DossierV1Draft | null;
  const readText = [...n.summaryBullets, n.proposedBody].join("\n");
  const banned = bannedTermsIn(readText);
  return {
    readText,
    lines: [
      "| Check | Old | New |",
      "|---|---|---|",
      `| About you length (characters) | ${old?.proposedBody?.length ?? ""} | ${n.proposedBody.length} |`,
      `| Summary bullets | ${old ? (old.summaryBullets?.length ?? 0) : ""} | ${n.summaryBullets.length} |`,
      `| Internal words | | ${banned.length ? banned.join(", ") : "none"} |`,
      "",
      "Summary:",
      ...bulletList(n.summaryBullets),
      "",
      "About you:",
      "",
      ...quoted(n.proposedBody),
      "",
    ],
  };
}

function callSection(operation: Operation, s: Saved): CallSection {
  switch (operation) {
    case "weekly_reply":
      return weeklySection(s.new as WeeklyReply, s.old);
    case "mid_week_chat":
      return midWeekSection(s.new as MidWeekChatReply, s.old);
    default:
      return aboutYouSection(s.new as DossierV1Draft, s.old);
  }
}

/** How a reply is named in the report: its file in a folder, or the original call's date in the snapshot. */
function replyLabel(name: string, operation: Operation, d: { source?: string; originalCallAt: string | null }): string {
  return d.originalCallAt
    ? `${name} (${OPERATION_LABELS[operation]} on ${d.originalCallAt.slice(0, 10)})`
    : `${name} (${d.source ?? "unknown packet"})`;
}

const OPERATION_PLURALS: Record<Operation, string> = {
  weekly_reply: "weekly reads",
  mid_week_chat: "mid-week replies",
  dossier_v1: "About you first drafts",
  dossier_correction: "About you corrections",
  dossier_audit: "About you tidy-ups",
};

/** "2 weekly reads, 1 mid-week reply", in operation order. */
function operationCounts(counts: Map<Operation, number>): string {
  return OPERATIONS.filter((o) => counts.has(o))
    .map((o) => {
      const n = counts.get(o)!;
      return `${n} ${n === 1 ? OPERATION_LABELS[o] : OPERATION_PLURALS[o]}`;
    })
    .join(", ");
}

/** One configuration folder's section: the per-call sections, goal checks, retried and refused replies. */
function reportConfiguration(dir: string): ConfigurationReport {
  const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")) as ConfigFile;
  const folder = path.basename(dir);
  const files = numbered(dir, ".json");
  const sections: string[] = [];
  const checkFailures: ReplayCheckFailure[] = [];
  const byOperation = new Map<Operation, number>();
  const tally = (operation: Operation) => byOperation.set(operation, (byOperation.get(operation) ?? 0) + 1);
  // Replies that came back only when asked once more.
  const retried: string[] = [];
  const records: ReplyRecord[] = [];
  for (const file of files) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Saved;
    const operation = s.operation ?? "weekly_reply";
    tally(operation);
    const name = path.basename(file, ".json");
    const label = replyLabel(name, operation, s);
    const section = callSection(operation, s);
    const goal = s.goal ?? null;
    // A reply saved before the goal checks has no prompt head, and fails the goal-line check.
    const prompt = s.promptHead === undefined ? "" : s.promptHead;
    const failed = replayCheckFailures({ label, goal, prompt, readText: section.readText });
    checkFailures.push(...failed);
    const refusals = s.refusedAttempts ?? [];
    const retryNote = refusals.length
      ? `Asked once more: ${refusals.map((r) => `attempt ${r.attempt} refused (${r.error}; stop reason ${r.stopReason})`).join("; ")}.`
      : null;
    if (retryNote) retried.push(`- ${label}: ${retryNote}`);
    records.push(
      replyRecord(name, operation, s, true, {
        goalCheckFailures: failed.map((f) => f.check),
        bannedTerms: bannedTermsIn(section.readText),
        plan: operation === "weekly_reply" ? planSanity((s.new as WeeklyReply).prescribedWeek, s.planCheck) : null,
      }),
    );

    const heading = s.originalCallAt
      ? `### ${name}: ${OPERATION_LABELS[operation]} on ${s.originalCallAt.slice(0, 10)}`
      : `### ${label}: ${OPERATION_LABELS[operation]}`;
    sections.push(
      heading,
      "",
      `Model ${s.model ?? "default"}. Outcome ${s.outcome}${s.repairs ? ` (${s.repairs})` : ""}. Tokens in ${s.inputTokens}, out ${s.outputTokens}.`,
      "",
      ...(retryNote ? [retryNote, ""] : []),
      ...(s.asked ? [`Athlete: ${cell(s.asked)}`, ""] : []),
      `Goal: ${goal ? `${goal.kind}${goal.distance ? ` (${goal.distance})` : ""}` : "none"}. Goal checks: ${failed.length ? failed.map((f) => f.check).join(", ") : "passed"}${prompt === null ? " (no goal line in this prompt, so not checked for one)" : ""}.`,
      "",
      ...section.lines,
      "Verdict: _to be judged_",
      "",
    );
  }
  const refused = numbered(dir, ".failed.json").filter((f) => !existsSync(f.replace(/\.failed\.json$/, ".json")));
  const failures = refused.map((f) => ({ f, d: JSON.parse(readFileSync(f, "utf8")) as SavedFailure }));
  // A refused reply has nothing to check, so it cannot pass the gate either.
  for (const { f, d } of failures) {
    const operation = d.operation ?? "weekly_reply";
    tally(operation);
    const label = replyLabel(path.basename(f, ".failed.json"), operation, d);
    checkFailures.push({ label, check: "refused reply", detail: "no reply to check; replay it again" });
    records.push(
      replyRecord(path.basename(f, ".failed.json"), operation, d, false, { goalCheckFailures: [], bannedTerms: [], plan: null }),
    );
  }
  const measures = configurationMeasures(folder, config.provider, records);
  writeFileSync(path.join(dir, "measures.json"), JSON.stringify(measures, null, 2));
  const lines: string[] = [
    `## ${folder}`,
    "",
    `Provider ${config.provider}${config.baseUrlHost ? ` at ${config.baseUrlHost}` : ""}. Model ${config.model}, effort ${config.effort}. ${config.repeats} repeat${config.repeats === 1 ? "" : "s"} over ${config.inputs}${config.dryRun ? " (dry run, offline stub)" : ""}.`,
    `Started ${config.startedAt}${config.resumedAt?.length ? `, resumed ${config.resumedAt.join(", ")}` : ""}. Harness commit ${config.harnessCommit ?? "unknown"}.${config.note ? ` Note: ${config.note}` : ""}`,
    "",
    `Replies: ${operationCounts(byOperation) || "none"}.`,
    "",
    "### Measures",
    "",
    ...measuresTable(measures),
    "### Goal checks",
    "",
    ...(checkFailures.length
      ? checkFailures.map((f) => `- ${f.label}: ${f.check}: ${f.detail}`)
      : [GOAL_CHECKS_PASSED]),
    "",
    ...sections,
  ];
  if (retried.length > 0) {
    lines.push("### Retried replies", "", "Refused for their shape, then came back when asked once more, as the app does.", "", ...retried, "");
  }
  if (refused.length > 0) {
    lines.push("### Refused replies", "");
    for (const { f, d } of failures) {
      const operation = d.operation ?? "weekly_reply";
      const what = d.originalCallAt
        ? `${OPERATION_LABELS[operation]} on ${d.originalCallAt.slice(0, 10)}`
        : `${d.source}, ${OPERATION_LABELS[operation]}`;
      const attempts = d.refusedAttempts?.length ?? 0;
      const tries = attempts > 1 ? ` (refused on all ${attempts} attempts)` : "";
      lines.push(`- ${path.basename(f)} (${what}): ${d.error}; stop reason ${d.stopReason}${tries}`);
    }
    lines.push("");
  }
  return {
    folder,
    config,
    lines,
    // Named with the configuration, for the report's opening list and the exit message.
    checkFailures: checkFailures.map((f) => ({ ...f, label: `${folder}/${f.label}` })),
    replies: files.length + refused.length,
    measures,
  };
}

/** Configuration folders under the output root: every folder holding a config.json, by name. */
function configurationFolders(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(ROOT, e.name, "config.json")))
    .map((e) => path.join(ROOT, e.name))
    .sort();
}

const GOAL_CHECKS_PASSED =
  "All passed: every packet has a goal line, no non-marathon reply says marathon, no stay-fit reply gives a long-run verdict, and no reply was refused.";

/** A markdown table cell. */
function cell(text: string | null): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Builds one report.md at the root over every configuration and returns the goal checks that failed. */
function report(): ReplayCheckFailure[] {
  const folders = configurationFolders();
  if (folders.length === 0) throw new Error(`No configuration folders (with a config.json) under ${ROOT}.`);
  const parts = folders.map(reportConfiguration);
  const checkFailures = parts.flatMap((p) => p.checkFailures);
  const out: string[] = [
    "# Replay gate: first-pass report",
    "",
    `Generated ${new Date().toISOString()} from ${parts.reduce((n, p) => n + p.replies, 0)} replayed coach calls across ${parts.length} configuration${parts.length === 1 ? "" : "s"} in ${ROOT}.`,
    "",
    "The checks below only point at what to read. A figure listed as missing may be rounded, restated or deliberately dropped; each one is judged by a person before the gate passes.",
    "",
    "## Configurations",
    "",
    "Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt. The other columns are the measures; each configuration's section breaks them down.",
    "",
    `| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed | ${SUMMARY_MEASURE_HEADERS.join(" | ")} |`,
    `|---|---|---|---|---|---|---|---|---|---|---|${SUMMARY_MEASURE_HEADERS.map(() => "---|").join("")}`,
    ...parts.map(({ folder, config: c, replies, measures: m }) =>
      [
        "",
        folder,
        c.provider,
        cell(c.baseUrlHost),
        cell(c.model),
        c.effort,
        c.repeats,
        cell(c.note),
        replies,
        m.schema.firstTry,
        m.schema.afterRetry,
        m.schema.failed,
        ...summaryMeasureCells(m),
        "",
      ]
        .join(" | ")
        .trim(),
    ),
    "",
    ...measuresNote(),
    "## Goal checks",
    "",
    ...(checkFailures.length
      ? checkFailures.map((f) => `- ${f.label}: ${f.check}: ${f.detail}`)
      : [GOAL_CHECKS_PASSED]),
    "",
    // Blind scores joined to each pack's key; nothing when there is no review folder.
    ...reviewResults(flagPath("--review") ?? path.resolve(ROOT, "..", "review")),
    ...parts.flatMap((p) => p.lines),
  ];
  writeFileSync(path.join(ROOT, "report.md"), out.join("\n"));
  console.log(`report written to ${path.join(ROOT, "report.md")}`);
  return checkFailures;
}

if (reviewPack) {
  reviewPacks();
} else {
  mkdirSync(ROOT, { recursive: true });
  if (!reportOnly) await replay(PACKETS ? folderCalls(PACKETS) : storedDemoCalls());
  const checkFailures = report();
  if (checkFailures.length > 0) {
    console.error(`${checkFailures.length} goal check${checkFailures.length === 1 ? "" : "s"} failed:`);
    for (const f of checkFailures) console.error(`- ${f.label}: ${f.check}: ${f.detail}`);
    process.exitCode = 1;
  }
}
