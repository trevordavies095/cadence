/**
 * Replay gate for the reading-flow work (ticket 09).
 *
 * Re-sends every weekly call in the demo snapshot's call log to the live model
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
 * Every report opens with three goal checks, each naming the read that failed:
 * a packet with no goal line (no goal, or the rebuilt prompt does not open with
 * "Athlete goal:"); "marathon" in a read whose goal is not a marathon; and a
 * long-run verdict in a read whose goal is stay fit. A refused reply also fails,
 * since it leaves a read unchecked. The checks read every athlete-facing word:
 * headline, flags, answers, the read, the days, safety callouts and About you
 * proposals. The script exits non-zero when any check fails, in any configuration. The dry run over tests/fixtures/replay-packets runs in
 * the API test suite (tests/replay-weekly-reads.test.ts).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainingGoal } from "../src/goal/types.js";
import { createAnthropicLlmPort, weeklyUserPromptFor } from "../src/llm/anthropic.js";
import { askOnceMore } from "../src/llm/askOnceMore.js";
import { TESTED_COACH_MODEL } from "../src/llm/coachModel.js";
import { anthropicCoachTarget, type CoachProvider, type CoachTarget } from "../src/llm/coachTarget.js";
import { ANTHROPIC_EFFORT_LEVELS, parseAnthropicEffort, type AnthropicEffort } from "../src/llm/effort.js";
import { LlmSchemaError } from "../src/llm/port.js";
import { createStubLlmPort } from "../src/llm/stub.js";
import type { PrescribedDay, WeeklyReply } from "../src/llm/types.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import { normalizeSelfHostedBaseUrl, selfHostedEndpoint, selfHostedHost } from "../src/settings/selfHostedStore.js";
import { replayCheckFailures, type ReplayCheckFailure } from "./replayChecks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(here, "../../demo/snapshot.sql");
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

type StoredCall = {
  /** Where the call came from: the snapshot's call time, or the packet's file name. */
  source: string;
  createdAt: string | null;
  model: string | undefined;
  packet: ModelPacket;
  old: Record<string, unknown> | null;
  /** Dry run only: how many attempts the stub refuses for their shape first. */
  stubRefusals?: number;
};

function storedWeeklyCalls(): StoredCall[] {
  const rows = copyTable(readFileSync(SNAPSHOT, "utf8"), "llm_call_log")
    .filter((r) => r.operation === "weekly_reply" && r.outcome !== "failed")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.map((r) => {
    const request = JSON.parse(r.request!) as { messages: Array<{ content: string }> };
    const content = request.messages[0]!.content;
    const marker = content.indexOf("Model packet");
    const packet = JSON.parse(content.slice(content.indexOf("\n", marker) + 1)) as ModelPacket;
    const response = JSON.parse(r.response_raw!) as {
      content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    };
    const old = response.content.find((b) => b.type === "tool_use" && b.name === "submit_weekly_reply")?.input;
    if (!old) throw new Error(`Call at ${r.created_at} has no weekly reply`);
    return { source: `snapshot call at ${r.created_at}`, createdAt: r.created_at!, model: r.model!, packet, old };
  });
}

// ---- Reading a packet folder ------------------------------------------------

function folderCalls(dir: string): StoredCall[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No .json packets in ${dir}`);
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    const wrapped = raw.packet && typeof raw.packet === "object";
    const packet = (wrapped ? raw.packet : raw) as ModelPacket;
    const model = wrapped && typeof raw.model === "string" ? raw.model : undefined;
    const stubRefusals = wrapped && typeof raw.stubRefusals === "number" ? raw.stubRefusals : 0;
    return { source: f, createdAt: null, model, packet, old: null, stubRefusals };
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
  let reply: WeeklyReply;
  try {
    // Asked once more when refused for its shape, as the app does (ADR 0002).
    const result = await askOnceMore(async (attempt) => {
      const logged = log.length;
      try {
        if (stubRefusalsLeft > 0) {
          stubRefusalsLeft--;
          throw new LlmSchemaError("stub refusal: analysis is required and must be non-empty");
        }
        // The port writes its log row, with any repairs and token counts, only for a call with an id.
        return { ok: true as const, value: await port.generateWeeklyReply(call.packet, { callId: randomUUID() }) };
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
    });
    if (!result.ok) throw new LlmSchemaError(result.error);
    reply = result.value;
  } catch (err) {
    // A refused reply is a finding, not a reason to stop: keep what the model sent and move on.
    const failed = log.at(-1);
    writeFileSync(
      failedFile,
      JSON.stringify(
        {
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
        source: call.source,
        originalCallAt: call.createdAt,
        model: target.model,
        replayedAt: new Date().toISOString(),
        // What the goal checks read: the packet's goal and the rebuilt prompt's first line.
        goal: call.packet.goal ?? null,
        promptHead: weeklyUserPromptFor(call.packet).split("\n", 1)[0],
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
  /** Missing on replies saved before packet folders existed. */
  source?: string;
  originalCallAt: string | null;
  model: string | null;
  goal?: TrainingGoal | null;
  promptHead?: string;
  outcome: string | null;
  repairs: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Missing on replies saved before the replay asked once more. */
  refusedAttempts?: Refusal[];
  /** Null for a packet from a folder: it has no earlier reply. */
  old: { analysis: string; prescribedWeek: { days: PrescribedDay[] } } | null;
  new: WeeklyReply;
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

/** One configuration folder's section: the per-call tables, goal checks, retried and refused replies. */
function reportConfiguration(dir: string): ConfigurationReport {
  const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")) as ConfigFile;
  const folder = path.basename(dir);
  const files = numbered(dir, ".json");
  const sections: string[] = [];
  const checkFailures: ReplayCheckFailure[] = [];
  // Replies that came back only when asked once more.
  const retried: string[] = [];
  for (const file of files) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Saved;
    const n = s.new;
    const old = s.old;
    const name = path.basename(file, ".json");
    // Names the packet: its file in a folder, or the original call's date in the snapshot.
    const label = s.originalCallAt
      ? `${name} (week read on ${s.originalCallAt.slice(0, 10)})`
      : `${name} (${s.source ?? "unknown packet"})`;
    const newText = [
      n.headline,
      ...(n.flags ?? []).flatMap((f) => [f.title, f.detail]),
      ...(n.answers ?? []).flatMap((a) => [a.question, a.answer]),
      n.analysis,
      dayText(n.prescribedWeek.days),
      ...(n.safetyCallouts ?? []).map((c) => JSON.stringify(c)),
      ...(n.settingsProposalBullets ?? []),
    ].join("\n");
    const goal = s.goal ?? null;
    const failed = replayCheckFailures({ label, goal, prompt: s.promptHead ?? "", readText: newText });
    checkFailures.push(...failed);
    const refusals = s.refusedAttempts ?? [];
    const retryNote = refusals.length
      ? `Asked once more: ${refusals.map((r) => `attempt ${r.attempt} refused (${r.error}; stop reason ${r.stopReason})`).join("; ")}.`
      : null;
    if (retryNote) retried.push(`- ${label}: ${retryNote}`);
    const normalized = newText.replace(/[–—]/g, "-");
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
    const banned = bannedTermsIn(newText);

    const heading = s.originalCallAt
      ? `### ${name}: week read on ${s.originalCallAt.slice(0, 10)}`
      : `### ${label}`;
    sections.push(
      heading,
      "",
      `Model ${s.model ?? "default"}. Outcome ${s.outcome}${s.repairs ? ` (${s.repairs})` : ""}. Tokens in ${s.inputTokens}, out ${s.outputTokens}.`,
      "",
      ...(retryNote ? [retryNote, ""] : []),
      `Goal: ${goal ?`${goal.kind}${goal.distance ? ` (${goal.distance})` : ""}` : "none"}. Goal checks: ${failed.length ? failed.map((f) => f.check).join(", ") : "passed"}.`,
      "",
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
      "Verdict: _to be judged_",
      "",
    );
  }
  const refused = numbered(dir, ".failed.json").filter((f) => !existsSync(f.replace(/\.failed\.json$/, ".json")));
  // A refused reply has no read to check, so it cannot pass the gate either.
  for (const f of refused) {
    const d = JSON.parse(readFileSync(f, "utf8")) as { source?: string; originalCallAt: string | null };
    const name = path.basename(f, ".failed.json");
    const label = d.originalCallAt
      ? `${name} (week read on ${d.originalCallAt.slice(0, 10)})`
      : `${name} (${d.source ?? "unknown packet"})`;
    checkFailures.push({ label, check: "refused reply", detail: "no read to check; replay it again" });
  }
  const lines: string[] = [
    `## ${folder}`,
    "",
    `Provider ${config.provider}${config.baseUrlHost ? ` at ${config.baseUrlHost}` : ""}. Model ${config.model}, effort ${config.effort}. ${config.repeats} repeat${config.repeats === 1 ? "" : "s"} over ${config.inputs}${config.dryRun ? " (dry run, offline stub)" : ""}.`,
    `Started ${config.startedAt}${config.resumedAt?.length ? `, resumed ${config.resumedAt.join(", ")}` : ""}. Harness commit ${config.harnessCommit ?? "unknown"}.${config.note ? ` Note: ${config.note}` : ""}`,
    "",
    "### Goal checks",
    "",
    ...(checkFailures.length
      ? checkFailures.map((f) => `- ${f.label}: ${f.check}: ${f.detail}`)
      : ["All passed: every packet has a goal line, no non-marathon read says marathon, no stay-fit read gives a long-run verdict, and no reply was refused."]),
    "",
    ...sections,
  ];
  if (retried.length > 0) {
    lines.push("### Retried replies", "", "Refused for their shape, then came back when asked once more, as the app does.", "", ...retried, "");
  }
  if (refused.length > 0) {
    lines.push("### Refused replies", "");
    for (const f of refused) {
      const d = JSON.parse(readFileSync(f, "utf8")) as {
        source?: string;
        originalCallAt: string | null;
        error: string;
        stopReason: string | null;
        /** Missing on failures saved before the replay asked once more. */
        refusedAttempts?: Refusal[];
      };
      const what = d.originalCallAt ? `week read on ${d.originalCallAt.slice(0, 10)}` : d.source;
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
    `Generated ${new Date().toISOString()} from ${parts.reduce((n, p) => n + p.replies, 0)} replayed weekly calls across ${parts.length} configuration${parts.length === 1 ? "" : "s"} in ${ROOT}.`,
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
      : ["All passed: every packet has a goal line, no non-marathon read says marathon, no stay-fit read gives a long-run verdict, and no reply was refused."]),
    "",
    ...parts.flatMap((p) => p.lines),
  ];
  writeFileSync(path.join(ROOT, "report.md"), out.join("\n"));
  console.log(`report written to ${path.join(ROOT, "report.md")}`);
  return checkFailures;
}

mkdirSync(ROOT, { recursive: true });
if (!reportOnly) await replay(PACKETS ? folderCalls(PACKETS) : storedWeeklyCalls());
const checkFailures = report();
if (checkFailures.length > 0) {
  console.error(`${checkFailures.length} goal check${checkFailures.length === 1 ? "" : "s"} failed:`);
  for (const f of checkFailures) console.error(`- ${f.label}: ${f.check}: ${f.detail}`);
  process.exitCode = 1;
}
