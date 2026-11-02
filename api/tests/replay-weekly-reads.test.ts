/**
 * The weekly-read replay script (scripts/replay-weekly-reads.ts): its goal
 * checks, and the dry run with the offline stub over a packet folder, for the
 * weekly read and the other four coach operations. Never calls the live model.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { longRunVerdictIn, mentionsMarathon, replayCheckFailures } from "../scripts/replayChecks.js";
import { recordedWeeklyReplyAsForm } from "./weeklyForms.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(api, "tests/fixtures/replay-packets");
const DEMO_OPERATIONS = path.join(api, "tests/fixtures/demo-operations");

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
    expect(run.files()).toEqual(["01.1.json", "02.1.json", "config.json", "measures.json"]);
    const report = run.report();
    expect(report).toContain("from 2 replayed coach calls across 1 configuration");
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
    expect(refused).toContain("- 02.1.failed.json (02-failed.json, weekly read): stub refusal");
    expect(refused).toContain("refused on all 2 attempts");
    expect(refused).not.toContain("01.1");
    expect(report).toContain("### 01.1 (01-retried.json): weekly read\n\nModel claude-opus-4-7.");
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
    expect(run.files(SELF_HOSTED)).toEqual(["01.1.json", "02.1.json", "config.json", "measures.json"]);
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
    const files = ["01.1.json", "01.2.json", "02.1.json", "02.2.json", "config.json", "measures.json"];
    expect(run.files()).toEqual(files);
    expect(run.config().repeats).toBe(2);
    const before = Object.fromEntries(
      files.filter((f) => f !== "config.json" && f !== "measures.json").map((f) => [f, readFileSync(path.join(run.out, DEFAULT_CONFIG, f), "utf8")]),
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
    expect(report).toContain("from 6 replayed coach calls across 2 configurations");
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

describe("replay --only", () => {
  const SEASON_PACKETS = path.join(api, "tests/fixtures/seasons/season-packets");
  const REGRESSION_SET = path.join(api, "tests/fixtures/regression-set.json");
  /** An output root under a fresh temp folder, named as a run's root: snapshot or seasons. */
  const rootNamed = (name: string) => path.join(mkdtempSync(path.join(tmpdir(), "replay-only-")), name);
  const replies = (files: string[]) => files.filter((f) => /^\d+\.\d+\.json$/.test(f));

  it("checks in a regression set of about 20 inputs, a reason each, ids within the two roots", () => {
    const set = JSON.parse(readFileSync(REGRESSION_SET, "utf8")) as Array<{ input: string; why: string }>;
    expect(set.length).toBeGreaterThanOrEqual(18);
    expect(set.length).toBeLessThanOrEqual(22);
    expect(new Set(set.map((e) => e.input)).size).toBe(set.length);
    for (const { input, why } of set) {
      const m = /^(seasons|snapshot)\/(\d{2})$/.exec(input);
      expect(m, input).not.toBeNull();
      expect(Number(m![2])).toBeGreaterThanOrEqual(1);
      expect(Number(m![2])).toBeLessThanOrEqual(m![1] === "seasons" ? 18 : 17);
      expect(why.trim().length, input).toBeGreaterThan(0);
    }
  });

  it("replays only the named inputs of a comma list, keeping their ids, and skips the other root's", () => {
    const run = dryRun(SEASON_PACKETS, rootNamed("seasons"), ["--only", "seasons/02, seasons/14,snapshot/01,snapshot/17"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(replies(run.files())).toEqual(["02.1.json", "14.1.json"]);
    expect(run.stdout).toContain("--only: 2 of 18 inputs under seasons (02, 14)");
    const report = run.report();
    expect(report).toContain("from 2 replayed coach calls");
    expect(report).toContain("### 02.1 (1-stay-fit-w2.json)");
    expect(report).toContain("### 14.1 (3-return-w2.json)");
  }, 60_000);

  it("takes @file: the checked-in regression set replays its own inputs from each root", () => {
    const set = JSON.parse(readFileSync(REGRESSION_SET, "utf8")) as Array<{ input: string }>;
    const expected = (root: string) =>
      set.filter((e) => e.input.startsWith(`${root}/`)).map((e) => `${e.input.split("/")[1]}.1.json`).sort();

    const seasons = dryRun(SEASON_PACKETS, rootNamed("seasons"), ["--only", "@tests/fixtures/regression-set.json"]);
    expect(seasons.stderr).toBe("");
    expect(seasons.status).toBe(0);
    expect(replies(seasons.files())).toEqual(expected("seasons"));

    // The demo snapshot run: no --packets.
    const out = rootNamed("snapshot");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const snapshot = spawnSync(
      path.join(api, "node_modules/.bin/tsx"),
      ["scripts/replay-weekly-reads.ts", "--dry-run", "--out", out, "--only", `@${REGRESSION_SET}`],
      { cwd: api, env, encoding: "utf8" },
    );
    // The demo's weeks were logged before its goal was stored, so the goal-line
    // check fails on them and the run exits non-zero; nothing else may go wrong.
    expect(snapshot.stderr).not.toMatch(/Error/);
    expect(snapshot.stderr).toMatch(/^\d+ goal checks? failed:\n(- .+: no goal line: the packet has no goal\n)+$/);
    expect(replies(readdirSync(path.join(out, DEFAULT_CONFIG)).sort())).toEqual(expected("snapshot"));
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain(`from ${expected("snapshot").length} replayed coach calls`);
  }, 120_000);

  it("refuses a bad id, an id past the last input, a missing or malformed file, or a list naming no input of the run, before any call", () => {
    const notAList = path.join(mkdtempSync(path.join(tmpdir(), "replay-only-file-")), "set.json");
    writeFileSync(notAList, JSON.stringify([{ input: "seasons/01" }]));
    const cases: Array<[string, RegExp]> = [
      ["seasons-01", /--only "seasons-01": expected <root folder name>\/<input id>/],
      ["seasons/01,seasons/x", /--only "seasons\/x": expected/],
      ["seasons/19", /--only "seasons\/19": seasons has inputs 01 to 18/],
      ["@tests/fixtures/no-such-set.json", /--only @tests\/fixtures\/no-such-set.json: no file at/],
      [`@${notAList}`, /expected a non-empty JSON list of/],
      ["snapshot/01,snapshot/02", /--only names no input of this run: its inputs are seasons\/<id>/],
    ];
    for (const [only, message] of cases) {
      const run = dryRun(SEASON_PACKETS, rootNamed("seasons"), ["--only", only]);
      expect(run.status, only).not.toBe(0);
      expect(run.stderr).toMatch(message);
      expect(run.stdout).not.toMatch(/done in/);
      expect(existsSync(run.out), only).toBe(false);
    }
  }, 90_000);

  it("is ignored by --report-only", () => {
    const run = dryRun(FIXTURE);
    expect(run.status).toBe(0);
    const again = spawnSync(
      path.join(api, "node_modules/.bin/tsx"),
      ["scripts/replay-weekly-reads.ts", "--report-only", "--out", run.out, "--only", "not-an-id"],
      { cwd: api, env: process.env, encoding: "utf8" },
    );
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
    expect(readFileSync(path.join(run.out, "report.md"), "utf8")).toContain("from 2 replayed coach calls");
  }, 60_000);
});

describe("replay over every coach operation", () => {
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const goal = { kind: "race", distance: "10k", raceName: "Riverside 10K", raceDate: "2026-11-08" };
  const firstDraft = {
    operation: "dossier_v1",
    input: {
      goal,
      answers: {
        goal: "Riverside 10K on Nov 8, under 45 minutes.",
        schedule: "Four runs a week: Tue, Thu, Sat and Sun.",
        injuries_constraints: "None right now.",
      },
      prefills: { available: false },
    },
  };

  /** A folder with one input of each operation, in operation order. */
  function fiveOperations(extra: Record<string, Record<string, unknown>> = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-operations-"));
    copyFileSync(path.join(FIXTURE, "02-10k.json"), path.join(dir, "01-weekly.json"));
    copyFileSync(path.join(DEMO_OPERATIONS, "01-mid-week-attached-run.json"), path.join(dir, "02-mid-week.json"));
    writeFileSync(path.join(dir, "03-first-draft.json"), JSON.stringify(firstDraft));
    copyFileSync(path.join(DEMO_OPERATIONS, "03-about-you-correction.json"), path.join(dir, "04-correction.json"));
    copyFileSync(path.join(DEMO_OPERATIONS, "02-about-you-audit.json"), path.join(dir, "05-audit.json"));
    for (const [file, patch] of Object.entries(extra)) {
      writeFileSync(path.join(dir, file), JSON.stringify({ ...read(path.join(dir, file)), ...patch }));
    }
    return dir;
  }

  it("dispatches one input of each operation to its stub method and validator, with a report section for each", () => {
    const run = dryRun(fiveOperations());
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.files()).toEqual(["01.1.json", "02.1.json", "03.1.json", "04.1.json", "05.1.json", "config.json", "measures.json"]);

    const saved = (stem: string) => read(path.join(run.out, DEFAULT_CONFIG, `${stem}.json`));
    const reply = (stem: string) => saved(stem).new as Record<string, unknown>;
    expect(["01.1", "02.1", "03.1", "04.1", "05.1"].map((s) => saved(s).operation)).toEqual([
      "weekly_reply",
      "mid_week_chat",
      "dossier_v1",
      "dossier_correction",
      "dossier_audit",
    ]);
    // Each reply has its own operation's shape, as the stub builds it for that method.
    expect(reply("01.1")).toMatchObject({ analysis: expect.any(String), prescribedWeek: expect.anything() });
    expect(reply("02.1").body).toContain("Attached run feedback");
    expect(reply("02.1")).not.toHaveProperty("prescribedWeek");
    for (const s of ["03.1", "04.1", "05.1"]) {
      expect(reply(s)).toMatchObject({ summaryBullets: expect.any(Array), proposedBody: expect.stringContaining("## Stance") });
    }
    expect(reply("04.1").proposedBody).toContain("Thursday hill loop is closed");
    expect((reply("05.1").summaryBullets as string[]).join(" ")).toMatch(/Next tidy-up/);
    // The goal-line check reads the rebuilt prompt where the operation has one.
    expect(saved("02.1").promptHead).toMatch(/^Athlete goal: /);
    expect(saved("03.1").promptHead).toBeNull();
    expect(saved("03.1").goal).toEqual(goal);

    const report = run.report();
    expect(report).toContain("from 5 replayed coach calls across 1 configuration");
    expect(report).toContain(
      "Replies: 1 weekly read, 1 mid-week reply, 1 About you first draft, 1 About you correction, 1 About you tidy-up.",
    );
    const headings = report.match(/^### \d\d\.1 .*$/gm);
    expect(headings).toEqual([
      "### 01.1 (01-weekly.json): weekly read",
      "### 02.1 (02-mid-week.json): mid-week reply",
      "### 03.1 (03-first-draft.json): About you first draft",
      "### 04.1 (04-correction.json): About you correction",
      "### 05.1 (05-audit.json): About you tidy-up",
    ]);
    const section = (n: number) => report.slice(report.indexOf(headings![n - 1]!), headings![n] ? report.indexOf(headings![n]!) : undefined);
    expect(section(1)).toContain("| Read length (characters) |");
    expect(section(2)).toContain("| Reply length (characters) |");
    expect(section(2)).toContain("Athlete: Attaching Tuesday's easy 6.");
    expect(section(2)).toMatch(/Reply:\n\n> .*Attached run feedback/);
    expect(section(2)).toContain("About you suggestions:");
    expect(section(2)).toContain("Plan changes:");
    for (const n of [3, 4, 5]) {
      expect(section(n)).toContain("| About you length (characters) |");
      expect(section(n)).toMatch(/Summary:\n- /);
      expect(section(n)).toContain("About you:\n\n> # About you");
      expect(section(n)).toContain("(no goal line in this prompt, so not checked for one)");
    }
    for (const n of [1, 2, 3, 4, 5]) expect(section(n)).toContain("| Internal words | | none |");
    expect(report).toMatch(/## Goal checks\n\nAll passed/);
  }, 30_000);

  it("applies the goal and vocabulary checks to the words of every operation", () => {
    const fitness = { kind: "fitness" };
    const dir = fiveOperations({
      // A stay-fit athlete whose About you says marathon and long run is improving.
      "04-correction.json": {
        goal: fitness,
        input: {
          ...(read(path.join(DEMO_OPERATIONS, "03-about-you-correction.json")).input as Record<string, unknown>),
          athleteMessage: "I want my marathon long runs back, my long run is improving every week. The recap is great.",
        },
      },
    });
    const run = dryRun(dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`${DEFAULT_CONFIG}/04.1 (04-correction.json): marathon in a non-marathon read`);
    expect(run.stderr).toContain("04.1 (04-correction.json): long-run verdict for stay fit");
    expect(run.stderr).not.toContain("04.1 (04-correction.json): no goal line");
    const report = run.report();
    const correction = report.slice(report.indexOf("### 04.1"), report.indexOf("### 05.1"));
    expect(correction).toMatch(/\| Internal words \| \| .*recap/);
  }, 30_000);

  it("asks once more for every operation, as the app does, and a reply refused twice fails", () => {
    const dir = fiveOperations({
      "01-weekly.json": { packet: read(path.join(FIXTURE, "02-10k.json")), stubRefusals: 1 },
      "02-mid-week.json": { stubRefusals: 1 },
      "05-audit.json": { stubRefusals: 2 },
    });
    const run = dryRun(dir);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/01\.1\.json done in \d+ s after asking once more/);
    expect(run.stdout).toMatch(/02\.1\.json done in \d+ s after asking once more \(stub refusal: body is required/);
    expect(run.stdout).toContain("05.1.json refused: stub refusal: proposedBody is required");
    expect(run.files()).toEqual(["01.1.json", "02.1.json", "03.1.json", "04.1.json", "05.1.failed.json", "config.json", "measures.json"]);
    const retried = read(path.join(run.out, DEFAULT_CONFIG, "02.1.json"));
    expect(retried.operation).toBe("mid_week_chat");
    expect(retried.refusedAttempts).toHaveLength(1);
    expect((retried.timing as { attempts: unknown[] }).attempts).toHaveLength(2);
    const failed = read(path.join(run.out, DEFAULT_CONFIG, "05.1.failed.json"));
    expect(failed.operation).toBe("dossier_audit");
    expect(failed.refusedAttempts).toHaveLength(2);
    expect((failed.timing as { attempts: unknown[] }).attempts).toHaveLength(2);

    const report = run.report();
    expect(report).toContain("- 02.1 (02-mid-week.json): Asked once more: attempt 1 refused");
    expect(report).toContain("- 05.1.failed.json (05-audit.json, About you tidy-up): stub refusal: proposedBody is required");
    expect(report).toContain(`| ${DEFAULT_CONFIG} | anthropic |  | claude-opus-4-7 | xhigh | 1 |  | 5 | 2 | 2 | 1 |`);
    expect(run.stderr).toContain("05.1 (05-audit.json): refused reply");
  }, 30_000);

  it("replays the committed demo-operation inputs and passes every check", () => {
    const run = dryRun(DEMO_OPERATIONS);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const report = run.report();
    expect(report).toContain("Replies: 1 mid-week reply, 1 About you correction, 1 About you tidy-up.");
    expect(report).toMatch(/## Goal checks\n\nAll passed/);
  }, 30_000);

  it("refuses an input with an unknown operation, or an About you operation without its input", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-operations-"));
    writeFileSync(path.join(dir, "01.json"), JSON.stringify({ operation: "race_report", packet: {} }));
    const unknown = dryRun(dir);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain('01.json: unknown operation "race_report"');

    writeFileSync(path.join(dir, "01.json"), JSON.stringify({ operation: "dossier_audit", packet: {} }));
    const noInput = dryRun(dir);
    expect(noInput.status).not.toBe(0);
    expect(noInput.stderr).toContain('01.json: dossier_audit needs an "input"');
  }, 30_000);
});

describe("replay measures", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const packet = (f: string) => JSON.parse(readFileSync(path.join(FIXTURE, f), "utf8")) as Record<string, unknown>;
  const usage = { inputTokens: 20_000, outputTokens: 4_000, cacheReadTokens: 1_000, cacheCreationTokens: 2_000 };
  // Per million tokens: 20k in at $5, 1k cache read at $0.50, 2k cache write at $6.25, 4k out at $25.
  const COST = 0.1 + 0.0005 + 0.0125 + 0.1;

  /** A weekly read refused once then accepted, and one whose headline runs past its cap; both report usage. */
  function tunedPackets(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-measures-"));
    writeFileSync(
      path.join(dir, "01-retried.json"),
      JSON.stringify({ packet: packet("01-stay-fit.json"), stubRefusals: 1, stubUsage: usage }),
    );
    writeFileSync(
      path.join(dir, "02-long-headline.json"),
      JSON.stringify({ packet: packet("02-10k.json"), stubPatch: { headline: "Steady week. ".repeat(30) }, stubUsage: usage }),
    );
    return dir;
  }

  it("writes measures.json with the retry, the cap hit by field and the cost, and puts every measure in the summary", () => {
    const run = dryRun(tunedPackets());
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const m = read(path.join(run.out, DEFAULT_CONFIG, "measures.json"));
    expect(m.schema).toEqual({ firstTry: 1, afterRetry: 1, failed: 0 });
    expect(m.lengthCaps).toEqual({ hits: 1, byField: { headline: 1 } });
    expect(m.softRepairs).toMatchObject({ count: 1, replies: 1, byField: { headline: 1 } });
    expect(m.goalCheckFailures.count).toBe(0);
    expect(m.bannedVocabulary.hits).toBe(0);
    expect(m.planSanity).toMatchObject({ band: { low: 0.5, high: 1.6 }, weeklyReplies: 2, flaggedReplies: 0 });
    expect(m.tokens.input).toEqual({ median: 20_000, n: 2 });
    expect(m.tokens.thinking).toEqual({ median: null, n: 0 });
    expect(m.latency.totalMs.n).toBe(2);
    expect(m.latency.wallClockMs).toBeGreaterThanOrEqual(0);
    // The stub's refusal reports no usage, so each reply costs one accepted attempt.
    expect(m.cost.priceTakenOn).toBe("2026-11-01");
    expect(m.cost.perReplyUsd["01.1"]).toBeCloseTo(COST, 6);
    expect(m.cost.totalUsd).toBeCloseTo(2 * COST, 6);

    const saved = read(path.join(run.out, DEFAULT_CONFIG, "01.1.json"));
    expect(saved.timing.attempts).toHaveLength(2);
    expect(saved.timing.ttftMs).toBeNull();
    expect(saved.planCheck).toMatchObject({ weekStartMonday: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    const report = run.report();
    expect(report).toContain(
      "| Prompt cut | Soft repairs | Caps hit | Goal-check failures | Banned words | Plan sanity flags | Cost total | Cost per reply (median) |",
    );
    expect(report).toContain(`| ${DEFAULT_CONFIG} | anthropic |  | claude-opus-4-7 | xhigh | 1 |  | 2 | 1 | 1 | 0 |`);
    expect(report).toContain("| 1 | 1 | 0 | 0 | 0 of 2 | $0.4260 | $0.2130 |");
    expect(report).toContain("| Length caps hit | 1 (headline 1) |");
    expect(report).toContain("within 0.5x to 1.6x of the packet's recent weekly distance");
    expect(report).toContain("| Opus 4.7 (claude-opus-4-7) | $5 | $25 | $0.50 | $6.25 |");
  }, 30_000);

  it("leaves cost blank for a self-hosted configuration", () => {
    const run = dryRun(tunedPackets(), undefined, [
      "--provider",
      "self_hosted",
      "--base-url",
      "http://macbook.local:8000",
      "--model",
      "gemma-4",
      "--effort",
      "high",
    ]);
    expect(run.status).toBe(0);
    const config = "self_hosted--gemma-4--high";
    const m = read(path.join(run.out, config, "measures.json"));
    expect(m.cost).toBeNull();
    expect(m.tokens.output).toEqual({ median: 4_000, n: 2 });
    const report = run.report();
    expect(report).toContain("| 1 | 1 | 0 | 0 | 0 of 2 |  |  |");
    expect(report).toContain("| Cost | self-hosted: not priced |");
  }, 30_000);

  it("recomputes from the reply files on --report-only: a six-day plan trips sanity, a short input count trips the cut flag", () => {
    const run = dryRun(FIXTURE);
    expect(run.status).toBe(0);
    const file = path.join(run.out, DEFAULT_CONFIG, "02.1.json");
    const saved = read(file);
    saved.new.prescribedWeek.days = saved.new.prescribedWeek.days.slice(0, 6);
    saved.inputTokens = 7_000;
    saved.estimatedInputTokens = 10_000;
    saved.timing = { ttftMs: 2_500, totalMs: 9_000, attempts: [{ attempt: 1, ttftMs: 2_500, totalMs: 9_000 }] };
    writeFileSync(file, JSON.stringify(saved));

    const again = reportOnly(run.out);
    expect(again.status).toBe(0);
    const m = read(path.join(run.out, DEFAULT_CONFIG, "measures.json"));
    expect(m.planSanity.flaggedReplies).toBe(1);
    expect(m.planSanity.byCheck).toEqual({ "seven days": 1 });
    expect(m.planSanity.flags[0]).toMatchObject({ reply: "02.1", check: "seven days", detail: "6 days" });
    expect(m.promptCut).toMatchObject({ checked: 1, cut: ["02.1"], lowestRatio: 0.7 });
    expect(m.latency.firstTokenMs).toEqual({ median: 2_500, worst: 2_500, n: 1 });
    const report = again.report();
    expect(report).toContain("- 02.1: seven days: 6 days");
    expect(report).toContain("| 1 of 1 |");
  }, 30_000);
});

describe("replay against a fake self-hosted server", () => {
  const SH_FIXTURE = path.join(api, "tests/fixtures/self-hosted/omlx-gpt-oss-weekly");

  it("saves time to first token, thinking characters and the server's usage from the stream", async () => {
    // The recording predates the plan box: its tool input is translated into the weekly form.
    const sse = Buffer.from(recordedWeeklyReplyAsForm(readFileSync(`${SH_FIXTURE}.sse`, "utf8")), "utf8");
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        // Everything before the first delta at once, the rest a little later.
        const cut = sse.indexOf("content_block_delta");
        res.write(sse.subarray(0, cut));
        setTimeout(() => res.end(sse.subarray(cut)), 30);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const packets = mkdtempSync(path.join(tmpdir(), "replay-sh-packets-"));
    // The recorded packet predates goals; give it the demo athlete's marathon so the goal checks pass.
    const recorded = JSON.parse(readFileSync(`${SH_FIXTURE}.packet.json`, "utf8")) as Record<string, unknown>;
    const goal = { kind: "race", distance: "marathon", raceName: "Lakeshore Marathon", raceDate: "2026-11-15" };
    writeFileSync(path.join(packets, "01-weekly.json"), JSON.stringify({ ...recorded, goal }));
    const out = mkdtempSync(path.join(tmpdir(), "replay-sh-out-"));
    let stderr = "";
    let status: number | null;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      const child = spawn(
        path.join(api, "node_modules/.bin/tsx"),
        [
          "scripts/replay-weekly-reads.ts",
          "--packets",
          packets,
          "--out",
          out,
          "--provider",
          "self_hosted",
          "--base-url",
          `http://127.0.0.1:${port}`,
          "--model",
          "gpt-oss-20b-MXFP4-Q8",
          "--effort",
          "high",
        ],
        { cwd: api, env },
      );
      child.stderr.on("data", (d) => (stderr += String(d)));
      status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    } finally {
      server.close();
    }
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const config = "self_hosted--gpt-oss-20b-MXFP4-Q8--high";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = JSON.parse(readFileSync(path.join(out, config, "01.1.json"), "utf8")) as Record<string, any>;
    expect(saved.timing.ttftMs).toBeGreaterThanOrEqual(0);
    expect(saved.timing.totalMs).toBeGreaterThanOrEqual(saved.timing.ttftMs);
    expect(saved.inputTokens).toBe(16_592);
    expect(saved.thinkingTokens).toBeNull();
    expect(saved.thinkingChars).toBeGreaterThan(0);
    expect(saved.estimatedInputTokens).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = JSON.parse(readFileSync(path.join(out, config, "measures.json"), "utf8")) as Record<string, any>;
    expect(m.latency.firstTokenMs.n).toBe(1);
    expect(m.tokens.thinking).toEqual({ median: null, n: 0 });
    expect(m.tokens.thinkingChars.n).toBe(1);
    expect(m.promptCut.checked).toBe(1);
    expect(m.cost).toBeNull();
  }, 60_000);
});
