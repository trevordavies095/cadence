/**
 * Publishing the benchmark report (scripts/replay-publish.ts): the script
 * rewrites only the marked blocks of a report from an analysis built by
 * scripts/replay-analysis.ts over a small root, and the review block says
 * pending until a pack has a scores.json. Never calls a model and needs no
 * database.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(api, "tests/fixtures/replay-publish");

function tsx(script: string, args: string[]) {
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), [script, ...args], { cwd: api, encoding: "utf8" });
}

const PROSE_TOP = "# A report\n\nHand-written opening. It stays.\n\n## Results\n\nWhat the numbers mean.\n\n";
const PROSE_MID = "\n\nA paragraph between blocks, also by hand.\n\n## Review\n\n";
const PROSE_END = "\n\n## Caveats\n\n- One repeat per row.\n";

function doc(results = "old results table", review = "old review text"): string {
  return (
    PROSE_TOP +
    `<!-- generated:results:start -->\n${results}\n<!-- generated:results:end -->` +
    PROSE_MID +
    `<!-- generated:review:start -->\n${review}\n<!-- generated:review:end -->` +
    PROSE_END
  );
}

/** The report with each block's body cut out: what must survive a rewrite. */
function prose(text: string): string {
  return text.replace(/(<!-- generated:([\w-]+):start -->)[\s\S]*?(<!-- generated:\2:end -->)/g, "$1$3");
}

function block(text: string, name: string): string {
  const m = new RegExp(`<!-- generated:${name}:start -->([\\s\\S]*?)<!-- generated:${name}:end -->`).exec(text);
  return m ? m[1]! : "";
}

describe("replay:publish", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "replay-publish-"));
  const analysis = path.join(tmp, "analysis");
  const review = path.join(tmp, "review");
  const pack = path.join(review, "self_hosted--test-model--high");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  beforeAll(() => {
    // One self-hosted configuration over the season packets, input 01 refused twice.
    const dir = path.join(tmp, "seasons", "self_hosted--test-model--high");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        configuration: path.basename(dir),
        provider: "self_hosted",
        baseUrlHost: "10.0.0.5",
        model: "test-model",
        effort: "high",
        repeats: 1,
        note: "MacBook, oMLX 0.7.3 at 10.0.0.5:8000, models in /home/someone/models/test",
        inputs: path.join(api, "tests/fixtures/seasons/season-packets"),
        harnessCommit: "0123456789abcdef",
      }),
    );
    const f = JSON.parse(readFileSync(path.join(api, "tests/fixtures/replay-analysis/gpt-oss-120b-run-aliases.json"), "utf8"));
    const attempt = (n: number) => ({ attempt: n, error: f.error, stopReason: "tool_use", outputTokens: 100, inputTokens: 1000, responseRaw: f.responseRaw });
    writeFileSync(
      path.join(dir, "01.1.failed.json"),
      JSON.stringify({
        operation: "weekly_reply",
        error: f.error,
        stopReason: "tool_use",
        timing: { ttftMs: 100, totalMs: 2000, attempts: [{ attempt: 1, ttftMs: 100, totalMs: 1000 }, { attempt: 2, ttftMs: 90, totalMs: 1000 }] },
        refusedAttempts: [attempt(1), attempt(2)],
      }),
    );
    const res = tsx("scripts/replay-analysis.ts", ["--roots", path.join(tmp, "seasons"), "--out", analysis]);
    expect(res.status, res.stderr).toBe(0);
    mkdirSync(pack, { recursive: true });
    copyFileSync(path.join(FIXTURES, "key.json"), path.join(pack, "key.json"));
  });

  function publish(file: string, ...extra: string[]) {
    return tsx("scripts/replay-publish.ts", ["--analysis", analysis, "--doc", file, "--review", review, ...extra]);
  }

  it("the analysis records each configuration's setup, without the server host", () => {
    const json = JSON.parse(readFileSync(path.join(analysis, "analysis.json"), "utf8"));
    expect(json.setup).toHaveLength(1);
    expect(json.setup[0].roots[0]).toMatchObject({ root: "seasons", model: "test-model", effort: "high", harnessCommit: "0123456789abcdef" });
    expect(JSON.stringify(json.setup)).not.toContain("baseUrlHost");
  });

  it("--dry-run prints the rewritten report and writes nothing", () => {
    const file = path.join(tmp, "dry.md");
    writeFileSync(file, doc());
    const res = publish(file, "--dry-run");
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(doc());
    expect(res.stdout).toContain("Hand-written opening. It stays.");
    expect(res.stdout).not.toContain("old results table");
    expect(block(res.stdout, "results")).toContain("| test-model--high | 1 | 0 (0 / 0) | 1 | 1 of 1 |");
    expect(res.stderr).toContain("Would rewrite 2 blocks");
  });

  it("replaces the blocks, keeps every word of prose, and a second run changes nothing", () => {
    const file = path.join(tmp, "report.md");
    writeFileSync(file, doc());
    const res = publish(file);
    expect(res.status, res.stderr).toBe(0);
    const once = readFileSync(file, "utf8");
    expect(prose(once)).toBe(prose(doc()));
    expect(once.startsWith(PROSE_TOP)).toBe(true);
    expect(once.endsWith(PROSE_END)).toBe(true);
    expect(once).not.toContain("old results table");
    expect(once).not.toContain("old review text");
    expect(block(once, "results")).toContain("Valid as sent, by kind of reply:");
    expect(publish(file).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("publishes no host address and no local path", () => {
    const file = path.join(tmp, "setup.md");
    writeFileSync(file, "<!-- generated:setup:start -->\n<!-- generated:setup:end -->\n<!-- generated:hardest:start -->\n<!-- generated:hardest:end -->\n");
    const res = publish(file);
    expect(res.status, res.stderr).toBe(0);
    const out = readFileSync(file, "utf8");
    expect(out).toContain("MacBook, oMLX 0.7.3 at (host)");
    expect(out).toContain("0123456");
    expect(out).not.toMatch(/10\.0\.0\.5|\/home\/|season-packets\//);
    expect(out).not.toContain(tmp);
  });

  it("the review block says pending with the command to join, until a scores.json is filled", () => {
    const file = path.join(tmp, "review.md");
    writeFileSync(file, doc());
    expect(publish(file).status).toBe(0);
    const pending = block(readFileSync(file, "utf8"), "review");
    expect(pending).toContain("**Pending.**");
    expect(pending).toContain("1 review pack written, none scored");
    expect(pending).toContain("npm run replay:publish -- --analysis ../.scratch/benchmark-analysis --doc ../docs/reports/local-models-2026-11.md");

    copyFileSync(path.join(FIXTURES, "scores.json"), path.join(pack, "scores.json"));
    try {
      expect(publish(file).status).toBe(0);
      const after = readFileSync(file, "utf8");
      const filled = block(after, "review");
      expect(filled).not.toContain("Pending");
      expect(filled).toContain("### test-model--high against claude-opus-4-7--xhigh");
      expect(filled).toContain("2 fully scored");
      expect(filled).toContain("candidate 0 (0%), baseline 2 (100%), tie 0 (0%)");
      expect(filled).toContain("snapshot-06 (injury-flag week): candidate 5, baseline 24 (-19)");
      expect(filled).not.toContain(review);
      expect(prose(after)).toBe(prose(doc()));
    } finally {
      rmSync(path.join(pack, "scores.json"));
    }
  });

  it("refuses an unknown or unpaired marker and leaves the report as it was", () => {
    const unknown = path.join(tmp, "unknown.md");
    const text = "x\n<!-- generated:nonsense:start -->\nold\n<!-- generated:nonsense:end -->\n";
    writeFileSync(unknown, text);
    const res = publish(unknown);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("generated:nonsense is not a known block");
    expect(readFileSync(unknown, "utf8")).toBe(text);

    const unpaired = path.join(tmp, "unpaired.md");
    const half = "x\n<!-- generated:results:start -->\nold\n";
    writeFileSync(unpaired, half);
    const res2 = publish(unpaired);
    expect(res2.status).not.toBe(0);
    expect(res2.stderr).toContain("is not followed by its own end marker");
    expect(readFileSync(unpaired, "utf8")).toBe(half);
  });
});
