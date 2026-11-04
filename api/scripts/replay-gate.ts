/**
 * The replay gate: one command measures a harness change (a "lever") on the
 * regression set, before the lever is committed.
 *
 *   cd api
 *   OMLX_KEY=... ANTHROPIC_API_KEY=sk-ant-... npm run replay:gate -- \
 *     --lever strict --base-url http://<macbook>:8000 --key-env OMLX_KEY
 *
 * It runs the regression set (tests/fixtures/regression-set.json) through the
 * replay (scripts/replay-weekly-reads.ts) on two configurations, over both input
 * sets, one repeat each:
 *
 *   anthropic--claude-opus-4-7--xhigh          Opus 4.7 at xhigh; the key is
 *                                               ANTHROPIC_API_KEY, never a flag
 *   self_hosted--gpt-oss-20b-MXFP4-Q8--high    gpt-oss-20b on oMLX at high, at
 *                                               --base-url, keyed by --key-env
 *
 * into <lever folder>/snapshot (the demo snapshot) and <lever folder>/seasons
 * (the season packets), then the analysis (scripts/replay-analysis.ts) over
 * those two roots into <lever folder>/analysis, with Opus as the baseline so
 * the comparison is same-harness. The lever folder is
 * .scratch/benchmark-after/<lever> at the repo root (--root <dir> names another
 * parent); it is created when missing. The gate never writes under
 * .scratch/benchmark/, which holds the "before" runs, nor under
 * .scratch/benchmark-coaching/, which holds the coaching baseline.
 *
 * Last, it prints the gate record, one line per configuration: reads valid as
 * sent (accepted by the validator, on the first try or when asked once more,
 * as the benchmark counted them) out of the replies run; structured days, the
 * days Cadence filed from the valid weekly reads' plan boxes over every day
 * they stored; how many valid replies carry a repair note; and the verdict:
 *
 *   gate flat-form: opus 19/20 valid (19 first try, 0 after retry), structured days 100% (112 of 112), 0 repairs: PASS, needs at least 18/20 valid (baseline band 18 to 19) and 100% structured days
 *   gate flat-form: gpt-oss-20b 18/20 valid (18 first try, 0 after retry), structured days 86.6% (91 of 105), 3 repairs: FAIL, needs at least 19/20 valid and 90% structured days
 *
 * The pass rule (scripts/replayGateRule.ts, thresholds from
 * .scratch/plan-as-text/spec.md, "Measurement"): Opus passes at or above the
 * baseline band's low on reads valid, the band read from
 * tests/fixtures/baseline-band.json, and at 100 percent structured days;
 * gpt-oss-20b passes at 19 of 20 reads valid or more and at least 90 percent
 * structured days. The thresholds are for the 20-input regression set: with
 * --only naming any other input set, the gate prints the numbers and says the
 * thresholds apply to the regression set only. The gate's exit code does not
 * follow the verdict; the record is read, not acted on.
 *
 * --only <root>/<id>[,...] or @<file> (a JSON list of { input, why }, as the
 * replay takes it) runs that input set instead of the regression set.
 *
 * A rerun resumes: the replay skips every reply already saved, so an
 * interrupted gate costs only what is left (a refused or failed reply is asked
 * again). The analysis is rebuilt over whatever is there.
 *
 * Procedure, for every lever (strict, contract, retry, repairs, in that order):
 *
 *   1. Make the lever's change, with its tests, and do not commit it yet.
 *   2. Wake the MacBook and check oMLX is up and serving gpt-oss-20b-MXFP4-Q8
 *      (curl <base url>/v1/models lists it; no model call). A server that
 *      does not answer turns the self-hosted replies into transport failures;
 *      the gate then says so and exits non-zero, and the record is not a result.
 *   3. Run the gate with the lever's name, as above. Opus costs about $3; the
 *      self-hosted side takes under an hour. The gate prints its estimate
 *      first and refuses above $5 (see "Caps on spend" below); pass
 *      --allow-cost only after reading why it is high.
 *   4. Paste the two record lines into the lever's commit message, commit, and
 *      keep the lever's folder (.scratch/benchmark-after/<lever>): the next
 *      lever's gate is read against it, and the final report links them.
 *   5. Gate the next lever only after this one is committed.
 *
 * The demo snapshot's inputs predate a stored goal, so the replay's goal-line
 * check fails on them and the replay exits non-zero by design. The gate
 * accepts a replay that exits non-zero only when it printed its goal-check
 * summary and saved a reply (or a refusal) for every regression-set input of
 * that root; anything else (a thrown error, a missing reply) stops the gate.
 *
 * --dry-run passes through to the replay: both configurations use the offline
 * stub, no key is needed and nothing is sent. It writes into
 * <root>/<lever>-dry-run, so a stub reply can never be resumed into a live
 * gate; --base-url is optional there.
 *
 * --configs <short>[,<short>] runs only the named configurations, such as
 * --configs gpt-oss-20b to iterate on the self-hosted side without paying for
 * Opus. The names are the short names of one table for both sets
 * (scripts/replayGateConfigurations.ts): opus (the control), gpt-oss-20b,
 * opus-high, haiku-5-5, sonnet-5-5, opus-5-5. The format set runs opus and
 * gpt-oss-20b when the flag is absent; a configuration with no threshold gets
 * its numbers and no verdict. A self-hosted configuration's server is
 * --base-url, or the URL in its environment variable (OMLX_BASE_URL) when the
 * flag is absent.
 *
 * The coaching set (coaching-quality ticket 12): --set coaching measures
 * whether a lever makes the coaching worse. It runs the hard set
 * (tests/fixtures/hard-set.json, 14 weekly reads) on the control (and any
 * configuration --configs names), with the rules retry on (--rules-retry to the
 * replay, as the app runs since 2f8960c) and one repeat (--repeats <n> for
 * more), into <lever folder>/coaching/{snapshot,seasons}; has the judge score
 * every reply (scripts/replay-judge.ts --score, Opus 5.5 at high when --judge
 * <model> and --judge-effort <level> are absent) into
 * <lever folder>/coaching/judge, beside a copy of the judge's calibration
 * (--calibration <file>, default .scratch/benchmark-coaching/judge-2/calibration.json)
 * so the analysis heads its coaching section with it; runs the analysis with
 * --judge into <lever folder>/coaching/analysis; and judges each configuration
 * against its row of tests/fixtures/coaching-band.json (--band <file> names
 * another):
 *
 *   gate tone: opus coaching mean 3.29 over 1 repeat, 3 unsafe, 14 of 14 scored: PASS, needs mean at least 3.14 (band 3.36 minus its spread 0.21) and at most 4 unsafe a repeat (the band's worst repeat); this run has 1 repeat, the band 4
 *
 * The rule (scripts/replayGateRule.ts, judgeCoaching): the mean of the run's
 * repeat means at or above the band's mean minus its spread (the baseline's
 * own run-to-run noise is the tolerance), and the unsafe replies a repeat at or
 * below the band's worst repeat. No verdict on another input set, another
 * judge than the band's, a configuration with no band row, or a repeat the
 * judge did not score in full (rerun the gate: scored replies are not judged
 * again). The format set is unchanged by all of this, and stays the default.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run replay:gate -- --set coaching --lever tone
 *
 * Caps on spend. Before any replay starts, the gate prints the output cap every
 * call sends (MAX_OUTPUT_TOKENS in src/llm/anthropic.ts, 20,000 tokens) and an
 * estimated cost (scripts/replayCost.ts), per configuration:
 *
 *   inputs selected (the regression set's, as --only hands the replay)
 *     x the cost per reply: the median, across every saved live run of that
 *       configuration, of each run's cost.medianUsd in measures.json, found
 *       under the saved-run folders, .scratch/benchmark and
 *       .scratch/benchmark-after (--saved-runs <dir>[,<dir>] names others).
 *       A run's per-reply cost already prices its retries, so there is no
 *       attempts multiplier; and one runaway run cannot set the figure.
 *
 * With no saved run for an Anthropic configuration it uses the regression
 * set's Opus figure, about $0.15 a reply, and says so. A self-hosted
 * configuration is estimated at $0 and never refuses. The coaching set
 * multiplies the inputs by the repeats, reads its saved runs from
 * .scratch/benchmark-coaching, and adds the judge's calls, one per reply,
 * priced as scripts/replayJudge.ts estimates a call before its reply exists
 * (estimateJudgeCalls). When the total is above $5 the gate refuses to start:
 * it says so, names --allow-cost, and exits non-zero having called no model.
 * --allow-cost runs it anyway. A dry run prints and applies the same check, so
 * the refusal can be rehearsed offline. The plain replay (npm run replay) has
 * no such check.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_OUTPUT_TOKENS } from "../src/llm/anthropic.js";
import { ANTHROPIC_EFFORT_LEVELS, parseAnthropicEffort } from "../src/llm/effort.js";
import { describeEstimate, estimateGateCost, GATE_COST_CAP_USD } from "./replayCost.js";
import { CONTROL, DEFAULT_CONFIGURATIONS, configurationsNamed, type GateConfiguration } from "./replayGateConfigurations.js";
import { judge, judgeCoaching, readBaselineBand, readCoachingBand, type CoachingNumbers, type GateNumbers } from "./replayGateRule.js";
import { DEFAULT_JUDGE_EFFORT, describeJudgeEstimate, estimateJudgeCalls, judgeConfiguration, type Judge } from "./replayJudge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, "..");
const REGRESSION_SET = path.join(api, "tests/fixtures/regression-set.json");
const HARD_SET = path.join(api, "tests/fixtures/hard-set.json");
const BASELINE_BAND = path.join(api, "tests/fixtures/baseline-band.json");
const SEASON_PACKETS = path.join(api, "tests/fixtures/seasons/season-packets");
const RUBRIC = path.join(api, "../docs/coaching-rubric.md");
const TSX = path.join(api, "node_modules/.bin/tsx");
const ROOTS = ["snapshot", "seasons"] as const;
type Root = (typeof ROOTS)[number];
const BASELINE = CONTROL.folder;

// ---- Flags --------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run");
const allowCost = process.argv.includes("--allow-cost");

function flagValue(flag: string, what: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return value;
}

const LEVER = flagValue("--lever", "a name, such as strict");
if (!LEVER) throw new Error("--lever <name> is required, such as --lever strict.");
if (!/^[A-Za-z0-9._-]+$/.test(LEVER) || LEVER.startsWith(".")) {
  throw new Error(`Invalid --lever "${LEVER}": letters, digits, ".", "_" and "-" only, as it names a folder.`);
}
const SET = flagValue("--set", "format or coaching") ?? "format";
if (SET !== "format" && SET !== "coaching") throw new Error(`Invalid --set "${SET}": expected format (the regression set) or coaching (the hard set).`);
const COACHING = SET === "coaching";
const configsFlag = flagValue("--configs", "configuration names, such as opus,gpt-oss-20b");
const CONFIGURATIONS: GateConfiguration[] = configurationsNamed(configsFlag ? configsFlag.split(",") : DEFAULT_CONFIGURATIONS[SET]);
const SELF_HOSTED = CONFIGURATIONS.find((c) => c.provider === "self_hosted");
const BASE_URL =
  flagValue("--base-url", "the self-hosted server's URL") ??
  (SELF_HOSTED?.baseUrlEnv ? process.env[SELF_HOSTED.baseUrlEnv]?.trim() || null : null) ??
  (dryRun ? "http://gate-dry-run.invalid:8000" : null);
if (!BASE_URL && SELF_HOSTED) throw new Error("--base-url <url> is required: the oMLX server serving gpt-oss-20b-MXFP4-Q8, such as http://macbook.local:8000.");
const KEY_ENV = flagValue("--key-env", "an environment variable name");
const repeatsFlag = flagValue("--repeats", "a number");
if (repeatsFlag !== null && !COACHING) throw new Error("--repeats is for --set coaching; the format gate runs one repeat.");
if (repeatsFlag !== null && !/^[1-9]\d*$/.test(repeatsFlag)) throw new Error(`Invalid --repeats "${repeatsFlag}": expected a whole number from 1.`);
const REPEATS = repeatsFlag === null ? 1 : Number(repeatsFlag);
const judgeEffortFlag = flagValue("--judge-effort", "a level");
const judgeEffort = judgeEffortFlag === null ? DEFAULT_JUDGE_EFFORT : parseAnthropicEffort(judgeEffortFlag);
if (!judgeEffort) throw new Error(`Invalid --judge-effort "${judgeEffortFlag}": expected one of ${ANTHROPIC_EFFORT_LEVELS.join(", ")}.`);
/** The judge the coaching set scores with: Opus 5.5 at high, the one calibration chose and the band was scored by. */
const JUDGE: Judge = { provider: "anthropic", model: flagValue("--judge", "a model id, such as claude-opus-5-5") ?? "claude-opus-5-5", effort: judgeEffort };
const PARENT = path.resolve(flagValue("--root", "a folder") ?? path.resolve(api, "../.scratch/benchmark-after"));
const LEVER_DIR = path.join(PARENT, dryRun ? `${LEVER}-dry-run` : LEVER, ...(COACHING ? ["coaching"] : []));
const DEFAULT_SAVED_RUNS = COACHING ? ["../.scratch/benchmark-coaching"] : ["../.scratch/benchmark", "../.scratch/benchmark-after"];
const SAVED_RUNS = (flagValue("--saved-runs", "one or more folders, comma-separated") ?? DEFAULT_SAVED_RUNS.map((d) => path.resolve(api, d)).join(","))
  .split(",")
  .filter(Boolean)
  .map((d) => path.resolve(d));
const COACHING_BAND = path.resolve(flagValue("--band", "a coaching band file") ?? path.join(api, "tests/fixtures/coaching-band.json"));
const CALIBRATION = path.resolve(flagValue("--calibration", "a calibration.json") ?? path.join(api, "../.scratch/benchmark-coaching/judge-2/calibration.json"));


/** The real path of `p`, through its nearest existing ancestor, so a symlink cannot hide where it lands. */
function realish(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const up = path.dirname(existing);
    if (up === existing) break;
    existing = up;
  }
  return path.join(realpathSync(existing), ...rest);
}

/** Refuses a lever folder at or under any .scratch/benchmark/ or .scratch/benchmark-coaching/, where the "before" runs live. */
function refuseBeforeRuns(dir: string): void {
  for (const candidate of new Set([dir, realish(dir)])) {
    for (let p = candidate; ; p = path.dirname(p)) {
      if (["benchmark", "benchmark-coaching"].includes(path.basename(p)) && path.basename(path.dirname(p)) === ".scratch") {
        throw new Error(`Refusing to write into ${dir}: it is under ${p}, the "before" runs. Use .scratch/benchmark-after.`);
      }
      if (path.dirname(p) === p) break;
    }
  }
}

refuseBeforeRuns(LEVER_DIR);

/**
 * A folder saved by a dry run must not be resumed by a live run, nor the other
 * way round; and a coaching folder, saved with the rules retry on, must not be
 * resumed without it.
 */
function refuseMixedRuns(): void {
  for (const root of ROOTS) {
    for (const c of CONFIGURATIONS) {
      const file = path.join(LEVER_DIR, root, c.folder, "config.json");
      if (!existsSync(file)) continue;
      const saved = JSON.parse(readFileSync(file, "utf8")) as { dryRun?: boolean; rulesRetry?: boolean };
      if (Boolean(saved.dryRun) !== dryRun) {
        throw new Error(`${file} was written by a ${saved.dryRun ? "dry" : "live"} run; this is a ${dryRun ? "dry" : "live"} run. Use another --lever.`);
      }
      if (COACHING && !saved.rulesRetry) throw new Error(`${file} was written with the rules retry off; the coaching gate runs with it on. Use another --lever.`);
    }
  }
}

refuseMixedRuns();

// ---- The input set ----------------------------------------------------------------------

const SET_FILE = COACHING ? HARD_SET : REGRESSION_SET;
const SET_NAME = COACHING ? "the hard set" : "the regression set";
const setInputs = (JSON.parse(readFileSync(SET_FILE, "utf8")) as Array<{ input: string; why: string }>).map((e) => e.input);
const ONLY = flagValue("--only", "a comma-separated list of <root>/<input id>, or @<file>");

/** The inputs this gate runs: the set's, or what --only names. */
function inputSet(): string[] {
  if (ONLY === null) return setInputs;
  const names = ONLY.startsWith("@")
    ? (JSON.parse(readFileSync(path.resolve(ONLY.slice(1)), "utf8")) as Array<{ input: string }>).map((e) => String(e.input).trim())
    : ONLY.split(",").map((n) => n.trim()).filter(Boolean);
  for (const name of names) {
    if (!/^(snapshot|seasons)\/\d+$/.test(name)) throw new Error(`--only "${name}": expected snapshot/<id> or seasons/<id>, such as seasons/09.`);
  }
  if (names.length === 0) throw new Error("--only names no input.");
  return names;
}

const INPUTS = inputSet();
/** Whether the thresholds apply: the set's inputs, no more and no fewer. */
const IS_SET = [...new Set(INPUTS)].sort().join(",") === [...setInputs].sort().join(",");
const idsOf = (root: Root) => INPUTS.filter((i) => i.startsWith(`${root}/`)).map((i) => i.slice(root.length + 1));
const ROOTS_RUN = ROOTS.filter((r) => idsOf(r).length > 0);
const BAND = COACHING ? null : readBaselineBand(BASELINE_BAND);
const BAND_COACHING = COACHING ? readCoachingBand(COACHING_BAND) : null;

// ---- Caps on spend -------------------------------------------------------------------

/** Prints the output cap and the estimate; refuses, before anything is written or called, above the cap. */
function checkCost(): void {
  const replies = INPUTS.length * REPEATS;
  const estimate = estimateGateCost(
    CONFIGURATIONS.map((c) => ({ short: c.short, folder: c.folder, provider: c.provider, inputs: replies })),
    SAVED_RUNS,
  );
  const lines = describeEstimate(estimate);
  let totalUsd = estimate.totalUsd;
  if (COACHING) {
    // One judge call per reply; the rubric as the judge is given it, a stand-in's size when it is not written.
    const rubricMissing = !existsSync(RUBRIC);
    const judged = estimateJudgeCalls(replies * CONFIGURATIONS.length, JUDGE, rubricMissing ? "" : readFileSync(RUBRIC, "utf8"), rubricMissing);
    totalUsd += judged.usd;
    lines.splice(
      lines.length - 1,
      1,
      `  the judge:${describeJudgeEstimate([judged], rubricMissing)[0]!.replace(/^ {2}/, " ")}`,
      `  total $${totalUsd.toFixed(2)} (replies $${estimate.totalUsd.toFixed(2)}, judge $${judged.usd.toFixed(2)}), cap $${GATE_COST_CAP_USD.toFixed(2)}`,
    );
  }
  console.log(`gate ${LEVER}: output cap ${MAX_OUTPUT_TOKENS} tokens per call (thinking included)`);
  console.log(`gate ${LEVER}: estimated cost${dryRun ? " of the live run (this dry run sends nothing)" : ""}:`);
  for (const line of lines) console.log(line);
  if (totalUsd <= GATE_COST_CAP_USD) return;
  if (allowCost) {
    console.log(`gate ${LEVER}: the estimate is above the $${GATE_COST_CAP_USD} cap; going on, as --allow-cost was passed.`);
    return;
  }
  console.error(
    `Refusing to start: the estimated cost $${totalUsd.toFixed(2)} is above the $${GATE_COST_CAP_USD} cap. Pass --allow-cost to run it anyway. No model was called.`,
  );
  process.exit(1);
}

checkCost();

// ---- Running the scripts --------------------------------------------------------------

/** Runs a script under tsx from api/, its stdout shown as it comes and its stderr shown and kept. */
function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, args, { cwd: api, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function replayArgs(c: GateConfiguration, root: Root): string[] {
  const only = ONLY === null ? `@${SET_FILE}` : idsOf(root).map((id) => `${root}/${id}`).join(",");
  const args = ["scripts/replay-weekly-reads.ts", "--out", path.join(LEVER_DIR, root), "--only", only, "--repeats", String(REPEATS)];
  if (root === "seasons") args.push("--packets", SEASON_PACKETS);
  args.push("--provider", c.provider, "--model", c.model, "--effort", c.effort);
  if (c.provider === "self_hosted") {
    args.push("--base-url", BASE_URL!);
    if (KEY_ENV) args.push("--key-env", KEY_ENV);
  }
  // The app runs with the rules retry on (2f8960c); the coaching band was measured with it on where it fires.
  if (COACHING) args.push("--rules-retry");
  if (dryRun) args.push("--dry-run");
  return args;
}

/** The inputs of `root` with neither a reply nor a refusal saved for `c`, in any repeat run. */
function missingReplies(c: GateConfiguration, root: Root): string[] {
  const dir = path.join(LEVER_DIR, root, c.folder);
  const files = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const repeats = Array.from({ length: REPEATS }, (_, i) => i + 1);
  return idsOf(root).filter((id) => repeats.some((r) => !files.has(`${id}.${r}.json`) && !files.has(`${id}.${r}.failed.json`)));
}

/**
 * One replay, judged: a clean exit, or a non-zero exit caused only by failed
 * goal checks (the demo snapshot's missing goal line, by design), with every
 * input's reply saved. Anything else is a failed run.
 */
async function replay(c: GateConfiguration, root: Root): Promise<void> {
  console.log(`\n== gate ${LEVER}: ${c.folder} over ${root} ==`);
  const { code, stderr } = await run(replayArgs(c, root));
  const missing = missingReplies(c, root);
  const goalChecksOnly = /^\d+ goal checks? failed:$/m.test(stderr);
  if (code === 0 && missing.length === 0) return;
  if (code !== 0 && goalChecksOnly && missing.length === 0) {
    console.log(`(the replay exited ${code} for its goal checks only; every reply is saved, so the gate goes on)`);
    return;
  }
  throw new Error(
    `The replay of ${c.folder} over ${root} failed (exit ${code}${missing.length ? `; no reply saved for ${missing.map((id) => `${root}/${id}`).join(", ")}` : ""}). Rerun the gate to resume.`,
  );
}

// ---- The coaching judge ----------------------------------------------------------------

const JUDGE_DIR = path.join(LEVER_DIR, "judge");
const JUDGE_SCORES = path.join(JUDGE_DIR, "baseline-scores", judgeConfiguration(JUDGE));

/**
 * The judge scores every reply of the configurations run (scored ones are not
 * called again), beside the calibration the analysis heads section 9 with.
 */
async function judgeReplies(): Promise<void> {
  console.log(`\n== gate ${LEVER}: the judge, ${judgeConfiguration(JUDGE)} ==`);
  mkdirSync(JUDGE_DIR, { recursive: true });
  if (existsSync(CALIBRATION)) {
    copyFileSync(CALIBRATION, path.join(JUDGE_DIR, "calibration.json"));
  } else {
    console.log(`(no calibration at ${CALIBRATION}: the analysis reads the judge as not calibrated)`);
  }
  const args = [
    "scripts/replay-judge.ts",
    "--score",
    "--judge",
    JUDGE.model,
    "--effort",
    JUDGE.effort,
    "--roots",
    ROOTS_RUN.map((r) => path.join(LEVER_DIR, r)).join(","),
    "--judge-dir",
    JUDGE_DIR,
    "--repeats",
    String(REPEATS),
    "--configuration",
    CONFIGURATIONS.map((c) => c.folder).join(","),
    // The gate's own estimate, judge calls included, was checked against the cap above.
    "--allow-cost",
  ];
  if (dryRun) args.push("--dry-run");
  const judged = await run(args);
  if (judged.code !== 0) throw new Error(`The judge failed (exit ${judged.code}). Rerun the gate to resume.`);
}

// ---- The record -------------------------------------------------------------------------

type Outcome = { replies: number; firstTry: number; afterRetry: number; failedBy: Record<string, number> };
type AnalysisJson = {
  outcomes: Array<{ configuration: string; all: Outcome }>;
  quality: Array<{ configuration: string; valid: { softRepairReplies: number } }>;
  planLines: Array<{ configuration: string; weekly: { daysParsed: number; daysTotal: number } }>;
  coaching?: {
    judge: { configuration: string };
    configurations: Array<{ configuration: string; failed: number; repeatMeans: Array<{ repeat: number; n: number; mean: number; unsafe: number }> }>;
  };
};

/** The coaching numbers of `c` from the analysis's section 9, repeats 1 to this run's only. */
function coachingNumbers(analysis: AnalysisJson, c: GateConfiguration): CoachingNumbers {
  const row = analysis.coaching?.configurations.find((x) => x.configuration === c.folder);
  return {
    repeats: (row?.repeatMeans ?? []).filter((r) => r.repeat <= REPEATS).map((r) => ({ repeat: r.repeat, scored: r.n, mean: r.mean, unsafe: r.unsafe })),
    failed: row?.failed ?? 0,
  };
}

/** One record line per configuration, from the analysis, and any transport failure that voids it. */
function record(analysis: AnalysisJson): { lines: string[]; transport: string[] } {
  const lines: string[] = [];
  const transport: string[] = [];
  for (const c of CONFIGURATIONS) {
    const o = analysis.outcomes.find((x) => x.configuration === c.folder)?.all;
    if (COACHING) {
      if (!o) throw new Error(`The analysis has no ${c.folder}.`);
      if (!analysis.coaching) throw new Error("The analysis has no coaching section.");
      lines.push(
        judgeCoaching({ lever: LEVER!, short: c.short, numbers: coachingNumbers(analysis, c), band: BAND_COACHING!, inputSet: IS_SET, judge: judgeConfiguration(JUDGE) }).line,
      );
    } else {
      const q = analysis.quality.find((x) => x.configuration === c.folder)?.valid;
      const p = analysis.planLines?.find((x) => x.configuration === c.folder)?.weekly;
      if (!o || !q || !p) throw new Error(`The analysis has no ${c.folder}.`);
      const numbers: GateNumbers = {
        replies: o.replies,
        firstTry: o.firstTry,
        afterRetry: o.afterRetry,
        daysParsed: p.daysParsed,
        daysTotal: p.daysTotal,
        softRepairReplies: q.softRepairReplies,
      };
      lines.push(judge({ lever: LEVER!, short: c.short, numbers, band: BAND!, regressionSet: IS_SET }).line);
    }
    const lost = o.failedBy["http/transport/timeout"] ?? 0;
    if (lost > 0) transport.push(`${c.short}: ${lost} repl${lost === 1 ? "y" : "ies"} lost to http/transport/timeout`);
  }
  return { lines, transport };
}

// ---- Main ---------------------------------------------------------------------------------

mkdirSync(LEVER_DIR, { recursive: true });
if (COACHING) {
  const b = BAND_COACHING!;
  console.log(
    `gate ${LEVER}${dryRun ? " (dry run, offline stub)" : ""}: ${INPUTS.length} inputs${IS_SET ? ` (${SET_NAME})` : ` (not ${SET_NAME}: no verdict)`}, ${REPEATS} repeat${REPEATS === 1 ? "" : "s"}, the rules retry on as the app runs, judge ${judgeConfiguration(JUDGE)}, writing into ${LEVER_DIR}`,
  );
  console.log(`gate ${LEVER}: the coaching band ${path.relative(api, COACHING_BAND)}: judge ${b.judge.configuration}, measured on ${b.measuredOn}, harness ${b.harness}`);
} else {
  console.log(
    `gate ${LEVER}${dryRun ? " (dry run, offline stub)" : ""}: ${INPUTS.length} inputs${IS_SET ? ` (${SET_NAME})` : ` (not ${SET_NAME}: no verdict)`}, writing into ${LEVER_DIR}`,
  );
}
// Self-hosted first: a server that is not awake shows before Opus is paid for.
for (const c of [...CONFIGURATIONS].reverse()) {
  for (const root of ROOTS_RUN) await replay(c, root);
}
if (COACHING) await judgeReplies();

const analysisDir = path.join(LEVER_DIR, "analysis");
console.log(`\n== gate ${LEVER}: analysis ==`);
const analysed = await run([
  "scripts/replay-analysis.ts",
  "--roots",
  ROOTS_RUN.map((r) => path.join(LEVER_DIR, r)).join(","),
  "--out",
  analysisDir,
  "--baseline",
  BASELINE,
  ...(COACHING ? ["--judge", JUDGE_SCORES] : []),
]);
if (analysed.code !== 0) throw new Error(`The analysis failed (exit ${analysed.code}).`);

const { lines, transport } = record(JSON.parse(readFileSync(path.join(analysisDir, "analysis.json"), "utf8")) as AnalysisJson);
console.log(`\nGate record (paste into the lever's commit message; keep ${LEVER_DIR}):\n`);
for (const line of lines) console.log(line);
if (transport.length > 0) {
  console.error(`\nNot a gate result: ${transport.join("; ")}. Is the server awake? Rerun the gate to retry those replies.`);
  process.exitCode = 1;
}
