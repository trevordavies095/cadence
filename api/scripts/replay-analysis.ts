/**
 * An analysis of the replay benchmark's results (scripts/replay-weekly-reads.ts),
 * for tuning the coaching harness (tool schema, the validator's soft repairs,
 * the retry) until local models send valid, good replies. Makes no calls and
 * never writes into the roots it reads; runs in progress are read as they are.
 *
 *   cd api
 *   npm run replay:analyse -- \
 *     --roots ../.scratch/benchmark/snapshot,../.scratch/benchmark/seasons \
 *     --out ../.scratch/benchmark-analysis
 *
 * --roots: comma-separated output roots, each holding configuration folders
 * (<provider>--<model>--<effort>, with a config.json); default the two above.
 * --out: where analysis.md, analysis.json and replies.csv go; default
 * ../.scratch/benchmark-analysis. It may not sit inside a root.
 * --baseline: the configuration the plans are compared against; default
 * anthropic--claude-opus-4-7--xhigh.
 * --judge: one judge configuration's folder of saved scores (coaching-quality
 * ticket 09, `<judge>/<root>/<configuration>/<NN>.<R>.json`); adds section 9,
 * Coaching (scripts/replayCoaching.ts). Without it the analysis is unchanged.
 * --answer-key: the coach's answers (ticket 08); default
 * .scratch/benchmark-coaching/coach-packet/returned/answer-key.json (private: the reviewers' answers are never committed); absent, section 9 has no coach columns.
 *
 * Per configuration and operation it reports schema outcomes and failure
 * causes; every validator error of every refused attempt, by field path and
 * rule; what the retry did; a rescue simulation that reads each refused
 * attempt's tool input back from its saved stream, applies the candidate
 * repairs in scripts/replayRepairs.ts and re-runs the real validators from
 * src/llm/schema.ts (runs on the old nested forms only: on the plan-as-text
 * form the parser is the repair); quality signals on valid replies; each
 * weekly plan next to the baseline's for the same input, an unparsed day
 * counted as no plan; which inputs fail where; and cost and speed. Section 1
 * also reports the plan lines (scripts/replayPlanLines.ts): structured days of
 * seven per configuration, unparsed days, bare numbers, dropped lines, days
 * fixed by the retry, and the failures by the parser's reasons, and the plan
 * rules tripped (scripts/replayPlanRules.ts): per configuration, the weekly
 * reads whose plan the app's own plan check would warn on, by rule. The top of analysis.md ranks what to change in the harness from those
 * numbers. replies.csv has one row per reply attempt.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TrainingGoal } from "../src/goal/types.js";
import { resolvePlanWeekStartMonday, resolveWeeklyPlanWeek } from "../src/llm/stub.js";
import { recentWeeklyDistanceM } from "../src/packet/recentTraining.js";
import type { WeeklyReply } from "../src/llm/types.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import { comparePlans, pearson, planSummary, readTextOf, spread, weeklyShape, type PlanComparison, type Spread } from "./replayAnalysisStats.js";
import { replayCheckFailures } from "./replayChecks.js";
import { configurationInputs, OPERATIONS, promptHead, type Operation, type StoredCall } from "./replayInputs.js";
import { attemptCostUsd, capHitsOf, planSanity, repairsOf, type PlanExpectation, type Usage } from "./replayMeasures.js";
import { carriesPlanLines, PLAN_LINE_FAILURE_REASONS, planLineSummary, type PlanLineSummary } from "./replayPlanLines.js";
import { PLAN_RULES, planRuleSummary, type PlanRuleSummary } from "./replayPlanRules.js";
import { coachingHarnessItem, coachingMarkdown, coachingSection, readAnswerKey, readJudgeDir } from "./replayCoaching.js";
import {
  CANDIDATE_REPAIRS,
  athleteUnit,
  extractAttempt,
  mapEnumValue,
  normaliseError,
  tryRepairs,
  validateFor,
  type ErrorKind,
  type ExtractedAttempt,
  type NormalisedError,
  type RepairContext,
} from "./replayRepairs.js";

// ---- Flags ----------------------------------------------------------------------------

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

const ROOTS = (flagValue("--roots") ?? "../.scratch/benchmark/snapshot,../.scratch/benchmark/seasons")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => path.resolve(r));
const OUT = path.resolve(flagValue("--out") ?? "../.scratch/benchmark-analysis");
const BASELINE = flagValue("--baseline") ?? "anthropic--claude-opus-4-7--xhigh";
const JUDGE = flagValue("--judge") ? path.resolve(flagValue("--judge")!) : null;
const ANSWER_KEY = path.resolve(flagValue("--answer-key") ?? fileURLToPath(new URL("../../.scratch/benchmark-coaching/coach-packet/returned/answer-key.json", import.meta.url)));

// ---- Reading the roots ------------------------------------------------------------------

type ConfigFile = {
  configuration?: string;
  provider?: string;
  model?: string;
  effort?: string;
  repeats?: number;
  note?: string | null;
  inputs?: string;
  startedAt?: string;
  harnessCommit?: string;
};

type Refusal = {
  attempt: number;
  error: string;
  stopReason: string | null;
  outputTokens: number | null;
  inputTokens?: number | null;
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  responseRaw: unknown;
};

/** One attempt's timing; live runs since plan-as-text ticket 08 add how its request was built, its row's outcome, repairs and tokens. */
type AttemptTiming = {
  attempt: number;
  ttftMs: number | null;
  totalMs: number;
  request?: { kind: string; turns?: string[]; fixDates?: string[]; fixed?: string[] };
  outcome?: string | null;
  repairs?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

type Timing = { ttftMs: number | null; totalMs: number; attempts: AttemptTiming[] };

/** A reply file or a failure file, with the fields both may hold. */
type SavedReply = {
  operation?: Operation;
  source?: string;
  model?: string | null;
  goal?: TrainingGoal | null;
  promptHead?: string | null;
  error?: string;
  outcome?: string | null;
  repairs?: string | null;
  stopReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  thinkingChars?: number | null;
  timing?: Timing;
  planCheck?: PlanExpectation | null;
  refusedAttempts?: Refusal[];
  /** The plan-lines summary the replay saves since plan-as-text ticket 11; derived when missing. */
  plan?: PlanLineSummary | null;
  /** The plan rules summary the replay saves since coaching-quality ticket 02; the analysis recomputes it from the input's packet when it has one. */
  rules?: PlanRuleSummary | null;
  new?: unknown;
};

type ReplyOutcome = "first try" | "after retry" | "failed";
/** Why a failed reply failed: its last attempt's cause. */
type FailCause = "schema refusal" | "http/transport/timeout" | "no tool call" | "max_tokens" | "model refusal";

const FAIL_CAUSES: FailCause[] = ["schema refusal", "http/transport/timeout", "no tool call", "max_tokens", "model refusal"];

function causeOf(kind: ErrorKind): FailCause {
  return kind === "schema" ? "schema refusal" : kind === "transport" ? "http/transport/timeout" : kind;
}

type Attempt = {
  attempt: number;
  outcome: "accepted" | "refused" | "failed";
  /** How the attempt's request was built (live runs since plan-as-text ticket 08), e.g. "first", "fix_lines". */
  requestKind: string | null;
  error: string | null;
  normalised: NormalisedError | null;
  stopReason: string | null;
  usage: Usage;
  thinkingChars: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  costUsd: number | null;
  /** Refused attempts only: what the saved stream holds. */
  extracted: ExtractedAttempt | null;
  /** Refused attempts: whether the real validator, re-run on the extracted input, gives the recorded error. */
  reproduced: boolean | null;
  rescuedAlone: string[];
  rescuedByAll: boolean | null;
  remainingError: string | null;
};

type Reply = {
  root: string;
  configuration: string;
  provider: string;
  model: string;
  inputId: string;
  repeat: number;
  key: string;
  operation: Operation;
  call: StoredCall | null;
  saved: SavedReply;
  outcome: ReplyOutcome;
  failCause: FailCause | null;
  attempts: Attempt[];
  ctx: RepairContext | null;
  /** Whether this reply's run (its configuration folder in its root) carries the plan-as-text form. */
  newForm: boolean;
  /** What the plan lines came to (scripts/replayPlanLines.ts); null for About you and refused replies. */
  planLines: PlanLineSummary | null;
  /** The plan rules the plan tripped (scripts/replayPlanRules.ts); null for other operations, refused replies and inputs with no packet. */
  planRules: PlanRuleSummary | null;
};

const warnings: string[] = [];

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    warnings.push(`${file}: unreadable (${err instanceof Error ? err.message : err}); skipped, perhaps still being written`);
    return null;
  }
}

function usageOf(s: { inputTokens?: number | null; outputTokens?: number | null; thinkingTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null }): Usage {
  return {
    inputTokens: s.inputTokens ?? null,
    outputTokens: s.outputTokens ?? null,
    thinkingTokens: s.thinkingTokens ?? null,
    cacheReadTokens: s.cacheReadTokens ?? null,
    cacheCreationTokens: s.cacheCreationTokens ?? null,
  };
}

function contextFor(operation: Operation, call: StoredCall | null, saved: SavedReply): RepairContext | null {
  if (call && "packet" in call) {
    const unit = athleteUnit(call.packet);
    if (operation === "weekly_reply") {
      const { weekStartMonday, isoWeek } = resolveWeeklyPlanWeek(call.packet);
      return { operation, weekStartMonday, isoWeek, unit };
    }
    return { operation, weekStartMonday: resolvePlanWeekStartMonday(call.packet), isoWeek: null, unit };
  }
  if (call) return { operation, weekStartMonday: null, isoWeek: null, unit: null };
  // No inputs to read: an accepted weekly reply saved what its plan was checked against.
  if (operation === "weekly_reply" && saved.planCheck) {
    return { operation, weekStartMonday: saved.planCheck.weekStartMonday, isoWeek: saved.planCheck.isoWeek, unit: null };
  }
  if (operation !== "weekly_reply" && operation !== "mid_week_chat") return { operation, weekStartMonday: null, isoWeek: null, unit: null };
  return null;
}

const inputCache = new Map<string, StoredCall[] | null>();

function inputsFor(dir: string, config: ConfigFile): StoredCall[] | null {
  const key = config.inputs ?? dir;
  if (!inputCache.has(key)) inputCache.set(key, configurationInputs(dir));
  const calls = inputCache.get(key)!;
  if (!calls) warnings.push(`${dir}: inputs ${config.inputs ?? "(none recorded)"} could not be read; failed weekly and mid-week replies cannot be re-validated`);
  return calls;
}

function loadReplies(): { replies: Reply[]; configs: Map<string, { config: ConfigFile; dirs: string[]; measures: Array<{ root: string; m: Record<string, unknown> | null; files: number }> }> } {
  const replies: Reply[] = [];
  const configs = new Map<string, { config: ConfigFile; dirs: string[]; measures: Array<{ root: string; m: Record<string, unknown> | null; files: number }> }>();
  for (const root of ROOTS) {
    if (!existsSync(root)) {
      warnings.push(`${root}: missing root; skipped`);
      continue;
    }
    const rootName = path.basename(root);
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(root, entry.name);
      if (!entry.isDirectory() || !existsSync(path.join(dir, "config.json"))) continue;
      const config = (readJson(path.join(dir, "config.json")) ?? {}) as ConfigFile;
      const configuration = entry.name;
      const calls = inputsFor(dir, config);
      const files = readdirSync(dir);
      const stems = new Map<string, { ok?: string; failed?: string }>();
      for (const f of files) {
        const m = /^(\d+)\.(\d+)(\.failed)?\.json$/.exec(f);
        if (!m) continue;
        const stem = `${m[1]}.${m[2]}`;
        const e = stems.get(stem) ?? {};
        if (m[3]) e.failed = f;
        else e.ok = f;
        stems.set(stem, e);
      }
      const measuresFile = path.join(dir, "measures.json");
      const measures = existsSync(measuresFile) ? (readJson(measuresFile) as Record<string, unknown> | null) : null;
      const entryConfig = configs.get(configuration) ?? { config, dirs: [], measures: [] };
      entryConfig.dirs.push(dir);
      entryConfig.measures.push({ root: rootName, m: measures, files: stems.size });
      configs.set(configuration, entryConfig);
      const read = [...stems]
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .flatMap(([stem, e]) => {
          // A reply file wins over a failure file for the same stem, as the replay report reads them.
          const file = e.ok ?? e.failed!;
          const saved = readJson(path.join(dir, file)) as SavedReply | null;
          return saved ? [{ stem, e, file, saved }] : [];
        });
      const newForm = read.some(({ stem, saved }) => savedCarriesPlanLines(saved, saved.operation ?? calls?.[Number(stem.split(".")[0]) - 1]?.operation ?? "weekly_reply"));
      for (const { stem, e, file, saved } of read) {
        const [inputId, repeatText] = stem.split(".") as [string, string];
        const call = calls?.[Number(inputId) - 1] ?? null;
        const operation = saved.operation ?? call?.operation ?? "weekly_reply";
        if (call && call.operation !== operation) {
          warnings.push(`${dir}/${file}: saved as ${operation} but input ${inputId} is ${call.operation}; the input was not used`);
        }
        const matched = call && call.operation === operation ? call : null;
        replies.push(
          buildReply({
            root: rootName,
            configuration,
            provider: config.provider ?? configuration.split("--")[0]!,
            model: config.model ?? saved.model ?? configuration,
            inputId,
            repeat: Number(repeatText),
            operation,
            call: matched,
            saved,
            accepted: Boolean(e.ok),
            newForm,
          }),
        );
      }
    }
  }
  return { replies, configs };
}

function buildReply(r: {
  root: string;
  configuration: string;
  provider: string;
  model: string;
  inputId: string;
  repeat: number;
  operation: Operation;
  call: StoredCall | null;
  saved: SavedReply;
  accepted: boolean;
  newForm: boolean;
}): Reply {
  const { saved, accepted } = r;
  const refusals = [...(saved.refusedAttempts ?? [])].sort((a, b) => a.attempt - b.attempt);
  const timings = saved.timing?.attempts ?? [];
  const lastRefusal = refusals.at(-1);
  // Attempts made: the timing says; without it, the refusals plus the final attempt when it was not one.
  const finalIsRefusal = !accepted && lastRefusal !== undefined && (timings.length === 0 || lastRefusal.attempt === timings.length) && (saved.error === undefined || saved.error === lastRefusal.error || timings.length > 0);
  const made = Math.max(timings.length, refusals.length + (accepted || !finalIsRefusal ? 1 : 0));
  const ctx = contextFor(r.operation, r.call, saved);
  // A reply accepted with plan lines that did not parse and then asked to fix
  // them (fix_lines), or with a plan that tripped a rule and was sent back
  // (fix_rules, the rules retry): the reply's own row, whose usage the file saves, is the
  // attempt before the fix; the fix's tokens are in its timing entry.
  const fixAt = accepted ? timings.find((t) => t.request?.kind === "fix_lines" || t.request?.kind === "fix_rules")?.attempt : undefined;
  const counted = fixAt !== undefined ? fixAt - 1 : made;
  const attempts: Attempt[] = [];
  for (let n = 1; n <= made; n++) {
    const t = timings.find((x) => x.attempt === n);
    const refusal = refusals.find((x) => x.attempt === n);
    if (refusal) {
      const usage = usageOf(refusal);
      const extracted = extractAttempt(refusal.responseRaw, r.operation);
      const normalised = normaliseError(refusal.error);
      let reproduced: boolean | null = null;
      // The checkers in replayRepairs.ts read the old nested forms; a run on the plan-as-text form is not re-validated.
      if (ctx && !r.newForm && normalised.kind === "schema" && extracted.toolInput !== null) {
        const v = validateFor(r.operation, extracted.toolInput, ctx);
        reproduced = !v.ok && v.error === refusal.error;
      }
      attempts.push({
        attempt: n,
        outcome: "refused",
        requestKind: t?.request?.kind ?? null,
        error: refusal.error,
        normalised,
        stopReason: refusal.stopReason,
        usage,
        thinkingChars: extracted.format === "none" ? null : extracted.thinkingChars,
        ttftMs: t?.ttftMs ?? null,
        totalMs: t?.totalMs ?? null,
        costUsd: attemptCostUsd(r.model, usage),
        extracted,
        reproduced,
        rescuedAlone: [],
        rescuedByAll: null,
        remainingError: null,
      });
    } else {
      const final = n === made;
      const own = n === counted;
      const isFix = n === fixAt;
      const usage = own ? usageOf(saved) : isFix ? usageOf({ inputTokens: t?.inputTokens, outputTokens: t?.outputTokens }) : usageOf({});
      const failedHere = !accepted && final;
      // A fix that failed leaves the first reply standing: that attempt failed, the reply did not.
      const fixFailed = isFix && t?.outcome !== undefined && t.outcome !== null && t.outcome !== "ok" && t.outcome !== "repaired";
      attempts.push({
        attempt: n,
        outcome: failedHere || fixFailed ? "failed" : "accepted",
        requestKind: t?.request?.kind ?? null,
        error: failedHere ? (saved.error ?? "unknown error") : fixFailed ? (t?.repairs ?? t?.outcome ?? "the fix failed") : null,
        normalised: failedHere ? normaliseError(saved.error ?? "unknown error") : null,
        stopReason: own ? (saved.stopReason ?? null) : null,
        usage,
        thinkingChars: own ? (saved.thinkingChars ?? null) : null,
        ttftMs: t?.ttftMs ?? null,
        totalMs: t?.totalMs ?? null,
        costUsd: attemptCostUsd(r.model, usage),
        extracted: null,
        reproduced: null,
        rescuedAlone: [],
        rescuedByAll: null,
        remainingError: null,
      });
    }
  }
  let failCause: FailCause | null = null;
  if (!accepted) {
    const last = attempts.at(-1);
    failCause = last ? causeOf(last.outcome === "refused" ? last.normalised!.kind : errorKindOrTransport(last.error ?? "")) : "http/transport/timeout";
  }
  return {
    ...r,
    key: `${r.root}/${r.inputId}`,
    outcome: accepted ? (refusals.length ? "after retry" : "first try") : "failed",
    failCause,
    attempts,
    ctx,
    planLines: accepted ? (saved.plan !== undefined ? saved.plan : planLineSummary(r.operation, saved)) : null,
    // Recomputed from the input's packet whenever it is at hand, so a change to a rule
    // reaches older runs; the summary the replay saved stands in only without one.
    planRules: !accepted
      ? null
      : r.call && "packet" in r.call
        ? planRuleSummary(r.operation, r.call.packet, saved.new)
        : (saved.rules ?? null),
  };
}

/**
 * Whether a saved reply carries the plan-as-text form (tickets 06 and 10): a
 * `plan` summary, a stored day with a line or parsed flag, or a refused
 * attempt whose tool input has a plan or changes box.
 */
function savedCarriesPlanLines(saved: SavedReply, operation: Operation): boolean {
  if (saved.plan) return true;
  if (saved.new !== undefined && carriesPlanLines(operation, saved.new)) return true;
  return (saved.refusedAttempts ?? []).some((a) => {
    const input = extractAttempt(a.responseRaw, operation).toolInput as Record<string, unknown> | null;
    return Boolean(input) && typeof input === "object" && (typeof input!.plan === "string" || typeof input!.changes === "string");
  });
}

/** A final attempt that was not a refusal failed outside the validator: classified by its text, else transport. */
function errorKindOrTransport(error: string): ErrorKind {
  const kind = normaliseError(error).kind;
  return kind === "schema" ? "transport" : kind;
}

// ---- Rescue simulation ------------------------------------------------------------------

/** Refused attempts the repairs can work on: a schema refusal, or no tool call (a reply may have been sent elsewhere). */
function workable(a: Attempt): boolean {
  return a.outcome === "refused" && (a.normalised?.kind === "schema" || a.normalised?.kind === "no tool call");
}

function attemptPasses(reply: Reply, a: Attempt, repairs: string[]): { ok: boolean; value: unknown; error: string | null; changes: string[] } {
  if (!reply.ctx || !a.extracted) return { ok: false, value: null, error: "no context to validate against", changes: [] };
  const ctx: RepairContext = { ...reply.ctx, strayInput: a.extracted.strayInput?.value ?? null };
  const out = tryRepairs(a.extracted.toolInput, ctx, repairs);
  return { ok: out.result.ok, value: out.result.ok ? out.result.value : null, error: out.result.ok ? null : out.result.error, changes: out.changes };
}

/** The first workable attempt (in order) that the repairs make valid, with its validated value. */
function replyRescue(reply: Reply, repairs: string[]): { attempt: number; value: unknown; changes: string[] } | null {
  for (const a of reply.attempts.filter(workable)) {
    const out = attemptPasses(reply, a, repairs);
    if (out.ok) return { attempt: a.attempt, value: out.value, changes: out.changes };
  }
  return null;
}

type RescueTable = {
  population: number;
  alone: Record<string, number>;
  /** Greedy order: each step adds the repair that rescues most on top of the ones before. */
  cumulative: Array<{ id: string; gain: number; total: number }>;
  all: number;
  /** Rescues lost when one repair is left out of the full set. */
  neededBy: Record<string, number>;
};

const REPAIR_IDS = CANDIDATE_REPAIRS.map((r) => r.id);

function rescueTable(population: Reply[], order: string[] | null): RescueTable {
  const count = (set: string[]) => population.filter((r) => replyRescue(r, set) !== null).length;
  const alone = Object.fromEntries(REPAIR_IDS.map((id) => [id, count([id])]));
  const cumulative: RescueTable["cumulative"] = [];
  let chosen: string[] = [];
  let total = count([]);
  if (order) {
    for (const id of order) {
      const next = count([...chosen, id]);
      cumulative.push({ id, gain: next - total, total: next });
      chosen = [...chosen, id];
      total = next;
    }
  } else {
    const left = new Set(REPAIR_IDS);
    while (left.size) {
      let best: { id: string; n: number } | null = null;
      for (const id of REPAIR_IDS.filter((x) => left.has(x))) {
        const n = count([...chosen, id]);
        if (!best || n > best.n) best = { id, n };
      }
      cumulative.push({ id: best!.id, gain: best!.n - total, total: best!.n });
      chosen = [...chosen, best!.id];
      total = best!.n;
      left.delete(best!.id);
    }
  }
  const all = count(REPAIR_IDS);
  const neededBy = Object.fromEntries(REPAIR_IDS.map((id) => [id, all - count(REPAIR_IDS.filter((x) => x !== id))]));
  return { population: population.length, alone, cumulative, all, neededBy };
}

// ---- Analysis ----------------------------------------------------------------------------

function tally(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function isBaseline(c: string): boolean {
  return c === BASELINE;
}

const SCHEMA_KEYS = {
  top: {
    weekly_reply: ["headline", "flags", "answers", "analysis", "prescribedWeek", "settingsProposalBullets", "safetyCallouts"],
    mid_week_chat: ["body", "settingsProposalBullets", "safetyCallouts", "prescribedDayPatches", "allowPastDayPatches"],
    dossier: ["summaryBullets", "proposedBody"],
  },
  day: ["date", "dayType", "run", "strength", "notes"],
  run: ["type", "distanceM", "durationS", "structure", "paceOrHr", "shoes"],
};

/** Keys outside the tool schema in one extracted input, as "level.key" (top, day, run). */
function unknownKeys(operation: Operation, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const o = input as Record<string, unknown>;
  const top = operation === "weekly_reply" || operation === "mid_week_chat" ? SCHEMA_KEYS.top[operation] : SCHEMA_KEYS.top.dossier;
  const out = Object.keys(o).filter((k) => !top.includes(k)).map((k) => `top.${k}`);
  const days: unknown[] = [];
  const week = o.prescribedWeek;
  if (week && typeof week === "object" && Array.isArray((week as { days?: unknown }).days)) days.push(...(week as { days: unknown[] }).days);
  if (Array.isArray(o.prescribedDayPatches)) days.push(...o.prescribedDayPatches);
  for (const d of days) {
    if (!d || typeof d !== "object") continue;
    for (const k of Object.keys(d)) if (!SCHEMA_KEYS.day.includes(k)) out.push(`day.${k}`);
    const run = (d as { run?: unknown }).run;
    if (run && typeof run === "object") for (const k of Object.keys(run)) if (!SCHEMA_KEYS.run.includes(k)) out.push(`run.${k}`);
  }
  return out;
}

/** Enum values sent for dayType and run.type (and the day fields used in their place) that are not in the enum. */
/**
 * Every shape problem in one extracted input, not only the first the validator
 * stops at: what a schema or prompt change would have to cover.
 */
function shapeIssues(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["not an object"];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  // The flat forms (a `plan` or `changes` string) take these boxes as one string of lines; earlier forms took lists.
  const flat = typeof o.plan === "string" || typeof o.changes === "string";
  for (const key of ["settingsProposalBullets", "safetyCallouts", "prescribedDayPatches"]) if (key in o && o[key] === null) out.push(`${key} null`);
  for (const key of ["flags", "answers"]) {
    const list = o[key];
    if (!flat && Array.isArray(list) && list.some((x) => typeof x === "string")) out.push(`${key} entries as plain strings`);
    if (Array.isArray(list) && list.some((x) => isObj(x) && Object.values(x).some((v) => typeof v === "string" && !v.trim()))) out.push(`${key} entries with an empty field`);
  }
  for (const key of flat ? ["summaryBullets"] : ["settingsProposalBullets", "summaryBullets"]) if (typeof o[key] === "string") out.push(`${key} as a string`);
  if (flat) for (const key of ["flags", "answers", "settingsProposalBullets", "safetyCallouts"]) if (Array.isArray(o[key])) out.push(`${key} as a list`);
  const week = o.prescribedWeek;
  if (isObj(week) && !(typeof week.week === "string" && /^\d{4}-W\d{2}$/.test(week.week))) out.push("week id not YYYY-Www");
  const days: unknown[] = [...(isObj(week) && Array.isArray(week.days) ? week.days : []), ...(Array.isArray(o.prescribedDayPatches) ? o.prescribedDayPatches : [])];
  const dayTypes = ["rest", "easy", "quality", "long", "race", "other"];
  const any = (pred: (d: Record<string, unknown>) => boolean) => days.some((d) => isObj(d) && pred(d));
  if (any((d) => d.dayType === undefined)) out.push("day without dayType");
  if (any((d) => typeof d.dayType === "string" && !dayTypes.includes(d.dayType))) out.push("dayType outside the enum");
  if (any((d) => isObj(d.run) && d.run.type === undefined)) out.push("run without type");
  if (any((d) => isObj(d.run) && typeof d.run.type === "string" && !dayTypes.slice(1).includes(d.run.type))) out.push("run.type outside the enum");
  if (any((d) => isObj(d.run) && typeof d.run.distanceM !== "number" && typeof d.run.durationS !== "number")) out.push("run without distanceM (or durationS)");
  if (any((d) => typeof d.dayType === "string" && !["rest", "other"].includes(d.dayType) && !isObj(d.run))) out.push("run day without a run object");
  return out;
}

function enumValuesSeen(input: unknown): Array<{ field: string; value: string }> {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const days: unknown[] = [];
  const week = o.prescribedWeek;
  if (week && typeof week === "object" && Array.isArray((week as { days?: unknown }).days)) days.push(...(week as { days: unknown[] }).days);
  if (Array.isArray(o.prescribedDayPatches)) days.push(...o.prescribedDayPatches);
  const dayTypes = ["rest", "easy", "quality", "long", "race", "other"];
  const out: Array<{ field: string; value: string }> = [];
  for (const d of days) {
    if (!d || typeof d !== "object") continue;
    const day = d as Record<string, unknown>;
    if (typeof day.dayType === "string" && !dayTypes.includes(day.dayType)) out.push({ field: "dayType", value: day.dayType });
    for (const alias of ["session", "name", "activity", "type", "workout"]) {
      if (typeof day[alias] === "string") out.push({ field: `day.${alias}`, value: (day[alias] as string).slice(0, 40) });
    }
    const run = day.run as Record<string, unknown> | null | undefined;
    if (run && typeof run === "object" && typeof run.type === "string" && !dayTypes.slice(1).includes(run.type)) out.push({ field: "run.type", value: run.type });
  }
  return out;
}

function analyse(replies: Reply[], configs: ReturnType<typeof loadReplies>["configs"]) {
  const configurations = [...configs.keys()].sort((a, b) => (isBaseline(a) ? -1 : isBaseline(b) ? 1 : a.localeCompare(b)));
  const candidates = configurations.filter((c) => !isBaseline(c));
  const byConfig = (c: string) => replies.filter((r) => r.configuration === c);
  const opsOf = (rs: Reply[]) => OPERATIONS.filter((o) => rs.some((r) => r.operation === o));

  // 1. Outcomes.
  const outcomeRow = (rs: Reply[]) => ({
    replies: rs.length,
    firstTry: rs.filter((r) => r.outcome === "first try").length,
    afterRetry: rs.filter((r) => r.outcome === "after retry").length,
    failed: rs.filter((r) => r.outcome === "failed").length,
    failedBy: Object.fromEntries(FAIL_CAUSES.map((c) => [c, rs.filter((r) => r.failCause === c).length])),
  });
  const outcomes = configurations.map((c) => {
    const rs = byConfig(c);
    return { configuration: c, all: outcomeRow(rs), byOperation: Object.fromEntries(opsOf(rs).map((o) => [o, outcomeRow(rs.filter((r) => r.operation === o))])) };
  });

  // 1b. Plan lines: structured days and the parser's failures, from each valid reply's summary.
  const planLineRow = (rs: Reply[]) => {
    const s = rs.map((r) => r.planLines).filter((x): x is PlanLineSummary => x !== null);
    const sum = (f: (x: PlanLineSummary) => number) => s.reduce((n, x) => n + f(x), 0);
    const daysTotal = sum((x) => x.daysTotal);
    const daysParsed = sum((x) => x.daysParsed);
    return {
      replies: s.length,
      daysTotal,
      daysParsed,
      unparsed: daysTotal - daysParsed,
      /** Share of the stored days Cadence filed; null with no days. */
      structuredShare: daysTotal ? daysParsed / daysTotal : null,
      repliesAllParsed: s.filter((x) => x.daysParsed === x.daysTotal).length,
      failedFirst: sum((x) => x.failures.length),
      retried: s.filter((x) => x.retried).length,
      retryAskedFor: sum((x) => x.retryAskedFor.length),
      fixedByRetry: sum((x) => x.fixedByRetry.length),
      bareNumbers: sum((x) => x.bareNumbers),
      droppedLines: sum((x) => x.droppedLines.length),
      ignoredLines: sum((x) => x.ignoredLines),
    };
  };
  const planLines = configurations.map((c) => {
    const valid = byConfig(c).filter((r) => r.outcome !== "failed");
    return {
      configuration: c,
      form: byConfig(c).some((r) => r.newForm) ? (byConfig(c).every((r) => r.newForm) ? "plan lines" : "mixed") : "nested days",
      weekly: planLineRow(valid.filter((r) => r.operation === "weekly_reply")),
      midWeek: planLineRow(valid.filter((r) => r.operation === "mid_week_chat")),
    };
  });
  const failuresByReason = configurations.flatMap((c) =>
    (["weekly_reply", "mid_week_chat"] as const).flatMap((operation) => {
      const s = byConfig(c)
        .filter((r) => r.operation === operation)
        .map((r) => r.planLines)
        .filter((x): x is PlanLineSummary => x !== null);
      return PLAN_LINE_FAILURE_REASONS.flatMap((reason) => {
        const failed = s.flatMap((x) => x.failures.filter((f) => f.reason === reason).map((f) => ({ f, fixed: x.fixedByRetry.includes(f.date) })));
        const dropped = s.reduce((n, x) => n + x.droppedLines.filter((f) => f.reason === reason).length, 0);
        if (failed.length === 0 && dropped === 0) return [];
        const fixed = failed.filter((x) => x.fixed).length;
        return [{ configuration: c, operation, reason, firstParse: failed.length, fixedByRetry: fixed, stillUnparsed: failed.length - fixed, droppedLines: dropped }];
      });
    }),
  );

  // 1c. Plan rules tripped (scripts/replayPlanRules.ts): per configuration, over the weekly reads the check could run on.
  const planRules = configurations.map((c) => {
    const s = byConfig(c)
      .filter((r) => r.operation === "weekly_reply")
      .map((r) => r.planRules)
      .filter((x): x is PlanRuleSummary => x !== null);
    return {
      configuration: c,
      repliesChecked: s.length,
      byRule: Object.fromEntries(PLAN_RULES.map((rule) => [rule, s.filter((x) => x.tripped.includes(rule)).length])) as Record<(typeof PLAN_RULES)[number], number>,
      repliesWithAnyRule: s.filter((x) => x.tripped.length > 0).length,
      skippedByRule: Object.fromEntries(PLAN_RULES.map((rule) => [rule, s.filter((x) => x.skipped.some((k) => k.rule === rule)).length])) as Record<(typeof PLAN_RULES)[number], number>,
      // Replies sent back once for a tripped rule (the rules retry, ticket 11); the rules above are the plan that was kept.
      rulesRetries: byConfig(c).filter((r) => r.operation === "weekly_reply" && r.attempts.some((a) => a.requestKind === "fix_rules")).length,
    };
  });

  // 2. Failure taxonomy.
  const refused = replies.flatMap((r) => r.attempts.filter((a) => a.outcome === "refused").map((a) => ({ r, a })));
  const taxonomy = (items: typeof refused) => {
    const rows = new Map<string, { path: string; rule: string; ruleLabel: string; first: number; retry: number }>();
    for (const { a } of items) {
      const n = a.normalised!;
      const k = `${n.path} ${n.rule}`;
      const row = rows.get(k) ?? { path: n.path, rule: n.rule, ruleLabel: n.ruleLabel, first: 0, retry: 0 };
      if (a.attempt === 1) row.first++;
      else row.retry++;
      rows.set(k, row);
    }
    return [...rows.values()].sort((x, y) => y.first + y.retry - (x.first + x.retry) || x.path.localeCompare(y.path));
  };
  const failureTaxonomy = {
    overall: taxonomy(refused.filter(({ r }) => !isBaseline(r.configuration))),
    byConfiguration: Object.fromEntries(configurations.map((c) => [c, taxonomy(refused.filter(({ r }) => r.configuration === c))])),
    byPathAcrossModels: (() => {
      const out: Record<string, Record<string, number>> = {};
      for (const { r, a } of refused) {
        const p = a.normalised!.path;
        out[p] ??= {};
        out[p][r.configuration] = (out[p][r.configuration] ?? 0) + 1;
      }
      return out;
    })(),
  };

  // 3. Retry effectiveness: replies whose first attempt was refused and that were asked again.
  const retryRows = configurations.map((c) => {
    const rs = byConfig(c).filter((r) => r.attempts.length >= 2 && r.attempts[0]!.outcome === "refused");
    const fixed = rs.filter((r) => r.attempts[1]!.outcome === "accepted").length;
    const second = rs.map((r) => r.attempts[1]!).filter((a) => a.outcome === "refused");
    const pairs = rs.filter((r) => r.attempts[1]!.outcome === "refused");
    const sameError = pairs.filter((r) => r.attempts[0]!.error === r.attempts[1]!.error).length;
    const samePathRule = pairs.filter((r) => {
      const [x, y] = [r.attempts[0]!.normalised!, r.attempts[1]!.normalised!];
      return x.path === y.path && x.rule === y.rule;
    }).length;
    const sameRuleLabel = pairs.filter((r) => r.attempts[0]!.normalised!.ruleLabel === r.attempts[1]!.normalised!.ruleLabel).length;
    return {
      configuration: c,
      retried: rs.length,
      fixed,
      sameError,
      samePathAndRule: samePathRule,
      newError: pairs.length - samePathRule,
      sameKindOfError: sameRuleLabel,
      secondFailedOutsideValidator: rs.filter((r) => r.attempts[1]!.outcome === "failed").length,
      refusedAgain: second.length,
      /** Every second request this configuration sent, by how it was built (live runs since ticket 08 save it). */
      secondRequests: tally(byConfig(c).filter((r) => r.attempts.length >= 2).map((r) => r.attempts[1]!.requestKind ?? "not recorded")),
    };
  });

  // 4. Rescue simulation, for runs on the old nested forms only: on the
  // plan-as-text form the parser is the repair, and the candidate repairs read
  // shapes those runs no longer send.
  const oldForm = replies.filter((r) => !r.newForm);
  const skippedRuns = [...new Set(replies.filter((r) => r.newForm).map((r) => `${r.root}/${r.configuration}`))].sort();
  const refusedOld = refused.filter(({ r }) => !r.newForm);
  const rescuable = (r: Reply) => r.attempts.some(workable);
  const failedPopulation = oldForm.filter((r) => !isBaseline(r.configuration) && r.outcome === "failed" && rescuable(r));
  const overallTable = rescueTable(failedPopulation, null);
  const order = overallTable.cumulative.map((c) => c.id);
  const perModelTables = Object.fromEntries(candidates.map((c) => [c, rescueTable(failedPopulation.filter((r) => r.configuration === c), order)]));
  // Retries the repairs would have saved: replies accepted only after asking once more, rescued on attempt 1.
  const retriedPopulation = oldForm.filter((r) => !isBaseline(r.configuration) && r.outcome === "after retry" && workable(r.attempts[0]!));
  const firstAttemptOnly = (r: Reply, set: string[]) => {
    const a = r.attempts[0]!;
    return workable(a) && attemptPasses(r, a, set).ok;
  };
  const retriesSaved = Object.fromEntries(
    candidates.map((c) => [c, { retried: retriedPopulation.filter((r) => r.configuration === c).length, savedByAll: retriedPopulation.filter((r) => r.configuration === c && firstAttemptOnly(r, REPAIR_IDS)).length }]),
  );
  // Per attempt marks for the CSV, and what still fails.
  for (const r of oldForm) {
    for (const a of r.attempts.filter(workable)) {
      a.rescuedAlone = REPAIR_IDS.filter((id) => attemptPasses(r, a, [id]).ok);
      const all = attemptPasses(r, a, REPAIR_IDS);
      a.rescuedByAll = all.ok;
      a.remainingError = all.ok ? null : all.error;
    }
  }
  const stillFailing = failedPopulation
    .filter((r) => replyRescue(r, REPAIR_IDS) === null)
    .map((r) => {
      const last = [...r.attempts].reverse().find(workable)!;
      return { configuration: r.configuration, key: r.key, operation: r.operation, attempt: last.attempt, error: last.remainingError, normalised: last.remainingError ? normaliseError(last.remainingError) : null };
    });
  const stillFailingByError = tally(stillFailing.map((s) => (s.normalised ? `${s.normalised.path} ${s.normalised.rule}` : "(no context)")));
  const notWorkable = oldForm.filter((r) => !isBaseline(r.configuration) && r.outcome === "failed" && !rescuable(r)).map((r) => ({ configuration: r.configuration, key: r.key, cause: r.failCause, error: r.attempts.at(-1)?.error ?? null }));
  const extraction = (() => {
    const atts = refused.map(({ a }) => a);
    return {
      refusedAttempts: atts.length,
      byFormat: tally(atts.map((a) => a.extracted?.format ?? "none")),
      toolInputFound: atts.filter((a) => a.extracted?.toolInput !== null && a.extracted?.toolInput !== undefined).length,
      unparsedToolJson: atts.filter((a) => a.extracted?.unparsedToolJson).length,
      strayInputs: tally(atts.filter((a) => a.extracted?.strayInput).map((a) => a.extracted!.strayInput!.from)),
      reproduced: atts.filter((a) => a.reproduced === true).length,
      notReproduced: refused.filter(({ a }) => a.reproduced === false).map(({ r, a }) => `${r.configuration}/${r.key}.${r.repeat} attempt ${a.attempt}: recorded "${a.error}", re-run "${(() => {
        const v = validateFor(r.operation, a.extracted!.toolInput, r.ctx!);
        return v.ok ? "accepted" : v.error;
      })()}"`),
      checked: atts.filter((a) => a.reproduced !== null).length,
    };
  })();
  const enumSeen = (() => {
    const rows = new Map<string, { field: string; value: string; mapped: string | null; byConfiguration: Record<string, number> }>();
    for (const { r, a } of refusedOld) {
      for (const s of enumValuesSeen(a.extracted?.toolInput)) {
        const k = `${s.field}\u0000${s.value}`;
        const row = rows.get(k) ?? { field: s.field, value: s.value, mapped: mapEnumValue(s.value, s.field !== "run.type"), byConfiguration: {} };
        row.byConfiguration[r.configuration] = (row.byConfiguration[r.configuration] ?? 0) + 1;
        rows.set(k, row);
      }
    }
    return [...rows.values()].sort((x, y) => sumValues(y.byConfiguration) - sumValues(x.byConfiguration));
  })();
  const shapeIssueCounts = (() => {
    const out: Record<string, Record<string, number>> = {};
    for (const { r, a } of refusedOld) {
      if (a.extracted?.toolInput === null || a.extracted?.toolInput === undefined) continue;
      for (const k of shapeIssues(a.extracted.toolInput)) {
        out[k] ??= {};
        out[k][r.configuration] = (out[k][r.configuration] ?? 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(out).sort((x, y) => sumValues(y[1]) - sumValues(x[1])));
  })();
  const unknownKeyCounts = (() => {
    const out: Record<string, Record<string, number>> = {};
    for (const { r, a } of refusedOld) {
      for (const k of new Set(unknownKeys(r.operation, a.extracted?.toolInput))) {
        out[k] ??= {};
        out[k][r.configuration] = (out[k][r.configuration] ?? 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(out).sort((x, y) => sumValues(y[1]) - sumValues(x[1])));
  })();
  const rescueDetails = failedPopulation.map((r) => {
    const res = replyRescue(r, REPAIR_IDS);
    // The smallest set in the greedy order that rescues it, read off the order.
    const needed: string[] = [];
    if (res) {
      let set: string[] = [];
      for (const id of order) {
        set = [...set, id];
        if (replyRescue(r, set)) break;
      }
      // Drop any that the rescue does not need.
      for (const id of [...set]) {
        const without = set.filter((x) => x !== id);
        if (replyRescue(r, without)) set = without;
      }
      needed.push(...set);
    }
    // A rescued plan with no run in it passes the validator but is not a plan worth having.
    const plan = res && r.operation === "weekly_reply" ? planSummary((res.value as WeeklyReply).prescribedWeek) : null;
    return {
      configuration: r.configuration,
      key: r.key,
      repeat: r.repeat,
      operation: r.operation,
      rescued: Boolean(res),
      attempt: res?.attempt ?? null,
      needs: needed,
      runDays: plan?.runDays ?? null,
      plannedKm: plan ? plan.totalM / 1000 : null,
      changes: res?.changes ?? [],
    };
  });

  // 5. Quality signals on valid replies, and on rescued ones apart.
  type Quality = { label: string; replies: number; softRepairs: Record<string, number>; softRepairReplies: number; capsHit: Record<string, number>; goalCheckFailures: Record<string, number>; bannedTerms: Record<string, number>; planFlags: Record<string, number>; planFlagged: number; volumeRatio: Spread; repairChanges?: Record<string, number> };
  const qualityOf = (items: Array<{ r: Reply; value: unknown; repairs: string | null; refusalErrors: string[]; changes?: string[] }>, label: string): Quality => {
    const soft = items.flatMap((i) => repairsOf(i.repairs).map((x) => x.field));
    const caps = items.flatMap((i) => capHitsOf(i.repairs, i.refusalErrors));
    const goal: string[] = [];
    const banned: string[] = [];
    const plan: string[] = [];
    const ratios: number[] = [];
    let flagged = 0;
    for (const { r, value } of items) {
      const readText = readTextOf(r.operation, value);
      banned.push(...bannedTermsIn(readText));
      const prompt = r.saved.promptHead !== undefined && r.outcome !== "failed" ? r.saved.promptHead : r.call ? promptHead(r.call) : null;
      const goalOf = r.saved.goal ?? r.call?.goal ?? null;
      goal.push(...replayCheckFailures({ label: r.key, goal: goalOf, prompt, readText }).map((f) => f.check));
      if (r.operation === "weekly_reply") {
        const expect = r.saved.planCheck ?? (r.call && "packet" in r.call && r.ctx?.weekStartMonday ? { weekStartMonday: r.ctx.weekStartMonday, isoWeek: r.ctx.isoWeek, recentWeeklyM: recentWeeklyDistanceM(r.call.packet) } : null);
        const s = planSanity((value as WeeklyReply).prescribedWeek, expect);
        if (s.flags.length) flagged++;
        plan.push(...s.flags.map((f) => f.check));
        if (s.ratio !== null) ratios.push(s.ratio);
      }
    }
    const q: Quality = {
      label,
      replies: items.length,
      softRepairs: tally(soft),
      softRepairReplies: items.filter((i) => repairsOf(i.repairs).length > 0).length,
      capsHit: tally(caps),
      goalCheckFailures: tally(goal),
      bannedTerms: tally(banned),
      planFlags: tally(plan),
      planFlagged: flagged,
      volumeRatio: spread(ratios),
    };
    if (items.some((i) => i.changes)) q.repairChanges = tally(items.flatMap((i) => (i.changes ?? []).map((c) => c.replace(/\[\d+\]/g, "[n]").replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "N"))));
    return q;
  };
  const rescuedValues = new Map<Reply, { value: unknown; changes: string[]; validatorRepairs: string[] }>();
  for (const r of failedPopulation) {
    const res = replyRescue(r, REPAIR_IDS);
    if (!res) continue;
    // Re-run to read the validator's own soft repairs on the repaired input.
    const a = r.attempts.find((x) => x.attempt === res.attempt)!;
    const out = tryRepairs(a.extracted!.toolInput, { ...r.ctx!, strayInput: a.extracted!.strayInput?.value ?? null }, REPAIR_IDS);
    rescuedValues.set(r, { value: res.value, changes: res.changes, validatorRepairs: out.result.ok ? (out.result.repairs ?? []) : [] });
  }
  const quality = configurations.map((c) => {
    const valid = byConfig(c).filter((r) => r.outcome !== "failed" && r.saved.new !== undefined);
    const rescued = [...rescuedValues].filter(([r]) => r.configuration === c);
    return {
      configuration: c,
      valid: qualityOf(valid.map((r) => ({ r, value: r.saved.new, repairs: r.saved.repairs ?? null, refusalErrors: r.attempts.filter((a) => a.outcome === "refused").map((a) => a.error!) })), "valid"),
      byOperation: Object.fromEntries(
        opsOf(valid).map((o) => [o, qualityOf(valid.filter((r) => r.operation === o).map((r) => ({ r, value: r.saved.new, repairs: r.saved.repairs ?? null, refusalErrors: [] })), o)]),
      ),
      rescued: qualityOf(rescued.map(([r, v]) => ({ r, value: v.value, repairs: v.validatorRepairs.join("; ") || null, refusalErrors: [], changes: v.changes })), "rescued"),
    };
  });

  // 6. Plans against the baseline.
  const baselineWeekly = new Map(replies.filter((r) => isBaseline(r.configuration) && r.operation === "weekly_reply" && r.outcome !== "failed" && r.repeat === 1).map((r) => [r.key, r.saved.new as WeeklyReply]));
  type PlanRow = { configuration: string; key: string; repeat: number; source: "valid" | "rescued"; comparison: PlanComparison; candidate: ReturnType<typeof weeklyShape> & { totalKm: number }; baseline: ReturnType<typeof weeklyShape> & { totalKm: number } };
  const planRows: PlanRow[] = [];
  for (const r of replies) {
    if (isBaseline(r.configuration) || r.operation !== "weekly_reply") continue;
    const base = baselineWeekly.get(r.key);
    if (!base) continue;
    const value = r.outcome !== "failed" ? (r.saved.new as WeeklyReply | undefined) : (rescuedValues.get(r)?.value as WeeklyReply | undefined);
    if (!value?.prescribedWeek) continue;
    planRows.push({
      configuration: r.configuration,
      key: r.key,
      repeat: r.repeat,
      source: r.outcome !== "failed" ? "valid" : "rescued",
      comparison: comparePlans(value.prescribedWeek, base.prescribedWeek),
      candidate: { ...weeklyShape(value), totalKm: planSummary(value.prescribedWeek).totalM / 1000 },
      baseline: { ...weeklyShape(base), totalKm: planSummary(base.prescribedWeek).totalM / 1000 },
    });
  }
  const planSummaryOf = (rows: PlanRow[]) => ({
    pairs: rows.length,
    /** Unparsed days across the pairs, each side: left out of the ratios, "no plan" in the day types. */
    unparsed: { candidate: rows.reduce((n, x) => n + x.comparison.unparsed.candidate, 0), baseline: rows.reduce((n, x) => n + x.comparison.unparsed.baseline, 0) },
    pairsWithUnparsed: rows.filter((x) => x.comparison.unparsed.candidate + x.comparison.unparsed.baseline > 0).length,
    distanceRatio: spread(rows.map((x) => x.comparison.distanceRatio)),
    longRunRatio: spread(rows.map((x) => x.comparison.longRunRatio)),
    runDaysDiff: spread(rows.map((x) => x.comparison.runDays.candidate - x.comparison.runDays.baseline)),
    dayTypeMatch: spread(rows.map((x) => x.comparison.dayTypeMatch)),
    sameRestDays: rows.filter((x) => x.comparison.sameRestDays).length,
    restAgreement: spread(rows.map((x) => x.comparison.restAgreement)),
    qualityBoth: rows.filter((x) => x.comparison.quality.candidate && x.comparison.quality.baseline).length,
    qualityOnlyCandidate: rows.filter((x) => x.comparison.quality.candidate && !x.comparison.quality.baseline).length,
    qualityOnlyBaseline: rows.filter((x) => !x.comparison.quality.candidate && x.comparison.quality.baseline).length,
    flags: { candidate: spread(rows.map((x) => x.candidate.flags)), baseline: spread(rows.map((x) => x.baseline.flags)) },
    answers: { candidate: spread(rows.map((x) => x.candidate.answers)), baseline: spread(rows.map((x) => x.baseline.answers)) },
    answersFewer: rows.filter((x) => x.candidate.answers < x.baseline.answers).length,
    headlineChars: { candidate: spread(rows.map((x) => x.candidate.headlineChars)), baseline: spread(rows.map((x) => x.baseline.headlineChars)) },
    analysisChars: { candidate: spread(rows.map((x) => x.candidate.analysisChars)), baseline: spread(rows.map((x) => x.baseline.analysisChars)) },
  });
  const plans = candidates.map((c) => ({
    configuration: c,
    valid: planSummaryOf(planRows.filter((x) => x.configuration === c && x.source === "valid")),
    rescued: planSummaryOf(planRows.filter((x) => x.configuration === c && x.source === "rescued")),
  }));
  const divergences = planRows
    .flatMap((x) => {
      const out: string[] = [];
      const c = x.comparison;
      if (c.distanceRatio !== null && Math.abs(c.distanceRatio - 1) > 0.25) out.push(`weekly distance ${x.candidate.totalKm.toFixed(1)} km vs ${x.baseline.totalKm.toFixed(1)} km (x${c.distanceRatio.toFixed(2)})`);
      if (c.longRunRatio !== null && Math.abs(c.longRunRatio - 1) > 0.25) out.push(`long run x${c.longRunRatio.toFixed(2)}`);
      if (c.dayTypeMatch < 0.5) out.push(`day types match on ${Math.round(c.dayTypeMatch * 7)}/7 days`);
      if (c.quality.candidate !== c.quality.baseline) out.push(c.quality.candidate ? "quality session the baseline does not plan" : "no quality session where the baseline plans one");
      if (x.candidate.answers < x.baseline.answers) out.push(`${x.candidate.answers} answers vs ${x.baseline.answers}`);
      if (c.unparsed.candidate > 0) out.push(`${c.unparsed.candidate} of 7 days not filed (left out of the ratios)`);
      return out.length ? [{ configuration: x.configuration, key: x.key, repeat: x.repeat, source: x.source, distanceRatio: c.distanceRatio, issues: out }] : [];
    })
    .sort((a, b) => Math.abs((b.distanceRatio ?? 1) - 1) - Math.abs((a.distanceRatio ?? 1) - 1));

  // 7. Per-input difficulty.
  const keys = [...new Set(replies.map((r) => r.key))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const difficulty = keys.map((key) => {
    const rs = replies.filter((r) => r.key === key);
    const status = Object.fromEntries(
      configurations.map((c) => {
        const mine = rs.filter((r) => r.configuration === c);
        if (!mine.length) return [c, "missing"];
        const failed = mine.filter((r) => r.outcome === "failed");
        if (!failed.length) return [c, mine.some((r) => r.outcome === "after retry") ? "after retry" : "first try"];
        const rescued = failed.filter((r) => rescuedValues.has(r)).length;
        return [c, rescued === failed.length ? "failed (rescuable)" : `failed (${failed[0]!.failCause})`];
      }),
    );
    const ran = candidates.filter((c) => status[c] !== "missing");
    const failedIn = candidates.filter((c) => String(status[c]).startsWith("failed"));
    return { key, operation: rs[0]!.operation, source: rs.find((r) => r.call)?.call?.source ?? null, status, ran: ran.length, failedIn };
  });
  const hardest = difficulty.filter((d) => d.ran >= 2 && d.failedIn.length / d.ran >= 0.5).sort((a, b) => b.failedIn.length / b.ran - a.failedIn.length / a.ran || b.failedIn.length - a.failedIn.length);

  // 8. Cost and speed.
  const speed = configurations.map((c) => {
    const rs = byConfig(c);
    const row = (items: Reply[]) => {
      const atts = items.flatMap((r) => r.attempts);
      const thinkingAtts = atts.filter((a) => a.thinkingChars !== null && (a.outcome === "accepted" || a.outcome === "refused"));
      const xs = thinkingAtts.map((a) => a.thinkingChars!);
      const ys = thinkingAtts.map((a) => (a.outcome === "refused" ? 1 : 0));
      const costs = atts.map((a) => a.costUsd).filter((x): x is number => x !== null);
      return {
        replies: items.length,
        attempts: atts.length,
        firstTokenMs: spread(items.map((r) => r.saved.timing?.ttftMs ?? null)),
        totalMs: spread(items.map((r) => r.saved.timing?.totalMs ?? null)),
        attemptTotalMs: spread(atts.map((a) => a.totalMs)),
        inputTokens: spread(atts.map((a) => a.usage.inputTokens)),
        outputTokens: spread(atts.map((a) => a.usage.outputTokens)),
        thinkingTokens: spread(atts.map((a) => a.usage.thinkingTokens)),
        thinkingChars: spread(xs),
        thinkingCharsRefused: spread(thinkingAtts.filter((a) => a.outcome === "refused").map((a) => a.thinkingChars)),
        thinkingCharsAccepted: spread(thinkingAtts.filter((a) => a.outcome === "accepted").map((a) => a.thinkingChars)),
        thinkingVsRefusalR: pearson(xs, ys),
        costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      };
    };
    const cfg = configs.get(c)!;
    const measuresCost = cfg.measures.map((m) => ({ root: m.root, totalUsd: ((m.m?.cost as { totalUsd?: number } | undefined)?.totalUsd ?? null) as number | null, measuredReplies: (m.m?.replies as number | undefined) ?? null, filesNow: m.files }));
    return { configuration: c, all: row(rs), byOperation: Object.fromEntries(opsOf(rs).map((o) => [o, row(rs.filter((r) => r.operation === o))])), measuresJson: measuresCost };
  });

  return {
    configurations,
    candidates,
    outcomes,
    planLines,
    failuresByReason,
    planRules,
    failureTaxonomy,
    retry: retryRows,
    rescue: { skippedRuns, failedPopulation: failedPopulation.length, overall: overallTable, perModel: perModelTables, order, retriesSaved, stillFailing, stillFailingByError, notWorkable, extraction, enumSeen, unknownKeys: unknownKeyCounts, shapeIssues: shapeIssueCounts, details: rescueDetails },
    quality,
    plans,
    planRows,
    divergences,
    difficulty,
    hardest,
    speed,
    // 9. Coaching (scripts/replayCoaching.ts), only with --judge: undefined leaves analysis.json as it was.
    coaching: JUDGE ? coachingOf(configurations) : undefined,
  };
}

function coachingOf(configurations: string[]) {
  const c = coachingSection({ judge: readJudgeDir(JUDGE!), key: readAnswerKey(ANSWER_KEY), configurations, control: BASELINE, roots: ROOTS.map((r) => path.basename(r)), keyFile: path.basename(ANSWER_KEY) });
  warnings.push(...c.warnings);
  return c;
}

function sumValues(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}


// ---- Writing -----------------------------------------------------------------------------

export type Analysis = ReturnType<typeof analyse>;

export function short(c: string): string {
  return c.replace(/^self_hosted--/, "").replace(/^anthropic--/, "");
}

export function cell(v: unknown): string {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function pct(n: number, d: number): string {
  return d ? `${Math.round((100 * n) / d)}%` : "–";
}

export function fmt(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

export function secs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`;
}

/** Structured days of seven for a configuration's valid weekly reads, as the results table shows them. */
export function structuredDaysCell(w: { replies: number; daysTotal: number; daysParsed: number }): string {
  if (!w.replies || !w.daysTotal) return "–";
  return `${((7 * w.daysParsed) / w.daysTotal).toFixed(1)} (${pct(w.daysParsed, w.daysTotal)})`;
}

export function spreadCells(s: Spread, f: (n: number | null) => string = (n) => fmt(n)): string {
  return `${f(s.median)} / ${f(s.p90)} / ${f(s.worst)}`;
}

export function table(header: string[], rows: Array<Array<unknown>>): string[] {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

const REPAIR_BY_ID = new Map(CANDIDATE_REPAIRS.map((r) => [r.id, r]));

function harnessChanges(a: Analysis): string[] {
  const lines: string[] = [];
  const total = a.rescue.failedPopulation;
  const items: Array<{ score: number; text: string }> = [];
  for (const step of a.rescue.overall.cumulative) {
    const rep = REPAIR_BY_ID.get(step.id)!;
    const alone = a.rescue.overall.alone[step.id] ?? 0;
    const needed = a.rescue.overall.neededBy[step.id] ?? 0;
    if (step.gain === 0 && alone === 0 && needed === 0) continue;
    const perModel = a.candidates
      .map((c) => {
        const t = a.rescue.perModel[c];
        if (!t || !t.population) return null;
        const gain = t.cumulative.find((x) => x.id === step.id)?.gain ?? 0;
        return `${short(c)} +${gain} (alone ${t.alone[step.id] ?? 0}, needed by ${t.neededBy[step.id] ?? 0})`;
      })
      .filter(Boolean)
      .join("; ");
    items.push({
      score: needed * 1000 + step.gain * 100 + alone,
      text: `**Repair: ${rep.label}** (\`${rep.id}\`, ${rep.letter}). In the combined set it is needed by ${needed} of ${a.rescue.overall.all} rescued replies; adds ${step.gain} in the greedy order; rescues ${alone} of ${total} failed replies alone. Per model: ${perModel || "none"}.\n   ${rep.lossy ? "Lossy: drops or cuts what the model wrote; lift only with a note in the call log." : `Mechanical; would live in ${rep.liftTo}.`}`,
    });
  }
  // Schema: field names the models used in place of the schema's.
  const keys = Object.entries(a.rescue.unknownKeys).filter(([k]) => k.startsWith("run.") || k.startsWith("day."));
  if (keys.length) {
    const top = keys.slice(0, 6).map(([k, by]) => `\`${k}\` ${sumValues(by)} (${Object.entries(by).map(([c, n]) => `${short(c)} ${n}`).join(", ")})`);
    const n = keys.slice(0, 6).reduce((s, [, by]) => s + sumValues(by), 0);
    items.push({
      score: n * 50,
      text: `**Tool schema: field names outside the schema** in refused attempts (attempts using the key): ${top.join("; ")}.\n   The run/day schema's names (distanceM, structure, paceOrHr, dayType) are not followed; make them required with a unit in the description, or accept the aliases (\`mapRunFieldAliases\`, \`mapDayFieldAliases\`).`,
    });
  }
  const shapes = Object.entries(a.rescue.shapeIssues);
  if (shapes.length) {
    const n = shapes.slice(0, 6).reduce((s, [, by]) => s + sumValues(by), 0);
    items.push({
      score: n * 45,
      text: `**Tool schema: every shape problem in refused attempts** (not only the first error): ${shapes.slice(0, 8).map(([k, by]) => `${k} ${sumValues(by)} (${Object.entries(by).map(([c, x]) => `${short(c)} ${x}`).join(", ")})`).join("; ")}.\n   Each is a schema description or prompt line to test; "answers entries as plain strings" cannot be repaired without losing the answer (the question is not in the reply).`,
    });
  }
  const retried = a.retry.filter((r) => !isBaseline(r.configuration)).reduce((s, r) => s + r.retried, 0);
  if (retried) {
    const fixed = a.retry.reduce((s, r) => s + (isBaseline(r.configuration) ? 0 : r.fixed), 0);
    const same = a.retry.reduce((s, r) => s + (isBaseline(r.configuration) ? 0 : r.samePathAndRule), 0);
    const fresh = a.retry.reduce((s, r) => s + (isBaseline(r.configuration) ? 0 : r.newError), 0);
    items.push({
      score: same * 60,
      text: `**Retry prompt:** of ${retried} retried replies, attempt 2 fixed ${fixed}, repeated the same path and rule in ${same}, and failed on a new error in ${fresh}. Per model: ${a.retry
        .filter((r) => r.retried && !isBaseline(r.configuration))
        .map((r) => `${short(r.configuration)} ${r.fixed}/${r.samePathAndRule}/${r.newError}`)
        .join("; ")} (fixed/same/new).\n   Since plan-as-text ticket 08 the retry sends the reply back with the validator's message as an error tool result (a plain "call the tool" turn when no tool was called, the request unchanged when the reply was cut off); see the second requests by kind in section 3. On runs before that, it re-sent the identical request.`,
    });
  }
  const noTool = a.outcomes.filter((o) => !isBaseline(o.configuration)).reduce((s, o) => s + (o.all.failedBy["no tool call"] ?? 0), 0);
  const noToolAttempts = a.failureTaxonomy.overall.filter((t) => t.ruleLabel === "no tool call").reduce((s, t) => s + t.first + t.retry, 0);
  if (noToolAttempts) {
    items.push({
      score: noToolAttempts * 40,
      text: `**No tool call:** ${noToolAttempts} attempts came back with stop_reason tool_use but no ${"submit_*"} block (${noTool} replies failed that way); stray JSON found for ${sumValues(a.rescue.extraction.strayInputs)}.\n   The server dropped the call (thinking only); not fixable from the stream, so a retry or tool_choice {type: "tool"} is the lever.`,
    });
  }
  const bigDiv = a.divergences.filter((d) => d.distanceRatio !== null && Math.abs(d.distanceRatio - 1) > 0.25);
  if (bigDiv.length) {
    const per = tally(bigDiv.map((d) => short(d.configuration)));
    items.push({
      score: bigDiv.length * 30,
      text: `**Plan volume:** ${bigDiv.length} weekly plans differ from the baseline's distance by more than 25% (${Object.entries(per).map(([c, n]) => `${c} ${n}`).join(", ")}); worst ${bigDiv.slice(0, 3).map((d) => `${short(d.configuration)} ${d.key} x${d.distanceRatio!.toFixed(2)}`).join(", ")}.\n   Read these plans beside the baseline's; a ratio far from 1 on a rescued plan can also be a unit guessed wrong by mapRunFieldAliases.`,
    });
  }
  if (a.hardest.length) {
    items.push({
      score: a.hardest.length * 20,
      text: `**Hard inputs:** ${a.hardest.length} inputs fail in at least half the models that ran them: ${a.hardest.slice(0, 8).map((h) => `${h.key} (${h.failedIn.length}/${h.ran})`).join(", ")}.\n   Read these packets first when changing the prompt; they are the regression set.`,
    });
  }
  const still = Object.entries(a.rescue.stillFailingByError);
  if (still.length) {
    items.push({
      score: 0,
      text: `**Still failing after every repair:** ${a.rescue.stillFailing.length} replies; top remaining errors: ${still.slice(0, 5).map(([e, n]) => `\`${e}\` ${n}`).join("; ")}.\n   These need a prompt or schema change, not a repair.`,
    });
  }
  const coaching = a.coaching ? coachingHarnessItem(a.coaching, short) : null;
  if (coaching) items.push(coaching);
  items.sort((x, y) => y.score - x.score);
  lines.push(...items.map((it, i) => `${i + 1}. ${it.text}`));
  return lines;
}

function markdown(a: Analysis): string {
  const L: string[] = [];
  const total = a.rescue.failedPopulation;
  L.push("# Replay benchmark analysis", "");
  L.push(`Generated ${new Date().toISOString()} from ${ROOTS.map((r) => `\`${r}\``).join(", ")}. Baseline \`${BASELINE}\`. Rerun from \`api/\`: \`npm run replay:analyse -- --roots ${ROOTS.join(",")} --out ${OUT}${JUDGE ? ` --judge ${JUDGE} --answer-key ${ANSWER_KEY}` : ""}\`.`, "");
  L.push("Rows still running are read as they stand: a missing reply is missing, not failed.", "");
  L.push("## What to change in the harness", "");
  L.push(`Ranked from the numbers below. ${total} failed self-hosted replies had a refused attempt the repairs could work on; with every candidate repair, ${a.rescue.overall.all} pass the real validators (src/llm/schema.ts).`, "");
  L.push(...harnessChanges(a), "");
  if (warnings.length) L.push("Warnings while reading:", "", ...warnings.map((w) => `- ${w}`), "");

  // 1.
  L.push("## 1. Outcomes", "");
  L.push("Structured days (of seven): the days Cadence filed from the plan box, per valid weekly read, as the mean of seven and the share of all stored days. A run on the old nested form files every day by construction.", "");
  const structured = (c: string) => structuredDaysCell(a.planLines.find((p) => p.configuration === c)!.weekly);
  L.push(
    ...table(
      ["Configuration", "Operation", "Replies", "First try", "After retry", "Failed", "Structured days (of seven)", ...FAIL_CAUSES],
      a.outcomes.flatMap((o) => [
        [short(o.configuration), "all", o.all.replies, o.all.firstTry, o.all.afterRetry, o.all.failed, structured(o.configuration), ...FAIL_CAUSES.map((c) => o.all.failedBy[c])],
        ...Object.entries(o.byOperation).map(([op, x]) => ["", op, x.replies, x.firstTry, x.afterRetry, x.failed, op === "weekly_reply" ? structured(o.configuration) : "", ...FAIL_CAUSES.map((c) => x.failedBy[c])]),
      ]),
    ),
    "",
  );
  L.push("### Plan lines", "", "Per configuration, over valid replies: the weekly read's plan box (seven days) and mid-week replies' changes lines. First parse: dates that failed when the reply that counted was parsed, before the plan-lines retry; fixed: dates that retry filed. Bare numbers: a number with no unit. Dropped: lines for a date outside the plan week; ignored: lines with no day.", "");
  L.push(
    ...table(
      ["Configuration", "Form", "Box", "Replies", "Days filed", "Unparsed days", "Replies fully filed", "Failed on first parse", "Plan-lines retries", "Days fixed by the retry", "Bare numbers", "Dropped lines", "Ignored lines"],
      a.planLines.flatMap((p) =>
        ([["plan (weekly)", p.weekly], ["changes (mid-week)", p.midWeek]] as const)
          .filter(([, x]) => x.replies > 0)
          .map(([box, x], i) => [
            i === 0 ? short(p.configuration) : "",
            i === 0 ? p.form : "",
            box,
            x.replies,
            `${x.daysParsed} of ${x.daysTotal} (${pct(x.daysParsed, x.daysTotal)})`,
            x.unparsed,
            x.repliesAllParsed,
            x.failedFirst,
            x.retried,
            `${x.fixedByRetry} of ${x.retryAskedFor}`,
            x.bareNumbers,
            x.droppedLines,
            x.ignoredLines,
          ]),
      ),
    ),
    "",
  );
  L.push("### Plan-line failures by reason", "", "The parser's fixed reasons (src/prescribed/planLines.ts), over valid replies. A dropped line is one for a date outside the plan week.", "");
  L.push(
    ...(a.failuresByReason.length
      ? table(
          ["Configuration", "Box", "Reason", "Failed on first parse", "Fixed by the retry", "Still unparsed", "Lines dropped"],
          a.failuresByReason.map((f) => [short(f.configuration), f.operation === "weekly_reply" ? "plan" : "changes", f.reason, f.firstParse, f.fixedByRetry, f.stillUnparsed, f.droppedLines]),
        )
      : ["No plan line failed in any configuration."]),
    "",
  );

  L.push("### Plan rules tripped", "", "The plan check (src/prescribed/planCheck.ts, issue #58) run on each valid weekly read's plan against its packet, the same check the app runs on Sunday. Checked: weekly reads with a plan and a packet. A rule's column counts the replies whose plan tripped it; skipped counts the replies whose packet lacked the text the rule needs, so a low count is not a pass when the skipped count is high.", "");
  L.push(
    ...table(
      [
        "Configuration", "Replies checked", ...PLAN_RULES, "Replies with any rule", ...PLAN_RULES.map((r) => `${r} skipped`),
        // Shown only on runs with the rules retry, so earlier analyses read as before.
        ...(a.planRules.some((p) => p.rulesRetries > 0) ? ["Sent back for a rule"] : []),
      ],
      a.planRules.map((p) => [
        short(p.configuration), p.repliesChecked, ...PLAN_RULES.map((r) => p.byRule[r]), p.repliesWithAnyRule, ...PLAN_RULES.map((r) => p.skippedByRule[r]),
        ...(a.planRules.some((q) => q.rulesRetries > 0) ? [p.rulesRetries] : []),
      ]),
    ),
    "",
  );

  // 2.
  L.push("## 2. Failure taxonomy", "", "Every refused attempt's validator error, indices as [n]. First = attempt 1, retry = attempt 2.", "");
  L.push("### Across self-hosted models", "");
  L.push(...table(["Path", "Rule", "Kind", "First", "Retry"], a.failureTaxonomy.overall.map((t) => [t.path, t.rule, t.ruleLabel, t.first, t.retry])), "");
  L.push("### By path and model", "");
  const cfgs = a.configurations;
  L.push(...table(["Path", ...cfgs.map(short)], Object.entries(a.failureTaxonomy.byPathAcrossModels).sort((x, y) => sumValues(y[1]) - sumValues(x[1])).map(([p, by]) => [p, ...cfgs.map((c) => by[c] ?? 0)])), "");
  for (const c of a.candidates) {
    const t = a.failureTaxonomy.byConfiguration[c] ?? [];
    if (!t.length) continue;
    L.push(`### ${short(c)}`, "", ...table(["Path", "Rule", "First", "Retry"], t.slice(0, 10).map((x) => [x.path, x.rule, x.first, x.retry])), "");
  }

  // 3.
  L.push(
    "## 3. Retry effectiveness",
    "",
    "Replies whose attempt 1 was refused and that were asked once more, every operation. Since plan-as-text ticket 08 the second request carries the validator's message as an error tool result (`error_result`), a plain call-the-tool turn when no tool was called (`no_tool_call`), or the first request again when the reply was cut off (`resend`); runs before that re-sent the identical request. A reply accepted with plan lines that did not parse is asked to fix those dates (`fix_lines`); that retry is no refusal and is counted under Plan lines in section 1.",
    "",
  );
  L.push(...table(["Configuration", "Retried", "Fixed", "Same path and rule", "New error", "Same kind of error", "Attempt 2 failed outside the validator"], a.retry.filter((r) => r.retried).map((r) => [short(r.configuration), r.retried, `${r.fixed} (${pct(r.fixed, r.retried)})`, r.samePathAndRule, r.newError, r.sameKindOfError, r.secondFailedOutsideValidator])), "");
  L.push("Every second request, by how it was built (\"not recorded\": dry runs and runs before ticket 08):", "");
  L.push(...table(["Configuration", "Second requests"], a.retry.filter((r) => Object.keys(r.secondRequests).length).map((r) => [short(r.configuration), Object.entries(r.secondRequests).map(([k, n]) => `${k} ${n}`).join(", ")])), "");

  // 4.
  L.push("## 4. Rescue simulation", "");
  if (a.rescue.skippedRuns.length) {
    L.push(`Skipped for runs on the plan-as-text form, where the parser is the repair: ${a.rescue.skippedRuns.map((x) => `\`${x}\``).join(", ")}. The figures below cover the other runs only.`, "");
  }
  const ex = a.rescue.extraction;
  L.push(
    `Tool inputs read back from ${ex.refusedAttempts} refused attempts (${Object.entries(ex.byFormat).map(([f, n]) => `${f} ${n}`).join(", ")}); a tool input found in ${ex.toolInputFound}, unparsable tool JSON in ${ex.unparsedToolJson}, stray reply JSON in ${sumValues(ex.strayInputs)}. Re-running the validator on the extracted input reproduces the recorded error for ${ex.reproduced} of ${ex.checked} checked.`,
    "",
  );
  if (ex.notReproduced.length) L.push("Not reproduced (the input or validator differs from the run's):", "", ...ex.notReproduced.slice(0, 10).map((x) => `- ${x}`), "");
  L.push(`A reply counts as rescued when any of its refused attempts, repaired, passes the real validator. Population: ${total} failed replies with a workable refused attempt; ${a.rescue.notWorkable.length} failed replies had none (transport, timeouts, no attempt to read).`, "");
  L.push("### Each repair alone and cumulatively (greedy order over all models)", "");
  const pm = a.candidates.filter((c) => a.rescue.perModel[c]?.population);
  L.push(
    ...table(
      ["Repair", "Letter", "Alone", "Cumulative +", "Cumulative total", "Needed by (leave-one-out)", ...pm.map((c) => `${short(c)} (of ${a.rescue.perModel[c]!.population}) alone / cum. total`)],
      a.rescue.overall.cumulative.map((s) => [
        s.id,
        REPAIR_BY_ID.get(s.id)!.letter,
        a.rescue.overall.alone[s.id],
        s.gain,
        s.total,
        a.rescue.overall.neededBy[s.id],
        ...pm.map((c) => {
          const t = a.rescue.perModel[c]!;
          return `${t.alone[s.id]} / ${t.cumulative.find((x) => x.id === s.id)?.total ?? "–"}`;
        }),
      ]),
    ),
    "",
  );
  L.push(`With every repair: ${a.rescue.overall.all} of ${total} rescued. Per model: ${pm.map((c) => `${short(c)} ${a.rescue.perModel[c]!.all}/${a.rescue.perModel[c]!.population}`).join(", ")}.`, "");
  L.push(`Retries the repairs would have saved (accepted only after asking once more, attempt 1 rescued): ${Object.entries(a.rescue.retriesSaved).filter(([, v]) => v.retried).map(([c, v]) => `${short(c)} ${v.savedByAll}/${v.retried}`).join(", ") || "none"}.`, "");
  L.push("### Rescued replies and the smallest set each needs", "");
  L.push(
    ...table(
      ["Configuration", "Reply", "Operation", "Rescued", "Attempt", "Needs", "Run days / km planned"],
      a.rescue.details.map((d) => [short(d.configuration), `${d.key}.${d.repeat}`, d.operation, d.rescued ? "yes" : "no", d.attempt ?? "", d.needs.join(", "), d.runDays === null ? "" : `${d.runDays} / ${fmt(d.plannedKm, 1)}`]),
    ),
    "",
  );
  const empty = a.rescue.details.filter((d) => d.rescued && d.runDays === 0);
  if (empty.length) L.push(`Rescued plans with no run day (valid but empty, worth reading): ${empty.map((d) => `${short(d.configuration)} ${d.key}`).join(", ")}.`, "");
  L.push("### Still failing after every repair", "");
  L.push(...table(["Remaining error", "Replies"], Object.entries(a.rescue.stillFailingByError)), "");
  L.push(...table(["Configuration", "Reply", "Attempt", "Error"], a.rescue.stillFailing.map((s) => [short(s.configuration), s.key, s.attempt, s.error])), "");
  if (a.rescue.notWorkable.length) L.push("Failed with nothing to repair:", "", ...table(["Configuration", "Reply", "Cause", "Error"], a.rescue.notWorkable.map((n) => [short(n.configuration), n.key, n.cause, n.error])), "");
  L.push("### Enum values seen (refused attempts)", "", "Values sent for dayType and run.type outside the enum, and the day fields sent in place of dayType, with what the near-miss map (`mapEnumNearMisses`) makes of them.", "");
  L.push(...table(["Field", "Value", "Maps to", ...a.candidates.map(short)], a.rescue.enumSeen.map((e) => [e.field, e.value, e.mapped ?? "(unmapped)", ...a.candidates.map((c) => e.byConfiguration[c] ?? 0)])), "");
  L.push("### Every shape problem in refused attempts", "", "The validator stops at the first error; these are all the problems each refused tool input has (attempts with each).", "");
  L.push(...table(["Problem", ...a.candidates.map(short)], Object.entries(a.rescue.shapeIssues).map(([k, by]) => [k, ...a.candidates.map((c) => by[c] ?? 0)])), "");
  L.push("### Keys outside the tool schema (refused attempts, attempts using each)", "");
  L.push(...table(["Key", ...a.candidates.map(short)], Object.entries(a.rescue.unknownKeys).map(([k, by]) => [k, ...a.candidates.map((c) => by[c] ?? 0)])), "");

  // 5.
  L.push("## 5. Quality signals", "", "Valid replies as the run saved them; rescued replies (section 4) apart, with the validator's own soft repairs on the repaired input.", "");
  const qRow = (c: string, q: (typeof a.quality)[number]["valid"]) => [
    short(c),
    q.label,
    q.replies,
    `${q.softRepairReplies}: ${Object.entries(q.softRepairs).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(", ")}`,
    Object.entries(q.capsHit).map(([k, n]) => `${k} ${n}`).join(", "),
    Object.entries(q.goalCheckFailures).map(([k, n]) => `${k} ${n}`).join(", "),
    Object.entries(q.bannedTerms).map(([k, n]) => `${k} ${n}`).join(", "),
    `${q.planFlagged}: ${Object.entries(q.planFlags).map(([k, n]) => `${k} ${n}`).join(", ")}`,
    spreadCells(q.volumeRatio),
  ];
  L.push(
    ...table(
      ["Configuration", "Replies", "n", "Soft repairs (replies: by field)", "Caps hit", "Goal-check failures", "Banned vocabulary", "Plan sanity flagged", "Volume ratio med / p90 / worst"],
      a.quality.flatMap((q) => [qRow(q.configuration, q.valid), ...(q.rescued.replies ? [qRow(q.configuration, q.rescued)] : [])]),
    ),
    "",
  );
  const baseNoGoal = a.quality.find((q) => isBaseline(q.configuration))?.valid.goalCheckFailures["no goal line"] ?? 0;
  if (baseNoGoal) L.push(`The baseline fails "no goal line" on ${baseNoGoal} replies too: those inputs carry no goal (the demo snapshot's prompt opens "Athlete goal: not set."), so that count is the input's, not the model's.`, "");
  const changes = a.quality.filter((q) => q.rescued.repairChanges);
  if (changes.length) {
    L.push("What the repairs changed in rescued replies (normalised):", "");
    for (const q of changes) L.push(`- ${short(q.configuration)}: ${Object.entries(q.rescued.repairChanges!).slice(0, 8).map(([k, n]) => `${k} (${n})`).join("; ")}`);
    L.push("");
  }

  // 6.
  L.push("## 6. Plans against the baseline", "", `Weekly replies valid on both sides, same input, baseline repeat 1. Ratios are candidate over baseline, over the days both sides filed; an unparsed day counts as no plan and is left out of the ratios. Cells are median / p90 / worst.`, "");
  const pRow = (c: string, label: string, p: (typeof a.plans)[number]["valid"]) => [
    short(c),
    label,
    p.pairs,
    `${p.unparsed.candidate} / ${p.unparsed.baseline} (in ${p.pairsWithUnparsed} pairs)`,
    spreadCells(p.distanceRatio),
    spreadCells(p.longRunRatio),
    spreadCells(p.runDaysDiff),
    fmt(p.dayTypeMatch.median),
    `${p.sameRestDays}/${p.pairs}`,
    `${p.qualityBoth} both, +${p.qualityOnlyCandidate}, -${p.qualityOnlyBaseline}`,
    `${fmt(p.flags.candidate.median)} vs ${fmt(p.flags.baseline.median)}`,
    `${fmt(p.answers.candidate.median)} vs ${fmt(p.answers.baseline.median)} (fewer in ${p.answersFewer})`,
    `${fmt(p.headlineChars.candidate.median, 0)} vs ${fmt(p.headlineChars.baseline.median, 0)}`,
    `${fmt(p.analysisChars.candidate.median, 0)} vs ${fmt(p.analysisChars.baseline.median, 0)}`,
  ];
  L.push(
    ...table(
      ["Configuration", "Replies", "Pairs", "Unparsed days (cand / base)", "Weekly distance ratio", "Long-run ratio", "Run days (cand - base)", "Day-type match (median)", "Same rest days", "Quality session", "Flags (median)", "Answers (median)", "Headline chars", "Analysis chars"],
      a.plans.flatMap((p) => [pRow(p.configuration, "valid", p.valid), ...(p.rescued.pairs ? [pRow(p.configuration, "rescued", p.rescued)] : [])]),
    ),
    "",
  );
  L.push("### Big divergences", "", "Weekly distance off by more than 25%, long run off by more than 25%, day types matching on fewer than half the days, a quality session on one side only, or fewer answers.", "");
  L.push(...table(["Configuration", "Input", "Source", "Divergence"], a.divergences.map((d) => [short(d.configuration), `${d.key}.${d.repeat}`, d.source, d.issues.join("; ")])), "");

  // 7.
  L.push("## 7. Per-input difficulty", "");
  L.push(...table(["Input", "Operation", "Source", ...a.configurations.map(short)], a.difficulty.map((d) => [d.key, d.operation, d.source ?? "", ...a.configurations.map((c) => d.status[c])])), "");
  L.push(`Inputs failing in at least half the self-hosted models that ran them: ${a.hardest.map((h) => `${h.key} (${h.failedIn.map(short).join(", ")})`).join("; ") || "none"}.`, "");

  // 8.
  L.push("## 8. Cost and speed", "", "Per reply: time to first token (attempt 1) and total (retry included). Per attempt: tokens and thinking characters. Cells are median / p90 / worst.", "");
  L.push(
    ...table(
      ["Configuration", "Operation", "Replies", "First token", "Total", "Input tokens", "Output tokens", "Thinking chars", "Thinking chars refused vs accepted (median)", "r(thinking, refused)", "Cost"],
      a.speed.flatMap((s) => [
        ["all", s.all] as const,
        ...Object.entries(s.byOperation).map(([o, x]) => [o, x] as const),
      ].map(([op, x], i) => [
        i === 0 ? short(s.configuration) : "",
        op,
        x.replies,
        spreadCells(x.firstTokenMs, secs),
        spreadCells(x.totalMs, secs),
        spreadCells(x.inputTokens, (n) => fmt(n, 0)),
        spreadCells(x.outputTokens, (n) => fmt(n, 0)),
        spreadCells(x.thinkingChars, (n) => fmt(n, 0)),
        `${fmt(x.thinkingCharsRefused.median, 0)} vs ${fmt(x.thinkingCharsAccepted.median, 0)}`,
        fmt(x.thinkingVsRefusalR),
        x.costUsd === null ? "–" : `$${x.costUsd.toFixed(2)}`,
      ])),
    ),
    "",
  );
  L.push("measures.json per root (cost as the replay priced it; a reply count below the files now present means it is stale):", "");
  L.push(...table(["Configuration", "Root", "measures.json replies", "Files now", "Cost (measures.json)"], a.speed.flatMap((s) => s.measuresJson.map((m) => [short(s.configuration), m.root, m.measuredReplies ?? "–", m.filesNow, m.totalUsd === null ? "–" : `$${m.totalUsd.toFixed(2)}`]))), "");
  L.push("Thinking characters are counted from the thinking blocks in each attempt's saved response (oMLX and vLLM report no thinking tokens). r is the point-biserial correlation between an attempt's thinking length and being refused.", "");

  // 9.
  if (a.coaching) L.push(...coachingMarkdown(a.coaching, { table, short, fmt }));
  return L.join("\n");
}

const CSV_COLUMNS = [
  "root",
  "configuration",
  "provider",
  "model",
  "input_id",
  "repeat",
  "operation",
  "attempt",
  "attempts_made",
  "reply_outcome",
  "fail_cause",
  "attempt_outcome",
  "request_kind",
  "error",
  "error_path",
  "error_rule",
  "error_kind",
  "stop_reason",
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "thinking_chars",
  "ttft_ms",
  "attempt_total_ms",
  "cost_usd",
  "tool_input",
  "error_reproduced",
  "unknown_keys",
  "rescued_alone_by",
  "rescued_by_all",
  "remaining_error",
] as const;

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(replies: Reply[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const r of replies) {
    for (const a of r.attempts) {
      const ex = a.extracted;
      const toolInput = !ex ? "" : ex.toolInput !== null ? "tool call" : ex.unparsedToolJson ? "unparsed" : ex.strayInput ? `stray (${ex.strayInput.from})` : "none";
      const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
        root: r.root,
        configuration: r.configuration,
        provider: r.provider,
        model: r.model,
        input_id: r.inputId,
        repeat: r.repeat,
        operation: r.operation,
        attempt: a.attempt,
        attempts_made: r.attempts.length,
        reply_outcome: r.outcome,
        fail_cause: r.failCause,
        attempt_outcome: a.outcome,
        request_kind: a.requestKind,
        error: a.error,
        error_path: a.normalised?.path,
        error_rule: a.normalised?.rule,
        error_kind: a.normalised?.kind,
        stop_reason: a.stopReason,
        input_tokens: a.usage.inputTokens,
        output_tokens: a.usage.outputTokens,
        thinking_tokens: a.usage.thinkingTokens,
        thinking_chars: a.thinkingChars,
        ttft_ms: a.ttftMs,
        attempt_total_ms: a.totalMs,
        cost_usd: a.costUsd === null ? null : a.costUsd.toFixed(5),
        tool_input: toolInput,
        error_reproduced: a.reproduced,
        unknown_keys: ex ? [...new Set(unknownKeys(r.operation, ex.toolInput))].join(" ") : "",
        rescued_alone_by: a.rescuedAlone.join(" "),
        rescued_by_all: a.rescuedByAll,
        remaining_error: a.remainingError,
      };
      rows.push(CSV_COLUMNS.map((c) => csvField(values[c])).join(","));
    }
  }
  return rows.join("\n") + "\n";
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Each configuration's setup as its config.json in each root records it, for
 * the published report. Only these fields: the server host is left out.
 */
export type SetupRow = {
  configuration: string;
  roots: Array<{
    root: string;
    provider: string | null;
    model: string | null;
    effort: string | null;
    repeats: number | null;
    note: string | null;
    inputs: string | null;
    startedAt: string | null;
    harnessCommit: string | null;
  }>;
};

function setupOf(configurations: string[], configs: ReturnType<typeof loadReplies>["configs"]): SetupRow[] {
  return configurations.map((configuration) => ({
    configuration,
    roots: configs.get(configuration)!.dirs.map((dir) => {
      const c = (readJson(path.join(dir, "config.json")) ?? {}) as ConfigFile;
      return {
        root: path.basename(path.dirname(dir)),
        provider: c.provider ?? null,
        model: c.model ?? null,
        effort: c.effort ?? null,
        repeats: c.repeats ?? null,
        note: c.note ?? null,
        inputs: c.inputs ?? null,
        startedAt: c.startedAt ?? null,
        harnessCommit: c.harnessCommit ?? null,
      };
    }),
  }));
}

/** analysis.json as main() writes it. */
export type AnalysisFile = Analysis & {
  generatedAt: string;
  roots: string[];
  baseline: string;
  warnings: string[];
  repairs: Array<{ id: string; letter: string; label: string; lossy: boolean; liftTo: string }>;
  setup: SetupRow[];
};

function main(): void {
  if (ROOTS.length === 0) throw new Error("--roots needs at least one output root.");
  for (const root of ROOTS) {
    if (inside(OUT, root) || inside(root, OUT)) throw new Error(`--out ${OUT} overlaps the root ${root}; the analysis never writes into a root.`);
  }
  const { replies, configs } = loadReplies();
  if (replies.length === 0) throw new Error(`No reply files under ${ROOTS.join(", ")}.`);
  const a = analyse(replies, configs);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "analysis.md"), markdown(a));
  const json = {
    generatedAt: new Date().toISOString(),
    roots: ROOTS,
    baseline: BASELINE,
    warnings,
    repairs: CANDIDATE_REPAIRS.map(({ apply: _apply, ...r }) => r),
    setup: setupOf(a.configurations, configs),
    ...a,
  };
  writeFileSync(path.join(OUT, "analysis.json"), JSON.stringify(json, null, 2));
  writeFileSync(path.join(OUT, "replies.csv"), csv(replies));
  console.log(`${replies.length} replies across ${a.configurations.length} configurations; ${a.rescue.overall.all} of ${a.rescue.failedPopulation} failed replies rescued by the candidate repairs.`);
  console.log(`Written to ${OUT}: analysis.md, analysis.json, replies.csv`);
  for (const w of warnings) console.warn(`warning: ${w}`);
}

// Run only as a script, so scripts/replay-publish.ts can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
