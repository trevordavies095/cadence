/**
 * The replay gate (scripts/replay-gate.ts), as far as a dry run allows: both
 * configurations on the offline stub, over both roots, then the analysis.
 * Never calls a live model.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GPT_OSS_READS_VALID_MIN, GPT_OSS_STRUCTURED_DAYS_MIN, judge, readBaselineBand, type GateNumbers } from "../scripts/replayGateRule.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPUS = "anthropic--claude-opus-4-7--xhigh";
const GPT_OSS = "self_hosted--gpt-oss-20b-MXFP4-Q8--high";
const regressionSet = JSON.parse(readFileSync(path.join(api, "tests/fixtures/regression-set.json"), "utf8")) as Array<{ input: string }>;
const band = readBaselineBand(path.join(api, "tests/fixtures/baseline-band.json"));
const n = regressionSet.length;
const OPUS_NEEDS = `needs at least ${band.readsValid.low}/${n} valid (baseline band ${band.readsValid.low} to ${band.readsValid.high}) and 100% structured days`;
const GPT_OSS_NEEDS = "needs at least 19/20 valid and 90% structured days";
/** Weekly reads in the regression set, and the days they store. */
const weeklyDays = 16 * 7;

/** Marks the first `count` days of a saved weekly reply as not filed, and drops its saved summary so the analysis reads the days. */
function unfile(file: string, count: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  saved.new.prescribedWeek.days = saved.new.prescribedWeek.days.map((d: Record<string, unknown>, i: number) =>
    i < count ? { date: d.date, dayType: "other", run: null, notes: d.line, line: d.line, parsed: false } : d,
  );
  delete saved.plan;
  writeFileSync(file, JSON.stringify(saved));
}

/** The weekly reads a configuration saved in a lever folder, by path. */
function weeklyReplies(lever: string, config: string): string[] {
  return ["snapshot", "seasons"].flatMap((root) => {
    const dir = path.join(lever, root, config);
    return readdirSync(dir)
      .filter((f) => /^\d+\.\d+\.json$/.test(f))
      .map((f) => path.join(dir, f))
      .filter((f) => JSON.parse(readFileSync(f, "utf8")).operation === "weekly_reply");
  });
}

/** A saved-run folder holding one live Opus run at `medianUsd` a reply; an empty one when omitted. */
function savedRuns(medianUsd?: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "replay-gate-saved-"));
  if (medianUsd === undefined) return dir;
  const run = path.join(dir, "strict", "snapshot", OPUS);
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, "config.json"), JSON.stringify({ startedAt: "2026-11-02T12:00:00Z", dryRun: false }));
  writeFileSync(path.join(run, "measures.json"), JSON.stringify({ cost: { medianUsd } }));
  return dir;
}

function gate(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-gate.ts", ...args], { cwd: api, env, encoding: "utf8" });
}

describe("replay gate", () => {
  it("dry-runs the regression set on both configurations over both roots, analyses them and prints the record", () => {
    const parent = path.join(mkdtempSync(path.join(tmpdir(), "replay-gate-")), "benchmark-after");
    // No saved run: the fallback $0.15 a reply x 20 inputs is $3, under the cap.
    const run = gate(["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns()]);
    expect(run.status, run.stderr).toBe(0);

    // The cap and the estimate come before any replay starts.
    const firstReplay = run.stdout.indexOf("== gate strict:");
    expect(run.stdout.indexOf("output cap 20000 tokens per call")).toBeGreaterThanOrEqual(0);
    expect(run.stdout.indexOf("output cap 20000 tokens per call")).toBeLessThan(firstReplay);
    expect(run.stdout.indexOf("total $3.00, cap $5.00")).toBeLessThan(firstReplay);
    expect(run.stdout).toContain("no saved run for this configuration, so the regression set's Opus figure of about $0.15 a reply");

    // A dry run writes beside the lever's live folder, never into it.
    const lever = path.join(parent, "strict-dry-run");
    expect(existsSync(path.join(parent, "strict"))).toBe(false);
    for (const root of ["snapshot", "seasons"]) {
      const ids = regressionSet.filter((e) => e.input.startsWith(`${root}/`)).map((e) => `${e.input.split("/")[1]}.1.json`).sort();
      for (const config of [OPUS, GPT_OSS]) {
        const files = readdirSync(path.join(lever, root, config)).filter((f) => /^\d+\.\d+\.json$/.test(f)).sort();
        expect(files, `${root}/${config}`).toEqual(ids);
        expect(JSON.parse(readFileSync(path.join(lever, root, config, "config.json"), "utf8"))).toMatchObject({ dryRun: true });
      }
    }
    for (const f of ["analysis.md", "analysis.json", "replies.csv"]) expect(existsSync(path.join(lever, "analysis", f)), f).toBe(true);
    const analysis = JSON.parse(readFileSync(path.join(lever, "analysis", "analysis.json"), "utf8")) as { baseline: string; configurations: string[] };
    expect(analysis.baseline).toBe(OPUS);
    expect(analysis.configurations).toEqual([OPUS, GPT_OSS]);

    // The demo snapshot's goal-line failures end each snapshot replay non-zero; the gate goes on.
    expect(run.stdout).toContain("exited 1 for its goal checks only");
    expect(run.stdout).toContain(`gate strict (dry run, offline stub): ${n} inputs (the regression set)`);
    const record = run.stdout.trim().split("\n").slice(-2);
    expect(record).toEqual([
      `gate strict: opus ${n}/${n} valid (${n} first try, 0 after retry), structured days 100% (${weeklyDays} of ${weeklyDays}), 0 repairs: PASS, ${OPUS_NEEDS}`,
      `gate strict: gpt-oss-20b ${n}/${n} valid (${n} first try, 0 after retry), structured days 100% (${weeklyDays} of ${weeklyDays}), 0 repairs: PASS, ${GPT_OSS_NEEDS}`,
    ]);

    // A rerun resumes: every reply is already saved, and the record is the same.
    // Its saved Opus runs price it over the cap, so it goes on only with --allow-cost.
    const again = gate(["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns(0.5), "--allow-cost"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("going on, as --allow-cost was passed");
    expect(again.stdout.match(/exists, skipped/g)).toHaveLength(2 * regressionSet.length);
    expect(again.stdout.trim().split("\n").slice(-2)).toEqual(record);

    // One day Opus could not file fails it; gpt-oss-20b stays above 90 percent with three.
    unfile(weeklyReplies(lever, OPUS)[0]!, 1);
    unfile(weeklyReplies(lever, GPT_OSS)[0]!, 3);
    const failed = gate(["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns(), "--allow-cost"]);
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout.trim().split("\n").slice(-2)).toEqual([
      `gate strict: opus ${n}/${n} valid (${n} first try, 0 after retry), structured days 99.1% (${weeklyDays - 1} of ${weeklyDays}), 0 repairs: FAIL, ${OPUS_NEEDS}`,
      `gate strict: gpt-oss-20b ${n}/${n} valid (${n} first try, 0 after retry), structured days 97.3% (${weeklyDays - 3} of ${weeklyDays}), 0 repairs: PASS, ${GPT_OSS_NEEDS}`,
    ]);
  }, 300_000);

  it("refuses a run estimated above $5 before writing or calling anything, naming --allow-cost", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "replay-gate-cost-"));
    for (const saved of [savedRuns(0.5), savedRuns(1.5)]) {
      const run = gate(["--lever", "strict", "--dry-run", "--root", tmp, "--saved-runs", saved]);
      expect(run.status).not.toBe(0);
      expect(run.stdout).toContain("output cap 20000 tokens per call");
      expect(run.stderr).toMatch(/Refusing to start: the estimated cost \$\d+\.\d\d is above the \$5 cap\. Pass --allow-cost/);
      expect(run.stdout).not.toContain("== gate strict:");
    }
    expect(readdirSync(tmp)).toEqual([]);
  }, 60_000);

  it("never refuses a self-hosted-only run, however dear the saved Opus runs", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "replay-gate-self-hosted-"));
    // --only naming the regression set file is the regression set: the thresholds apply.
    const run = gate(["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns(50), "--configs", "gpt-oss-20b", "--only", "@tests/fixtures/regression-set.json"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("gpt-oss-20b: $0 (self-hosted, bills nothing)");
    expect(run.stdout).toContain("total $0.00, cap $5.00");
    expect(run.stdout).not.toContain(OPUS);
    expect(readdirSync(path.join(parent, "strict-dry-run", "snapshot")).filter((f) => !f.endsWith(".md"))).toEqual([GPT_OSS]);
    expect(run.stdout.trim().split("\n").at(-1)).toBe(
      `gate strict: gpt-oss-20b ${n}/${n} valid (${n} first try, 0 after retry), structured days 100% (${weeklyDays} of ${weeklyDays}), 0 repairs: PASS, ${GPT_OSS_NEEDS}`,
    );

    // Twelve days not filed across four weekly reads: 100 of 112 is under 90 percent.
    for (const file of weeklyReplies(path.join(parent, "strict-dry-run"), GPT_OSS).slice(0, 4)) unfile(file, 3);
    const failed = gate(["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns(), "--configs", "gpt-oss-20b"]);
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout.trim().split("\n").at(-1)).toBe(
      `gate strict: gpt-oss-20b ${n}/${n} valid (${n} first try, 0 after retry), structured days 89.2% (${weeklyDays - 12} of ${weeklyDays}), 0 repairs: FAIL, ${GPT_OSS_NEEDS}`,
    );
  }, 300_000);

  it("prints the numbers with no verdict for an input set other than the regression set", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "replay-gate-other-set-"));
    const run = gate(["--lever", "strict", "--dry-run", "--root", parent, "--saved-runs", savedRuns(), "--configs", "gpt-oss-20b", "--only", "seasons/03,seasons/07"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 inputs (not the regression set: no verdict)");
    // Only the root the set names is run.
    expect(existsSync(path.join(parent, "strict-dry-run", "snapshot"))).toBe(false);
    expect(run.stdout.trim().split("\n").at(-1)).toBe(
      `gate strict: gpt-oss-20b 2/2 valid (2 first try, 0 after retry), structured days 100% (14 of 14), 0 repairs; no verdict: the thresholds apply to the ${n}-input regression set only`,
    );
  }, 120_000);

  it("the pass rule: Opus at or above the band's low and 100% structured days; gpt-oss-20b at 19 of 20 and 90%", () => {
    const numbers = (valid: number, daysParsed: number, over: Partial<GateNumbers> = {}): GateNumbers => ({
      replies: 20,
      firstTry: valid - 1,
      afterRetry: 1,
      daysParsed,
      daysTotal: 112,
      softRepairReplies: 2,
      ...over,
    });
    const verdict = (short: string, x: GateNumbers, regressionSet = true) => judge({ lever: "x", short, numbers: x, band, regressionSet }).verdict;
    expect(band.readsValid).toMatchObject({ low: 18, of: 20 });
    expect(verdict("opus", numbers(band.readsValid.low, 112))).toBe("PASS");
    expect(verdict("opus", numbers(20, 112))).toBe("PASS");
    expect(verdict("opus", numbers(band.readsValid.low - 1, 112))).toBe("FAIL");
    expect(verdict("opus", numbers(20, 111))).toBe("FAIL");
    expect([GPT_OSS_READS_VALID_MIN, GPT_OSS_STRUCTURED_DAYS_MIN]).toEqual([19, 0.9]);
    expect(verdict("gpt-oss-20b", numbers(19, Math.ceil(112 * 0.9)))).toBe("PASS");
    expect(verdict("gpt-oss-20b", numbers(18, 112))).toBe("FAIL");
    expect(verdict("gpt-oss-20b", numbers(20, Math.ceil(112 * 0.9) - 1))).toBe("FAIL");
    // No valid weekly read: no structured days to speak of, so no pass.
    expect(verdict("gpt-oss-20b", numbers(20, 0, { daysTotal: 0 }))).toBe("FAIL");
    // A run short of the regression set's replies cannot pass.
    expect(verdict("opus", numbers(18, 112, { replies: 19 }))).toBe("FAIL");
    expect(verdict("opus", numbers(20, 112), false)).toBeNull();
    expect(judge({ lever: "x", short: "gpt-oss-20b", numbers: numbers(19, 100), band, regressionSet: true }).line).toBe(
      `gate x: gpt-oss-20b 19/20 valid (18 first try, 1 after retry), structured days 89.2% (100 of 112), 2 repairs: FAIL, ${GPT_OSS_NEEDS}`,
    );
  });

  it("refuses the before runs' folder, a missing or bad lever, and a live run with no server, before writing anything", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "replay-gate-refuse-"));
    const before = path.join(tmp, ".scratch", "benchmark");
    mkdirSync(before, { recursive: true });
    const cases: Array<[string[], RegExp]> = [
      [["--lever", "strict", "--dry-run", "--root", before], /Refusing to write into .*the "before" runs/],
      [["--lever", "strict", "--dry-run", "--root", path.join(before, "nested")], /Refusing to write into/],
      [["--dry-run", "--root", tmp], /--lever <name> is required/],
      [["--lever", "../up", "--dry-run", "--root", tmp], /Invalid --lever/],
      [["--lever", "strict", "--root", tmp], /--base-url <url> is required/],
    ];
    for (const [args, message] of cases) {
      const run = gate(args);
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(run.stderr).toMatch(message);
    }
    expect(readdirSync(before)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([".scratch"]);
  }, 60_000);
});
