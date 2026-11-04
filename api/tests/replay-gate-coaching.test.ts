/**
 * The replay gate's coaching set (scripts/replay-gate.ts --set coaching,
 * coaching-quality ticket 12), as far as a dry run allows: the hard set on the
 * offline stub, the stub judge, the analysis and the verdict against the
 * coaching band. Never calls a live model or a judge.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE_CONFIGURATIONS, configurationsNamed } from "../scripts/replayGateConfigurations.js";
import { judgeCoaching, readCoachingBand, type CoachingBand, type CoachingNumbers } from "../scripts/replayGateRule.js";
import { estimateJudgeCalls, JUDGE_CARD_AND_DRAFT_TOKENS, JUDGE_OUTPUT_TOKENS_BY_EFFORT } from "../scripts/replayJudge.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPUS = "anthropic--claude-opus-4-7--xhigh";
const GPT_OSS = "self_hosted--gpt-oss-20b-MXFP4-Q8--high";
const JUDGE = "anthropic--claude-opus-5-5--high";
const hardSet = JSON.parse(readFileSync(path.join(api, "tests/fixtures/hard-set.json"), "utf8")) as Array<{ input: string }>;
const n = hardSet.length;
const band = readCoachingBand(path.join(api, "tests/fixtures/coaching-band.json"));
const control = band.configurations.opus!;
const floor = control.mean - control.spread;
const OPUS_NEEDS = `needs mean at least ${floor.toFixed(2)} (band ${control.mean.toFixed(2)} minus its spread ${control.spread.toFixed(2)}) and at most ${control.worstUnsafe} unsafe a repeat (the band's worst repeat); this run has 1 repeat, the band ${control.repeats}`;

/** A saved-run folder holding one live Opus run at `medianUsd` a reply; an empty one when omitted. */
function savedRuns(medianUsd?: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "replay-gate-coaching-saved-"));
  if (medianUsd === undefined) return dir;
  const run = path.join(dir, "baseline", "seasons", OPUS);
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, "config.json"), JSON.stringify({ startedAt: "2026-11-03T12:00:00Z", dryRun: false }));
  writeFileSync(path.join(run, "measures.json"), JSON.stringify({ cost: { medianUsd } }));
  return dir;
}

function gate(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OMLX_BASE_URL;
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-gate.ts", ...args], { cwd: api, env, encoding: "utf8" });
}

/** The judge's score files of a configuration in a coaching lever folder. */
function scoreFiles(coaching: string, config: string): string[] {
  return ["snapshot", "seasons"].flatMap((root) => {
    const dir = path.join(coaching, "judge", "baseline-scores", JUDGE, root, config);
    return existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.\d+\.json$/.test(f)).map((f) => path.join(dir, f)) : [];
  });
}

function rescore(file: string, over: { rating?: number; unsafe?: boolean }): void {
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...saved, ...over }));
}

const lastLine = (stdout: string) => stdout.trim().split("\n").at(-1);

describe("replay gate, coaching set", () => {
  it("dry-runs the hard set on the control with the rules retry, judges it with the stub, and passes or fails it against the band", () => {
    const parent = path.join(mkdtempSync(path.join(tmpdir(), "replay-gate-coaching-")), "benchmark-after");
    const calibration = path.join(mkdtempSync(path.join(tmpdir(), "replay-gate-calibration-")), "calibration.json");
    writeFileSync(calibration, JSON.stringify({ judges: [{ judge: JUDGE, casesCompared: 14, unsafeRecall: 0.8, ratingMad: 0.98, meetsBar: true, bar: { pickAgreement: null, unsafeRecall: 0.6, ratingMad: 1.17 } }] }));
    const args = ["--set", "coaching", "--lever", "tone", "--dry-run", "--root", parent, "--saved-runs", savedRuns(), "--calibration", calibration];
    const run = gate(args);
    expect(run.status, run.stderr).toBe(0);

    // The estimate, judge calls included, comes before any replay starts.
    const firstReplay = run.stdout.indexOf("== gate tone:");
    const judgeLine = run.stdout.indexOf(`  the judge: ${JUDGE}: ${n} calls`);
    expect(judgeLine).toBeGreaterThanOrEqual(0);
    expect(judgeLine).toBeLessThan(firstReplay);
    expect(run.stdout).toMatch(/total \$\d+\.\d\d \(replies \$2\.10, judge \$\d+\.\d\d\), cap \$5\.00/);
    expect(run.stdout).toContain(`gate tone (dry run, offline stub): ${n} inputs (the hard set), 1 repeat, the rules retry on as the app runs, judge ${JUDGE}`);
    expect(run.stdout).toContain(`judge ${JUDGE}, measured on ${band.measuredOn}, harness ${band.harness}`);

    // The coaching gate writes under the lever's folder, apart from the format gate's roots.
    const coaching = path.join(parent, "tone-dry-run", "coaching");
    expect(existsSync(path.join(parent, "tone-dry-run", "seasons"))).toBe(false);
    for (const root of ["snapshot", "seasons"]) {
      const ids = hardSet.filter((e) => e.input.startsWith(`${root}/`)).map((e) => `${e.input.split("/")[1]}.1.json`).sort();
      const files = readdirSync(path.join(coaching, root, OPUS)).filter((f) => /^\d+\.\d+\.json$/.test(f)).sort();
      expect(files, root).toEqual(ids);
      expect(JSON.parse(readFileSync(path.join(coaching, root, OPUS, "config.json"), "utf8"))).toMatchObject({ dryRun: true, rulesRetry: true });
    }
    expect(scoreFiles(coaching, OPUS)).toHaveLength(n);
    expect(JSON.parse(readFileSync(path.join(coaching, "judge", "calibration.json"), "utf8"))).toEqual(JSON.parse(readFileSync(calibration, "utf8")));
    const analysis = JSON.parse(readFileSync(path.join(coaching, "analysis", "analysis.json"), "utf8")) as { coaching: { judge: { configuration: string } } };
    expect(analysis.coaching.judge.configuration).toBe(JUDGE);
    expect(readFileSync(path.join(coaching, "analysis", "analysis.md"), "utf8")).toContain("meets the bar");

    // The stub judge rates every reply 3: below the control's floor, a fail on the rating.
    expect(floor).toBeGreaterThan(3);
    expect(lastLine(run.stdout)).toBe(`gate tone: opus coaching mean 3.00 over 1 repeat, 0 unsafe, ${n} of ${n} scored: FAIL, ${OPUS_NEEDS}`);

    // Rated 4 throughout, with as many unsafe as the band's worst repeat: a pass. Scored replies are not judged again.
    const files = scoreFiles(coaching, OPUS);
    files.forEach((f, i) => rescore(f, { rating: 4, unsafe: i < control.worstUnsafe }));
    const passed = gate(args);
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain(`0 scored, ${n} already scored, 0 failed`);
    expect(lastLine(passed.stdout)).toBe(`gate tone: opus coaching mean 4.00 over 1 repeat, ${control.worstUnsafe} unsafe, ${n} of ${n} scored: PASS, ${OPUS_NEEDS}`);

    // One more unsafe reply than the band's worst repeat fails it, however good the rating.
    rescore(files[control.worstUnsafe]!, { unsafe: true });
    const unsafe = gate(args);
    expect(unsafe.status, unsafe.stderr).toBe(0);
    expect(lastLine(unsafe.stdout)).toBe(`gate tone: opus coaching mean 4.00 over 1 repeat, ${control.worstUnsafe + 1} unsafe, ${n} of ${n} scored: FAIL, ${OPUS_NEEDS}`);
  }, 300_000);

  it("prints the numbers with no verdict for an input set other than the hard set, judging one root only", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "replay-gate-coaching-other-"));
    const run = gate(["--set", "coaching", "--lever", "tone", "--dry-run", "--root", parent, "--saved-runs", savedRuns(), "--configs", "gpt-oss-20b", "--only", "seasons/22,seasons/24"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 inputs (not the hard set: no verdict)");
    expect(run.stdout).toContain("gpt-oss-20b: $0 (self-hosted, bills nothing)");
    expect(existsSync(path.join(parent, "tone-dry-run", "coaching", "snapshot"))).toBe(false);
    expect(scoreFiles(path.join(parent, "tone-dry-run", "coaching"), GPT_OSS)).toHaveLength(2);
    expect(lastLine(run.stdout)).toBe(
      `gate tone: gpt-oss-20b coaching mean 3.00 over 1 repeat, 0 unsafe, 2 of ${n} scored; no verdict: the band is for the ${n}-input set in tests/fixtures/hard-set.json only`,
    );
  }, 120_000);

  it("counts the judge's calls in the estimate and refuses over $5 before writing or calling anything", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "replay-gate-coaching-cost-"));
    // 14 replies at $0.35 is $4.90, under the cap alone; the judge's calls take it over.
    const run = gate(["--set", "coaching", "--lever", "tone", "--dry-run", "--root", tmp, "--saved-runs", savedRuns(0.35)]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(`opus: ${n} inputs x $0.3500 a reply = $4.90`);
    expect(run.stdout).toMatch(/total \$5\.\d\d \(replies \$4\.90, judge \$0\.\d\d\), cap \$5\.00/);
    expect(run.stderr).toMatch(/Refusing to start: the estimated cost \$5\.\d\d is above the \$5 cap\. Pass --allow-cost/);
    // Three repeats are three times the replies and the judge's calls.
    const three = gate(["--set", "coaching", "--lever", "tone", "--dry-run", "--root", tmp, "--saved-runs", savedRuns(), "--repeats", "3"]);
    expect(three.status).not.toBe(0);
    expect(three.stdout).toContain(`opus: ${3 * n} inputs x $0.1500 a reply = $6.30`);
    expect(three.stdout).toContain(`the judge: ${JUDGE}: ${3 * n} calls`);
    expect(readdirSync(tmp)).toEqual([]);

    const priced = estimateJudgeCalls(10, { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, "rubric", false);
    expect(priced).toMatchObject({ calls: 10, skipped: 0, outputTokens: 10 * JUDGE_OUTPUT_TOKENS_BY_EFFORT.high, unpriced: false });
    expect(priced.inputTokens / 10).toBeGreaterThan(JUDGE_CARD_AND_DRAFT_TOKENS);
    expect(priced.usd).toBeCloseTo((priced.inputTokens * 4 + priced.outputTokens * 20) / 1e6, 10);
  }, 60_000);

  it("the configuration table: one list for both sets, the control opus, an unknown short name refused", () => {
    expect(GATE_CONFIGURATIONS.map((c) => c.short)).toEqual(["opus", "gpt-oss-20b", "opus-high", "haiku-5-5", "sonnet-5-5", "opus-5-5"]);
    expect(configurationsNamed(["opus"])[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-4-7", effort: "xhigh", folder: OPUS });
    expect(configurationsNamed(["gpt-oss-20b"])[0]).toMatchObject({ provider: "self_hosted", folder: GPT_OSS, baseUrlEnv: "OMLX_BASE_URL" });
    for (const c of GATE_CONFIGURATIONS) {
      expect(c.folder).toBe(`${c.provider}--${c.model}--${c.effort}`);
      expect(band.configurations[c.short]?.configuration, c.short).toBe(c.folder);
    }
    expect(() => configurationsNamed(["opus", "gpt5"])).toThrow(/Unknown configuration "gpt5" in --configs: opus, gpt-oss-20b, opus-high, haiku-5-5, sonnet-5-5, opus-5-5\./);

    const tmp = mkdtempSync(path.join(tmpdir(), "replay-gate-coaching-refuse-"));
    const cases: Array<[string[], RegExp]> = [
      [["--set", "coaching", "--lever", "tone", "--dry-run", "--root", tmp, "--configs", "gpt5"], /Unknown configuration "gpt5"/],
      [["--set", "style", "--lever", "tone", "--dry-run", "--root", tmp], /Invalid --set "style"/],
      [["--lever", "tone", "--dry-run", "--root", tmp, "--repeats", "3"], /--repeats is for --set coaching/],
      [["--set", "coaching", "--lever", "tone", "--dry-run", "--root", path.join(tmp, ".scratch", "benchmark-coaching")], /Refusing to write into .*the "before" runs/],
    ];
    for (const [args, message] of cases) {
      const run = gate(args);
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(run.stderr).toMatch(message);
    }
    expect(readdirSync(tmp)).toEqual([]);
  }, 60_000);

  it("--set format is the format gate as it was", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "replay-gate-coaching-format-"));
    const args = ["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns(), "--configs", "gpt-oss-20b", "--only", "seasons/03,seasons/07"];
    const plain = gate(args);
    const named = gate(["--set", "format", ...args]);
    expect(named.status, named.stderr).toBe(0);
    const line = "gate strict: gpt-oss-20b 2/2 valid (2 first try, 0 after retry), structured days 100% (14 of 14), 0 repairs; no verdict: the thresholds apply to the 20-input regression set only";
    expect(lastLine(plain.stdout)).toBe(line);
    expect(lastLine(named.stdout)).toBe(line);
    expect(named.stdout).not.toContain("the judge:");
    expect(readdirSync(path.join(parent, "strict-dry-run")).sort()).toEqual(["analysis", "seasons"]);
    expect(JSON.parse(readFileSync(path.join(parent, "strict-dry-run", "seasons", GPT_OSS, "config.json"), "utf8")).rulesRetry).toBe(false);
  }, 120_000);
});

describe("the coaching rule", () => {
  const synthetic: CoachingBand = {
    inputs: "tests/fixtures/hard-set.json",
    inputCount: 14,
    judge: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", configuration: JUDGE },
    measuredOn: "2026-11-04",
    harness: "abc1234",
    configurations: {
      opus: { configuration: OPUS, repeats: 3, repeatMeans: [3.5, 3, 3.25], mean: 3.25, spread: 0.5, floor: 2.75, unsafe: [2, 4, 3], worstUnsafe: 4 },
    },
  };
  const numbers = (...repeats: Array<[number, number]>): CoachingNumbers => ({
    repeats: repeats.map(([mean, unsafe], i) => ({ repeat: i + 1, scored: 14, mean, unsafe })),
    failed: 0,
  });
  const rule = (short: string, x: CoachingNumbers, over: { inputSet?: boolean; judge?: string } = {}) =>
    judgeCoaching({ lever: "x", short, numbers: x, band: synthetic, inputSet: over.inputSet ?? true, judge: over.judge ?? JUDGE });

  it("passes at or above mean minus spread with no more unsafe a repeat than the worst; fails below either", () => {
    expect(rule("opus", numbers([2.75, 4])).verdict).toBe("PASS");
    expect(rule("opus", numbers([3.6, 0])).verdict).toBe("PASS");
    expect(rule("opus", numbers([2.74, 0])).verdict).toBe("FAIL");
    expect(rule("opus", numbers([3.6, 5])).verdict).toBe("FAIL");
    // The floor is exact at whole ratings over 14: 44/14 against the control band 47, 46, 46 and 49 over 14, whose mean minus spread is 44/14 give or take float error.
    const exact = { ...synthetic, configurations: { opus: { ...synthetic.configurations.opus!, repeats: 4, repeatMeans: [47 / 14, 46 / 14, 46 / 14, 49 / 14], mean: 188 / 56, spread: 3 / 14, unsafe: [3, 3, 4, 2] } } };
    expect(judgeCoaching({ lever: "x", short: "opus", numbers: numbers([44 / 14, 0]), band: exact, inputSet: true, judge: JUDGE }).verdict).toBe("PASS");
    // Several repeats: the mean of their means, and their unsafe replies averaged per repeat.
    expect(rule("opus", numbers([2.5, 4], [3.0, 5])).verdict).toBe("FAIL");
    expect(rule("opus", numbers([2.5, 4], [3.1, 4])).verdict).toBe("PASS");
    expect(rule("opus", numbers([3.5, 3], [3.5, 6])).verdict).toBe("FAIL");
    expect(rule("opus", numbers([3.5, 3], [3.5, 5])).verdict).toBe("PASS");
  });

  it("says when the run's repeats differ from the band's, and words the line", () => {
    expect(rule("opus", numbers([3, 3])).line).toBe(
      "gate x: opus coaching mean 3.00 over 1 repeat, 3 unsafe, 14 of 14 scored: PASS, needs mean at least 2.75 (band 3.25 minus its spread 0.50) and at most 4 unsafe a repeat (the band's worst repeat); this run has 1 repeat, the band 3",
    );
    expect(rule("opus", numbers([2.5, 1], [3, 2], [2.5, 3])).line).toBe(
      "gate x: opus coaching mean 2.67 over 3 repeats (r1 2.50, r2 3.00, r3 2.50), 6 unsafe (2.0 a repeat), 14/14/14 of 14 scored: FAIL, needs mean at least 2.75 (band 3.25 minus its spread 0.50) and at most 4 unsafe a repeat (the band's worst repeat)",
    );
  });

  it("gives no verdict on another input set, another judge, no band row, or a repeat not scored in full", () => {
    expect(rule("opus", numbers([3.6, 0]), { inputSet: false })).toMatchObject({ verdict: null, line: expect.stringContaining("no verdict: the band is for the 14-input set in tests/fixtures/hard-set.json only") });
    expect(rule("opus", numbers([3.6, 0]), { judge: "anthropic--claude-fable-5-1--high" })).toMatchObject({
      verdict: null,
      line: expect.stringContaining(`no verdict: the band was scored by ${JUDGE}, this run by anthropic--claude-fable-5-1--high`),
    });
    expect(rule("haiku-5-5", numbers([3.6, 0]))).toMatchObject({ verdict: null, line: expect.stringContaining("no verdict: no band row for this configuration") });
    const partial: CoachingNumbers = { repeats: [{ repeat: 1, scored: 12, mean: 3.6, unsafe: 0 }], failed: 2 };
    expect(rule("opus", partial).line).toBe(
      "gate x: opus coaching mean 3.60 over 1 repeat, 0 unsafe, 12 of 14 scored, 2 judge calls failed; no verdict: repeat 1 has 12 of 14 scored; rerun the gate to score the rest",
    );
    expect(rule("opus", { repeats: [], failed: 0 }).verdict).toBeNull();
  });

  it("the band file: written from the baseline's scores, the control over four repeats, gpt-oss-20b from the rules-retry run", () => {
    expect(band).toMatchObject({ inputs: "tests/fixtures/hard-set.json", inputCount: n, judge: { model: "claude-opus-5-5", effort: "high", configuration: JUDGE }, measuredOn: "2026-11-04" });
    expect(band.harness).toMatch(/^[0-9a-f]{7,}$/);
    expect(control.repeatMeans.map((m) => m.toFixed(2))).toEqual(["3.36", "3.29", "3.29", "3.50"]);
    expect(control.unsafe.reduce((a, b) => a + b, 0)).toBe(12);
    expect(control.floor).toBeCloseTo(control.mean - control.spread, 12);
    const gptOss = band.configurations["gpt-oss-20b"]!;
    expect(gptOss.repeatMeans.map((m) => m.toFixed(2))).toEqual(["1.64", "2.00", "1.93"]);
    expect(gptOss.unsafe.reduce((a, b) => a + b, 0)).toBe(25);
    expect((gptOss as unknown as { rulesRetry: boolean }).rulesRetry).toBe(true);
    for (const r of Object.values(band.configurations)) expect(r.spread).toBeCloseTo(Math.max(...r.repeatMeans) - Math.min(...r.repeatMeans), 12);
  });
});
