/**
 * Writes the coaching band (tests/fixtures/coaching-band.json, coaching-quality
 * ticket 12) from the coaching baseline's saved judge scores, so the band is
 * never typed by hand. Makes no calls.
 *
 *   cd api
 *   npm run replay:coaching-band -- --bench ../.scratch/benchmark-coaching
 *
 * Per configuration (by the gate's short name, scripts/replayGateConfigurations.ts)
 * it reads the judge's scores of the hard set (tests/fixtures/hard-set.json),
 * repeat by repeat, and records each repeat's mean rating and unsafe replies,
 * the mean of the repeat means, the spread (highest repeat mean minus lowest),
 * the floor (mean minus spread) and the worst repeat's unsafe count. A reply
 * the replay saved as failed was judged as no reply arrived and counts as the
 * judge rated it. Every repeat must hold a score for every hard-set input; a
 * missing or failed judge call stops the script.
 *
 * Where each row comes from (folders under --bench):
 *
 *   opus          baseline/ repeats 1-3 (rules retry off), judged in judge-2/,
 *                 and rules-retry/ repeat 1 (rules retry on), judged in
 *                 judge-retry/, as a fourth repeat: the retry never fired on
 *                 the control, so that run is a clean repeat.
 *   gpt-oss-20b   rules-retry/ repeats 1-3, judged in judge-retry/: the app
 *                 runs with the rules retry on (2f8960c), and gpt-oss-20b is
 *                 the configuration it changes.
 *   the rest      baseline/ repeats 1-3, judged in judge-2/.
 *
 * Each source's config.json is checked: a live run, of the named configuration,
 * with the rules retry as stated. --out names another file; --harness the
 * commit to record (the current HEAD's short hash when absent); --measured-on
 * the date (today when absent).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJudgeDir, type JudgeScore } from "./replayCoaching.js";
import { GATE_CONFIGURATIONS } from "./replayGateConfigurations.js";
import type { CoachingBand, CoachingBandRow } from "./replayGateRule.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, "..");
const repo = path.resolve(api, "..");
const HARD_SET = "tests/fixtures/hard-set.json";
const ROOTS = ["seasons", "snapshot"] as const;
const JUDGE = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", configuration: "anthropic--claude-opus-5-5--high" };

function flagValue(flag: string, what: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return value;
}

const BENCH = path.resolve(flagValue("--bench", "the coaching benchmark's folder") ?? path.join(repo, ".scratch/benchmark-coaching"));
const OUT = path.resolve(flagValue("--out", "a file") ?? path.join(api, "tests/fixtures/coaching-band.json"));
const HARNESS = flagValue("--harness", "a commit") ?? execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: api, encoding: "utf8" }).trim();
const MEASURED_ON = flagValue("--measured-on", "a date, such as 2026-11-04") ?? new Date().toISOString().slice(0, 10);

/** One run's repeats of a configuration: the replies' folder, the judge's folder, and the rules retry it ran with. */
type Source = { replies: string; scores: string; repeats: number[]; rulesRetry: boolean };

const BASELINE: Source = { replies: "baseline", scores: "judge-2", repeats: [1, 2, 3], rulesRetry: false };
const RULES_RETRY: Source = { replies: "rules-retry", scores: "judge-retry", repeats: [1, 2, 3], rulesRetry: true };

const SOURCES: Record<string, { sources: Source[]; note: string }> = {
  opus: {
    sources: [BASELINE, { ...RULES_RETRY, repeats: [1] }],
    note: "The control. Repeats 1-3 are the baseline (rules retry off); repeat 4 is the rules-retry control run (rules retry on), which never fired on it (the control tripped no plan rule), so it is a fourth clean repeat.",
  },
  "gpt-oss-20b": {
    sources: [RULES_RETRY],
    note: "From the rules-retry run: the app runs with the rules retry on since 2f8960c, and this is the configuration it changes.",
  },
};

const hardSet = (JSON.parse(readFileSync(path.join(api, HARD_SET), "utf8")) as Array<{ input: string }>).map((e) => e.input).sort();
/** A source folder as the repo names it: --bench is <repo>/.scratch/benchmark-coaching, wherever that repo is checked out. */
const rel = (p: string) => path.relative(path.dirname(path.dirname(BENCH)), p);

/** Checks a source's replies were a live run of `folder` with the rules retry as stated. */
function checkReplies(source: Source, folder: string): void {
  for (const root of ROOTS) {
    const file = path.join(BENCH, source.replies, root, folder, "config.json");
    if (!existsSync(file)) throw new Error(`${file} does not exist.`);
    const config = JSON.parse(readFileSync(file, "utf8")) as { configuration?: string; dryRun?: boolean; rulesRetry?: boolean };
    if (config.dryRun) throw new Error(`${file} is a dry run.`);
    if (config.configuration !== folder) throw new Error(`${file} is ${config.configuration}, not ${folder}.`);
    if (Boolean(config.rulesRetry) !== source.rulesRetry) throw new Error(`${file}: rules retry ${config.rulesRetry ? "on" : "off"}, expected ${source.rulesRetry ? "on" : "off"}.`);
  }
}

/** One repeat's scores of `folder` in a source, every hard-set input scored, or a thrown error. */
function repeatScores(scores: JudgeScore[], folder: string, repeat: number, where: string): JudgeScore[] {
  const mine = scores.filter((s) => s.configuration === folder && s.repeat === repeat);
  const failed = mine.filter((s) => s.outcome !== "ok");
  if (failed.length) throw new Error(`${where}: ${folder} repeat ${repeat}: ${failed.length} failed judge calls (${failed.map((s) => s.input).join(", ")}).`);
  const inputs = mine.map((s) => s.input).sort();
  if (inputs.join(",") !== hardSet.join(",")) {
    throw new Error(`${where}: ${folder} repeat ${repeat} scores ${inputs.length} inputs, not the hard set's ${hardSet.length} (missing ${hardSet.filter((i) => !inputs.includes(i)).join(", ") || "none"}).`);
  }
  return mine;
}

function row(short: string): CoachingBandRow & Record<string, unknown> {
  const c = GATE_CONFIGURATIONS.find((x) => x.short === short)!;
  const { sources, note } = SOURCES[short] ?? { sources: [BASELINE], note: "From the baseline (rules retry off)." };
  const repeatMeans: number[] = [];
  const unsafe: number[] = [];
  const from: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    checkReplies(source, c.folder);
    const judgeDir = path.join(BENCH, source.scores, "baseline-scores", JUDGE.configuration);
    const read = readJudgeDir(judgeDir);
    for (const repeat of source.repeats) {
      const s = repeatScores(read.scores, c.folder, repeat, rel(judgeDir));
      repeatMeans.push(s.reduce((n, x) => n + x.rating!, 0) / s.length);
      unsafe.push(s.filter((x) => x.unsafe === true).length);
    }
    from.push({
      replies: ROOTS.map((r) => rel(path.join(BENCH, source.replies, r, c.folder))),
      scores: ROOTS.map((r) => rel(path.join(judgeDir, r, c.folder))),
      repeats: source.repeats,
      rulesRetry: source.rulesRetry,
    });
  }
  const mean = repeatMeans.reduce((n, x) => n + x, 0) / repeatMeans.length;
  const spread = Math.max(...repeatMeans) - Math.min(...repeatMeans);
  return {
    configuration: c.folder,
    repeats: repeatMeans.length,
    repeatMeans,
    mean,
    spread,
    floor: mean - spread,
    unsafe,
    worstUnsafe: Math.max(...unsafe),
    rulesRetry: [...new Set(sources.map((s) => s.rulesRetry))].length > 1 ? "mixed" : sources[0]!.rulesRetry,
    sources: from,
    note,
  };
}

const band: CoachingBand & Record<string, unknown> = {
  inputs: HARD_SET,
  inputCount: hardSet.length,
  judge: JUDGE,
  measuredOn: MEASURED_ON,
  harness: HARNESS,
  control: "opus",
  gateRulesRetry: true,
  configurations: Object.fromEntries(GATE_CONFIGURATIONS.map((c) => [c.short, row(c.short)])),
  note:
    "Per configuration, the judge's mean rating of each repeat over the hard set and each repeat's unsafe replies. A coaching gate run (npm run replay:gate -- --set coaching) passes when its mean rating is at or above mean minus spread and its unsafe replies a repeat are at or below worstUnsafe. Gate runs pass --rules-retry to the replay, as the app runs with it on. Written by scripts/replay-coaching-band.ts; do not edit by hand.",
};

writeFileSync(OUT, `${JSON.stringify(band, null, 2)}\n`);
console.log(`wrote ${OUT}`);
for (const [short, r] of Object.entries(band.configurations)) {
  console.log(
    `  ${short}: ${r.repeatMeans.map((m) => m.toFixed(2)).join(" / ")}, mean ${r.mean.toFixed(2)}, spread ${r.spread.toFixed(2)}, floor ${r.floor.toFixed(2)}; unsafe ${r.unsafe.join(" / ")}, worst ${r.worstUnsafe}`,
  );
}
