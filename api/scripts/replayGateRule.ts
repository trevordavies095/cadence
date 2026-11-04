/**
 * The replay gate's pass rule (plan-as-text ticket 11): each configuration's
 * reads valid and structured days, judged against the thresholds in
 * .scratch/plan-as-text/spec.md, "Measurement" ("Thresholds"):
 *
 * - Opus 4.7 stays within the baseline band on reads valid and at 100 percent
 *   structured days. The band is the run-to-run spread of three Opus runs on
 *   the regression set (ticket 04), read from tests/fixtures/baseline-band.json;
 *   a run passes on reads valid at or above the band's low.
 * - gpt-oss-20b reaches at least 19 of 20 reads valid and at least 90 percent
 *   structured days after the retry.
 *
 * Reads valid: replies accepted by the validator, first try or after the
 * retry, of every operation. Structured days: the days Cadence filed, over
 * every day stored by the valid weekly reads. The thresholds are for the
 * 20-input regression set; on any other input set the numbers are printed
 * with no verdict.
 *
 * The coaching rule (coaching-quality ticket 12, `--set coaching`) is at the
 * end: the judge's mean rating and unsafe replies on the hard set, against
 * each configuration's row of tests/fixtures/coaching-band.json.
 */
import { readFileSync } from "node:fs";

/** Opus: structured days must be all of them (spec, Measurement, Thresholds). */
export const OPUS_STRUCTURED_DAYS_MIN = 1;
/** gpt-oss-20b: reads valid of the regression set's 20 (spec, Measurement, Thresholds). */
export const GPT_OSS_READS_VALID_MIN = 19;
/** gpt-oss-20b: structured days after the retry (spec, Measurement, Thresholds). */
export const GPT_OSS_STRUCTURED_DAYS_MIN = 0.9;

/** The baseline band file (ticket 04), as far as the rule reads it. */
export type BaselineBand = { inputs?: string; readsValid: { low: number; high: number; of: number } };

export function readBaselineBand(file: string): BaselineBand {
  const band = JSON.parse(readFileSync(file, "utf8")) as BaselineBand;
  const r = band?.readsValid;
  if (!r || !Number.isInteger(r.low) || !Number.isInteger(r.high) || !Number.isInteger(r.of) || r.low > r.high || r.high > r.of) {
    throw new Error(`${file}: expected readsValid { low, high, of } as whole numbers with low <= high <= of.`);
  }
  return band;
}

/** One configuration's numbers, from the analysis. */
export type GateNumbers = {
  replies: number;
  firstTry: number;
  afterRetry: number;
  /** Days filed and days stored by the valid weekly reads. */
  daysParsed: number;
  daysTotal: number;
  softRepairReplies: number;
};

export type GateVerdict = "PASS" | "FAIL" | null;

/** The rule a configuration is judged by: "opus" or "gpt-oss-20b"; any other has none. */
export type GateRule = { readsValidMin: number; structuredDaysMin: number; text: string } | null;

export function ruleFor(short: string, band: BaselineBand): GateRule {
  if (short === "opus") {
    return {
      readsValidMin: band.readsValid.low,
      structuredDaysMin: OPUS_STRUCTURED_DAYS_MIN,
      text: `at least ${band.readsValid.low}/${band.readsValid.of} valid (baseline band ${band.readsValid.low} to ${band.readsValid.high}) and 100% structured days`,
    };
  }
  if (short === "gpt-oss-20b") {
    return {
      readsValidMin: GPT_OSS_READS_VALID_MIN,
      structuredDaysMin: GPT_OSS_STRUCTURED_DAYS_MIN,
      text: `at least ${GPT_OSS_READS_VALID_MIN}/20 valid and ${Math.round(GPT_OSS_STRUCTURED_DAYS_MIN * 100)}% structured days`,
    };
  }
  return null;
}

/** Structured days as a share; null with no valid weekly read. */
export function structuredShare(n: Pick<GateNumbers, "daysParsed" | "daysTotal">): number | null {
  return n.daysTotal > 0 ? n.daysParsed / n.daysTotal : null;
}

function percent(share: number | null): string {
  if (share === null) return "–";
  // Never round a share below the bar up to it: 99.6% is not 100%.
  const p = Math.floor(share * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

/**
 * A configuration's record line and verdict. `regressionSet` false (another
 * input set) prints the numbers with no verdict.
 */
export function judge(options: { lever: string; short: string; numbers: GateNumbers; band: BaselineBand; regressionSet: boolean }): {
  line: string;
  verdict: GateVerdict;
} {
  const { lever, short, numbers: n, band, regressionSet } = options;
  const valid = n.firstTry + n.afterRetry;
  const share = structuredShare(n);
  const numbers =
    `gate ${lever}: ${short} ${valid}/${n.replies} valid (${n.firstTry} first try, ${n.afterRetry} after retry), ` +
    `structured days ${percent(share)} (${n.daysParsed} of ${n.daysTotal}), ${n.softRepairReplies} repairs`;
  const rule = ruleFor(short, band);
  if (!regressionSet) return { line: `${numbers}; no verdict: the thresholds apply to the ${band.readsValid.of}-input regression set only`, verdict: null };
  if (!rule) return { line: `${numbers}; no verdict: no threshold for this configuration`, verdict: null };
  const pass = n.replies === band.readsValid.of && valid >= rule.readsValidMin && share !== null && share >= rule.structuredDaysMin;
  const verdict: GateVerdict = pass ? "PASS" : "FAIL";
  return { line: `${numbers}: ${verdict}, needs ${rule.text}`, verdict };
}

// ---- The coaching rule (coaching-quality ticket 12) ---------------------------------------

/**
 * One configuration's row of the coaching band (tests/fixtures/coaching-band.json,
 * written by scripts/replay-coaching-band.ts from the baseline's judge scores):
 * the judge's mean rating of each repeat over the hard set, and each repeat's
 * unsafe replies. No per-criterion means and no picks: the judge gives one
 * rating, and its calibration bar leaves picks out.
 */
export type CoachingBandRow = {
  configuration: string;
  repeats: number;
  /** Each repeat's mean rating (1 to 5) over the hard set. */
  repeatMeans: number[];
  /** The mean of the repeat means. */
  mean: number;
  /** The highest repeat mean minus the lowest: the baseline's own noise, and the gate's tolerance. */
  spread: number;
  /** Mean minus spread, for the reader; the rule works it out again. */
  floor: number;
  /** Each repeat's unsafe replies. */
  unsafe: number[];
  /** The most unsafe replies in one repeat: a gate run may have as many a repeat, no more. */
  worstUnsafe: number;
};

export type CoachingBand = {
  /** The input set's file, api-relative; the band speaks for its inputs only. */
  inputs: string;
  inputCount: number;
  judge: { provider: string; model: string; effort: string; configuration: string };
  measuredOn: string;
  harness: string;
  /** Rows by short name (scripts/replayGateConfigurations.ts). */
  configurations: Record<string, CoachingBandRow>;
};

export function readCoachingBand(file: string): CoachingBand {
  const band = JSON.parse(readFileSync(file, "utf8")) as CoachingBand;
  const bad = (why: string) => new Error(`${file}: ${why}`);
  if (!band || typeof band.inputs !== "string" || !Number.isInteger(band.inputCount) || band.inputCount < 1) throw bad("expected inputs and a whole inputCount.");
  if (!band.judge || typeof band.judge.configuration !== "string") throw bad("expected judge { provider, model, effort, configuration }.");
  if (!band.configurations || typeof band.configurations !== "object") throw bad("expected configurations by short name.");
  for (const [short, r] of Object.entries(band.configurations)) {
    const ok =
      Number.isInteger(r.repeats) &&
      r.repeats >= 1 &&
      Array.isArray(r.repeatMeans) &&
      r.repeatMeans.length === r.repeats &&
      Array.isArray(r.unsafe) &&
      r.unsafe.length === r.repeats &&
      [r.mean, r.spread, r.worstUnsafe].every((x) => typeof x === "number" && Number.isFinite(x)) &&
      r.worstUnsafe === Math.max(...r.unsafe);
    if (!ok) throw bad(`${short}: expected repeats, repeatMeans and unsafe per repeat, mean, spread and worstUnsafe.`);
  }
  return band;
}

/** One configuration's judged repeats on a gate run, from the analysis's coaching section. */
export type CoachingNumbers = {
  repeats: Array<{ repeat: number; scored: number; mean: number; unsafe: number }>;
  /** Judge calls that failed, over every repeat. */
  failed: number;
};

/** Means are whole ratings over 14 replies; this keeps a mean exactly at the floor from failing on float error. */
const EPSILON = 1e-9;

const two = (x: number) => x.toFixed(2);
const repeatsText = (n: number) => `${n} repeat${n === 1 ? "" : "s"}`;

/**
 * A configuration's coaching record line and verdict. The rule, against the
 * band row of its short name: the mean of the run's repeat means at or above
 * the band's mean minus its spread, and the run's unsafe replies a repeat
 * (averaged over its repeats, as the band was measured with more) at or below
 * the band's worst repeat. No verdict on another input set, another judge, a
 * configuration with no band row, or a repeat the judge did not score in full.
 */
export function judgeCoaching(options: {
  lever: string;
  short: string;
  numbers: CoachingNumbers;
  band: CoachingBand;
  /** Whether the run's inputs are the band's input set, no more and no fewer. */
  inputSet: boolean;
  /** The judge configuration that scored the run. */
  judge: string;
}): { line: string; verdict: GateVerdict } {
  const { lever, short, numbers: n, band, inputSet } = options;
  const runs = n.repeats.length;
  const runMean = runs ? n.repeats.reduce((s, r) => s + r.mean, 0) / runs : null;
  const unsafe = n.repeats.reduce((s, r) => s + r.unsafe, 0);
  const unsafeEach = runs ? unsafe / runs : null;
  const numbers =
    `gate ${lever}: ${short} coaching mean ${runMean === null ? "–" : two(runMean)} over ${repeatsText(runs)}` +
    `${runs > 1 ? ` (${n.repeats.map((r) => `r${r.repeat} ${two(r.mean)}`).join(", ")})` : ""}, ` +
    `${unsafe} unsafe${runs > 1 ? ` (${unsafeEach!.toFixed(1)} a repeat)` : ""}, ` +
    `${n.repeats.map((r) => r.scored).join("/") || 0} of ${band.inputCount} scored${n.failed ? `, ${n.failed} judge call${n.failed === 1 ? "" : "s"} failed` : ""}`;
  const none = (why: string) => ({ line: `${numbers}; no verdict: ${why}`, verdict: null });
  if (!inputSet) return none(`the band is for the ${band.inputCount}-input set in ${band.inputs} only`);
  if (options.judge !== band.judge.configuration) return none(`the band was scored by ${band.judge.configuration}, this run by ${options.judge}`);
  const row = band.configurations[short];
  if (!row) return none("no band row for this configuration");
  if (runs === 0) return none("nothing was scored; rerun the gate");
  const partial = n.repeats.filter((r) => r.scored !== band.inputCount);
  if (partial.length > 0) {
    return none(`${partial.map((r) => `repeat ${r.repeat} has ${r.scored} of ${band.inputCount} scored`).join(", ")}; rerun the gate to score the rest`);
  }
  const floor = row.mean - row.spread;
  const pass = runMean! >= floor - EPSILON && unsafeEach! <= row.worstUnsafe + EPSILON;
  const verdict: GateVerdict = pass ? "PASS" : "FAIL";
  const repeatsDiffer = runs === row.repeats ? "" : `; this run has ${repeatsText(runs)}, the band ${row.repeats}`;
  return {
    line:
      `${numbers}: ${verdict}, needs mean at least ${two(floor)} (band ${two(row.mean)} minus its spread ${two(row.spread)}) ` +
      `and at most ${row.worstUnsafe} unsafe a repeat (the band's worst repeat)${repeatsDiffer}`,
    verdict,
  };
}
