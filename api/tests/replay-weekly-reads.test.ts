/**
 * The weekly-read replay script (scripts/replay-weekly-reads.ts): its goal
 * checks, and the dry run with the offline stub over a packet folder. Never
 * calls the live model.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { longRunVerdictIn, mentionsMarathon, replayCheckFailures } from "../scripts/replayChecks.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(api, "tests/fixtures/replay-packets");

/** The folder a run with no matrix flags writes into: Anthropic at the tested default. */
const DEFAULT_CONFIG = "anthropic--claude-opus-4-7--xhigh";

function dryRun(
  packets: string,
  out = mkdtempSync(path.join(tmpdir(), "replay-out-")),
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  const run = spawnSync(
    path.join(api, "node_modules/.bin/tsx"),
    ["scripts/replay-weekly-reads.ts", "--packets", packets, "--dry-run", "--out", out, ...extraArgs],
    { cwd: api, env, encoding: "utf8" },
  );
  return {
    ...run,
    out,
    report: () => readFileSync(path.join(out, "report.md"), "utf8"),
    /** The files in one configuration folder, sorted. */
    files: (config = DEFAULT_CONFIG) => readdirSync(path.join(out, config)).sort(),
    config: (config = DEFAULT_CONFIG) => JSON.parse(readFileSync(path.join(out, config, "config.json"), "utf8")) as Record<string, unknown>,
  };
}

/** --report-only over an output root, no packets needed. */
function reportOnly(out: string) {
  const run = spawnSync(
    path.join(api, "node_modules/.bin/tsx"),
    ["scripts/replay-weekly-reads.ts", "--report-only", "--out", out],
    { cwd: api, env: process.env, encoding: "utf8" },
  );
  return { ...run, report: () => readFileSync(path.join(out, "report.md"), "utf8") };
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
    // No matrix flags: today's run, in the Anthropic folder at the tested default.
    expect(run.files()).toEqual(["01.1.json", "02.1.json", "config.json"]);
    const report = run.report();
    expect(report).toContain("from 2 replayed weekly calls across 1 configuration");
    expect(report).toContain(`## ${DEFAULT_CONFIG}`);
    expect(report).toContain("### 01.1 (01-stay-fit.json)");
    expect(report).toContain("### 02.1 (02-10k.json)");
    expect(report).toMatch(/## Goal checks\n\nAll passed/);
  }, 30_000);

  it("takes --model and --effort, and refuses an effort that is not one of the five levels", () => {
    const ok = dryRun(FIXTURE, undefined, ["--model", "claude-opus-5-5", "--effort", "high"]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.files("anthropic--claude-opus-5-5--high")).toContain("01.1.json");

    const bad = dryRun(FIXTURE, undefined, ["--effort", "extra"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/Invalid --effort "extra".*low, medium, high, xhigh, max/);
  }, 30_000);

  it("exits non-zero and names the packet when a check fails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-packets-"));
    copyFileSync(path.join(FIXTURE, "01-stay-fit.json"), path.join(dir, "01-stay-fit.json"));
    const noGoal = JSON.parse(readFileSync(path.join(FIXTURE, "02-10k.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(path.join(dir, "02-no-goal.json"), JSON.stringify({ ...noGoal, goal: null, coaching: null }));
    const run = dryRun(dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`${DEFAULT_CONFIG}/02.1 (02-no-goal.json): no goal line: the packet has no goal`);
    expect(run.report()).toContain(`- ${DEFAULT_CONFIG}/02.1 (02-no-goal.json): no goal line`);
    expect(run.report()).not.toContain("01.1 (01-stay-fit.json): no goal line");
  }, 30_000);

  it("asks once more for a reply refused for its shape, notes the retry, lists it apart from failures and fails on a refusal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-packets-"));
    const packet = (f: string) => JSON.parse(readFileSync(path.join(FIXTURE, f), "utf8")) as unknown;
    writeFileSync(path.join(dir, "01-retried.json"), JSON.stringify({ packet: packet("01-stay-fit.json"), stubRefusals: 1 }));
    writeFileSync(path.join(dir, "02-failed.json"), JSON.stringify({ packet: packet("02-10k.json"), stubRefusals: 2 }));
    const run = dryRun(dir);
    // The retried reply passes; the reply refused twice leaves a read unchecked.
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("02.1 (02-failed.json): refused reply");
    expect(run.stdout).toMatch(/01\.1\.json done in \d+ s after asking once more/);
    expect(run.stdout).toContain("02.1.json refused: stub refusal");

    const config = path.join(run.out, DEFAULT_CONFIG);
    const saved = JSON.parse(readFileSync(path.join(config, "01.1.json"), "utf8")) as {
      refusedAttempts: Array<{ attempt: number; error: string }>;
      new: { analysis: string };
    };
    expect(saved.refusedAttempts).toHaveLength(1);
    expect(saved.refusedAttempts[0]).toMatchObject({ attempt: 1, error: expect.stringContaining("analysis is required") });
    expect(saved.new.analysis.length).toBeGreaterThan(0);
    const failed = JSON.parse(readFileSync(path.join(config, "02.1.failed.json"), "utf8")) as {
      refusedAttempts: unknown[];
    };
    expect(failed.refusedAttempts).toHaveLength(2);

    const report = run.report();
    const retried = report.slice(report.indexOf("### Retried replies"), report.indexOf("### Refused replies"));
    expect(retried).toContain("- 01.1 (01-retried.json): Asked once more: attempt 1 refused");
    expect(retried).not.toContain("02");
    const refused = report.slice(report.indexOf("### Refused replies"));
    expect(refused).toContain("- 02.1.failed.json (02-failed.json): stub refusal");
    expect(refused).toContain("refused on all 2 attempts");
    expect(refused).not.toContain("01.1");
    expect(report).toContain("### 01.1 (01-retried.json)\n\nModel claude-opus-4-7.");
    // The summary counts one reply after a retry and one refused.
    expect(report).toContain(`| ${DEFAULT_CONFIG} | anthropic |  | claude-opus-4-7 | xhigh | 1 |  | 2 | 0 | 1 | 1 |`);

    // Resumable: a re-run skips the reply saved after the retry and keeps its note.
    const again = dryRun(dir, run.out);
    expect(again.stdout).toContain("01.1.json exists, skipped");
    expect(again.report()).toContain("- 01.1 (01-retried.json): Asked once more");
  }, 30_000);
});

describe("replay matrix", () => {
  const SELF_HOSTED = "self_hosted--mlx-community_gemma-4_fast--high";
  const selfHostedArgs = [
    "--provider",
    "self_hosted",
    "--base-url",
    "http://macbook.local:8000/v1",
    "--key-env",
    "REPLAY_TEST_SH_KEY",
    "--model",
    "mlx-community/gemma-4:fast",
    "--effort",
    "high",
  ];

  it("writes one folder per configuration with its config.json, named from provider, model and effort", () => {
    const run = dryRun(FIXTURE, undefined, [...selfHostedArgs, "--note", "M4 Pro, 24 GB, oMLX at 64k"], {
      REPLAY_TEST_SH_KEY: "sk-local-secret",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(readdirSync(run.out).sort()).toEqual(["report.md", SELF_HOSTED]);
    expect(run.files(SELF_HOSTED)).toEqual(["01.1.json", "02.1.json", "config.json"]);
    const config = run.config(SELF_HOSTED);
    expect(config).toMatchObject({
      configuration: SELF_HOSTED,
      provider: "self_hosted",
      baseUrlHost: "macbook.local",
      model: "mlx-community/gemma-4:fast",
      effort: "high",
      repeats: 1,
      note: "M4 Pro, 24 GB, oMLX at 64k",
      dryRun: true,
      inputs: FIXTURE,
    });
    expect(Date.parse(config.startedAt as string)).not.toBeNaN();
    expect(config.harnessCommit).toMatch(/^[0-9a-f]{40}$/);
    // The key is read from the named variable and never written anywhere.
    expect(JSON.stringify(config)).not.toContain("sk-local-secret");
    expect(readFileSync(path.join(run.out, SELF_HOSTED, "01.1.json"), "utf8")).not.toContain("sk-local-secret");
    const saved = JSON.parse(readFileSync(path.join(run.out, SELF_HOSTED, "01.1.json"), "utf8")) as { model: string };
    expect(saved.model).toBe("mlx-community/gemma-4:fast");
  }, 30_000);

  it("numbers repeats, and a second run writes nothing new", () => {
    const run = dryRun(FIXTURE, undefined, ["--repeats", "2"]);
    expect(run.status).toBe(0);
    const files = ["01.1.json", "01.2.json", "02.1.json", "02.2.json", "config.json"];
    expect(run.files()).toEqual(files);
    expect(run.config().repeats).toBe(2);
    const before = Object.fromEntries(
      files.filter((f) => f !== "config.json").map((f) => [f, readFileSync(path.join(run.out, DEFAULT_CONFIG, f), "utf8")]),
    );

    const again = dryRun(FIXTURE, run.out, ["--repeats", "2"]);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toMatch(/done in/);
    for (const f of Object.keys(before)) expect(again.stdout).toContain(`${f} exists, skipped`);
    expect(again.files()).toEqual(files);
    for (const [f, text] of Object.entries(before)) {
      expect(readFileSync(path.join(run.out, DEFAULT_CONFIG, f), "utf8")).toBe(text);
    }
    // The resumed run keeps when the configuration started.
    expect(again.config().startedAt).toBe(run.config().startedAt);
    expect(again.config().resumedAt).toHaveLength(1);
  }, 60_000);

  it("aggregates every configuration folder into one report with a summary table", () => {
    const first = dryRun(FIXTURE, undefined, ["--repeats", "2"]);
    expect(first.status).toBe(0);
    const second = dryRun(FIXTURE, first.out, selfHostedArgs, { REPLAY_TEST_SH_KEY: "k" });
    expect(second.status).toBe(0);

    const run = reportOnly(first.out);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const report = run.report();
    expect(report).toContain("from 6 replayed weekly calls across 2 configurations");
    expect(report).toContain("| Configuration | Provider | Host | Model | Effort | Repeats | Note | Replies | First try | After retry | Failed |");
    expect(report).toContain(`| ${DEFAULT_CONFIG} | anthropic |  | claude-opus-4-7 | xhigh | 2 |  | 4 | 4 | 0 | 0 |`);
    expect(report).toContain(`| ${SELF_HOSTED} | self_hosted | macbook.local | mlx-community/gemma-4:fast | high | 1 |  | 2 | 2 | 0 | 0 |`);
    // A section per configuration, each with its per-call tables.
    const anthropic = report.slice(report.indexOf(`## ${DEFAULT_CONFIG}`), report.indexOf(`## ${SELF_HOSTED}`));
    const selfHosted = report.slice(report.indexOf(`## ${SELF_HOSTED}`));
    expect(anthropic).toContain("### 01.2 (01-stay-fit.json)");
    expect(anthropic).toContain("| Read length (characters) |");
    expect(selfHosted).toContain("Provider self_hosted at macbook.local.");
    expect(selfHosted).toContain("### 02.1 (02-10k.json)");
    expect(selfHosted).not.toContain("01.2");
  }, 60_000);

  it("fails before any call when the --key-env variable is unset", () => {
    const run = dryRun(FIXTURE, undefined, [...selfHostedArgs.slice(0, 4), "--key-env", "REPLAY_TEST_UNSET_KEY", ...selfHostedArgs.slice(6)]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--key-env REPLAY_TEST_UNSET_KEY: the environment variable REPLAY_TEST_UNSET_KEY is unset or empty.");
    expect(run.stdout).not.toMatch(/done in/);
    expect(existsSync(path.join(run.out, SELF_HOSTED))).toBe(false);
  }, 30_000);

  it("refuses a bad provider, repeat count or self-hosted run without a base URL or model", () => {
    const cases: Array<[string[], RegExp]> = [
      [["--provider", "openai"], /Invalid --provider "openai"/],
      [["--repeats", "0"], /Invalid --repeats "0"/],
      [["--provider", "self_hosted", "--model", "m"], /self_hosted needs --base-url/],
      [["--provider", "self_hosted", "--base-url", "ftp://x"], /Invalid --base-url "ftp:\/\/x"/],
      [["--provider", "self_hosted", "--base-url", "http://x:8000"], /self_hosted needs --model/],
      [["--base-url", "http://x:8000"], /--base-url is for --provider self_hosted/],
    ];
    for (const [args, message] of cases) {
      const run = dryRun(FIXTURE, undefined, args);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(message);
      expect(run.stdout).not.toMatch(/done in/);
    }
  }, 60_000);
});
