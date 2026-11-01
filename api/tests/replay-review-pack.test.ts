/**
 * The replay benchmark's blind review pack (scripts/replayReview.ts, through
 * --review-pack on scripts/replay-weekly-reads.ts) and the join of filled
 * scores into the report. Two output roots are built with dry runs on the
 * offline stub, as the real benchmark has them: the demo snapshot's inputs in
 * one, the season packets in the other. Never calls a model.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { baselineIsA, plainText } from "../scripts/replayReview.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEASONS = path.join(api, "tests/fixtures/seasons/season-packets");
const BASELINE = "anthropic--claude-opus-4-7--xhigh";
const CANDIDATE = "self_hosted--cand-model_9b--high";
const OTHER = "self_hosted--other-model--high";
const candidateArgs = (model: string) => ["--provider", "self_hosted", "--base-url", "http://127.0.0.1:9", "--model", model, "--effort", "high"];

function replay(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-weekly-reads.ts", ...args], {
    cwd: api,
    env,
    encoding: "utf8",
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

let bench: string;
let snapshot: string;
let seasons: string;

/** Builds both roots: baseline, candidate and a second candidate over the snapshot and the seasons. */
beforeAll(() => {
  bench = mkdtempSync(path.join(tmpdir(), "replay-review-"));
  snapshot = path.join(bench, "snapshot");
  seasons = path.join(bench, "seasons");
  for (const [root, inputs] of [
    [snapshot, []],
    [seasons, ["--packets", SEASONS]],
  ] as const) {
    for (const extra of [[], candidateArgs("cand-model:9b"), candidateArgs("other-model")]) {
      const run = replay([...inputs, "--dry-run", "--out", root, ...extra]);
      // The snapshot's inputs predate the demo goal, so their goal checks fail; the replies are written all the same.
      expect(run.stderr).not.toMatch(/Error:|at .*\.ts:\d+/);
    }
  }
  // Week 3 of the stay-fit season has no reply on either side: the rule takes the nearest week.
  for (const config of [BASELINE, CANDIDATE]) rmSync(path.join(seasons, config, "03.1.json"));
  // The candidate's 10k week 3 was refused for its shape on both attempts.
  rmSync(path.join(seasons, CANDIDATE, "09.1.json"));
  writeFileSync(
    path.join(seasons, CANDIDATE, "09.1.failed.json"),
    JSON.stringify({
      operation: "weekly_reply",
      source: "2-10k-w3.json",
      originalCallAt: null,
      model: "cand-model:9b",
      error: "prescribedWeek.week must be an ISO week id (YYYY-Www)",
      outcome: "schema_invalid",
      stopReason: "tool_use",
      inputTokens: 6000,
      outputTokens: 900,
      timing: { ttftMs: 100, totalMs: 900, attempts: [{ attempt: 1 }, { attempt: 2 }] },
      responseRaw: '{"model":"cand-model:9b","content":[{"type":"thinking","thinking":"secret"}]}',
      refusedAttempts: [
        { attempt: 1, error: "prescribedWeek.week must be an ISO week id (YYYY-Www)" },
        { attempt: 2, error: "prescribedWeek.week must be an ISO week id (YYYY-Www)" },
      ],
    }),
  );
  // The baseline has no reply for the return season's week 3.
  rmSync(path.join(seasons, BASELINE, "15.1.json"));
}, 240_000);

function pack(extra: string[] = [], candidates = [CANDIDATE]) {
  return replay([
    "--review-pack",
    "--roots",
    `${snapshot},${seasons}`,
    "--baseline",
    BASELINE,
    ...candidates.flatMap((c) => ["--candidate", c]),
    ...extra,
  ]);
}

const RULE_PAIRS = [
  "seasons-02",
  "seasons-09",
  "seasons-15",
  "snapshot-10",
  "snapshot-06",
  "snapshot-13",
  "snapshot-11",
  "snapshot-14",
];

describe("review pack", () => {
  it("writes one pack per candidate beside the roots, with the pairs the rule picks, a key and a scores template", () => {
    const run = pack(["--seed", "7"], [CANDIDATE, OTHER]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const review = path.join(bench, "review");
    expect(readdirSync(review).sort()).toEqual([CANDIDATE, OTHER].sort());
    const dir = path.join(review, CANDIDATE);
    expect(readdirSync(dir).sort()).toEqual(
      ["README.md", "key.json", "scores.template.json", ...RULE_PAIRS.map((p) => `${p}.md`)].sort(),
    );
    // The rule writes nothing into the configuration folders.
    expect(existsSync(path.join(seasons, CANDIDATE, "review"))).toBe(false);

    const key = readJson(path.join(dir, "key.json"));
    expect(key).toMatchObject({ baseline: BASELINE, candidate: CANDIDATE, seed: 7, sample: "rule" });
    expect(Object.keys(key.pairs)).toEqual(RULE_PAIRS);
    expect(key.pairs["seasons-02"].why).toMatch(/stay-fit season, week 2 \(week 3 has no reply on either side; nearest week\)/);
    expect(key.pairs["seasons-09"]).toMatchObject({ baselineStatus: "ok", candidateStatus: "failed", source: "2-10k-w3.json" });
    expect(key.pairs["seasons-15"]).toMatchObject({ baselineStatus: "missing", candidateStatus: "ok" });
    expect(key.pairs["snapshot-10"].why).toMatch(/marathon week: the latest weekly read \(2026-W41\)/);
    expect(key.pairs["snapshot-06"].why).toMatch(/injury-flag week \(2026-W37\): the most pain notes that report something \(3\)/);
    expect(key.pairs["snapshot-13"].why).toMatch(/run attached/);
    expect(key.pairs["snapshot-11"].why).toMatch(/plain mid-week reply/);
    expect(key.pairs["snapshot-14"].operation).toBe("dossier_v1");
    for (const p of Object.values(key.pairs) as Array<{ A: string; B: string }>) {
      expect([p.A, p.B].sort()).toEqual([BASELINE, CANDIDATE].sort());
    }

    const template = readJson(path.join(dir, "scores.template.json"));
    expect(template.rubric.readsWeek).toMatch(/^Reads the week correctly/);
    expect(template.rubric.safety).toMatch(/pain, injury, return to running/);
    expect(template.rubric.preference).toMatch(/"A", "B", or "tie"/);
    expect(Object.keys(template.pairs)).toEqual(RULE_PAIRS);
    expect(template.pairs["seasons-09"]).toEqual({
      A: { readsWeek: null, planFits: null, safety: null, soundsLikeCade: null, clearConcise: null },
      B: { readsWeek: null, planFits: null, safety: null, soundsLikeCade: null, clearConcise: null },
      preference: null,
      notes: "",
    });
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toContain("1. [seasons-02](seasons-02.md): stay-fit season, week 2: weekly read");
  }, 60_000);

  it("lays each pair out as the athlete reads it, with failures shown plainly and nothing that names the model", () => {
    const dir = path.join(bench, "review", CANDIDATE);
    const key = readJson(path.join(dir, "key.json"));
    for (const id of RULE_PAIRS) {
      const text = readFileSync(path.join(dir, `${id}.md`), "utf8");
      expect(text).toMatch(/^# Pair \d of 8/);
      expect(text.indexOf("## What the coach was given")).toBeLessThan(text.indexOf("## Reply A"));
      expect(text.indexOf("## Reply A")).toBeLessThan(text.indexOf("## Reply B"));
      for (const tell of [/cand-model/i, /claude/i, /opus/i, /anthropic/i, /self.hosted/i, /127\.0\.0\.1/, /tokens/i, /secret/, /ttft|totalMs/]) {
        expect(text).not.toMatch(tell);
      }
    }
    const weekly = readFileSync(path.join(dir, "snapshot-06.md"), "utf8");
    expect(weekly).toContain("- **Pain notes in the week:**");
    expect(weekly).toContain("Right Achilles tight");
    expect(weekly).toContain("**The athlete's questions this week:**");
    for (const part of ["### Headline", "### The read", "### The week (2026-W38)"]) expect(weekly.split(part)).toHaveLength(3);
    expect(weekly).toMatch(/- \*\*Mon Sep 14: \w[\w ]*\.\*\*/);
    expect(weekly).toMatch(/\d+\.\d mi\./);

    const refused = readFileSync(path.join(dir, "seasons-09.md"), "utf8");
    const refusedSide = key.pairs["seasons-09"].A === CANDIDATE ? "A" : "B";
    const candidatePart = refused.split(`## Reply ${refusedSide}`)[1]!.split("## Reply")[0]!;
    expect(candidatePart).toContain("**No usable reply.** The coach's reply came back in the wrong shape on all 2 attempts");
    expect(candidatePart).toContain("`prescribedWeek.week must be an ISO week id (YYYY-Www)`");
    expect(refused).toContain("Race: Riverside 10K");
    expect(readFileSync(path.join(dir, "seasons-15.md"), "utf8")).toContain("**No reply on file.**");

    const midWeek = readFileSync(path.join(dir, "snapshot-13.md"), "utf8");
    expect(midWeek).toContain("**What the athlete just asked:**");
    expect(midWeek).toContain("**Runs attached:**");
    expect(midWeek).toMatch(/\d+:\d\d\/mi/);
    expect(midWeek.split("### Plan changes")).toHaveLength(3);
    const aboutYou = readFileSync(path.join(dir, "snapshot-14.md"), "utf8");
    expect(aboutYou).toContain("**The athlete's onboarding answers:**");
    expect(aboutYou.match(/^### About you$/gm)).toHaveLength(2);
    expect(aboutYou).toContain("> #### About you");
  });

  it("varies the A/B order across pairs and keeps it for the same seed", () => {
    const key = readJson(path.join(bench, "review", CANDIDATE, "key.json"));
    const aIsBaseline = Object.values(key.pairs).map((p) => (p as { A: string }).A === BASELINE);
    expect(aIsBaseline).toContain(true);
    expect(aIsBaseline).toContain(false);

    const again = pack(["--seed", "7", "--review", path.join(bench, "review-again")]);
    expect(again.status).toBe(0);
    const second = readJson(path.join(bench, "review-again", CANDIDATE, "key.json"));
    for (const id of RULE_PAIRS) expect(second.pairs[id].A).toBe(key.pairs[id].A);

    // Drawn per pair from the seed and the pair id alone.
    const ids = Array.from({ length: 40 }, (_, i) => `seasons-${i}`);
    expect(ids.map((id) => baselineIsA(7, id))).toEqual(ids.map((id) => baselineIsA(7, id)));
    expect(ids.map((id) => baselineIsA(7, id))).not.toEqual(ids.map((id) => baselineIsA(8, id)));
  }, 60_000);

  it("takes --sample in place of the rule, and notes a named input with no reply", () => {
    const review = path.join(bench, "review-sample");
    const run = pack(["--sample", "seasons/1,snapshot/15", "--sample", "seasons/03", "--review", review]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const key = readJson(path.join(review, CANDIDATE, "key.json"));
    expect(key.sample).toBe("named");
    expect(Object.keys(key.pairs)).toEqual(["seasons-01", "snapshot-15"]);
    expect(key.notes).toContain("seasons/03: no reply on either side; skipped.");
    expect(readFileSync(path.join(review, CANDIDATE, "README.md"), "utf8")).toContain("seasons/03: no reply on either side; skipped.");

    const bad = pack(["--sample", "elsewhere/01", "--review", review]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('--sample "elsewhere/01": no root named elsewhere');
  }, 60_000);

  it("makes the typography some models lean on plain", () => {
    expect(plainText("20‑mile run at 9 km")).toBe("20-mile run at 9 km");
  });
});

describe("review scores join", () => {
  const report = () => readFileSync(path.join(seasons, "report.md"), "utf8");
  const results = () => {
    const text = report();
    return text.slice(text.indexOf("## Review results"), text.indexOf(`## ${BASELINE}`));
  };

  /** Scores for every pair: baseline 3s; candidate 4s and preferred, except on two pairs where it scores 2s. */
  function fill(dir: string, worse: string[]) {
    const key = readJson(path.join(dir, "key.json"));
    const template = readJson(path.join(dir, "scores.template.json"));
    for (const [id, p] of Object.entries(key.pairs) as Array<[string, { A: string }]>) {
      const candidate = p.A === BASELINE ? "B" : "A";
      const baseline = candidate === "A" ? "B" : "A";
      const score = worse.includes(id) ? 2 : 4;
      for (const item of Object.keys(template.pairs[id].A)) {
        template.pairs[id][candidate][item] = score;
        template.pairs[id][baseline][item] = 3;
      }
      template.pairs[id].preference = worse.includes(id) ? baseline : candidate;
      template.pairs[id].notes = worse.includes(id) ? `worse on ${id}` : "";
    }
    writeFileSync(path.join(dir, "scores.json"), JSON.stringify(template, null, 2));
    return template;
  }

  it("joins a filled scores.json to the key: means, preference rate and the largest margins quoted", () => {
    const dir = path.join(bench, "review", CANDIDATE);
    fill(dir, ["snapshot-06", "seasons-09"]);
    const run = replay(["--report-only", "--out", seasons]);
    expect(run.stderr).not.toMatch(/Error:|at .*\.ts:\d+/);
    const text = results();
    expect(text).toContain(`### ${CANDIDATE} against ${BASELINE}`);
    expect(text).toContain("Seed 7, 8 pairs: 8 fully scored, 0 partly scored, 0 not scored.");
    expect(text).toContain("| Reads the week correctly | 3.00 | 3.50 | 8, 8 |");
    expect(text).toContain("| Clear and concise | 3.00 | 3.50 | 8, 8 |");
    expect(text).toContain("Preference over 8 pairs: candidate 6 (75%), baseline 2 (25%), tie 0 (0%).");
    const ahead = text.slice(text.indexOf("candidate ahead"), text.indexOf("baseline ahead"));
    expect(ahead.match(/^- \S+ \(/gm)).toHaveLength(2);
    expect(ahead).toMatch(/candidate 20, baseline 15 \(\+5\)/);
    const behind = text.slice(text.indexOf("baseline ahead"));
    expect(behind).toContain('- snapshot-06 (injury-flag week');
    expect(behind).toContain('candidate 10, baseline 15 (-5). Reviewer: "worse on snapshot-06"');
    expect(behind).toContain('- seasons-09 (10k season, week 3 (mid-season)): candidate 10, baseline 15 (-5).');
    expect(behind).toMatch(/ {2}- Candidate: "\(no usable reply: prescribedWeek\.week must be an ISO week id/);
    expect(behind).toMatch(/ {2}- Baseline: "[^"(]/);
    expect(text).toContain("- seasons-09: baseline ok, candidate failed");
    // The pack without scores is reported, not fatal.
    expect(text).toContain(`### ${OTHER} against ${BASELINE}`);
    expect(text).toContain("Not scored yet: no scores.json beside the pack's 8 pairs (seed 7).");
  }, 60_000);

  it("reports partial, malformed and unreadable scores without failing", () => {
    const dir = path.join(bench, "review", CANDIDATE);
    const scores = fill(dir, []);
    for (const id of RULE_PAIRS.slice(2)) {
      for (const side of ["A", "B"]) for (const item of Object.keys(scores.pairs[id][side])) scores.pairs[id][side][item] = null;
      scores.pairs[id].preference = null;
    }
    scores.pairs["seasons-09"].A.safety = null;
    scores.pairs["seasons-09"].A.readsWeek = 7;
    scores.pairs["seasons-02"].preference = "maybe";
    scores.pairs["not-a-pair"] = { A: {}, B: {}, preference: "A" };
    writeFileSync(path.join(dir, "scores.json"), JSON.stringify(scores));
    const run = replay(["--report-only", "--out", seasons]);
    expect(run.stderr).not.toMatch(/Error:|at .*\.ts:\d+/);
    const text = results();
    expect(text).toContain("Seed 7, 8 pairs: 0 fully scored, 2 partly scored, 6 not scored.");
    expect(text).toContain("| Reads the week correctly | 3.00 | 4.00 | 2, 1 |");
    expect(text).toContain("Preference over 1 pair: candidate 1 (100%)");
    expect(text).toContain("Problems in scores.json:");
    expect(text).toMatch(/seasons-09 [AB] readsWeek: 7 is not a whole number from 1 to 5; ignored\./);
    expect(text).toContain('seasons-02 preference: "maybe" is not "A", "B" or "tie"; ignored.');
    expect(text).toContain("not-a-pair is scored but is not in the key; ignored.");

    const otherDir = path.join(bench, "review", OTHER);
    writeFileSync(path.join(otherDir, "scores.json"), "{ not json");
    const again = replay(["--report-only", "--out", seasons]);
    expect(again.stderr).not.toMatch(/Error:|at .*\.ts:\d+/);
    expect(results()).toMatch(/scores\.json could not be read \(.+\); no results\./);
  }, 60_000);

  it("leaves the report without a review section when there is no review folder", () => {
    const lone = mkdtempSync(path.join(tmpdir(), "replay-review-lone-"));
    const root = path.join(lone, "seasons");
    mkdirSync(root);
    const run = replay(["--packets", path.join(api, "tests/fixtures/replay-packets"), "--dry-run", "--out", root]);
    expect(run.status).toBe(0);
    expect(readFileSync(path.join(root, "report.md"), "utf8")).not.toContain("## Review results");
  }, 60_000);
});
