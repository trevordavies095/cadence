/**
 * The replay benchmark's inputs (scripts/replay-weekly-reads.ts): the demo
 * snapshot's coach calls, the operation fixtures generated from the demo
 * database, and packet folders such as the season packets. Shared by the
 * replay itself and by the analysis over its results
 * (scripts/replay-analysis.ts), so both read an input id the same way.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainingGoal } from "../src/goal/types.js";
import { weeklyUserPromptFor } from "../src/llm/anthropic.js";
import { goalPromptLines } from "../src/llm/goalLines.js";
import { resolvePlanWeekStartMonday } from "../src/llm/stub.js";
import type { DossierAuditInput, DossierCorrectionInput, DossierV1Input } from "../src/llm/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import type { Usage } from "./replayMeasures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(here, "../../demo/snapshot.sql");
/** The inputs the snapshot's call log lacks, generated from the demo database. */
const DEMO_OPERATIONS = path.resolve(here, "../tests/fixtures/demo-operations");

// ---- Reading the snapshot ---------------------------------------------------

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\" };

/** One field of a Postgres COPY text row. */
export function unescapeCopy(field: string): string | null {
  if (field === "\\N") return null;
  return field.replace(/\\(?:([ntrbfv\\])|([0-7]{1,3})|(.))/g, (_m, esc, oct, other) =>
    esc ? ESCAPES[esc]! : oct ? String.fromCharCode(parseInt(oct, 8)) : other,
  );
}

export function copyTable(sql: string, table: string): Array<Record<string, string | null>> {
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
export const OPERATIONS = ["weekly_reply", "mid_week_chat", "dossier_v1", "dossier_correction", "dossier_audit"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** What the report calls each operation. */
export const OPERATION_LABELS: Record<Operation, string> = {
  weekly_reply: "weekly read",
  mid_week_chat: "mid-week reply",
  dossier_v1: "About you first draft",
  dossier_correction: "About you correction",
  dossier_audit: "About you tidy-up",
};

/** What one input sends: the operation and the port input it is called with. */
export type CoachInput =
  | { operation: "weekly_reply" | "mid_week_chat"; packet: ModelPacket }
  | { operation: "dossier_v1"; input: DossierV1Input }
  | { operation: "dossier_correction"; input: DossierCorrectionInput }
  | { operation: "dossier_audit"; input: DossierAuditInput };

export type StoredCall = CoachInput & {
  /** Where the call came from: the snapshot's call time, or the packet's file name. */
  source: string;
  createdAt: string | null;
  model: string | undefined;
  /** The athlete's goal, for the goal checks: the packet's, else the one given beside the input. */
  goal: TrainingGoal | null;
  old: Record<string, unknown> | null;
  /** Dry run only: how many attempts the stub refuses for their shape first. */
  stubRefusals?: number;
  /** Dry run only: fields laid over the stub's reply before the operation's validator runs. */
  stubPatch?: Record<string, unknown>;
  /** Dry run only: the usage the stub's call-log row reports, for the token and cost measures. */
  stubUsage?: Partial<Usage>;
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
export function storedDemoCalls(): StoredCall[] {
  return [...storedSnapshotCalls(), ...folderCalls(DEMO_OPERATIONS)];
}

// ---- Reading a packet folder ------------------------------------------------

export function isOperation(value: unknown): value is Operation {
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

export function folderCalls(dir: string): StoredCall[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No .json packets in ${dir}`);
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    const wrapped = Boolean(raw.packet || raw.input);
    const model = wrapped && typeof raw.model === "string" ? raw.model : undefined;
    const stubRefusals = wrapped && typeof raw.stubRefusals === "number" ? raw.stubRefusals : 0;
    const object = (v: unknown) =>
      wrapped && v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    const stubPatch = object(raw.stubPatch);
    const stubUsage = object(raw.stubUsage) as Partial<Usage> | undefined;
    return { ...inputFromFile(f, raw), source: f, createdAt: null, model, old: null, stubRefusals, stubPatch, stubUsage };
  });
}

/**
 * The first line of the user prompt the port builds for this input, for the
 * goal-line check; null for the About you drafts, whose prompts carry no goal line.
 */
export function promptHead(call: StoredCall): string | null {
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

/**
 * A packet folder recorded in config.json, found again: as recorded, else at the
 * same place under this checkout's api folder (a run made from another checkout).
 */
export function inputsFolder(recorded: string): string | null {
  if (existsSync(recorded)) return recorded;
  const at = recorded.lastIndexOf(`${path.sep}api${path.sep}`);
  if (at < 0) return null;
  const local = path.resolve(here, "..", recorded.slice(at + 5));
  return existsSync(local) ? local : null;
}

/**
 * A configuration folder's inputs rebuilt from its config.json (the demo
 * snapshot, or the packet folder it recorded), in input-id order: the input
 * with id "01" is the first. Null when config.json is missing or unreadable, or
 * its packet folder cannot be found.
 */
export function configurationInputs(configDir: string): StoredCall[] | null {
  try {
    const config = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8")) as { inputs?: string };
    if (config.inputs === "demo snapshot") return storedDemoCalls();
    const folder = typeof config.inputs === "string" ? inputsFolder(config.inputs) : null;
    return folder ? folderCalls(folder) : null;
  } catch {
    return null;
  }
}
