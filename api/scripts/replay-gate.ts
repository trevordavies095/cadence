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
 * .scratch/benchmark/, which holds the "before" runs.
 *
 * Last, it prints the gate record, one line per configuration: replies valid
 * as sent (accepted by the validator, on the first try or when asked once more,
 * as the benchmark counted them) out of the replies run, and how many of the
 * valid replies carry a soft repair by the validator:
 *
 *   gate strict: opus 20/20 valid, 0 repairs
 *   gate strict: gpt-oss-20b 9/20 valid, 0 repairs
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
 * --configs <short>[,<short>] runs only the named configurations (opus,
 * gpt-oss-20b; default both), such as --configs gpt-oss-20b to iterate on the
 * self-hosted side without paying for Opus.
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
 * configuration is estimated at $0 and never refuses. When the total is above
 * $5 the gate refuses to start: it says so, names --allow-cost, and exits
 * non-zero having called no model. --allow-cost runs it anyway. A dry run
 * prints and applies the same check, so the refusal can be rehearsed offline.
 * The plain replay (npm run replay) has no such check.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_OUTPUT_TOKENS } from "../src/llm/anthropic.js";
import { describeEstimate, estimateGateCost } from "./replayCost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, "..");
const REGRESSION_SET = path.join(api, "tests/fixtures/regression-set.json");
const SEASON_PACKETS = path.join(api, "tests/fixtures/seasons/season-packets");
const TSX = path.join(api, "node_modules/.bin/tsx");
const ROOTS = ["snapshot", "seasons"] as const;
type Root = (typeof ROOTS)[number];

/** The two configurations a gate runs; `short` names each in the record. */
const ALL_CONFIGURATIONS = [
  { short: "opus", folder: "anthropic--claude-opus-4-7--xhigh", provider: "anthropic", model: "claude-opus-4-7", effort: "xhigh" },
  { short: "gpt-oss-20b", folder: "self_hosted--gpt-oss-20b-MXFP4-Q8--high", provider: "self_hosted", model: "gpt-oss-20b-MXFP4-Q8", effort: "high" },
] as const;
type Configuration = (typeof ALL_CONFIGURATIONS)[number];
const BASELINE = ALL_CONFIGURATIONS[0].folder;

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
const configsFlag = flagValue("--configs", "configuration names, such as opus,gpt-oss-20b");
const CONFIGURATIONS: Configuration[] = configsFlag
  ? configsFlag.split(",").map((name) => {
      const c = ALL_CONFIGURATIONS.find((x) => x.short === name);
      if (!c) throw new Error(`Unknown configuration "${name}" in --configs: ${ALL_CONFIGURATIONS.map((x) => x.short).join(", ")}.`);
      return c;
    })
  : [...ALL_CONFIGURATIONS];
const BASE_URL = flagValue("--base-url", "the self-hosted server's URL") ?? (dryRun ? "http://gate-dry-run.invalid:8000" : null);
if (!BASE_URL && CONFIGURATIONS.some((c) => c.provider === "self_hosted")) throw new Error("--base-url <url> is required: the oMLX server serving gpt-oss-20b-MXFP4-Q8, such as http://macbook.local:8000.");
const KEY_ENV = flagValue("--key-env", "an environment variable name");
const PARENT = path.resolve(flagValue("--root", "a folder") ?? path.resolve(api, "../.scratch/benchmark-after"));
const LEVER_DIR = path.join(PARENT, dryRun ? `${LEVER}-dry-run` : LEVER);
const SAVED_RUNS = (flagValue("--saved-runs", "one or more folders, comma-separated") ?? ["../.scratch/benchmark", "../.scratch/benchmark-after"].map((d) => path.resolve(api, d)).join(","))
  .split(",")
  .filter(Boolean)
  .map((d) => path.resolve(d));


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

/** Refuses a lever folder at or under any .scratch/benchmark/, where the "before" runs live. */
function refuseBeforeRuns(dir: string): void {
  for (const candidate of new Set([dir, realish(dir)])) {
    for (let p = candidate; ; p = path.dirname(p)) {
      if (path.basename(p) === "benchmark" && path.basename(path.dirname(p)) === ".scratch") {
        throw new Error(`Refusing to write into ${dir}: it is under ${p}, the "before" runs. Use .scratch/benchmark-after.`);
      }
      if (path.dirname(p) === p) break;
    }
  }
}

refuseBeforeRuns(LEVER_DIR);

/** A folder saved by a dry run must not be resumed by a live run, nor the other way round. */
function refuseMixedRuns(): void {
  for (const root of ROOTS) {
    for (const c of CONFIGURATIONS) {
      const file = path.join(LEVER_DIR, root, c.folder, "config.json");
      if (!existsSync(file)) continue;
      const saved = JSON.parse(readFileSync(file, "utf8")) as { dryRun?: boolean };
      if (Boolean(saved.dryRun) !== dryRun) {
        throw new Error(`${file} was written by a ${saved.dryRun ? "dry" : "live"} run; this is a ${dryRun ? "dry" : "live"} run. Use another --lever.`);
      }
    }
  }
}

refuseMixedRuns();

// ---- The regression set ---------------------------------------------------------------

const regressionSet = JSON.parse(readFileSync(REGRESSION_SET, "utf8")) as Array<{ input: string; why: string }>;
const idsOf = (root: Root) => regressionSet.map((e) => e.input).filter((i) => i.startsWith(`${root}/`)).map((i) => i.slice(root.length + 1));

// ---- Caps on spend -------------------------------------------------------------------

/** Prints the output cap and the estimate; refuses, before anything is written or called, above the cap. */
function checkCost(): void {
  const estimate = estimateGateCost(
    CONFIGURATIONS.map((c) => ({ short: c.short, folder: c.folder, provider: c.provider, inputs: ROOTS.reduce((n, r) => n + idsOf(r).length, 0) })),
    SAVED_RUNS,
  );
  console.log(`gate ${LEVER}: output cap ${MAX_OUTPUT_TOKENS} tokens per call (thinking included)`);
  console.log(`gate ${LEVER}: estimated cost${dryRun ? " of the live run (this dry run sends nothing)" : ""}:`);
  for (const line of describeEstimate(estimate)) console.log(line);
  if (!estimate.refused) return;
  if (allowCost) {
    console.log(`gate ${LEVER}: the estimate is above the $${estimate.capUsd} cap; going on, as --allow-cost was passed.`);
    return;
  }
  console.error(
    `Refusing to start: the estimated cost $${estimate.totalUsd.toFixed(2)} is above the $${estimate.capUsd} cap. Pass --allow-cost to run it anyway. No model was called.`,
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

function replayArgs(c: Configuration, root: Root): string[] {
  const args = ["scripts/replay-weekly-reads.ts", "--out", path.join(LEVER_DIR, root), "--only", `@${REGRESSION_SET}`, "--repeats", "1"];
  if (root === "seasons") args.push("--packets", SEASON_PACKETS);
  args.push("--provider", c.provider, "--model", c.model, "--effort", c.effort);
  if (c.provider === "self_hosted") {
    args.push("--base-url", BASE_URL!);
    if (KEY_ENV) args.push("--key-env", KEY_ENV);
  }
  if (dryRun) args.push("--dry-run");
  return args;
}

/** The regression-set inputs of `root` with neither a reply nor a refusal saved for `c`. */
function missingReplies(c: Configuration, root: Root): string[] {
  const dir = path.join(LEVER_DIR, root, c.folder);
  const files = new Set(existsSync(dir) ? readdirSync(dir) : []);
  return idsOf(root).filter((id) => !files.has(`${id}.1.json`) && !files.has(`${id}.1.failed.json`));
}

/**
 * One replay, judged: a clean exit, or a non-zero exit caused only by failed
 * goal checks (the demo snapshot's missing goal line, by design), with every
 * input's reply saved. Anything else is a failed run.
 */
async function replay(c: Configuration, root: Root): Promise<void> {
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

// ---- The record -------------------------------------------------------------------------

type Outcome = { replies: number; firstTry: number; afterRetry: number; failedBy: Record<string, number> };
type AnalysisJson = {
  outcomes: Array<{ configuration: string; all: Outcome }>;
  quality: Array<{ configuration: string; valid: { softRepairReplies: number } }>;
};

/** One record line per configuration, from the analysis, and any transport failure that voids it. */
function record(analysis: AnalysisJson): { lines: string[]; transport: string[] } {
  const lines: string[] = [];
  const transport: string[] = [];
  for (const c of CONFIGURATIONS) {
    const o = analysis.outcomes.find((x) => x.configuration === c.folder)?.all;
    const q = analysis.quality.find((x) => x.configuration === c.folder)?.valid;
    if (!o || !q) throw new Error(`The analysis has no ${c.folder}.`);
    lines.push(`gate ${LEVER}: ${c.short} ${o.firstTry + o.afterRetry}/${o.replies} valid, ${q.softRepairReplies} repairs`);
    const lost = o.failedBy["http/transport/timeout"] ?? 0;
    if (lost > 0) transport.push(`${c.short}: ${lost} repl${lost === 1 ? "y" : "ies"} lost to http/transport/timeout`);
  }
  return { lines, transport };
}

// ---- Main ---------------------------------------------------------------------------------

mkdirSync(LEVER_DIR, { recursive: true });
console.log(`gate ${LEVER}${dryRun ? " (dry run, offline stub)" : ""}: ${regressionSet.length} inputs, writing into ${LEVER_DIR}`);
// Self-hosted first: a server that is not awake shows before Opus is paid for.
for (const c of [...CONFIGURATIONS].reverse()) {
  for (const root of ROOTS) await replay(c, root);
}

const analysisDir = path.join(LEVER_DIR, "analysis");
console.log(`\n== gate ${LEVER}: analysis ==`);
const analysed = await run([
  "scripts/replay-analysis.ts",
  "--roots",
  ROOTS.map((r) => path.join(LEVER_DIR, r)).join(","),
  "--out",
  analysisDir,
  "--baseline",
  BASELINE,
]);
if (analysed.code !== 0) throw new Error(`The analysis failed (exit ${analysed.code}).`);

const { lines, transport } = record(JSON.parse(readFileSync(path.join(analysisDir, "analysis.json"), "utf8")) as AnalysisJson);
console.log(`\nGate record (paste into the lever's commit message; keep ${LEVER_DIR}):\n`);
for (const line of lines) console.log(line);
if (transport.length > 0) {
  console.error(`\nNot a gate result: ${transport.join("; ")}. Is the server awake? Rerun the gate to retry those replies.`);
  process.exitCode = 1;
}
