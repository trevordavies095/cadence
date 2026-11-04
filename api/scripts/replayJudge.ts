/**
 * The coaching judge in the replay harness (coaching-quality 09): a model
 * scores drafts blind, as the coach scored them on his form, and its scores
 * are calibrated against his answer key before any are used.
 *
 * What the judge sees is what the form showed: the athlete card (athleteCard)
 * and one draft (draftLines), at the cuts the form's page used, through the
 * judge call in src/llm/judge.ts. Never the configuration, another draft, or
 * the coach's answers.
 *
 * Two jobs, both through scripts/replay-judge.ts (whose header has the commands):
 *
 * - Calibrate: score the form's drafts (the coach-packet key's 14 cases x 3)
 *   with one or more judges and compare with the answer key
 *   (.scratch/benchmark-coaching/coach-packet/returned/answer-key.json, private; reviewer "coach"):
 *   pick agreement per case, unsafe recall and precision per draft, rating mean
 *   absolute difference and share within one point, against CALIBRATION_BAR.
 *   Writes calibration.md and calibration.json.
 * - Score: every reply of every configuration and repeat in a baseline root.
 *
 * Scores land at <scores>/<judge configuration>/<root>/<configuration>/<NN>.<R>.json,
 * mirroring the baseline reply they judge, so calibration's 42 are reused by
 * the full scoring. A score file that exists with outcome "ok" is never asked
 * for again; one with outcome "failed" is.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askAtMostTwice, createAnthropicLlmPort, MAX_OUTPUT_TOKENS } from "../src/llm/anthropic.js";
import { anthropicCoachTarget } from "../src/llm/coachTarget.js";
import type { AnthropicEffort } from "../src/llm/effort.js";
import {
  buildStubJudgement,
  JUDGE_TOOL_NAME,
  judgeSystemPrompt,
  judgeToolSchema,
  judgeUserPrompt,
  type CoachingJudgeInput,
  type CoachingJudgement,
} from "../src/llm/judge.js";
import { LlmSchemaError, type AttemptReport, type AttemptRequest, type LlmPort } from "../src/llm/port.js";
import { createStubLlmPort } from "../src/llm/stub.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/types.js";
import { createInstrumentedFetch, timeToFirstTokenMs } from "./instrumentedFetch.js";
import {
  athleteCard,
  athleteKey,
  CUTS,
  DESCRIPTION_CAP,
  DRAFTS,
  draftLines,
  type CoachAthlete,
  type CoachPacketKey,
  type Cuts,
} from "./replayCoachPacket.js";
import { attemptCostUsd, estimatePromptTokens, PRICE_TABLE, type Usage } from "./replayMeasures.js";
import type { ReplySide, ReviewInput } from "./replayReview.js";

// ---- Judges ------------------------------------------------------------------------

/** One judge: always Anthropic, a model and a fixed effort. */
export type Judge = { provider: "anthropic"; model: string; effort: AnthropicEffort };

/** The effort a judge runs at unless told otherwise: high, not xhigh or max (the 5.5 models think heavily). */
export const DEFAULT_JUDGE_EFFORT: AnthropicEffort = "high";

/** A judge's folder name, as a configuration's: provider--model--effort. */
export function judgeConfiguration(judge: Judge): string {
  return `${judge.provider}--${judge.model.replace(/[^A-Za-z0-9._-]/g, "_")}--${judge.effort}`;
}

// ---- The pick rule (shared with ticket 10) ---------------------------------------------

export type DraftScore = { draft: string; rating: number | null; unsafe: boolean | null };

/**
 * The draft a scorer would send: the highest rating among the drafts not
 * unsafe, ties to the earlier letter; "none" when every draft is unsafe. Null
 * when it cannot be told: a draft with no unsafe answer, or a draft not
 * unsafe with no rating.
 */
export function pickDraft(drafts: DraftScore[]): string | "none" | null {
  const ordered = [...drafts].sort((a, b) => a.draft.localeCompare(b.draft));
  if (ordered.some((d) => d.unsafe === null || (d.unsafe === false && d.rating === null))) return null;
  let best: DraftScore | null = null;
  for (const d of ordered) {
    if (d.unsafe) continue;
    if (!best || d.rating! > best.rating!) best = d;
  }
  return best ? best.draft : "none";
}

/**
 * Every draft the pick rule could land on: the drafts not unsafe sharing the
 * highest rating, ["none"] when every draft is unsafe, null as pickDraft.
 * Calibration shares a case's credit among them, as the analysis shares picks.
 */
export function topDrafts(drafts: DraftScore[]): string[] | null {
  if (pickDraft(drafts) === null) return null;
  const safe = drafts.filter((d) => !d.unsafe);
  if (!safe.length) return ["none"];
  const best = Math.max(...safe.map((d) => d.rating!));
  return safe.filter((d) => d.rating === best).map((d) => d.draft).sort();
}

// ---- What the judge is shown -----------------------------------------------------------

/** One reply to be judged, with everything needed to show it as the form did. */
export type JudgeJob = {
  /** The root's folder name, such as seasons. */
  root: string;
  configuration: string;
  /** The input id, such as "22". */
  id: string;
  repeat: number;
  side: ReplySide;
  input: ReviewInput;
  athlete: CoachAthlete;
  cuts: Cuts;
};

/** The heading a draft is shown under: one draft per call, so no letter. */
export const JUDGE_DRAFT_HEADING = "── THE DRAFT ──";

/** What the judge is given for a job: the card and the one draft at the job's cuts. */
export function judgeInputFor(job: JudgeJob, rubric: string): CoachingJudgeInput {
  return {
    rubric,
    card: athleteCard(job.input, job.athlete),
    draft: [JUDGE_DRAFT_HEADING, ...draftLines(job.side, "A", job.athlete.name, job.cuts).slice(1)],
  };
}

/** The cuts the form's page used for these three drafts: the widest under the description cap, as writeCoachPacket chooses. */
export function formPageCuts(input: ReviewInput, athlete: CoachAthlete, sides: ReplySide[]): Cuts {
  const page = (cuts: Cuts) =>
    [athleteCard(input, athlete).join("\n"), ...sides.map((s, j) => draftLines(s, DRAFTS[j]!, athlete.name, cuts).join("\n"))].join("\n\n");
  return CUTS.find((c) => page(c).length <= DESCRIPTION_CAP) ?? CUTS[CUTS.length - 1]!;
}

/** A reply of any repeat: NN.R.json when it was accepted, else NN.R.failed.json, else missing. */
export function readReply(configDir: string, id: string, repeat: number): ReplySide {
  const ok = path.join(configDir, `${id}.${repeat}.json`);
  if (existsSync(ok)) return { status: "ok", file: ok, saved: JSON.parse(readFileSync(ok, "utf8")) };
  const failed = path.join(configDir, `${id}.${repeat}.failed.json`);
  if (existsSync(failed)) return { status: "failed", file: failed, saved: JSON.parse(readFileSync(failed, "utf8")) };
  return { status: "missing" };
}

/** Configuration folders (those with a config.json) in a root. */
export function configurationsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "config.json")))
    .map((e) => e.name)
    .sort();
}

export type JobSources = {
  /** Output roots, each holding configuration folders; named by folder name. */
  roots: string[];
  /** The coach's athletes by athleteKey. */
  athletes: Record<string, CoachAthlete>;
  /** Rebuilds a root's inputs from a configuration folder's config.json; null when they cannot be. */
  loadInputs: (configDir: string) => ReviewInput[] | null;
};

function rootsByName(roots: string[]): Map<string, string> {
  const byName = new Map(roots.map((r) => [path.basename(r), r]));
  if (byName.size !== roots.length) throw new Error("Two roots share a folder name; inputs name their root by folder name, so each needs its own.");
  return byName;
}

/** A root's inputs, rebuilt once from the first configuration folder that can. */
function inputsLoader(sources: JobSources, byName: Map<string, string>) {
  const cache = new Map<string, ReviewInput[]>();
  return (root: string): ReviewInput[] => {
    if (!cache.has(root)) {
      const dir = byName.get(root);
      if (!dir) throw new Error(`No root is named ${root} (roots: ${[...byName.keys()].join(", ")}).`);
      const inputs = configurationsIn(dir).map((c) => sources.loadInputs(path.join(dir, c))).find((i) => i !== null);
      if (!inputs) throw new Error(`${root}: the inputs could not be rebuilt from any configuration's config.json.`);
      cache.set(root, inputs);
    }
    return cache.get(root)!;
  };
}

function athleteFor(sources: JobSources, root: string, input: ReviewInput): CoachAthlete | null {
  const a = sources.athletes[athleteKey(root, input.source)];
  return a && typeof a === "object" && a.name && a.introduction ? a : null;
}

/** "seasons/22" from a root and id, the way the hard set and the form key name inputs. */
const inputName = (root: string, id: string) => `${root}/${id}`;

/**
 * The form's 42 drafts as jobs, from the coach-packet key: each case's three
 * drafts (repeat 1), shown at the cuts that case's page used.
 */
export function calibrationJobs(key: CoachPacketKey, sources: JobSources): JudgeJob[] {
  const byName = rootsByName(sources.roots);
  const inputsOf = inputsLoader(sources, byName);
  return key.cases.flatMap((c) => {
    const [root, rawId] = c.input.split("/") as [string, string];
    const input = inputsOf(root).find((i) => Number(i.id) === Number(rawId));
    if (!input) throw new Error(`${c.input}: no such input in ${root}.`);
    const athlete = athleteFor(sources, root, input);
    if (!athlete) throw new Error(`${c.input}: no athlete introduced for ${athleteKey(root, input.source)}.`);
    const sides = c.drafts.map((d) => readReply(path.join(byName.get(root)!, d.configuration), input.id, d.repeat));
    const cuts = formPageCuts(input, athlete, sides);
    return c.drafts.map((d, j) => ({ root, configuration: d.configuration, id: input.id, repeat: d.repeat, side: sides[j]!, input, athlete, cuts }));
  });
}

/** Reply files in a configuration folder as (id, repeat), accepted or refused, in order. */
function repliesIn(configDir: string): Array<{ id: string; repeat: number }> {
  const seen = new Map<string, { id: string; repeat: number }>();
  for (const f of readdirSync(configDir)) {
    const m = /^(\d+)\.(\d+)(?:\.failed)?\.json$/.exec(f);
    if (m) seen.set(`${m[1]}.${m[2]}`, { id: m[1]!, repeat: Number(m[2]) });
  }
  return [...seen.values()].sort((a, b) => Number(a.id) - Number(b.id) || a.repeat - b.repeat);
}

export type BaselineOptions = JobSources & {
  /** Limit to these configurations; every folder in the roots when null. */
  configurations: string[] | null;
  /** Limit to repeats 1 to this; every repeat when null. */
  repeats: number | null;
  /** The form's key, so a reply that was on the form is shown at that page's cuts; null shows every reply at the widest cuts. */
  key: CoachPacketKey | null;
};

/**
 * Every weekly read in the roots as jobs: each configuration, input and
 * repeat, a refused reply included (the form shows it as no reply arrived).
 * A reply that was a form draft is shown at its page's cuts, any other at the
 * widest. Inputs with no athlete on the card list are skipped and noted.
 */
export function baselineJobs(options: BaselineOptions): { jobs: JudgeJob[]; notes: string[] } {
  const byName = rootsByName(options.roots);
  const inputsOf = inputsLoader(options, byName);
  const formCuts = new Map<string, Cuts>();
  if (options.key) {
    // A run over one root (a gate's --only) shows only that root's form drafts at their page's cuts.
    const key = { ...options.key, cases: options.key.cases.filter((c) => byName.has(c.input.split("/")[0]!)) };
    const calibration = calibrationJobs(key, options);
    for (const j of calibration) formCuts.set(`${inputName(j.root, j.id)}|${j.configuration}|${j.repeat}`, j.cuts);
  }
  const notes: string[] = [];
  const jobs: JudgeJob[] = [];
  for (const [root, dir] of byName) {
    const present = configurationsIn(dir);
    const configurations = options.configurations ? options.configurations.filter((c) => present.includes(c)) : present;
    const inputs = inputsOf(root);
    for (const configuration of configurations) {
      for (const { id, repeat } of repliesIn(path.join(dir, configuration))) {
        if (options.repeats !== null && repeat > options.repeats) continue;
        const input = inputs.find((i) => Number(i.id) === Number(id));
        if (!input) {
          notes.push(`${inputName(root, id)}: no such input in ${root}; ${configuration} repeat ${repeat} skipped.`);
          continue;
        }
        if (input.operation !== "weekly_reply") continue;
        const athlete = athleteFor(options, root, input);
        if (!athlete) {
          notes.push(`${inputName(root, id)}: no athlete introduced for ${athleteKey(root, input.source)}; skipped.`);
          continue;
        }
        const side = readReply(path.join(dir, configuration), id, repeat);
        const cuts = formCuts.get(`${inputName(root, input.id)}|${configuration}|${repeat}`) ?? CUTS[0]!;
        jobs.push({ root, configuration, id: input.id, repeat, side, input, athlete, cuts });
      }
    }
  }
  return { jobs, notes: [...new Set(notes)] };
}

// ---- Score files -------------------------------------------------------------------------

/** One attempt's timing and, on a live run, how its request was built and what it cost. */
type AttemptTiming = {
  attempt: number;
  ttftMs: number | null;
  totalMs: number;
  request?: AttemptRequest;
  outcome?: string | null;
  repairs?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

type Refusal = {
  attempt: number;
  error: string;
  outcome: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  responseRaw: unknown;
  request?: AttemptRequest;
};

/** What one score file holds. */
export type ScoreFile = {
  /** "<root>/<NN>", as the form key and the hard set name inputs. */
  input: string;
  configuration: string;
  repeat: number;
  /** How the judged reply itself came back: a refused reply is judged as no reply arrived. */
  draftStatus: ReplySide["status"];
  /** The judge call's outcome. */
  outcome: "ok" | "failed";
  rating: CoachingJudgement["rating"] | null;
  unsafe: boolean | null;
  unsafeReason: string | null;
  reason: string | null;
  judge: Judge;
  judgedAt: string;
  dryRun: boolean;
  /** The judge call's error, when it failed. */
  error: string | null;
  repairs: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  estimatedInputTokens: number | null;
  /** Every attempt priced from PRICE_TABLE; null when nothing was billed or the model is not in it. */
  costUsd: number | null;
  timing: { ttftMs: number | null; totalMs: number; attempts: AttemptTiming[] };
  refusedAttempts: Refusal[];
  /** The tool input the accepted score came from. */
  toolInput: unknown;
  /** The cuts the draft was shown at. */
  cuts: Cuts;
  /** The user turn exactly as sent: the card and the one draft. */
  shown: string;
};

/** Where a job's score file goes under the scores folder. */
export function scoreFile(scoresDir: string, judge: Judge, job: Pick<JudgeJob, "root" | "configuration" | "id" | "repeat">): string {
  return path.join(scoresDir, judgeConfiguration(judge), job.root, job.configuration, `${job.id}.${job.repeat}.json`);
}

/** A score file, or null when there is none or it does not read. */
export function readScore(file: string): ScoreFile | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ScoreFile;
  } catch {
    return null;
  }
}

/** Whether a job still needs a call: no score file, or one whose call failed. */
export function needsScore(scoresDir: string, judge: Judge, job: JudgeJob): boolean {
  return readScore(scoreFile(scoresDir, judge, job))?.outcome !== "ok";
}

// ---- The cost estimate ---------------------------------------------------------------------

/**
 * Output tokens a judge call is assumed to bill, by effort, thinking included.
 * Grounded on the coaching baseline (2026-11-03): Opus 5.5 at xhigh billed a
 * median of 11,469 output tokens on a weekly read, most of it thinking; a
 * judge writes far less, but thinks as hard at the same effort. Each lower
 * level is taken at about half the one above. High is measured: the two
 * Opus 5.5 calibrations (84 calls) billed a mean of 918 and at most 1,396, so
 * high is that maximum rounded up, and low and medium follow it down.
 */
export const JUDGE_OUTPUT_TOKENS_BY_EFFORT: Record<AnthropicEffort, number> = {
  low: 1_000,
  medium: 1_200,
  high: 1_500,
  xhigh: 11_500,
  max: 20_000,
};

/** The tool-use system prompt Anthropic adds (286 tokens on Opus 5.5, 675 on Opus 4.7, per the pricing page), rounded up. */
export const TOOL_SYSTEM_TOKENS = 700;

/** The rubric's size when the doc is not written yet (ticket 08): the draft rubric's five qualities and six checks, about 6,000 characters. */
export const PLACEHOLDER_RUBRIC_TOKENS = 1_500;

export type JudgeEstimate = {
  judge: string;
  model: string;
  calls: number;
  /** Already scored, so not called again. */
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  /** At the assumed output per call. */
  usd: number;
  /** If every call billed the full output cap once. */
  ceilingUsd: number;
  /** True when PRICE_TABLE has no price for the model. */
  unpriced: boolean;
};

/** One call's input tokens: the system prompt and the user turn by the harness's chars/4 rule, the tool schema, and the tool-use prompt. */
export function estimateJudgeInputTokens(input: CoachingJudgeInput, rubricMissing: boolean): number {
  const prompt =
    estimatePromptTokens({ system: judgeSystemPrompt(input.rubric), messages: [{ content: judgeUserPrompt(input) }] }) ?? 0;
  return prompt + Math.round(JSON.stringify(judgeToolSchema()).length / 4) + TOOL_SYSTEM_TOKENS + (rubricMissing ? PLACEHOLDER_RUBRIC_TOKENS : 0);
}

/** `calls` judge calls billing `inputTokens` in all, priced with the effort's assumed output. */
function priceJudgeCalls(judge: Judge, calls: number, skipped: number, inputTokens: number): JudgeEstimate {
  const outputTokens = calls * JUDGE_OUTPUT_TOKENS_BY_EFFORT[judge.effort];
  const price = PRICE_TABLE.models[judge.model];
  const usd = price ? (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1e6 : 0;
  const ceilingUsd = price ? (inputTokens * price.inputPerMTok + calls * MAX_OUTPUT_TOKENS * price.outputPerMTok) / 1e6 : 0;
  return {
    judge: judgeConfiguration(judge),
    model: judge.model,
    calls,
    skipped,
    inputTokens,
    outputTokens,
    usd,
    ceilingUsd,
    unpriced: !price,
  };
}

/** What scoring `jobs` with `judge` would bill, skipping those already scored under `scoresDir`. */
export function estimateJudge(jobs: JudgeJob[], judge: Judge, rubric: string, rubricMissing: boolean, scoresDir: string): JudgeEstimate {
  const todo = jobs.filter((j) => needsScore(scoresDir, judge, j));
  const inputTokens = todo.reduce((n, j) => n + estimateJudgeInputTokens(judgeInputFor(j, rubric), rubricMissing), 0);
  return priceJudgeCalls(judge, todo.length, jobs.length - todo.length, inputTokens);
}

/**
 * The athlete card and one draft of a hard-set weekly read, in input tokens,
 * beyond the rubric and the tool parts. Measured on the baseline's scoring
 * (2026-11-04): Opus 5.5 judge calls billed about 2,500 input tokens, of which
 * the rubric and the tool parts are about 1,650; rounded up.
 */
export const JUDGE_CARD_AND_DRAFT_TOKENS = 1_000;

/**
 * What `calls` judge calls would bill before the replies they judge exist (the
 * coaching gate prices its judging before the replay): each call the rubric
 * and the tool parts, JUDGE_CARD_AND_DRAFT_TOKENS for the card and the draft,
 * and the effort's assumed output.
 */
export function estimateJudgeCalls(calls: number, judge: Judge, rubric: string, rubricMissing: boolean): JudgeEstimate {
  const perCall = estimateJudgeInputTokens({ rubric, card: [], draft: [] }, rubricMissing) + JUDGE_CARD_AND_DRAFT_TOKENS;
  return priceJudgeCalls(judge, calls, 0, calls * perCall);
}

/** The estimate as printed, one line per judge, then the total. */
export function describeJudgeEstimate(estimates: JudgeEstimate[], rubricMissing: boolean): string[] {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const lines = estimates.map((e) => {
    if (e.unpriced) return `  ${e.judge}: ${e.calls} calls; ${e.model} is not in PRICE_TABLE, so no estimate. Add it before a live run.`;
    const price = PRICE_TABLE.models[e.model]!;
    const each = e.calls ? ` (about ${Math.round(e.inputTokens / e.calls)} in and ${Math.round(e.outputTokens / e.calls)} out a call)` : "";
    const skipped = e.skipped ? `; ${e.skipped} already scored, skipped` : "";
    return `  ${e.judge}: ${e.calls} calls${each} at $${price.inputPerMTok}/$${price.outputPerMTok} per MTok = ${usd(e.usd)}, at most ${usd(e.ceilingUsd)} if every call ran to the ${MAX_OUTPUT_TOKENS}-token cap${skipped}`;
  });
  const total = estimates.reduce((n, e) => n + e.usd, 0);
  const ceiling = estimates.reduce((n, e) => n + e.ceilingUsd, 0);
  lines.push(`  total ${usd(total)} (at most ${usd(ceiling)}); prices taken ${PRICE_TABLE.takenOn}; output assumed per effort (JUDGE_OUTPUT_TOKENS_BY_EFFORT), a retry not counted`);
  if (rubricMissing) lines.push(`  the rubric doc is not written yet: each call counts ${PLACEHOLDER_RUBRIC_TOKENS} tokens for it`);
  return lines;
}

// ---- Running the judge ---------------------------------------------------------------------

/** Keeps the call's log rows in memory, for the usage and the repairs. */
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

/** The usage a call log row reports. */
function rowUsage(row: LlmCallRecord | undefined): Usage {
  return {
    inputTokens: row?.inputTokens ?? null,
    outputTokens: row?.outputTokens ?? null,
    thinkingTokens: row?.thinkingTokens ?? null,
    cacheReadTokens: row?.cacheReadTokens ?? null,
    cacheCreationTokens: row?.cacheCreationTokens ?? null,
  };
}

/** The judge tool's input in a logged response: the whole message JSON on a live call, the tool input itself on the stub. */
function toolInputOf(responseRaw: string | null | undefined): unknown {
  if (!responseRaw) return null;
  try {
    const body = JSON.parse(responseRaw) as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
    const block = Array.isArray(body.content) ? body.content.find((b) => b?.type === "tool_use" && b.name === JUDGE_TOOL_NAME) : undefined;
    return block ? block.input : body;
  } catch {
    return responseRaw;
  }
}

export type RunJudgeOptions = {
  jobs: JudgeJob[];
  judge: Judge;
  rubric: string;
  /** The scores folder: files go to <scoresDir>/<judge configuration>/<root>/<configuration>/<NN>.<R>.json. */
  scoresDir: string;
  /** The offline stub, through the adapter's own attempt loop; no key, no call. */
  dryRun: boolean;
  /** The Anthropic key; required unless dryRun. */
  apiKey: string | null;
  /** Injected fetch (tests); the global fetch otherwise. */
  fetchImpl?: typeof globalThis.fetch;
  /** Messages URL (tests); Anthropic's otherwise. */
  messagesUrl?: string;
  /** A dry run's first this-many attempts per call are refused for their shape (tests of the retry). */
  stubRefusals?: number;
  log?: (line: string) => void;
};

/** The stub through askAtMostTwice, as the replay's dry run does: the retry it shows is the app's. */
function dryRunJudgePort(rows: LlmCallRecord[], refusals: number): Pick<LlmPort, "judgeCoachingDraft"> {
  const stub = createStubLlmPort({ recorder: memoryRecorder(rows), appVersion: "replay-dry-run" });
  let left = refusals;
  return {
    judgeCoachingDraft: (input, o) =>
      askAtMostTwice(o, async (a) => {
        if (left > 0) {
          left--;
          throw new LlmSchemaError("stub refusal: rating must be one digit from 1 to 5");
        }
        return stub.judgeCoachingDraft!(input, { callId: a.callId });
      }),
  };
}

/**
 * Scores every job that needs it, one call at a time, into its score file. A
 * failed judge call is saved with outcome "failed" and the run goes on.
 * Returns how many were called, skipped and failed.
 */
export async function runJudge(options: RunJudgeOptions): Promise<{ called: number; skipped: number; failed: number }> {
  const log = options.log ?? (() => {});
  if (!options.dryRun && !options.apiKey) throw new Error("A live judge run needs an Anthropic key.");
  const judgeName = judgeConfiguration(options.judge);
  let called = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of options.jobs) {
    const file = scoreFile(options.scoresDir, options.judge, job);
    if (!needsScore(options.scoresDir, options.judge, job)) {
      skipped++;
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const rows: LlmCallRecord[] = [];
    const timed = createInstrumentedFetch({ keepBodies: false });
    const target = anthropicCoachTarget({ model: options.judge.model, effort: options.judge.effort }, options.apiKey, options.messagesUrl);
    // Built from flags only; the saved setting is never read (ADR 0004).
    const port: Pick<LlmPort, "judgeCoachingDraft"> = options.dryRun
      ? dryRunJudgePort(rows, options.stubRefusals ?? 0)
      : createAnthropicLlmPort({
          resolveCoachTarget: async () => target,
          recorder: memoryRecorder(rows),
          fetchImpl: options.fetchImpl ?? timed.fetch,
        });
    const input = judgeInputFor(job, options.rubric);
    const started = Date.now();
    let attemptStarted = started;
    let exchanged = 0;
    const attempts: AttemptTiming[] = [];
    const refusals: Refusal[] = [];
    const onAttempt = (report: AttemptReport) => {
      const row = report.callId ? rows.find((r) => r.id === report.callId) : undefined;
      if (report.error instanceof LlmSchemaError) {
        refusals.push({
          attempt: report.attempt,
          error: report.error.message,
          outcome: row?.outcome ?? null,
          stopReason: row?.stopReason ?? null,
          ...rowUsage(row),
          responseRaw: row?.responseRaw ?? null,
          ...(report.request ? { request: report.request } : {}),
        });
      }
      const messages = timed.exchanges.slice(exchanged).filter((ex) => ex.url.endsWith("/messages"));
      attempts.push({
        attempt: report.attempt,
        ttftMs: timeToFirstTokenMs(messages.at(-1)),
        totalMs: Date.now() - attemptStarted,
        ...(report.request
          ? {
              request: report.request,
              outcome: row?.outcome ?? null,
              repairs: row?.errorMessage ?? null,
              inputTokens: row?.inputTokens ?? null,
              outputTokens: row?.outputTokens ?? null,
            }
          : {}),
      });
      exchanged = timed.exchanges.length;
      attemptStarted = Date.now();
    };
    const callId = randomUUID();
    let judgement: CoachingJudgement | null = null;
    let error: string | null = null;
    try {
      judgement = await port.judgeCoachingDraft!(input, { callId, onAttempt, coachTarget: target });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    called++;
    const row = judgement ? (rows.find((r) => r.id === callId) ?? rows.at(-1)) : rows.at(-1);
    const costs = rows.map((r) => attemptCostUsd(r.model, rowUsage(r))).filter((c): c is number => c !== null);
    const score: ScoreFile = {
      input: inputName(job.root, job.id),
      configuration: job.configuration,
      repeat: job.repeat,
      draftStatus: job.side.status,
      outcome: judgement ? "ok" : "failed",
      rating: judgement?.rating ?? null,
      unsafe: judgement?.unsafe ?? null,
      unsafeReason: judgement?.unsafeReason ?? null,
      reason: judgement?.reason ?? null,
      judge: options.judge,
      judgedAt: new Date().toISOString(),
      dryRun: options.dryRun,
      error,
      repairs: judgement ? (row?.errorMessage ?? null) : null,
      stopReason: row?.stopReason ?? null,
      ...rowUsage(row),
      estimatedInputTokens: estimatePromptTokens(row?.request ?? null),
      costUsd: costs.length ? costs.reduce((n, c) => n + c, 0) : null,
      timing: { ttftMs: attempts[0]?.ttftMs ?? null, totalMs: Date.now() - started, attempts },
      refusedAttempts: refusals,
      toolInput: judgement ? (options.dryRun ? buildStubJudgement() : toolInputOf(row?.responseRaw)) : null,
      cuts: job.cuts,
      shown: judgeUserPrompt(input),
    };
    writeFileSync(file, `${JSON.stringify(score, null, 2)}\n`);
    if (!judgement) failed++;
    log(
      `${judgeName} ${score.input} ${job.configuration} repeat ${job.repeat}: ${
        judgement ? `${judgement.rating}${judgement.unsafe ? ", unsafe" : ""}${refusals.length ? " (asked once more)" : ""}` : `failed: ${error}`
      }`,
    );
  }
  return { called, skipped, failed };
}

// ---- Calibration -------------------------------------------------------------------------------

/** The answer key's shape (ticket 08, .scratch/benchmark-coaching/coach-packet/returned/answer-key.json, private). */
export type AnswerKey = {
  generatedAt: string;
  formSeed: number;
  reviewers: Array<{
    reviewer: "coach" | "user";
    submittedAt: string;
    priorities: string[];
    otherPriority: string | null;
    anythingElse: string | null;
    cases: Array<{
      case: number;
      input: string;
      answered: boolean;
      pick: "A" | "B" | "C" | "none" | null;
      comment: string | null;
      drafts: Array<{ draft: string; configuration: string; repeat: number; rating: number | null; unsafe: boolean | null }>;
    }>;
  }>;
};

/** The starting bar (ticket 09, change of 2026-11-03): pick agreement at least 60%, unsafe recall at least 80%, rating MAD at most 1.0. Used when the answer key has no second reviewer. */
export const CALIBRATION_BAR = { pickAgreement: 0.6, unsafeRecall: 0.8, ratingMad: 1.0 } as const;
/** pickAgreement null: picks are not part of the bar, and the judge's picks are not used. */
export type CalibrationBar = { pickAgreement: number | null; unsafeRecall: number; ratingMad: number };

/** However loosely the second reviewer matches the coach's unsafe flags, a judge must find at least this share of them. */
export const UNSAFE_RECALL_FLOOR = 0.6;

export type CaseComparison = {
  case: number;
  input: string;
  coachPick: string | null;
  judgePick: string | null;
  /** Null when either pick is missing. */
  agree: boolean | null;
  /** The case's share of agreement: 1 over the judge's tied top drafts when the coach's pick is among them, else 0; null with agree. */
  credit: number | null;
};

export type JudgeCalibration = {
  /** The judge's configuration name, provider--model--effort. */
  judge: string;
  model: string;
  effort: AnthropicEffort;
  /** Answered cases where both the coach and the judge made a pick. */
  casesCompared: number;
  pickAgreement: number | null;
  /** Of the drafts the coach called unsafe, the share the judge called unsafe; null when he called none. */
  unsafeRecall: number | null;
  /** Of the drafts the judge called unsafe, the share the coach did; null when the judge called none. */
  unsafePrecision: number | null;
  /** Drafts where both answered unsafe, and the share where they agree. */
  unsafeCompared: number;
  unsafeAgreement: number | null;
  coachUnsafe: number;
  judgeUnsafe: number;
  /** Drafts both rated; the mean absolute difference and the share within one point. */
  ratingsCompared: number;
  ratingMad: number | null;
  ratingWithinOne: number | null;
  /** Drafts the judge has no ok score for (missing or a failed call). */
  unscored: string[];
  meetsBar: boolean;
  bar: CalibrationBar;
  cases: CaseComparison[];
};

const share = (n: number, of: number) => (of ? n / of : null);

/**
 * One judge against one reviewer's answers. `scoreOf` gives the judge's score
 * for a draft (input, configuration, repeat), or null. Only answered cases
 * count; a draft the judge has no ok score for leaves its case's pick out.
 */
export function compareWithKey(
  judge: Judge,
  reviewer: AnswerKey["reviewers"][number],
  scoreOf: (input: string, configuration: string, repeat: number) => ScoreFile | null,
  bar: CalibrationBar = CALIBRATION_BAR,
): JudgeCalibration {
  const cases: CaseComparison[] = [];
  const unscored: string[] = [];
  let coachUnsafe = 0;
  let judgeUnsafe = 0;
  let bothUnsafe = 0;
  let unsafeCompared = 0;
  let unsafeAgree = 0;
  const diffs: number[] = [];
  for (const c of reviewer.cases) {
    if (!c.answered) continue;
    const judged = c.drafts.map((d) => {
      const s = scoreOf(c.input, d.configuration, d.repeat);
      const ok = s && s.outcome === "ok" ? s : null;
      if (!ok) unscored.push(`${c.input} ${d.configuration} repeat ${d.repeat} (case ${c.case} draft ${d.draft})`);
      return { d, s: ok };
    });
    for (const { d, s } of judged) {
      if (!s) continue;
      if (d.unsafe !== null && s.unsafe !== null) {
        unsafeCompared++;
        if (d.unsafe === s.unsafe) unsafeAgree++;
        if (d.unsafe) coachUnsafe++;
        if (s.unsafe) judgeUnsafe++;
        if (d.unsafe && s.unsafe) bothUnsafe++;
      }
      if (d.rating !== null && s.rating !== null) diffs.push(Math.abs(d.rating - s.rating));
    }
    const tops = judged.every((j) => j.s) ? topDrafts(judged.map(({ d, s }) => ({ draft: d.draft, rating: s!.rating, unsafe: s!.unsafe }))) : null;
    const judgePick = tops ? tops.join("/") : null;
    const coachPick = c.pick;
    const credit = coachPick && tops ? (tops.includes(coachPick) ? 1 / tops.length : 0) : null;
    cases.push({ case: c.case, input: c.input, coachPick, judgePick, agree: credit === null ? null : credit > 0, credit });
  }
  const compared = cases.filter((c) => c.credit !== null);
  const pickAgreement = share(compared.reduce((n, c) => n + c.credit!, 0), compared.length);
  const unsafeRecall = share(bothUnsafe, coachUnsafe);
  const ratingMad = diffs.length ? diffs.reduce((n, d) => n + d, 0) / diffs.length : null;
  const meetsBar =
    (bar.pickAgreement === null || (pickAgreement !== null && pickAgreement >= bar.pickAgreement)) &&
    ratingMad !== null &&
    ratingMad <= bar.ratingMad &&
    (unsafeRecall === null || unsafeRecall >= bar.unsafeRecall);
  return {
    judge: judgeConfiguration(judge),
    model: judge.model,
    effort: judge.effort,
    casesCompared: compared.length,
    pickAgreement,
    unsafeRecall,
    unsafePrecision: share(bothUnsafe, judgeUnsafe),
    unsafeCompared,
    unsafeAgreement: share(unsafeAgree, unsafeCompared),
    coachUnsafe,
    judgeUnsafe,
    ratingsCompared: diffs.length,
    ratingMad,
    ratingWithinOne: share(diffs.filter((d) => d <= 1).length, diffs.length),
    unscored,
    meetsBar,
    bar: { ...bar },
    cases,
  };
}

/**
 * The bar from the second reviewer (decided 2026-11-03): a judge passes when its
 * ratings are as close to the coach's as the other reviewer's are, with unsafe
 * recall no lower than UNSAFE_RECALL_FLOOR. Picks are not part of it: scoring
 * one draft at a time, the judge's ratings come out too flat to rank a case's
 * drafts, so pick rates come from the coach's answers only. Null when the key
 * has no such reviewer, or their answers leave the rating difference unmeasured.
 */
export function secondReviewerBar(answerKey: AnswerKey, reviewer: string, floor = UNSAFE_RECALL_FLOOR): { bar: CalibrationBar; from: string } | null {
  const target = answerKey.reviewers.find((r) => r.reviewer === reviewer);
  const other = answerKey.reviewers.find((r) => r.reviewer !== reviewer);
  if (!target || !other) return null;
  const theirs = new Map<string, ScoreFile>();
  for (const c of other.cases) {
    if (!c.answered) continue;
    for (const d of c.drafts) theirs.set(`${c.input}|${d.configuration}|${d.repeat}`, { outcome: "ok", rating: d.rating, unsafe: d.unsafe } as ScoreFile);
  }
  const asJudge = { provider: "anthropic", model: other.reviewer, effort: "high" } as Judge;
  const r = compareWithKey(asJudge, target, (input, configuration, repeat) => theirs.get(`${input}|${configuration}|${repeat}`) ?? null);
  if (r.ratingMad === null) return null;
  return { bar: { pickAgreement: null, unsafeRecall: Math.max(r.unsafeRecall ?? 0, floor), ratingMad: r.ratingMad }, from: other.reviewer };
}

/** The judge to use: of those that meet the bar, the higher pick agreement, then the lower rating MAD; null when none does. */
export function chooseJudge(results: JudgeCalibration[]): JudgeCalibration | null {
  const passing = results.filter((r) => r.meetsBar);
  passing.sort((a, b) => (b.pickAgreement ?? 0) - (a.pickAgreement ?? 0) || (a.ratingMad ?? Infinity) - (b.ratingMad ?? Infinity));
  return passing[0] ?? null;
}

export type CalibrationReport = {
  generatedAt: string;
  reviewer: string;
  answerKeyGeneratedAt: string;
  formSeed: number;
  dryRun: boolean;
  bar: CalibrationBar;
  /** The reviewer whose agreement with the coach set the bar; null for a fixed bar. */
  barFrom: string | null;
  judges: JudgeCalibration[];
  /** The chosen judge's configuration; null when none meets the bar. */
  choice: string | null;
};

const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
const num = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));

/** calibration.md: the bar, the table for every judge, the choice or why there is none, and the cases. */
export function calibrationMarkdown(report: CalibrationReport): string {
  const b = report.bar;
  const out = [
    "# Coaching judge calibration",
    "",
    `Against the ${report.reviewer}'s answer key (written ${report.answerKeyGeneratedAt}, form seed ${report.formSeed}); generated ${report.generatedAt}${report.dryRun ? ", DRY RUN on the offline stub: these numbers mean nothing" : ""}.`,
    "",
    `The bar: ${b.pickAgreement === null ? "" : `pick agreement at least ${pct(b.pickAgreement)}, `}unsafe recall at least ${pct(b.unsafeRecall)} (a judge that misses the ${report.reviewer}'s unsafe flags fails), rating mean absolute difference at most ${b.ratingMad.toFixed(2)}.${report.barFrom ? ` These are the ${report.barFrom}'s own agreement with the ${report.reviewer}, scored the same way (unsafe recall no lower than ${pct(UNSAFE_RECALL_FLOOR)}): a judge that passes rates as close to the ${report.reviewer} as the ${report.barFrom} does.` : ""}${b.pickAgreement === null ? ` Picks are not part of the bar: scoring one draft at a time, the judge's ratings are too flat to rank a case's drafts, so its picks are not used and pick rates come from the ${report.reviewer}'s answers only. Pick agreement is shown for reference.` : ""} The pick is the highest-rated draft not unsafe, "none" when every draft is unsafe; when drafts tie for the highest rating the case's credit is shared among them, as the analysis shares picks.`,
    "",
    "| Judge | Cases | Pick agreement | Unsafe recall | Unsafe precision | Unsafe agreement | Rating MAD | Within one | Meets the bar |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.judges.map(
      (j) =>
        `| ${j.judge} | ${j.casesCompared} | ${pct(j.pickAgreement)} | ${pct(j.unsafeRecall)} (${j.coachUnsafe} flagged) | ${pct(j.unsafePrecision)} (${j.judgeUnsafe} flagged) | ${pct(j.unsafeAgreement)} of ${j.unsafeCompared} | ${num(j.ratingMad)} | ${pct(j.ratingWithinOne)} of ${j.ratingsCompared} | ${j.meetsBar ? "yes" : "no"} |`,
    ),
    "",
  ];
  if (report.choice) {
    out.push(`**The choice: ${report.choice}.** Of the judges that meet the bar, it has the higher pick agreement (then the lower rating difference). It scores the baseline root.`, "");
  } else {
    out.push("**No judge meets the bar.** The rubric goes back to the coach, and no judge scores are used.", "");
  }
  for (const j of report.judges) {
    out.push(`## ${j.judge}`, "", "| Case | Input | Coach's pick | Judge's pick | Agree |", "| --- | --- | --- | --- | --- |");
    for (const c of j.cases) out.push(`| ${c.case} | ${c.input} | ${c.coachPick ?? "-"} | ${c.judgePick ?? "-"} | ${c.credit === null ? "-" : c.credit === 1 ? "yes" : c.credit > 0 ? `shared (${c.credit.toFixed(2)})` : "no"} |`);
    if (j.unscored.length) out.push("", `Not scored (left out): ${j.unscored.join("; ")}.`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

/** Writes calibration.md and calibration.json into `dir`. */
export function writeCalibration(dir: string, report: CalibrationReport): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "calibration.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(dir, "calibration.md"), calibrationMarkdown(report));
}

/** The calibration for these judges, read from their score files. */
export function calibrate(options: {
  judges: Judge[];
  answerKey: AnswerKey;
  reviewer: string;
  scoresDir: string;
  dryRun: boolean;
  bar?: CalibrationBar;
}): CalibrationReport {
  const reviewer = options.answerKey.reviewers.find((r) => r.reviewer === options.reviewer);
  if (!reviewer) throw new Error(`The answer key has no reviewer "${options.reviewer}" (it has ${options.answerKey.reviewers.map((r) => r.reviewer).join(", ") || "none"}).`);
  const fromReviewer = options.bar ? null : secondReviewerBar(options.answerKey, options.reviewer);
  const bar = options.bar ?? fromReviewer?.bar ?? CALIBRATION_BAR;
  const judges = options.judges.map((judge) =>
    compareWithKey(
      judge,
      reviewer,
      (input, configuration, repeat) => {
        const [root, id] = input.split("/") as [string, string];
        return readScore(scoreFile(options.scoresDir, judge, { root, configuration, id, repeat }));
      },
      bar,
    ),
  );
  return {
    generatedAt: new Date().toISOString(),
    reviewer: options.reviewer,
    answerKeyGeneratedAt: options.answerKey.generatedAt,
    formSeed: options.answerKey.formSeed,
    dryRun: options.dryRun,
    bar: { ...bar },
    barFrom: fromReviewer?.from ?? null,
    judges,
    choice: chooseJudge(judges)?.judge ?? null,
  };
}
