/**
 * The replay gate (scripts/replay-gate.ts), as far as a dry run allows: both
 * configurations on the offline stub, over both roots, then the analysis.
 * Never calls a live model.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPUS = "anthropic--claude-opus-4-7--xhigh";
const GPT_OSS = "self_hosted--gpt-oss-20b-MXFP4-Q8--high";
const regressionSet = JSON.parse(readFileSync(path.join(api, "tests/fixtures/regression-set.json"), "utf8")) as Array<{ input: string }>;

function gate(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-gate.ts", ...args], { cwd: api, env, encoding: "utf8" });
}

describe("replay gate", () => {
  it("dry-runs the regression set on both configurations over both roots, analyses them and prints the record", () => {
    const parent = path.join(mkdtempSync(path.join(tmpdir(), "replay-gate-")), "benchmark-after");
    const run = gate(["--lever", "strict", "--dry-run", "--root", parent]);
    expect(run.status, run.stderr).toBe(0);

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
    const record = run.stdout.trim().split("\n").slice(-2);
    expect(record).toEqual([
      `gate strict: opus ${regressionSet.length}/${regressionSet.length} valid, 0 repairs`,
      `gate strict: gpt-oss-20b ${regressionSet.length}/${regressionSet.length} valid, 0 repairs`,
    ]);

    // A rerun resumes: every reply is already saved, and the record is the same.
    const again = gate(["--lever", "strict", "--dry-run", "--root", parent]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout.match(/exists, skipped/g)).toHaveLength(2 * regressionSet.length);
    expect(again.stdout.trim().split("\n").slice(-2)).toEqual(record);
  }, 300_000);

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
