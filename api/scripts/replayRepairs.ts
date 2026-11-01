/**
 * Candidate repairs for the replay analysis (scripts/replay-analysis.ts): what
 * a refused attempt sent, read back from its saved stream, and pure fixes that
 * could turn it into a reply Cadence's real validators accept. Nothing here
 * changes the app: the analysis measures how many refused replies each repair
 * would have rescued, so the ones that pay can later be lifted into the
 * validator (src/llm/schema.ts) as soft repairs.
 *
 * Every repair takes the tool input and a context and returns a new value and
 * the changes it made, in words; it never mutates its argument. A repair with
 * no changes returns its input as it came.
 */
import { withCanonicalStance } from "../src/llm/anthropic.js";
import { cutAtSentence, cutAtWord, MAX_SAFETY_CALLOUTS } from "../src/llm/safety.js";
import {
  MAX_ANALYSIS_LENGTH,
  MAX_BULLET_LENGTH,
  MAX_DOSSIER_BODY_LENGTH,
  MAX_DOSSIER_SUMMARY_BULLETS,
  MAX_READ_ANSWERS,
  MAX_READ_FLAGS,
  MAX_SETTINGS_PROPOSAL_BULLETS,
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  validateMidWeekChatReply,
  validateWeeklyReply,
  type SchemaResult,
} from "../src/llm/schema.js";
import type { ModelPacket } from "../src/packet/types.js";
import type { Operation } from "./replayInputs.js";

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---- Reading a saved attempt ---------------------------------------------------

/** The reply tool each operation is asked to call. */
export const TOOL_NAMES: Record<Operation, string> = {
  weekly_reply: "submit_weekly_reply",
  mid_week_chat: "submit_mid_week_chat_reply",
  dossier_v1: "submit_about_you",
  dossier_correction: "submit_about_you",
  dossier_audit: "submit_about_you",
};

/** Top-level fields that mark a JSON object as an attempt at the operation's reply. */
const REPLY_KEYS: Record<Operation, string[]> = {
  weekly_reply: ["headline", "analysis", "prescribedWeek"],
  mid_week_chat: ["body"],
  dossier_v1: ["proposedBody", "summaryBullets"],
  dossier_correction: ["proposedBody", "summaryBullets"],
  dossier_audit: ["proposedBody", "summaryBullets"],
};

export type ExtractedAttempt = {
  /** How the saved response was stored: the reassembled message, the raw event stream, or nothing usable. */
  format: "message" | "sse" | "none";
  /** The input of the reply tool the operation asked for; null when no such call came or it did not parse. */
  toolInput: unknown;
  /** Names of every tool the reply called. */
  toolNames: string[];
  /** The tool input's JSON when it did not parse, as sent. */
  unparsedToolJson: string | null;
  /**
   * A reply-shaped object sent some other way when the asked-for tool call is
   * missing: under another tool name, or as JSON in the text or thinking.
   */
  strayInput: { from: "other tool" | "text" | "thinking"; value: Json } | null;
  stopReason: string | null;
  thinkingChars: number;
  textChars: number;
};

type Block = Json & { type?: unknown };

/** The first balanced {...} in a text that parses to an object, or null. */
export function firstJsonObject(text: string): Json | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (isObj(parsed)) return parsed;
        } catch {
          // not JSON; try the next opening brace
        }
        break;
      }
    }
  }
  return null;
}

/**
 * Rebuilds a message from a raw Messages event stream: content blocks by
 * index, thinking and text deltas, and each tool_use block's input from its
 * input_json_delta partial_json (oMLX sends the whole input in one delta).
 * Tool inputs stay as their JSON text, in `partialJson`, for the caller to parse.
 */
export function messageFromSse(raw: string): { content: Block[]; stopReason: string | null; partialJson: Map<number, string> } | null {
  const content: Block[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | null = null;
  let sawEvent = false;
  for (const chunk of raw.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isObj(event)) continue;
    sawEvent = true;
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "content_block_start":
        if (index >= 0 && isObj(event.content_block)) {
          content[index] = { ...event.content_block };
          if (event.content_block.type === "tool_use") partialJson.set(index, "");
        }
        break;
      case "content_block_delta": {
        const block = content[index];
        const delta = event.delta;
        if (!block || !isObj(delta)) break;
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          partialJson.set(index, (partialJson.get(index) ?? "") + delta.partial_json);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
        }
        break;
      }
      case "message_delta":
        if (isObj(event.delta) && typeof event.delta.stop_reason === "string") stopReason = event.delta.stop_reason;
        break;
    }
  }
  return sawEvent ? { content: content.filter(Boolean), stopReason, partialJson } : null;
}

/**
 * What one saved attempt sent. The replay keeps `responseRaw` as the message
 * the adapter reassembled from the stream (a JSON string), or as the raw
 * event-stream text when no message could be built; both are read here.
 */
export function extractAttempt(raw: unknown, operation: Operation): ExtractedAttempt {
  const toolName = TOOL_NAMES[operation];
  const none: ExtractedAttempt = {
    format: "none",
    toolInput: null,
    toolNames: [],
    unparsedToolJson: null,
    strayInput: null,
    stopReason: null,
    thinkingChars: 0,
    textChars: 0,
  };
  let message: unknown = raw;
  if (typeof raw === "string") {
    try {
      message = JSON.parse(raw);
    } catch {
      message = null;
    }
  }
  let blocks: Block[];
  let stopReason: string | null;
  let format: ExtractedAttempt["format"];
  if (isObj(message) && Array.isArray(message.content)) {
    format = "message";
    blocks = message.content.filter(isObj);
    stopReason = typeof message.stop_reason === "string" ? message.stop_reason : null;
  } else if (typeof raw === "string") {
    const sse = messageFromSse(raw);
    if (!sse) return none;
    format = "sse";
    stopReason = sse.stopReason;
    blocks = sse.content.map((b, i) => {
      const partial = sse.partialJson.get(i);
      if (b.type !== "tool_use" || partial === undefined) return b;
      if (partial.trim() === "") return { ...b, input: {} };
      try {
        return { ...b, input: JSON.parse(partial) as unknown };
      } catch {
        return { ...b, input: { _unparsed_partial_json: partial } };
      }
    });
  } else {
    return none;
  }
  const tools = blocks.filter((b) => b.type === "tool_use");
  const asked = tools.find((b) => b.name === toolName);
  let toolInput: unknown = asked ? (asked.input ?? null) : null;
  let unparsedToolJson: string | null = null;
  if (isObj(toolInput) && typeof toolInput._unparsed_partial_json === "string") {
    unparsedToolJson = toolInput._unparsed_partial_json;
    toolInput = null;
  }
  const text = blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
  const thinking = blocks.flatMap((b) => (b.type === "thinking" && typeof b.thinking === "string" ? [b.thinking] : [])).join("\n");
  let strayInput: ExtractedAttempt["strayInput"] = null;
  if (!asked) {
    const looksLikeReply = (v: unknown): v is Json => isObj(v) && REPLY_KEYS[operation].some((k) => k in v);
    const other = tools.map((b) => b.input).find(looksLikeReply);
    const fromText = firstJsonObject(text);
    const fromThinking = firstJsonObject(thinking.slice(-60_000));
    if (other) strayInput = { from: "other tool", value: other };
    else if (looksLikeReply(fromText)) strayInput = { from: "text", value: fromText };
    else if (looksLikeReply(fromThinking)) strayInput = { from: "thinking", value: fromThinking };
  }
  return {
    format,
    toolInput,
    toolNames: tools.map((b) => String(b.name)),
    unparsedToolJson,
    strayInput,
    stopReason,
    thinkingChars: thinking.length,
    textChars: text.length,
  };
}

// ---- Validator errors --------------------------------------------------------------

/** Why an attempt was refused or failed, from its error text. */
export type ErrorKind = "schema" | "no tool call" | "max_tokens" | "model refusal" | "transport";

export type NormalisedError = {
  /** The field path with list indices as [n], such as prescribedWeek.days[n].run.type; "(response)" when none. */
  path: string;
  /** The rest of the message with dates and the path's indices normalised. */
  rule: string;
  /** A short name for the rule, for grouping. */
  ruleLabel: string;
  kind: ErrorKind;
};

const PATH_RE = /^([A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*)(\s.*)?$/;

/** The kind of a failure's error text. A schema refusal is anything the validators say. */
export function errorKind(error: string): ErrorKind {
  if (/max_tokens/.test(error)) return "max_tokens";
  if (/missing \S+ tool_use block|response must be a JSON object|missing content array/.test(error)) return "no tool call";
  if (/refused the request/.test(error)) return "model refusal";
  if (
    /not a valid event stream|stream error|stream ended|exceeded|abort|timed? ?out|HTTP|status \d|fetch failed|ECONN|terminated|socket|network|model server/i.test(
      error,
    )
  ) {
    return "transport";
  }
  return "schema";
}

function ruleLabelOf(rule: string): string {
  if (/must be (?:easy|rest)\|/.test(rule)) return "not in enum";
  if (/requires a run object/.test(rule)) return "missing run";
  if (/is rest but has a non-rest run/.test(rule)) return "run on a rest day";
  if (/ISO week id/.test(rule)) return "not an ISO week id";
  if (/must be YYYY-MM-DD|must be <date>|outside the plan week|duplicate date/.test(rule)) return "wrong date";
  if (/must be at most \d+ characters/.test(rule)) return "over length cap";
  if (/must have at most \d+ items|exactly 7 entries/.test(rule)) return "wrong count";
  if (/non-empty|is required/.test(rule)) return "missing or empty";
  if (/must be an? (?:array|string|object|number|boolean)|must be a number|must be a string/.test(rule)) return "wrong type";
  return "other";
}

/** An error message as a field path and a rule, indices and dates normalised. */
export function normaliseError(error: string): NormalisedError {
  const kind = errorKind(error);
  const dated = error.replace(/\d{4}-\d{2}-\d{2}/g, "<date>");
  if (kind !== "schema") {
    const rule = dated.replace(/submit_[a-z_]+/g, "<tool>").replace(/\d{4,}ms/g, "<n>ms");
    return { path: "(response)", rule, ruleLabel: kind, kind };
  }
  const m = PATH_RE.exec(dated);
  if (!m || !m[2]) return { path: "(reply)", rule: dated, ruleLabel: ruleLabelOf(dated), kind };
  const path = m[1]!.replace(/\[\d+\]/g, "[n]");
  const rule = m[2].trim();
  return { path, rule, ruleLabel: ruleLabelOf(rule), kind };
}

// ---- The real validators --------------------------------------------------------------

export type RepairContext = {
  operation: Operation;
  /** The Monday the operation's validator checks dates against: the plan week for a weekly read, the current week mid-week. */
  weekStartMonday: string | null;
  /** The plan week's ISO id for a weekly read; null when the packet does not say. */
  isoWeek: string | null;
  /** The athlete's distance unit, for a distance sent without one. */
  unit: "metric" | "imperial" | null;
  /** A reply-shaped object found outside the asked-for tool call (see ExtractedAttempt.strayInput). */
  strayInput?: Json | null;
};

/**
 * The athlete's distance unit for a packet: the one it carries, else the unit
 * its recap writes distances in (older packets, such as the demo snapshot's,
 * carry none). Null when neither says.
 */
export function athleteUnit(packet: Pick<ModelPacket, "coaching" | "recapMarkdown">): RepairContext["unit"] {
  const set = packet.coaching?.unitPreference;
  if (set) return set;
  const recap = packet.recapMarkdown ?? "";
  const mi = (recap.match(/\d\s?mi\b/g) ?? []).length;
  const km = (recap.match(/\d\s?km\b/g) ?? []).length;
  return mi || km ? (mi > km ? "imperial" : "metric") : null;
}

/**
 * Runs the operation's own validator from src/llm/schema.ts, as the adapter
 * does: the About you drafts also get the canonical stance line, and the body
 * must still fit afterwards (validateAboutYou in src/llm/anthropic.ts).
 */
export function validateFor(operation: Operation, input: unknown, ctx: Pick<RepairContext, "weekStartMonday">): SchemaResult<unknown> {
  switch (operation) {
    case "weekly_reply":
      return validateWeeklyReply(input, ctx.weekStartMonday ?? "");
    case "mid_week_chat":
      return validateMidWeekChatReply(input, ctx.weekStartMonday ?? undefined);
    default: {
      const validate =
        operation === "dossier_v1"
          ? validateDossierV1Draft
          : operation === "dossier_correction"
            ? validateDossierCorrectionDraft
            : validateDossierAuditDraft;
      const checked = validate(input);
      if (!checked.ok) return checked;
      const proposedBody = withCanonicalStance(checked.value.proposedBody);
      if (proposedBody.length > MAX_DOSSIER_BODY_LENGTH) {
        return { ok: false, error: `proposedBody must be at most ${MAX_DOSSIER_BODY_LENGTH} characters` };
      }
      return { ok: true, value: { ...checked.value, proposedBody } };
    }
  }
}

// ---- Helpers for the repairs --------------------------------------------------------------

export type RepairResult = { value: unknown; changes: string[] };
export type Repair = (input: unknown, ctx: RepairContext) => RepairResult;

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** A field that arrived as a string of JSON, parsed; the value as it came otherwise. */
function parsedIfJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return v;
  }
}

/**
 * The day objects a reply carries, with their paths: the weekly plan's days
 * (a plan sent as a string of JSON is read, as the validator reads it) and the
 * mid-week patches. Works on (and returns parts of) the clone it is given.
 */
function daysIn(root: Json): Array<{ day: Json; path: string }> {
  const out: Array<{ day: Json; path: string }> = [];
  const week = parsedIfJson(root.prescribedWeek);
  if (isObj(week)) {
    if (week !== root.prescribedWeek) root.prescribedWeek = week;
    if (Array.isArray(week.days)) week.days.forEach((d, i) => isObj(d) && out.push({ day: d, path: `prescribedWeek.days[${i}]` }));
  }
  if (Array.isArray(root.prescribedDayPatches)) {
    root.prescribedDayPatches.forEach((d, i) => isObj(d) && out.push({ day: d, path: `prescribedDayPatches[${i}]` }));
  }
  return out;
}

/** Runs `fix` on a clone of an object input; anything else is returned untouched. */
function onObject(input: unknown, fix: (root: Json, changes: string[]) => void): RepairResult {
  if (!isObj(input)) return { value: input, changes: [] };
  const root = clone(input);
  const changes: string[] = [];
  fix(root, changes);
  return changes.length ? { value: root, changes } : { value: input, changes };
}

const RUN_TYPES = ["easy", "quality", "long", "race", "other"] as const;
const DAY_TYPES = ["rest", ...RUN_TYPES] as const;

/**
 * Near-miss words for each day type, matched after lower-casing and squeezing
 * spaces, hyphens and underscores; also matched as the first words of a longer
 * label ("Easy 5 mi (5:00/mi)", "Tempo Run"). Longest first wins.
 */
export const ENUM_SYNONYMS: Record<(typeof DAY_TYPES)[number], string[]> = {
  rest: ["rest", "rest day", "off", "day off", "off day", "none", "recovery day", "travel", "travel day"],
  easy: [
    "easy",
    "easy run",
    "recovery",
    "recovery run",
    "shakeout",
    "shake out",
    "aerobic",
    "base",
    "steady",
    "steady easy",
    "general aerobic",
    "jog",
    // A return-to-running walk-run is a run day, prescribed by time.
    "walk run",
    "run walk",
  ],
  quality: [
    "quality",
    "tempo",
    "tempo run",
    "threshold",
    "threshold run",
    "lt",
    "interval",
    "intervals",
    "interval run",
    "workout",
    "speed",
    "speedwork",
    "speed work",
    "hills",
    "hill",
    "hill repeats",
    "hill sprints",
    "fartlek",
    "repeats",
    "marathon pace",
    "mp",
    "race pace",
    "progression",
    "progression run",
    "cruise intervals",
    "vo2",
    "vo2max",
    "quality session",
    "hard",
  ],
  long: ["long", "long run", "longrun", "long easy", "long steady", "medium long", "medium long run"],
  race: ["race", "race day", "parkrun", "time trial"],
  other: ["other", "cross", "cross training", "crosstraining", "cross train", "strength", "gym", "walk", "bike", "cycling", "swim", "yoga", "mobility", "xt"],
};

const SYNONYM_LIST: Array<[string, (typeof DAY_TYPES)[number]]> = Object.entries(ENUM_SYNONYMS)
  .flatMap(([type, words]) => words.map((w) => [w, type as (typeof DAY_TYPES)[number]] as [string, (typeof DAY_TYPES)[number]]))
  .sort((a, b) => b[0].length - a[0].length);

function squeeze(v: string): string {
  return v
    .toLowerCase()
    .replace(/[_\-‐‑–—/]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.!;:,]+$/, "")
    .trim();
}

/**
 * The day type a near-miss word stands for, or null: the whole value, else
 * its first words ("Easy 5 mi (5:00/mi)", "Rest/Active Recovery"). `allowRest`
 * false for run.type.
 */
export function mapEnumValue(raw: string, allowRest: boolean): (typeof DAY_TYPES)[number] | null {
  const v = squeeze(raw);
  if (!v) return null;
  for (const [word, type] of SYNONYM_LIST) {
    if (v === word || v.startsWith(`${word} `) || v.startsWith(`${word}(`) || v.startsWith(`${word},`) || v.startsWith(`${word}:`) || v.startsWith(`${word}.`)) {
      if (type === "rest" && !allowRest) continue;
      return type;
    }
  }
  return null;
}

const METERS_PER_MILE = 1609.344;

/**
 * Meters from a distance sent in another form: "5 mi", "8 km", "8000 m",
 * "8,047", or a bare number in the athlete's unit when under 100 (meters at or
 * over 100). `unitHint` names the unit a field's name gave ("km", "mi", "m").
 */
export function metersFrom(raw: unknown, unitHint: "km" | "mi" | "m" | null, athleteUnit: RepairContext["unit"]): number | null {
  let n: number;
  let unit: "km" | "mi" | "m" | null = unitHint;
  if (typeof raw === "number" && Number.isFinite(raw)) n = raw;
  else if (typeof raw === "string") {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*(km|kms|kilometers?|kilometres?|k|mi|miles?|m|meters?|metres?)?\b/i.exec(raw.replace(/(\d),(\d{3})\b/g, "$1$2"));
    if (!m) return null;
    n = Number(m[1]!.replace(",", "."));
    const u = m[2]?.toLowerCase();
    if (u) unit = u.startsWith("k") ? "km" : u.startsWith("mi") ? "mi" : "m";
  } else return null;
  if (n < 0) return null;
  if (!unit) unit = n >= 100 ? "m" : athleteUnit === "imperial" ? "mi" : "km";
  const meters = unit === "km" ? n * 1000 : unit === "mi" ? n * METERS_PER_MILE : n;
  return Math.round(meters);
}

/** Seconds from a duration sent in another form: "49m", "2h22m", "45 min", "1:05:00", or minutes as a number. */
export function secondsFrom(raw: unknown, unitHint: "min" | "s" | null): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(unitHint === "s" ? raw : raw * 60);
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] ? Number(clock[3]) : null];
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const hm = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?$/.exec(t);
  if (hm && (hm[1] || hm[2] || hm[3])) {
    const s = Number(hm[1] ?? 0) * 3600 + Number(hm[2] ?? 0) * 60 + Number(hm[3] ?? 0);
    return s > 0 ? Math.round(s) : null;
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(unitHint === "s" ? n : n * 60) : null;
}

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The ISO week id (YYYY-Www) of a YYYY-MM-DD date. */
export function isoWeekOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((date.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// ---- The candidate repairs --------------------------------------------------------------

/** (a) A run with no valid type takes its day's type, when that is a run type (rest needs no run). */
export function fillRunTypeFromDayType(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    for (const { day, path } of daysIn(root)) {
      const run = day.run;
      if (!isObj(run) || typeof run.type === "string") continue;
      const dayType = day.dayType;
      if (typeof dayType === "string" && (RUN_TYPES as readonly string[]).includes(dayType)) {
        run.type = dayType;
        changes.push(`${path}.run.type filled from dayType ${dayType}`);
      }
    }
  });
}

/** (b) A plan week id that is not YYYY-Www becomes the expected plan week, else the week of the first date, else of the Monday. */
export function normaliseWeekId(input: unknown, ctx: RepairContext): RepairResult {
  return onObject(input, (root, changes) => {
    const week = parsedIfJson(root.prescribedWeek);
    if (!isObj(week)) return;
    if (typeof week.week === "string" && /^\d{4}-W\d{2}$/.test(week.week)) return;
    const firstDate = Array.isArray(week.days) && isObj(week.days[0]) && typeof week.days[0].date === "string" ? week.days[0].date : null;
    const id =
      ctx.isoWeek ??
      (firstDate && /^\d{4}-\d{2}-\d{2}$/.test(firstDate) ? isoWeekOf(firstDate) : ctx.weekStartMonday ? isoWeekOf(ctx.weekStartMonday) : null);
    if (!id) return;
    changes.push(`prescribedWeek.week ${JSON.stringify(week.week ?? null)} -> ${id}`);
    week.week = id;
    root.prescribedWeek = week;
  });
}

/** (c) dayType and run.type near-misses mapped to the enum: case, spaces, synonyms (ENUM_SYNONYMS). */
export function mapEnumNearMisses(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    for (const { day, path } of daysIn(root)) {
      if (typeof day.dayType === "string" && !(DAY_TYPES as readonly string[]).includes(day.dayType)) {
        const mapped = mapEnumValue(day.dayType, true);
        if (mapped) {
          changes.push(`${path}.dayType ${JSON.stringify(day.dayType)} -> ${mapped}`);
          day.dayType = mapped;
        }
      }
      const run = day.run;
      if (isObj(run) && typeof run.type === "string" && !(RUN_TYPES as readonly string[]).includes(run.type)) {
        const mapped = mapEnumValue(run.type, false);
        if (mapped && mapped !== "rest") {
          changes.push(`${path}.run.type ${JSON.stringify(run.type)} -> ${mapped}`);
          run.type = mapped;
        }
      }
    }
  });
}

/** Splits a text block into list items: one per line, bullet marks and numbering removed. */
export function splitIntoItems(text: string): string[] {
  return text
    .split(/\r?\n|(?:^|\s)[•▪◦]\s+/)
    .map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

/** (d) A string where an array of strings is required becomes a list: split on lines and bullets, else one item. */
export function coerceStringArrays(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    for (const key of ["settingsProposalBullets", "summaryBullets"]) {
      const v = root[key];
      if (typeof v !== "string") continue;
      const parsed = parsedIfJson(v);
      const items = Array.isArray(parsed) ? parsed : v.trim() ? splitIntoItems(v) : [];
      root[key] = items;
      changes.push(`${key} string -> ${items.length}-item array`);
    }
  });
}

/** (e) Flags and answers missing a non-empty title/detail or question/answer are dropped, and empty bullets. Lossy. */
export function dropEmptyEntries(input: unknown): RepairResult {
  const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return onObject(input, (root, changes) => {
    const keep: Array<[string, (x: unknown) => boolean]> = [
      ["flags", (x) => isObj(x) && filled(x.title) && filled(x.detail)],
      ["answers", (x) => isObj(x) && filled(x.question) && filled(x.answer)],
      ["settingsProposalBullets", filled],
      ["summaryBullets", filled],
    ];
    for (const [key, ok] of keep) {
      const list = root[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter(ok);
      if (kept.length === list.length) continue;
      root[key] = kept;
      changes.push(`${key}: dropped ${list.length - kept.length} of ${list.length} entries`);
    }
  });
}

/** (f) Fields past a hard cap that refuses (not one the validator already cuts) are cut, and lists past their count. */
export function trimOverCaps(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    const cutText = (key: string, max: number, at: (t: string, n: number) => string) => {
      const v = root[key];
      if (typeof v === "string" && v.length > max) {
        root[key] = at(v.trim(), max);
        changes.push(`${key} cut from ${v.length} to ${(root[key] as string).length} chars`);
      }
    };
    cutText("analysis", MAX_ANALYSIS_LENGTH, cutAtSentence);
    cutText("body", MAX_ANALYSIS_LENGTH, cutAtSentence);
    // The stance line is added after the check, so leave room for it.
    const stanceRoom = withCanonicalStance("").length;
    cutText("proposedBody", MAX_DOSSIER_BODY_LENGTH - stanceRoom - 2, cutAtSentence);
    for (const key of ["settingsProposalBullets", "summaryBullets"]) {
      const list = root[key];
      if (!Array.isArray(list)) continue;
      list.forEach((b, i) => {
        if (typeof b === "string" && b.length > MAX_BULLET_LENGTH) {
          list[i] = cutAtWord(b.trim(), MAX_BULLET_LENGTH);
          changes.push(`${key}[${i}] cut from ${b.length} chars`);
        }
      });
    }
    const counts: Array<[string, number]> = [
      ["flags", MAX_READ_FLAGS],
      ["answers", MAX_READ_ANSWERS],
      ["settingsProposalBullets", MAX_SETTINGS_PROPOSAL_BULLETS],
      ["summaryBullets", MAX_DOSSIER_SUMMARY_BULLETS],
      ["safetyCallouts", MAX_SAFETY_CALLOUTS],
    ];
    for (const [key, max] of counts) {
      const list = root[key];
      if (Array.isArray(list) && list.length > max) {
        root[key] = list.slice(0, max);
        changes.push(`${key} cut from ${list.length} to ${max} items`);
      }
    }
  });
}

/** Run field names seen in place of the schema's, with the unit their name gives. */
const RUN_DISTANCE_ALIASES: Array<[string, "km" | "mi" | "m" | null]> = [
  ["distance", null],
  ["distance_m", "m"],
  ["distanceMeters", "m"],
  ["meters", "m"],
  ["distanceKm", "km"],
  ["distance_km", "km"],
  ["km", "km"],
  ["kilometers", "km"],
  ["distanceMi", "mi"],
  ["distanceMiles", "mi"],
  ["distance_mi", "mi"],
  ["miles", "mi"],
  ["mi", "mi"],
];
const RUN_DURATION_ALIASES: Array<[string, "min" | "s" | null]> = [
  ["duration", null],
  ["durationMin", "min"],
  ["durationMinutes", "min"],
  ["duration_min", "min"],
  ["minutes", "min"],
  ["time", null],
  ["duration_s", "s"],
  ["durationSec", "s"],
  ["durationSeconds", "s"],
];
const RUN_PACE_ALIASES = ["pace", "pacePerKm", "pacePerMile", "paceMinPerKm", "paceMinPerMile", "targetPace", "target_pace", "hr", "heartRate", "effort", "intensity", "pace_or_hr", "paceOrHR"];
const RUN_STRUCTURE_ALIASES = ["description", "details", "workout", "session", "summary", "name", "title", "structure_text"];

/**
 * (g) Run fields sent under other names: distance (in the athlete's unit when
 * bare, or with a unit), distanceKm, miles and the like -> distanceM;
 * duration "49m", durationMin -> durationS; pace, pacePerKm, hr -> paceOrHr;
 * description, details -> structure; a distanceM sent as text -> a number.
 * Fields the schema does not know are then left for the validator, which ignores them.
 */
export function mapRunFieldAliases(input: unknown, ctx: RepairContext): RepairResult {
  return onObject(input, (root, changes) => {
    for (const { day, path } of daysIn(root)) {
      const run = day.run;
      if (!isObj(run)) continue;
      if (typeof run.distanceM === "string") {
        const m = metersFrom(run.distanceM, null, ctx.unit);
        if (m !== null) {
          changes.push(`${path}.run.distanceM ${JSON.stringify(run.distanceM)} -> ${m}`);
          run.distanceM = m;
        }
      }
      if (run.distanceM === undefined || run.distanceM === null) {
        for (const [key, unit] of RUN_DISTANCE_ALIASES) {
          if (run[key] === undefined || run[key] === null) continue;
          const m = metersFrom(run[key], unit, ctx.unit);
          if (m === null) continue;
          changes.push(`${path}.run.${key} ${JSON.stringify(run[key])} -> distanceM ${m}`);
          run.distanceM = m;
          delete run[key];
          break;
        }
      }
      if (typeof run.durationS === "string") {
        const s = secondsFrom(run.durationS, "s");
        if (s !== null) {
          changes.push(`${path}.run.durationS ${JSON.stringify(run.durationS)} -> ${s}`);
          run.durationS = s;
        }
      }
      if (run.durationS === undefined || run.durationS === null) {
        for (const [key, unit] of RUN_DURATION_ALIASES) {
          if (run[key] === undefined || run[key] === null) continue;
          const s = secondsFrom(run[key], unit);
          if (s === null) continue;
          changes.push(`${path}.run.${key} ${JSON.stringify(run[key])} -> durationS ${s}`);
          run.durationS = s;
          delete run[key];
          break;
        }
      }
      if (run.paceOrHr === undefined || run.paceOrHr === null) {
        const key = RUN_PACE_ALIASES.find((k) => run[k] !== undefined && run[k] !== null && run[k] !== "");
        if (key) {
          run.paceOrHr = String(run[key]);
          delete run[key];
          changes.push(`${path}.run.${key} -> paceOrHr`);
        }
      }
      if (run.structure === undefined || run.structure === null) {
        const key = RUN_STRUCTURE_ALIASES.find((k) => typeof run[k] === "string" && (run[k] as string).trim());
        if (key) {
          run.structure = run[key];
          delete run[key];
          changes.push(`${path}.run.${key} -> structure`);
        }
      }
      // A run with a duration but no distance is a time-only run, stored as distance 0 by the validator.
    }
  });
}

const DAY_TYPE_ALIASES = ["type", "day_type", "daytype", "DayType", "session", "sessionType", "session_type", "name", "activity", "workout", "kind", "category", "label"];
const DAY_NOTES_ALIASES = ["note", "reason", "why", "description", "details", "comment", "rationale", "purpose"];

/**
 * (g) Day fields sent under other names: session, name, activity, workout or
 * type -> dayType (the value as sent; mapEnumNearMisses maps it); note, reason,
 * description -> notes; a run's fields sent on the day itself (distance,
 * duration, pace) -> a run object.
 */
export function mapDayFieldAliases(input: unknown, ctx: RepairContext): RepairResult {
  return onObject(input, (root, changes) => {
    for (const { day, path } of daysIn(root)) {
      if (day.dayType === undefined || day.dayType === null) {
        const key = DAY_TYPE_ALIASES.find((k) => typeof day[k] === "string" && (day[k] as string).trim());
        if (key) {
          day.dayType = day[key];
          changes.push(`${path}.${key} ${JSON.stringify(day[key])} -> dayType`);
          delete day[key];
        }
      }
      if (day.notes === undefined || day.notes === null) {
        const key = DAY_NOTES_ALIASES.find((k) => typeof day[k] === "string" && (day[k] as string).trim());
        if (key) {
          day.notes = day[key];
          delete day[key];
          changes.push(`${path}.${key} -> notes`);
        }
      }
      if (day.run === undefined || day.run === null) {
        let distanceM: number | null = null;
        let distanceKey: string | null = null;
        for (const [key, unit] of RUN_DISTANCE_ALIASES.concat([["distanceM", "m"]])) {
          if (day[key] === undefined || day[key] === null) continue;
          distanceM = metersFrom(day[key], unit, ctx.unit);
          if (distanceM !== null) {
            distanceKey = key;
            break;
          }
        }
        let durationS: number | null = null;
        let durationKey: string | null = null;
        for (const [key, unit] of RUN_DURATION_ALIASES.concat([["durationS", "s"]])) {
          if (day[key] === undefined || day[key] === null) continue;
          durationS = secondsFrom(day[key], unit);
          if (durationS !== null) {
            durationKey = key;
            break;
          }
        }
        if ((distanceM !== null && distanceM > 0) || (durationS !== null && durationS > 0)) {
          const run: Json = { distanceM: distanceM ?? 0 };
          if (durationS) run.durationS = durationS;
          const pace = RUN_PACE_ALIASES.find((k) => typeof day[k] === "string");
          if (pace) {
            run.paceOrHr = day[pace];
            delete day[pace];
          }
          if (distanceKey) delete day[distanceKey];
          if (durationKey) delete day[durationKey];
          day.run = run;
          changes.push(`${path}: run built from the day's ${[distanceKey, durationKey].filter(Boolean).join(" and ")}`);
        }
      }
    }
  });
}

/** (g) A day with no dayType takes its run's type (a day with no run is left as it came). */
export function fillDayTypeFromRun(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    for (const { day, path } of daysIn(root)) {
      if (day.dayType !== undefined && day.dayType !== null && day.dayType !== "") continue;
      const run = day.run;
      const runType = isObj(run) && typeof run.type === "string" ? run.type : null;
      const mapped = runType ? ((RUN_TYPES as readonly string[]).includes(runType) ? runType : mapEnumValue(runType, false)) : null;
      // A day with no run is left alone: calling it rest would invent a rest day
      // where the model may have written its session into the notes.
      if (mapped) {
        day.dayType = mapped;
        changes.push(`${path}.dayType filled from run.type ${runType}`);
      }
    }
  });
}

/** (g) Optional fields sent as null, which the validator refuses (it accepts them absent), are removed. */
export function dropNullOptionals(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    for (const key of ["settingsProposalBullets", "safetyCallouts", "prescribedDayPatches", "allowPastDayPatches"]) {
      if (key in root && root[key] === null) {
        delete root[key];
        changes.push(`${key} null removed`);
      }
    }
    for (const { day, path } of daysIn(root)) {
      const run = day.run;
      if (isObj(run) && run.durationS === 0) {
        run.durationS = null;
        changes.push(`${path}.run.durationS 0 -> null`);
      }
    }
  });
}

/** (g) Fields sent as a string of JSON (flags, answers, callouts, patches, bullets, days) are parsed. */
export function parseStringifiedFields(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    for (const key of ["flags", "answers", "safetyCallouts", "prescribedDayPatches", "settingsProposalBullets", "summaryBullets"]) {
      const v = root[key];
      if (typeof v !== "string") continue;
      const parsed = parsedIfJson(v);
      if (Array.isArray(parsed)) {
        root[key] = parsed;
        changes.push(`${key} parsed from a string of JSON`);
      }
    }
    const week = parsedIfJson(root.prescribedWeek);
    if (isObj(week) && typeof week.days === "string") {
      const days = parsedIfJson(week.days);
      if (Array.isArray(days)) {
        week.days = days;
        root.prescribedWeek = week;
        changes.push("prescribedWeek.days parsed from a string of JSON");
      }
    }
    for (const { day, path } of daysIn(root)) {
      if (typeof day.run === "string") {
        const run = parsedIfJson(day.run);
        if (isObj(run)) {
          day.run = run;
          changes.push(`${path}.run parsed from a string of JSON`);
        }
      }
    }
  });
}

/**
 * (g) Flags sent as plain strings become {title, detail}: split at the first
 * " – ", " - ", ": " or " — " within the title cap; a string with none is left
 * (dropEmptyEntries drops it). Answers sent as plain strings cannot be fixed
 * the same way: the athlete's question is not in the reply.
 */
export function splitFlagStrings(input: unknown): RepairResult {
  return onObject(input, (root, changes) => {
    const flags = root.flags;
    if (!Array.isArray(flags)) return;
    flags.forEach((f, i) => {
      if (typeof f !== "string") return;
      const m = /^(.{2,80}?)\s*(?:\s[–—-]\s|:\s)\s*(.+)$/s.exec(f.trim());
      if (!m) return;
      flags[i] = { title: m[1]!.trim(), detail: m[2]!.trim() };
      changes.push(`flags[${i}] string split into title and detail`);
    });
  });
}

/** (g) With no call to the asked-for tool, a reply-shaped object sent under another tool name or as JSON text is used. */
export function useStrayToolInput(input: unknown, ctx: RepairContext): RepairResult {
  if (input !== null && input !== undefined) return { value: input, changes: [] };
  if (!ctx.strayInput) return { value: input, changes: [] };
  return { value: clone(ctx.strayInput), changes: ["reply taken from outside the tool call"] };
}

/**
 * (g) A plan whose seven dates are the wrong week (or wrong days) gets the
 * expected dates in order. Only for seven days whose own dates are seven
 * consecutive days, or all missing: a plan shifted by a week, not a muddle.
 */
export function realignPlanDates(input: unknown, ctx: RepairContext): RepairResult {
  return onObject(input, (root, changes) => {
    if (!ctx.weekStartMonday || ctx.operation !== "weekly_reply") return;
    const week = parsedIfJson(root.prescribedWeek);
    if (!isObj(week) || !Array.isArray(week.days) || week.days.length !== 7) return;
    const days = week.days as unknown[];
    if (!days.every(isObj)) return;
    const dates = (days as Json[]).map((d) => (typeof d.date === "string" ? d.date : null));
    const expected = Array.from({ length: 7 }, (_, i) => addDaysYmd(ctx.weekStartMonday!, i));
    if (dates.every((d, i) => d === expected[i])) return;
    const consecutive = dates.every((d, i) => d && /^\d{4}-\d{2}-\d{2}/.test(d) && (i === 0 || d.slice(0, 10) === addDaysYmd(dates[0]!.slice(0, 10), i)));
    const allMissing = dates.every((d) => d === null);
    if (!consecutive && !allMissing) return;
    (days as Json[]).forEach((d, i) => (d.date = expected[i]));
    root.prescribedWeek = week;
    changes.push(`prescribedWeek dates ${dates[0] ?? "missing"}.. -> ${expected[0]}..`);
  });
}

export type CandidateRepair = {
  id: string;
  /** The letter from the brief, (a) to (g). */
  letter: string;
  label: string;
  /** Whether it can lose what the model wrote (an entry dropped, text cut). */
  lossy: boolean;
  /** Where it would live if lifted into the app. */
  liftTo: string;
  apply: Repair;
};

/** Every candidate, in a stable order; the analysis measures each alone and cumulatively. */
export const CANDIDATE_REPAIRS: CandidateRepair[] = [
  { id: "fillRunTypeFromDayType", letter: "a", label: "fill a missing run.type from the day's dayType", lossy: false, liftTo: "parseRun/parseDay", apply: fillRunTypeFromDayType },
  { id: "normaliseWeekId", letter: "b", label: "normalise the plan's ISO week id from the plan week", lossy: false, liftTo: "validatePrescribedWeek", apply: normaliseWeekId },
  { id: "mapEnumNearMisses", letter: "c", label: "map near-miss dayType/run.type values to the enum", lossy: false, liftTo: "parseDay/parseRun", apply: (i) => mapEnumNearMisses(i) },
  { id: "coerceStringArrays", letter: "d", label: "coerce a string to an array of strings", lossy: false, liftTo: "parseSettingsProposalBullets, validateDossierSoftGateDraft", apply: (i) => coerceStringArrays(i) },
  { id: "dropEmptyEntries", letter: "e", label: "drop flags/answers entries with an empty field", lossy: true, liftTo: "parseReadFlags/parseReadAnswers", apply: (i) => dropEmptyEntries(i) },
  { id: "trimOverCaps", letter: "f", label: "trim fields and lists over hard caps", lossy: true, liftTo: "validateWeeklyReply, validateMidWeekChatReply, dossier drafts", apply: (i) => trimOverCaps(i) },
  { id: "mapRunFieldAliases", letter: "g", label: "map run field aliases (distance, distanceKm, pace, description, duration) to the schema's", lossy: false, liftTo: "parseRun", apply: mapRunFieldAliases },
  { id: "mapDayFieldAliases", letter: "g", label: "map day field aliases (session, name, activity, note, reason, a distance on the day) to the schema's", lossy: false, liftTo: "parseDay", apply: mapDayFieldAliases },
  { id: "fillDayTypeFromRun", letter: "g", label: "fill a missing dayType from run.type", lossy: false, liftTo: "parseDay", apply: (i) => fillDayTypeFromRun(i) },
  { id: "dropNullOptionals", letter: "g", label: "remove optional fields sent as null", lossy: false, liftTo: "validateWeeklyReply, validateMidWeekChatReply", apply: (i) => dropNullOptionals(i) },
  { id: "parseStringifiedFields", letter: "g", label: "parse fields sent as a string of JSON", lossy: false, liftTo: "validateWeeklyReply, validateMidWeekChatReply", apply: (i) => parseStringifiedFields(i) },
  { id: "splitFlagStrings", letter: "g", label: "split flags sent as strings into title and detail", lossy: false, liftTo: "parseReadFlags", apply: (i) => splitFlagStrings(i) },
  { id: "useStrayToolInput", letter: "g", label: "take a reply sent outside the tool call (other tool name, JSON in text)", lossy: false, liftTo: "extractToolInput (src/llm/anthropic.ts)", apply: useStrayToolInput },
  { id: "realignPlanDates", letter: "g", label: "realign a plan's seven consecutive dates to the plan week", lossy: false, liftTo: "validatePrescribedWeek", apply: realignPlanDates },
];

/**
 * The order the repairs run in when combined: shape first (a reply from outside
 * the tool call, strings of JSON, field names), then values, then dropping and
 * cutting. Each repair is pure, so the order only matters for what one repair
 * leaves for the next.
 */
export const PIPELINE_ORDER = [
  "useStrayToolInput",
  "parseStringifiedFields",
  "dropNullOptionals",
  "mapDayFieldAliases",
  "mapRunFieldAliases",
  "mapEnumNearMisses",
  "fillDayTypeFromRun",
  "fillRunTypeFromDayType",
  "normaliseWeekId",
  "realignPlanDates",
  "coerceStringArrays",
  "splitFlagStrings",
  "dropEmptyEntries",
  "trimOverCaps",
];

/** Applies a set of repairs (in PIPELINE_ORDER) and runs the real validator. */
export function tryRepairs(
  input: unknown,
  ctx: RepairContext,
  repairIds: Iterable<string>,
): { result: SchemaResult<unknown>; changes: string[]; value: unknown } {
  const chosen = new Set(repairIds);
  let value = input;
  const changes: string[] = [];
  for (const id of PIPELINE_ORDER) {
    if (!chosen.has(id)) continue;
    const repair = CANDIDATE_REPAIRS.find((r) => r.id === id)!;
    const out = repair.apply(value, ctx);
    value = out.value;
    changes.push(...out.changes);
  }
  return { result: validateFor(ctx.operation, value, ctx), changes, value };
}
