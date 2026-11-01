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
 * retry, failed) and a section per configuration.
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
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainingGoal } from "../src/goal/types.js";
import { createAnthropicLlmPort, weeklyUserPromptFor } from "../src/llm/anthropic.js";
import { askOnceMore, type AskResult } from "../src/llm/askOnceMore.js";
import { TESTED_COACH_MODEL } from "../src/llm/coachModel.js";
import { anthropicCoachTarget, type CoachProvider, type CoachTarget } from "../src/llm/coachTarget.js";
import { ANTHROPIC_EFFORT_LEVELS, parseAnthropicEffort, type AnthropicEffort } from "../src/llm/effort.js";
import { goalPromptLines } from "../src/llm/goalLines.js";
import { LlmSchemaError, type LlmCallOptions, type LlmPort } from "../src/llm/port.js";
import { createStubLlmPort, resolvePlanWeekStartMonday } from "../src/llm/stub.js";
import type {
  DossierAuditInput,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  PrescribedDay,
  SafetyCallout,
  WeeklyReply,
} from "../src/llm/types.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import { normalizeSelfHostedBaseUrl, selfHostedEndpoint, selfHostedHost } from "../src/settings/selfHostedStore.js";
import { replayCheckFailures, type ReplayCheckFailure } from "./replayChecks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(here, "../../demo/snapshot.sql");
/** The inputs the snapshot's call log lacks, generated from the demo database. */
const DEMO_OPERATIONS = path.resolve(here, "../tests/fixtures/demo-operations");
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

// ---- Reading the snapshot ---------------------------------------------------

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\" };

/** One field of a Postgres COPY text row. */
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

/** The five coach operations, named as the call log names them. */
const OPERATIONS = ["weekly_reply", "mid_week_chat", "dossier_v1", "dossier_correction", "dossier_audit"] as const;
type Operation = (typeof OPERATIONS)[number];

/** What the report calls each operation. */
const OPERATION_LABELS: Record<Operation, string> = {
  weekly_reply: "weekly read",
  mid_week_chat: "mid-week reply",
  dossier_v1: "About you first draft",
  dossier_correction: "About you correction",
  dossier_audit: "About you tidy-up",
};

/** What one input sends: the operation and the port input it is called with. */
type CoachInput =
  | { operation: "weekly_reply" | "mid_week_chat"; packet: ModelPacket }
  | { operation: "dossier_v1"; input: DossierV1Input }
  | { operation: "dossier_correction"; input: DossierCorrectionInput }
  | { operation: "dossier_audit"; input: DossierAuditInput };

type StoredCall = CoachInput & {
  /** Where the call came from: the snapshot's call time, or the packet's file name. */
  source: string;
  createdAt: string | null;
  model: string | undefined;
  /** The athlete's goal, for the goal checks: the packet's, else the one given beside the input. */
  goal: TrainingGoal | null;
  old: Record<string, unknown> | null;
  /** Dry run only: how many attempts the stub refuses for their shape first. */
  stubRefusals?: number;
};

/** The JSON after the line that introduces it in a logged user prompt. */
function jsonAfter(content: string, marker: string): unknown {
  const at = content.indexOf(marker);
  if (at < 0) throw new Error(`No "${marker}" line in the logged prompt`);
  return JSON.parse(content.slice(content.indexOf("\n", at) + 1));
}

/** The tool input of the original reply, or null when the model sent none. */
function loggedToolInput(responseRaw: string | null, tool: string): Record<string, unknown> | null {
  if (!responseRaw) return null;
  const response = JSON.parse(responseRaw) as {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
  };
  return response.content?.find((b) => b.type === "tool_use" && b.name === tool)?.input ?? null;
}

/**
 * The snapshot's coach calls: the weekly reads first (so their reply numbers
 * stay as they were before other operations were replayed), then the mid-week
 * replies, then the About you first draft, each group by call time.
 */
function storedSnapshotCalls(): StoredCall[] {
  const order: Operation[] = ["weekly_reply", "mid_week_chat", "dossier_v1"];
  const rows = copyTable(readFileSync(SNAPSHOT, "utf8"), "llm_call_log")
    .filter((r) => order.includes(r.operation as Operation) && r.outcome !== "failed")
    .sort(
      (a, b) =>
        order.indexOf(a.operation as Operation) - order.indexOf(b.operation as Operation) ||
        String(a.created_at).localeCompare(String(b.created_at)),
    );
  return rows.map((r): StoredCall => {
    const request = JSON.parse(r.request!) as { messages: Array<{ content: string }> };
    const content = request.messages[0]!.content;
    const common = { source: `snapshot call at ${r.created_at}`, createdAt: r.created_at!, model: r.model! };
    if (r.operation === "dossier_v1") {
      const input = jsonAfter(content, "Onboarding answers and running-log hints") as DossierV1Input;
      const old = loggedToolInput(r.response_raw ?? null, "submit_about_you");
      if (!old) throw new Error(`Call at ${r.created_at} has no About you draft`);
      return { ...common, operation: "dossier_v1", input, goal: input.goal ?? null, old };
    }
    const packet = jsonAfter(content, "Model packet") as ModelPacket;
    const operation = r.operation as "weekly_reply" | "mid_week_chat";
    const old = loggedToolInput(
      r.response_raw ?? null,
      operation === "weekly_reply" ? "submit_weekly_reply" : "submit_mid_week_chat_reply",
    );
    if (!old) throw new Error(`Call at ${r.created_at} has no ${OPERATION_LABELS[operation]}`);
    return { ...common, operation, packet, goal: packet.goal ?? null, old };
  });
}

/** The snapshot's calls, then the three inputs generated from the demo database. */
function storedDemoCalls(): StoredCall[] {
  return [...storedSnapshotCalls(), ...folderCalls(DEMO_OPERATIONS)];
}

// ---- Reading a packet folder ------------------------------------------------

function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);
}

/** One input file: a plain packet (a weekly read), or a wrapper naming its operation. */
function inputFromFile(f: string, raw: Record<string, unknown>): CoachInput & { goal: TrainingGoal | null } {
  const wrapped = (raw.packet && typeof raw.packet === "object") || (raw.input && typeof raw.input === "object");
  if (!wrapped) {
    if (raw.operation !== undefined) throw new Error(`${f}: an input with an operation needs a "packet" or an "input"`);
    const packet = raw as ModelPacket;
    return { operation: "weekly_reply", packet, goal: packet.goal ?? null };
  }
  const operation = raw.operation ?? "weekly_reply";
  if (!isOperation(operation)) {
    throw new Error(`${f}: unknown operation ${JSON.stringify(operation)}; expected one of ${OPERATIONS.join(", ")}`);
  }
  const besideGoal = (raw.goal ?? null) as TrainingGoal | null;
  if (operation === "weekly_reply" || operation === "mid_week_chat") {
    if (!raw.packet || typeof raw.packet !== "object") throw new Error(`${f}: ${operation} needs a "packet"`);
    const packet = raw.packet as ModelPacket;
    return { operation, packet, goal: packet.goal ?? besideGoal };
  }
  if (!raw.input || typeof raw.input !== "object") throw new Error(`${f}: ${operation} needs an "input"`);
  switch (operation) {
    case "dossier_v1": {
      const input = raw.input as DossierV1Input;
      return { operation, input, goal: input.goal ?? besideGoal };
    }
    case "dossier_correction":
      return { operation, input: raw.input as DossierCorrectionInput, goal: besideGoal };
    case "dossier_audit":
      return { operation, input: raw.input as DossierAuditInput, goal: besideGoal };
  }
}

function folderCalls(dir: string): StoredCall[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No .json packets in ${dir}`);
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    const wrapped = Boolean(raw.packet || raw.input);
    const model = wrapped && typeof raw.model === "string" ? raw.model : undefined;
    const stubRefusals = wrapped && typeof raw.stubRefusals === "number" ? raw.stubRefusals : 0;
    return { ...inputFromFile(f, raw), source: f, createdAt: null, model, old: null, stubRefusals };
  });
}

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
  responseRaw: unknown;
};

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

/**
 * The first line of the user prompt the port builds for this input, for the
 * goal-line check; null for the About you drafts, whose prompts carry no goal line.
 */
function promptHead(call: StoredCall): string | null {
  switch (call.operation) {
    case "weekly_reply":
      return weeklyUserPromptFor(call.packet).split("\n", 1)[0]!;
    case "mid_week_chat":
      // The mid-week prompt opens with the same goal lines, for the plan week's Monday.
      return goalPromptLines(call.packet, resolvePlanWeekStartMonday(call.packet))[0]!;
    default:
      return null;
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

/** Replays one input once into its reply file, skipped when the file exists. */
async function replayOne(call: StoredCall, file: string, apiKey: string | null): Promise<void> {
  const failedFile = file.replace(/\.json$/, ".failed.json");
  if (existsSync(file)) {
    console.log(`${path.basename(file)} exists, skipped`);
    return;
  }
  const log: LlmCallRecord[] = [];
  const target = coachTargetFor(call, apiKey);
  const port = dryRun
    ? createStubLlmPort()
    : createAnthropicLlmPort({
        // Built from flags; the replay never reads the saved setting (ADR 0004).
        resolveCoachTarget: async () => target,
        recorder: memoryRecorder(log),
      });
  const started = Date.now();
  // Each attempt refused for its shape, with what the model sent for it.
  const refusals: Refusal[] = [];
  let stubRefusalsLeft = dryRun ? (call.stubRefusals ?? 0) : 0;
  let reply: CoachReply;
  try {
    const ask = async (attempt: number): Promise<AskResult<CoachReply>> => {
      const logged = log.length;
      try {
        if (stubRefusalsLeft > 0) {
          stubRefusalsLeft--;
          throw new LlmSchemaError(`stub refusal: ${STUB_REFUSALS[call.operation]}`);
        }
        // The port writes its log row, with any repairs and token counts, only for a call with an id.
        return { ok: true as const, value: await sendToPort(port, call, { callId: randomUUID() }) };
      } catch (err) {
        if (err instanceof LlmSchemaError) {
          const row = log.length > logged ? log.at(-1) : undefined;
          refusals.push({
            attempt,
            error: err.message,
            outcome: row?.outcome ?? null,
            stopReason: row?.stopReason ?? null,
            outputTokens: row?.outputTokens ?? null,
            responseRaw: row?.responseRaw ?? null,
          });
        }
        throw err;
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
          outputTokens: failed?.outputTokens ?? null,
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
        inputTokens: row?.inputTokens ?? null,
        outputTokens: row?.outputTokens ?? null,
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
};

/** What a refused reply's file holds. */
type SavedFailure = {
  operation?: Operation;
  source?: string;
  originalCallAt: string | null;
  error: string;
  stopReason: string | null;
  /** Missing on failures saved before the replay asked once more. */
  refusedAttempts?: Refusal[];
};

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

/** Schema outcomes for one configuration (ticket 15 adds the other measures). */
type SchemaCounts = { firstTry: number; afterRetry: number; failed: number };

/** One configuration's part of the report. */
type ConfigurationReport = {
  folder: string;
  config: ConfigFile;
  /** Its section, headed at level 2. */
  lines: string[];
  checkFailures: ReplayCheckFailure[];
  replies: number;
  schema: SchemaCounts;
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
  }
  const lines: string[] = [
    `## ${folder}`,
    "",
    `Provider ${config.provider}${config.baseUrlHost ? ` at ${config.baseUrlHost}` : ""}. Model ${config.model}, effort ${config.effort}. ${config.repeats} repeat${config.repeats === 1 ? "" : "s"} over ${config.inputs}${config.dryRun ? " (dry run, offline stub)" : ""}.`,
    `Started ${config.startedAt}${config.resumedAt?.length ? `, resumed ${config.resumedAt.join(", ")}` : ""}. Harness commit ${config.harnessCommit ?? "unknown"}.${config.note ? ` Note: ${config.note}` : ""}`,
    "",
    `Replies: ${operationCounts(byOperation) || "none"}.`,
    "",
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
    schema: { firstTry: files.length - retried.length, afterRetry: retried.length, failed: refused.length },
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
    "Schema outcomes: replies accepted on the first try, accepted when asked once more, and refused on every attempt.",
    "",
    "| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...parts.map(
      ({ folder, config: c, replies, schema }) =>
        `| ${folder} | ${c.provider} | ${cell(c.baseUrlHost)} | ${cell(c.model)} | ${c.effort} | ${c.repeats} | ${cell(c.note)} | ${replies} | ${schema.firstTry} | ${schema.afterRetry} | ${schema.failed} |`,
    ),
    "",
    "## Goal checks",
    "",
    ...(checkFailures.length
      ? checkFailures.map((f) => `- ${f.label}: ${f.check}: ${f.detail}`)
      : [GOAL_CHECKS_PASSED]),
    "",
    ...parts.flatMap((p) => p.lines),
  ];
  writeFileSync(path.join(ROOT, "report.md"), out.join("\n"));
  console.log(`report written to ${path.join(ROOT, "report.md")}`);
  return checkFailures;
}

mkdirSync(ROOT, { recursive: true });
if (!reportOnly) await replay(PACKETS ? folderCalls(PACKETS) : storedDemoCalls());
const checkFailures = report();
if (checkFailures.length > 0) {
  console.error(`${checkFailures.length} goal check${checkFailures.length === 1 ? "" : "s"} failed:`);
  for (const f of checkFailures) console.error(`- ${f.label}: ${f.check}: ${f.detail}`);
  process.exitCode = 1;
}
