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
