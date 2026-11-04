/**
 * The coaching judge (coaching-quality 09; scripts/replayJudge.ts has the
 * workings). A model scores the coaching run's drafts blind, as the coach did
 * on his form: one rating 1 to 5 and unsafe yes or no per draft, with reasons.
 * It is calibrated against his answer key first; only a judge that meets the
 * bar scores the whole baseline. Every run prints its cost estimate before any
 * call; the user starts the live runs.
 *
 * Calibrate: the form's drafts (the coach-packet key's cases, three drafts each)
 * scored by each judge, then compared with the answer key:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run replay:judge -- --calibrate \
 *     --judge claude-fable-5-1,claude-opus-5-5 \
 *     --roots ../.scratch/benchmark-coaching/baseline/seasons,../.scratch/benchmark-coaching/baseline/snapshot
 *
 * Score: every reply of every configuration and repeat in the roots, by one judge:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run replay:judge -- --score --judge claude-opus-5-5 \
 *     --roots ../.scratch/benchmark-coaching/baseline/seasons,../.scratch/benchmark-coaching/baseline/snapshot
 *
 * Flags:
 * - --judge <model>,...: the judge models (repeat or comma-separate); --effort
 *   <level> for all of them, high when absent.
 * - --roots: the baseline's output roots (the defaults above when absent).
 * - --judge-dir <dir>: where calibration.md and calibration.json go, and the
 *   scores under <judge-dir>/baseline-scores/<judge configuration>/<root>/<configuration>/<NN>.<R>.json;
 *   .scratch/benchmark-coaching/judge when absent (judge-dry-run on a dry run).
 *   Calibration's scores are the full scoring's for the same drafts, so they are not bought twice.
 * - --packet-key <file>: the form's key (tests/fixtures/coach-packet-key.json).
 * - --answers <file>: the answer key (.scratch/benchmark-coaching/coach-packet/returned/answer-key.json, private);
 *   --reviewer coach|user, coach when absent. With no answer key, calibration
 *   scores the drafts and says the comparison waits for it.
 * - --rubric <file>: the rubric the judge is given, verbatim (docs/coaching-rubric.md).
 *   A live run refuses to start without it; a dry run uses a stand-in.
 * - --athletes <file>: the athletes' cards (tests/fixtures/coach-packet-athletes.json).
 * - --score only: --configuration <name>,... to limit the configurations;
 *   --repeats <n> to score repeats 1 to n only.
 * - --estimate: print the estimate and stop. --dry-run: the offline stub, no
 *   key, no cost. A live run whose estimate is over $5 needs --allow-cost.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANTHROPIC_EFFORT_LEVELS, parseAnthropicEffort } from "../src/llm/effort.js";
import type { CoachAthlete, CoachPacketKey } from "./replayCoachPacket.js";
import { GATE_COST_CAP_USD } from "./replayCost.js";
import { configurationInputs } from "./replayInputs.js";
import {
  baselineJobs,
  calibrate,
  calibrationJobs,
  DEFAULT_JUDGE_EFFORT,
  describeJudgeEstimate,
  estimateJudge,
  judgeConfiguration,
  runJudge,
  writeCalibration,
  type AnswerKey,
  type Judge,
  type JudgeJob,
} from "./replayJudge.js";
import type { ReviewInput } from "./replayReview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);

function flagValue(flag: string, what: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return value;
}

function flagValues(flag: string, what: string): string[] {
  const values: string[] = [];
  argv.forEach((arg, i) => {
    if (arg !== flag) return;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
    values.push(...value.split(",").map((v) => v.trim()).filter(Boolean));
  });
  return values;
}

const flagPath = (flag: string, fallback: string) => path.resolve(flagValue(flag, "a path") ?? fallback);

/** A configuration folder's inputs rebuilt from its config.json, in input-id order, as the replay's review pack loads them. */
function loadInputs(configDir: string): ReviewInput[] | null {
  const calls = configurationInputs(configDir);
  if (!calls) return null;
  return calls.map((call, i) => ({
    id: String(i + 1).padStart(2, "0"),
    operation: call.operation,
    source: call.source,
    goal: call.goal,
    ...("packet" in call ? { packet: call.packet, aboutYou: null } : { packet: null, aboutYou: call.input }),
    // Only weekly reads are judged, and they carry nothing the athlete sent with the call.
    asked: null,
  }));
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

async function main(): Promise<void> {
  const calibrating = has("--calibrate");
  const scoring = has("--score");
  if (calibrating === scoring) throw new Error("Pass --calibrate (score the form's drafts and compare with the answer key) or --score (score the whole baseline root).");
  const dryRun = has("--dry-run");

  const rawEffort = flagValue("--effort", "a level");
  const effort = rawEffort === null ? DEFAULT_JUDGE_EFFORT : parseAnthropicEffort(rawEffort);
  if (!effort) throw new Error(`Invalid --effort "${rawEffort}": expected one of ${ANTHROPIC_EFFORT_LEVELS.join(", ")}.`);
  const models = flagValues("--judge", "a comma-separated list of model ids");
  if (models.length === 0) throw new Error("Pass --judge <model id>,..., such as --judge claude-fable-5-1,claude-opus-5-5.");
  if (scoring && models.length > 1) throw new Error("--score takes one judge: the one calibration chose.");
  const judges: Judge[] = models.map((model) => ({ provider: "anthropic", model, effort }));

  const roots = flagValues("--roots", "a comma-separated list of output roots").map((r) => path.resolve(r));
  if (roots.length === 0) {
    roots.push(path.join(repo, ".scratch/benchmark-coaching/baseline/seasons"), path.join(repo, ".scratch/benchmark-coaching/baseline/snapshot"));
  }
  for (const r of roots) if (!existsSync(r)) throw new Error(`--roots: ${r} does not exist.`);
  const judgeDir = flagPath("--judge-dir", path.join(repo, `.scratch/benchmark-coaching/${dryRun ? "judge-dry-run" : "judge"}`));
  const scoresDir = path.join(judgeDir, "baseline-scores");

  const rubricFile = flagPath("--rubric", path.join(repo, "docs/coaching-rubric.md"));
  const rubricMissing = !existsSync(rubricFile);
  if (rubricMissing && !dryRun && !has("--estimate")) {
    throw new Error(`The judge is given the rubric verbatim, and ${rubricFile} does not exist yet (ticket 08 writes it). Pass --rubric <file>.`);
  }
  const rubric = rubricMissing ? "(Stand-in for docs/coaching-rubric.md, which is not written yet: dry run only.)" : readFileSync(rubricFile, "utf8");

  const athletes = Object.fromEntries(
    Object.entries(readJson<Record<string, CoachAthlete | string>>(flagPath("--athletes", path.join(here, "../tests/fixtures/coach-packet-athletes.json")))).filter(
      (e): e is [string, CoachAthlete] => typeof e[1] === "object",
    ),
  );
  const packetKeyFile = flagPath("--packet-key", path.join(here, "../tests/fixtures/coach-packet-key.json"));
  const packetKey = readJson<CoachPacketKey>(packetKeyFile);
  const sources = { roots, athletes, loadInputs };

  let jobs: JudgeJob[];
  if (calibrating) {
    jobs = calibrationJobs(packetKey, sources);
    console.log(`calibration: ${jobs.length} form drafts (${packetKey.cases.length} cases, key ${path.relative(process.cwd(), packetKeyFile)}), judges ${judges.map(judgeConfiguration).join(", ")}`);
  } else {
    const repeatsRaw = flagValue("--repeats", "a number");
    if (repeatsRaw !== null && !/^[1-9]\d*$/.test(repeatsRaw)) throw new Error(`Invalid --repeats "${repeatsRaw}": expected a whole number from 1.`);
    const configurations = flagValues("--configuration", "a comma-separated list of configuration folder names");
    const built = baselineJobs({
      ...sources,
      configurations: configurations.length ? configurations : null,
      repeats: repeatsRaw === null ? null : Number(repeatsRaw),
      key: packetKey,
    });
    jobs = built.jobs;
    for (const note of built.notes) console.log(`  note: ${note}`);
    console.log(`scoring: ${jobs.length} replies in ${roots.map((r) => path.basename(r)).join(", ")}, judge ${judgeConfiguration(judges[0]!)}`);
  }

  const estimates = judges.map((j) => estimateJudge(jobs, j, rubric, rubricMissing, scoresDir));
  console.log(`cost estimate${dryRun ? " (a dry run bills nothing; this is what the live run would)" : ""}:`);
  for (const line of describeJudgeEstimate(estimates, rubricMissing)) console.log(line);
  if (has("--estimate")) return;
  const total = estimates.reduce((n, e) => n + e.usd, 0);
  if (!dryRun && estimates.some((e) => e.unpriced)) throw new Error("A judge model is not in PRICE_TABLE; add its price before a live run.");
  if (!dryRun && total > GATE_COST_CAP_USD && !has("--allow-cost")) {
    throw new Error(`The estimate is over $${GATE_COST_CAP_USD}; pass --allow-cost to run it.`);
  }

  const keyEnv = flagValue("--key-env", "an environment variable name") ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[keyEnv]?.trim() || null;
  if (!dryRun && !apiKey) throw new Error(`Set ${keyEnv} to run the judge, or pass --dry-run or --estimate.`);

  for (const judge of judges) {
    const done = await runJudge({ jobs, judge, rubric, scoresDir, dryRun, apiKey, log: (l) => console.log(`  ${l}`) });
    console.log(`${judgeConfiguration(judge)}: ${done.called} scored, ${done.skipped} already scored, ${done.failed} failed, in ${path.join(scoresDir, judgeConfiguration(judge))}`);
  }

  if (calibrating) {
    const answersFile = flagPath("--answers", path.join(here, "../../.scratch/benchmark-coaching/coach-packet/returned/answer-key.json"));
    if (!existsSync(answersFile)) {
      console.log(`No answer key at ${answersFile} yet: the drafts are scored, and the comparison waits for it (run --calibrate again; scored drafts are not called again).`);
      return;
    }
    const report = calibrate({ judges, answerKey: readJson<AnswerKey>(answersFile), reviewer: flagValue("--reviewer", "coach or user") ?? "coach", scoresDir, dryRun });
    writeCalibration(judgeDir, report);
    const b = report.bar;
    console.log(`  the bar${report.barFrom ? ` (the ${report.barFrom}'s agreement with the ${report.reviewer})` : ""}: ${b.pickAgreement === null ? "picks not used" : `pick agreement >= ${b.pickAgreement.toFixed(2)}`}, unsafe recall >= ${b.unsafeRecall.toFixed(2)}, rating MAD <= ${b.ratingMad.toFixed(2)}`);
    for (const j of report.judges) {
      console.log(
        `  ${j.judge}: pick agreement ${j.pickAgreement ?? "n/a"} over ${j.casesCompared} cases, unsafe recall ${j.unsafeRecall ?? "n/a"}, rating MAD ${j.ratingMad ?? "n/a"}; ${j.meetsBar ? "meets" : "misses"} the bar`,
      );
    }
    console.log(report.choice ? `choice: ${report.choice}` : "no judge meets the bar: the rubric goes back to the coach");
    console.log(`wrote ${path.join(judgeDir, "calibration.md")} and calibration.json`);
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
