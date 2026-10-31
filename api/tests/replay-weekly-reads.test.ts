/**
 * The weekly-read replay script (scripts/replay-weekly-reads.ts): its goal
 * checks, and the dry run with the offline stub over a packet folder. Never
 * calls the live model.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { longRunVerdictIn, mentionsMarathon, replayCheckFailures } from "../scripts/replayChecks.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(api, "tests/fixtures/replay-packets");

function dryRun(packets: string) {
  const out = mkdtempSync(path.join(tmpdir(), "replay-out-"));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const run = spawnSync(
    path.join(api, "node_modules/.bin/tsx"),
    ["scripts/replay-weekly-reads.ts", "--packets", packets, "--dry-run", "--out", out],
    { cwd: api, env, encoding: "utf8" },
  );
  return { ...run, out, report: () => readFileSync(path.join(out, "report.md"), "utf8") };
}

describe("replay goal checks", () => {
  const prompt = "Athlete goal: general fitness, no race planned.\nTraining phase: base.";

  it("passes a stay-fit read with a goal line and nothing marathon-shaped", () => {
    expect(
      replayCheckFailures({
        label: "01 (fit.json)",
        goal: { kind: "fitness" },
        prompt,
        readText: "Three easy runs this week; the longer run is optional.",
      }),
    ).toEqual([]);
  });

  it("names a packet with no goal, or a prompt that does not open with the goal line", () => {
    expect(
      replayCheckFailures({ label: "03 (none.json)", goal: null, prompt: "Athlete goal: not set.", readText: "" }),
    ).toEqual([{ label: "03 (none.json)", check: "no goal line", detail: "the packet has no goal" }]);
    const [failure] = replayCheckFailures({
      label: "04",
      goal: { kind: "fitness" },
      prompt: "Reviewed week (already happened): 2026-W43\nAthlete goal: general fitness.",
      readText: "",
    });
    expect(failure).toMatchObject({ label: "04", check: "no goal line" });
  });

  it("flags marathon in a read whose goal is not a marathon, but not half marathon", () => {
    expect(mentionsMarathon("Classic marathon build.")).toBe(true);
    expect(mentionsMarathon("Good half-marathon pacing, and a Half Marathon next.")).toBe(false);
    const tenK = { kind: "race" as const, distance: "10k" as const };
    expect(
      replayCheckFailures({ label: "02 (10k.json)", goal: tenK, prompt, readText: "Think like a marathoner? No: marathon pace work." }),
    ).toEqual([{ label: "02 (10k.json)", check: "marathon in a non-marathon read", detail: "the goal is race (10k)" }]);
    const marathon = { kind: "race" as const, distance: "marathon" as const };
    expect(replayCheckFailures({ label: "05", goal: marathon, prompt, readText: "Marathon pace Sunday." })).toEqual([]);
  });

  it("flags a long-run verdict only when the goal is stay fit", () => {
    expect(longRunVerdictIn("Your long run is improving week on week.")).toBe("Your long run is improving week on week.");
    expect(longRunVerdictIn("Fast finish? Yes.")).toBe("Fast finish");
    expect(longRunVerdictIn("Protect easy days and land the long run.")).toBeNull();
    const read = "Long-run distance is declining. Keep it easy.";
    expect(replayCheckFailures({ label: "06", goal: { kind: "fitness" }, prompt, readText: read })).toEqual([
      { label: "06", check: "long-run verdict for stay fit", detail: '"Long-run distance is declining."' },
    ]);
    const tenK = { kind: "race" as const, distance: "10k" as const };
    expect(replayCheckFailures({ label: "07", goal: tenK, prompt, readText: read })).toEqual([]);
  });
});

describe("replay dry run over a packet folder", () => {
  it("replays the committed two-packet folder with the stub and passes every check", () => {
    const run = dryRun(FIXTURE);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const report = run.report();
    expect(report).toContain("from 2 replayed weekly calls");
    expect(report).toContain("## 01 (01-stay-fit.json)");
    expect(report).toContain("## 02 (02-10k.json)");
    expect(report).toMatch(/## Goal checks\n\nAll passed/);
  }, 30_000);

  it("exits non-zero and names the packet when a check fails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-packets-"));
    copyFileSync(path.join(FIXTURE, "01-stay-fit.json"), path.join(dir, "01-stay-fit.json"));
    const noGoal = JSON.parse(readFileSync(path.join(FIXTURE, "02-10k.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(path.join(dir, "02-no-goal.json"), JSON.stringify({ ...noGoal, goal: null, coaching: null }));
    const run = dryRun(dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("02 (02-no-goal.json): no goal line: the packet has no goal");
    expect(run.report()).toContain("- 02 (02-no-goal.json): no goal line");
    expect(run.report()).not.toContain("- 01 (01-stay-fit.json):");
  }, 30_000);
});
