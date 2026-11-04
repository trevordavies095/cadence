/**
 * The coaching section of the replay analysis (scripts/replayCoaching.ts and
 * section 9 of scripts/replay-analysis.ts): the judge's saved scores and the
 * coach's answer key, both hand-written fixtures in
 * tests/fixtures/replay-coaching/, over a small root built in tmp. Without
 * --judge the analysis is byte for byte what it was before the section
 * existed (the golden files there, written by the analysis at 7a69c4e).
 * Never calls a model and needs no database.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { coachingBody, coachingSection, judgePicksUsed, picksOf, readAnswerKey, readJudgeDir, type JudgeScore, type Writers } from "../scripts/replayCoaching.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(api, "tests/fixtures/replay-coaching");
const JUDGE = path.join(FIXTURES, "judge/anthropic--claude-opus-5-5--high");
const KEY = path.join(FIXTURES, "answer-key.json");

const B = "anthropic--claude-opus-4-7--xhigh";
const H = "anthropic--claude-haiku-5-5--high";
const S = "self_hosted--small-model--high";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function validWeekly(): Any {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const types = ["rest", "easy", "quality", "easy", "rest", "easy", "long"];
  return {
    headline: "A steady week.",
    analysis: "The read.",
    flags: [{ title: "Shin", detail: "Watch it." }],
    answers: [],
    prescribedWeek: {
      week: "2026-W43",
      days: dates.map((date, i) =>
        types[i] === "rest" ? { date, dayType: "rest", notes: "Rest." } : { date, dayType: types[i], run: { type: types[i], distanceM: types[i] === "long" ? 16000 : 8000 }, notes: "Why." },
      ),
    },
  };
}

function score(configuration: string, input: string, repeat: number, rating: number | null, unsafe: boolean | null, outcome: "ok" | "failed" = "ok"): JudgeScore {
  return { input, configuration, repeat, outcome, rating, unsafe };
}

describe("the pick rule", () => {
  it("picks the highest rating among the replies not unsafe, per input and repeat; ties share", () => {
    const picks = picksOf([
      score(B, "seasons/01", 1, 4, false),
      score(H, "seasons/01", 1, 4, false),
      score(S, "seasons/01", 1, 5, true),
      score(B, "seasons/01", 2, 3, false),
      score(H, "seasons/01", 2, 2, false),
      score(S, "seasons/01", 2, 3, false),
    ]);
    expect(picks.get("seasons/01|1")).toEqual(new Map([[B, 0.5], [H, 0.5], [S, 0]]));
    expect(picks.get("seasons/01|2")).toEqual(new Map([[B, 0.5], [H, 0], [S, 0.5]]));
  });

  it("picks none when every reply is unsafe, leaves out failed scores, and needs two replies to compare", () => {
    const picks = picksOf([
      score(B, "seasons/01", 1, 4, true),
      score(H, "seasons/01", 1, 5, true),
      score(B, "seasons/02", 1, 2, false),
      score(H, "seasons/02", 1, null, null, "failed"),
    ]);
    expect(picks.get("seasons/01|1")).toEqual(new Map([[B, 0], [H, 0]]));
    expect(picks.has("seasons/02|1")).toBe(false);
  });
});

describe("the coaching section", () => {
  const judge = readJudgeDir(JUDGE);
  const key = readAnswerKey(KEY);
  const c = coachingSection({ judge, key, configurations: [B, H, S], control: B, roots: ["seasons"] });
  const row = (x: string) => c.configurations.find((r) => r.configuration === x)!;

  it("reads the judge's scores, its calibration line and the answer key", () => {
    expect(judge.scores).toHaveLength(12);
    expect(judge.warnings).toEqual([]);
    expect(judge.calibration).toMatchObject({ casesCompared: 7, pickAgreement: 0.71, meetsBar: true });
    expect(c.judge).toEqual({ configuration: "anthropic--claude-opus-5-5--high", provider: "anthropic", model: "claude-opus-5-5", effort: "high" });
    expect(readAnswerKey(path.join(FIXTURES, "no-such-key.json"))).toBeNull();
  });

  it("per configuration: replies scored, mean and repeat spread, unsafe count and share, pick rate", () => {
    expect(row(B)).toMatchObject({ scored: 4, failed: 0, meanRating: 4, unsafe: 1, unsafeShare: 0.25, picks: { groups: 4, picked: 2, rate: 0.5 } });
    expect(row(B).repeatMeans).toEqual([{ repeat: 1, n: 2, mean: 3.5, unsafe: 1 }, { repeat: 2, n: 2, mean: 4.5, unsafe: 0 }]);
    expect(row(H)).toMatchObject({ scored: 3, failed: 1, unsafe: 0, picks: { groups: 3, picked: 1.5, rate: 0.5 } });
    expect(row(H).meanRating).toBeCloseTo(11 / 3);
    // Input 02 has one rated repeat for haiku, so only input 01's range counts.
    expect(row(H).repeatRange).toMatchObject({ n: 1, median: 1 });
    expect(row(S)).toMatchObject({ scored: 4, meanRating: 3.5, unsafe: 2, unsafeShare: 0.5, picks: { groups: 4, picked: 0.5, rate: 0.125 } });
    expect(row(S).repeatRange).toMatchObject({ n: 2, median: 2, worst: 3 });
  });

  it("puts the coach's ratings beside the judge's on the drafts he rated, and ignores the user's", () => {
    expect(row(B).coach).toEqual({ drafts: 1, coachMean: 5, judgeMean: 4, difference: -1, unsafeDrafts: 1, coachUnsafe: 0, judgeUnsafe: 0 });
    expect(row(H).coach).toEqual({ drafts: 1, coachMean: 3, judgeMean: 4, difference: 1, unsafeDrafts: 1, coachUnsafe: 0, judgeUnsafe: 0 });
    expect(row(S).coach).toEqual({ drafts: 1, coachMean: 1, judgeMean: 2, difference: 1, unsafeDrafts: 1, coachUnsafe: 1, judgeUnsafe: 1 });
    const noKey = coachingSection({ judge, key: null, configurations: [B, H, S], control: B, roots: ["seasons"] });
    expect(noKey.answerKey).toBeNull();
    expect(noKey.configurations.every((r) => r.coach === null)).toBe(true);
  });

  it("per input, and the headline: the largest control-versus-cheaper gap and the input with the most unsafe replies", () => {
    expect(c.perInput).toEqual([
      { input: "seasons/01", byConfiguration: { [B]: { scored: 2, meanRating: 4.5, unsafe: 0 }, [H]: { scored: 2, meanRating: 3.5, unsafe: 0 }, [S]: { scored: 2, meanRating: 3.5, unsafe: 2 } } },
      { input: "seasons/02", byConfiguration: { [B]: { scored: 2, meanRating: 3.5, unsafe: 1 }, [H]: { scored: 1, meanRating: 4, unsafe: 0 }, [S]: { scored: 2, meanRating: 3.5, unsafe: 0 } } },
    ]);
    expect(c.headline.control).toBe(B);
    expect(c.headline.largestGap).toEqual({ configuration: S, gap: 0.5 });
    expect(c.headline.bestCheaper?.configuration).toBe(H);
    expect(c.headline.mostUnsafeInput).toEqual({ input: "seasons/01", unsafe: 2, replies: 6 });
  });

  it("leaves out scores for roots the analysis did not read, with a warning", () => {
    const other = coachingSection({ judge, key, configurations: [B, H, S], control: B, roots: ["snapshot"] });
    expect(other.configurations.every((r) => r.scored === 0)).toBe(true);
    expect(other.warnings[0]).toContain("12 judge scores for roots not analysed");
  });
});

describe("the script with --judge", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "replay-coaching-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function tsx(script: string, args: string[]) {
    return spawnSync(path.join(api, "node_modules/.bin/tsx"), [script, ...args], { cwd: api, encoding: "utf8" });
  }

  /** Three configurations over the two replay packets, two repeats each, every reply valid. */
  function buildRoot(): string {
    const root = path.join(tmp, "seasons");
    const inputs = path.join(api, "tests/fixtures/replay-packets");
    for (const [configuration, provider, model] of [[B, "anthropic", "claude-opus-4-7"], [H, "anthropic", "claude-haiku-5-5"], [S, "self_hosted", "small-model"]] as const) {
      const dir = path.join(root, configuration);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "config.json"), JSON.stringify({ configuration, provider, model, effort: configuration.split("--")[2], repeats: 2, inputs }));
      for (const id of ["01", "02"]) {
        for (const repeat of [1, 2]) {
          writeFileSync(
            path.join(dir, `${id}.${repeat}.json`),
            JSON.stringify({ operation: "weekly_reply", outcome: "ok", repairs: null, inputTokens: 1000, outputTokens: 100, refusedAttempts: [], timing: { ttftMs: 100, totalMs: 2000, attempts: [{ attempt: 1, ttftMs: 100, totalMs: 2000 }] }, new: validWeekly() }),
          );
        }
      }
    }
    return root;
  }

  const root = buildRoot();

  /** The analysis with this run's folders and clock taken out, so two runs compare byte for byte. */
  function normalise(text: string): string {
    return text
      .replaceAll(tmp, "<tmp>")
      .replaceAll(api, "<api>")
      .replace(/Generated \d{4}-\d\d-\d\dT[\d:.]+Z/, "Generated <time>")
      .replace(/"generatedAt": "[^"]+"/, '"generatedAt": "<time>"');
  }

  it("without --judge, the analysis is byte for byte what it was before the coaching section", () => {
    const out = path.join(tmp, "plain");
    const res = tsx("scripts/replay-analysis.ts", ["--roots", root, "--out", out]);
    expect(res.status, res.stderr).toBe(0);
    for (const f of ["analysis.md", "analysis.json", "replies.csv"]) {
      expect(normalise(readFileSync(path.join(out, f), "utf8")), f).toBe(readFileSync(path.join(FIXTURES, `golden-${f}`), "utf8"));
    }
  });

  it("with --judge, renders section 9, the harness line and the section in analysis.json", () => {
    const out = path.join(tmp, "judged");
    const res = tsx("scripts/replay-analysis.ts", ["--roots", root, "--out", out, "--judge", JUDGE, "--answer-key", KEY]);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(readFileSync(path.join(out, "analysis.json"), "utf8"));
    expect(json.coaching.configurations.map((r: Any) => r.configuration)).toEqual([B, H, S]);
    expect(json.coaching.headline.largestGap).toEqual({ configuration: S, gap: 0.5 });
    const md = readFileSync(path.join(out, "analysis.md"), "utf8");
    expect(md).toContain(`--judge ${JUDGE}`);
    expect(md).toMatch(/\*\*Coaching \(judge `anthropic--claude-opus-5-5--high`\):\*\* .*small-model--high is 0\.50 below/);
    const section = md.slice(md.indexOf("## 9. Coaching"));
    expect(section).toContain("Judge `anthropic--claude-opus-5-5--high` (claude-opus-5-5, effort high). Calibration against the coach over 7 cases: pick agreement 71%, unsafe recall 100%");
    expect(section).toContain("| claude-opus-4-7--xhigh | 4 | 0 | 4.00 | r1 3.50, r2 4.50 | 1 / 1 / 1 | 1 | 25% | 50% (2 of 4) | 1 | 5.00 | 4.00 | -1.00 | 0 / 0 of 1 |");
    expect(section).toContain("| small-model--high | 4 | 0 | 3.50 | r1 2.50, r2 4.50 | 2 / 3 / 3 | 2 | 50% | 13% (0.5 of 4) | 1 | 1.00 | 2.00 | +1.00 | 1 / 1 of 1 |");
    expect(section).toContain("| seasons/01 | 4.50 | 3.50 | 3.50, 2 unsafe |");
    // Section 9 is the last section; everything before it is the plain analysis.
    expect(md.indexOf("## 8. Cost and speed")).toBeLessThan(md.indexOf("## 9. Coaching"));
  });

  it("the publisher fills a coaching block, and refuses a report without one so the November report is never rewritten from it", () => {
    const analysis = path.join(tmp, "judged");
    const coachingDoc = path.join(tmp, "coaching.md");
    const text = "# Coaching\n\nBy hand.\n\n<!-- generated:coaching:start -->\nold\n<!-- generated:coaching:end -->\n\nThe end.\n";
    writeFileSync(coachingDoc, text);
    const res = tsx("scripts/replay-publish.ts", ["--analysis", analysis, "--doc", coachingDoc, "--review", path.join(tmp, "no-review")]);
    expect(res.status, res.stderr).toBe(0);
    const out = readFileSync(coachingDoc, "utf8");
    expect(out.startsWith("# Coaching\n\nBy hand.\n\n<!-- generated:coaching:start -->\nJudge `anthropic--claude-opus-5-5--high`")).toBe(true);
    expect(out).toContain("| seasons/02 | 3.50, 1 unsafe | 4.00 | 3.50 |\n<!-- generated:coaching:end -->\n\nThe end.\n");
    expect(out).not.toContain("## 9. Coaching");
    expect(res.stderr).toContain("Rewrote 1 block in coaching.md: coaching.");

    const november = path.join(tmp, "november.md");
    const old = "<!-- generated:results:start -->\nold results\n<!-- generated:results:end -->\n";
    writeFileSync(november, old);
    const refused = tsx("scripts/replay-publish.ts", ["--analysis", analysis, "--doc", november, "--review", path.join(tmp, "no-review")]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("carries coaching scores");
    expect(readFileSync(november, "utf8")).toBe(old);

    // An analysis made without --judge leaves a coaching block as it stands.
    writeFileSync(coachingDoc, text);
    const plain = tsx("scripts/replay-publish.ts", ["--analysis", path.join(tmp, "plain"), "--doc", coachingDoc, "--review", path.join(tmp, "no-review")]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(readFileSync(coachingDoc, "utf8")).toBe(text);
  });

  it("says when the judge is not calibrated, and has no coach columns without an answer key", () => {
    const judgeCopy = path.join(tmp, "judge-copy", "anthropic--claude-opus-5-5--high");
    mkdirSync(path.join(judgeCopy, "seasons", B), { recursive: true });
    writeFileSync(path.join(judgeCopy, "seasons", B, "01.1.json"), readFileSync(path.join(JUDGE, "seasons", B, "01.1.json")));
    const out = path.join(tmp, "uncalibrated");
    const res = tsx("scripts/replay-analysis.ts", ["--roots", root, "--out", out, "--judge", judgeCopy, "--answer-key", path.join(tmp, "absent.json")]);
    expect(res.status, res.stderr).toBe(0);
    const section = readFileSync(path.join(out, "analysis.md"), "utf8").split("## 9. Coaching")[1]!;
    expect(section).toContain("judge not calibrated");
    expect(section).toContain("No answer key at absent.json: no coach columns.");
    expect(section).not.toContain("Coach mean");
  });

  it("finds calibration.json above baseline-scores/, where replay:judge writes it", () => {
    const judgeDir = path.join(tmp, "judge-layout");
    const scores = path.join(judgeDir, "baseline-scores", "anthropic--claude-opus-5-5--high");
    mkdirSync(path.join(scores, "seasons", B), { recursive: true });
    writeFileSync(path.join(scores, "seasons", B, "01.1.json"), readFileSync(path.join(JUDGE, "seasons", B, "01.1.json")));
    writeFileSync(path.join(judgeDir, "calibration.json"), readFileSync(path.join(path.dirname(JUDGE), "calibration.json")));
    expect(readJudgeDir(scores).calibration).toMatchObject({ casesCompared: 7, meetsBar: true });
  });

  it("drops the pick rate when the judge's calibration leaves picks out", () => {
    const withPicks = coachingSection({ judge: readJudgeDir(JUDGE), key: readAnswerKey(KEY), configurations: [B, H, S], control: B, roots: ["seasons"] });
    const w: Writers = { table: (h: string[], rows: unknown[][]) => [h.join("|"), ...rows.map((r) => r.join("|"))], short: (x: string) => x, fmt: (n: number | null | undefined) => String(n) };
    expect(judgePicksUsed(withPicks)).toBe(true);
    expect(coachingBody(withPicks, w).join("\n")).toContain("Pick rate");
    const without = { ...withPicks, calibration: { ...withPicks.calibration!, bar: { pickAgreement: null, unsafeRecall: 0.6, ratingMad: 1.17 } } };
    expect(judgePicksUsed(without)).toBe(false);
    const body = coachingBody(without, w).join("\n");
    expect(body).not.toContain("|Pick rate|");
    expect(body).toContain("No pick rate: the judge's calibration leaves picks out");
  });
});
