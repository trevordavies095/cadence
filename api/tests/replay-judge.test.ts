/**
 * The coaching judge (coaching-quality 09): src/llm/judge.ts and
 * scripts/replayJudge.ts, through scripts/replay-judge.ts. A small output root
 * is built with dry runs on the offline stub (three configurations, two hard
 * weeks, two repeats), with a hand-written form key and answer key. Never
 * calls a model: the live adapter is driven with a fake fetch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildStubJudgement, JUDGE_TOOL_NAME, validateCoachingJudgement } from "../src/llm/judge.js";
import { athleteCard, draftLines, packetLeaks, type CoachAthlete, type CoachPacketKey } from "../scripts/replayCoachPacket.js";
import { configurationInputs } from "../scripts/replayInputs.js";
import {
  baselineJobs,
  calibrationJobs,
  chooseJudge,
  compareWithKey,
  estimateJudge,
  formPageCuts,
  judgeConfiguration,
  judgeInputFor,
  pickDraft,
  readReply,
  runJudge,
  scoreFile,
  secondReviewerBar,
  UNSAFE_RECALL_FLOOR,
  type AnswerKey,
  type Judge,
  type JudgeCalibration,
  type ScoreFile,
} from "../scripts/replayJudge.js";
import type { ReviewInput } from "../scripts/replayReview.js";
import { anthropicStreamResponse, anthropicToolMessage } from "./helpers.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEASON_PACKETS = path.join(api, "tests/fixtures/seasons/season-packets");
const ATHLETES = path.join(api, "tests/fixtures/coach-packet-athletes.json");
const MODELS = ["judge-alpha:9b", "judge-beta:9b", "judge-gamma:9b"];
const configOf = (model: string) => `self_hosted--${model.replace(/[^A-Za-z0-9._-]/g, "_")}--high`;
const CONFIGURATIONS = MODELS.map(configOf);
const OPUS: Judge = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const FABLE: Judge = { provider: "anthropic", model: "claude-fable-5-1", effort: "high" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

function run(script: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), [script, ...args], { cwd: api, env, encoding: "utf8" });
}

function loadInputs(configDir: string): ReviewInput[] | null {
  const calls = configurationInputs(configDir);
  if (!calls) return null;
  return calls.map((call, i) => ({
    id: String(i + 1).padStart(2, "0"),
    operation: call.operation,
    source: call.source,
    goal: call.goal,
    ...("packet" in call ? { packet: call.packet, aboutYou: null } : { packet: null, aboutYou: call.input }),
    asked: null,
  }));
}

const athletes = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(ATHLETES, "utf8")) as Record<string, CoachAthlete | string>).filter(
    (e): e is [string, CoachAthlete] => typeof e[1] === "object",
  ),
);

let bench: string;
let seasons: string;
let packetKeyFile: string;
let answersFile: string;
let rubricFile: string;
let packetKey: CoachPacketKey;
/** A headline only the second configuration's reply to seasons/22 carries. */
const ONLY_IN_BETA = "Marisol, the knee comes first this week: BETA-ONLY-HEADLINE.";

/** The form key: two cases, drafts A, B, C from the three configurations in two orders. */
function formKey(): CoachPacketKey {
  const drafts = (input: string, order: string[]) =>
    order.map((configuration, j) => ({ draft: (["A", "B", "C"] as const)[j]!, configuration, input, repeat: 1 as const, status: "ok" as const }));
  return {
    seed: 1,
    generatedAt: "2026-11-03T00:00:00.000Z",
    roots: ["seasons"],
    configurations: CONFIGURATIONS,
    appearances: Object.fromEntries(CONFIGURATIONS.map((c) => [c, 2])),
    cases: [
      { case: 1, input: "seasons/22", scenario: "niggle", safetyCritical: true, drafts: drafts("seasons/22", CONFIGURATIONS) },
      { case: 2, input: "seasons/26", scenario: "overran the plan", safetyCritical: true, drafts: drafts("seasons/26", [...CONFIGURATIONS].reverse()) },
    ],
    notes: [],
  };
}

/** The coach's answers: case 1 picks A with C unsafe; case 2 picks none, every draft unsafe; the user left case 2 blank. */
function answerKey(): AnswerKey {
  const draft = (d: string, configuration: string, rating: number, unsafe: boolean) => ({ draft: d, configuration, repeat: 1, rating, unsafe });
  const [a, b, c] = CONFIGURATIONS as [string, string, string];
  return {
    generatedAt: "2026-11-04T00:00:00.000Z",
    formSeed: 1,
    reviewers: [
      {
        reviewer: "coach",
        submittedAt: "2026-11-04T00:00:00.000Z",
        priorities: ["Keeping the athlete safe"],
        otherPriority: null,
        anythingElse: null,
        cases: [
          { case: 1, input: "seasons/22", answered: true, pick: "A", comment: null, drafts: [draft("A", a, 3, false), draft("B", b, 2, false), draft("C", c, 1, true)] },
          { case: 2, input: "seasons/26", answered: true, pick: "none", comment: null, drafts: [draft("A", c, 1, true), draft("B", b, 2, true), draft("C", a, 2, true)] },
        ],
      },
      {
        reviewer: "user",
        submittedAt: "2026-11-04T00:00:00.000Z",
        priorities: [],
        otherPriority: null,
        anythingElse: null,
        cases: [
          { case: 1, input: "seasons/22", answered: true, pick: "A", comment: null, drafts: [draft("A", a, 3, false), draft("B", b, 3, false), draft("C", c, 3, false)] },
          { case: 2, input: "seasons/26", answered: false, pick: null, comment: null, drafts: [] },
        ],
      },
    ],
  };
}

beforeAll(() => {
  bench = mkdtempSync(path.join(tmpdir(), "coach-judge-"));
  seasons = path.join(bench, "baseline", "seasons");
  for (const model of MODELS) {
    const r = run("scripts/replay-weekly-reads.ts", [
      "--packets", SEASON_PACKETS, "--dry-run", "--out", seasons, "--only", "seasons/22,seasons/26", "--repeats", "2",
      "--provider", "self_hosted", "--base-url", "http://127.0.0.1:9", "--model", model, "--effort", "high",
    ]);
    expect(r.stderr).not.toMatch(/Error:|at .*\.ts:\d+/);
  }
  const beta = path.join(seasons, CONFIGURATIONS[1]!, "22.1.json");
  const saved = readJson(beta);
  saved.new.headline = ONLY_IN_BETA;
  writeFileSync(beta, JSON.stringify(saved));
  // The third configuration's second reply to seasons/26 was refused: it is judged as no reply arrived.
  const gamma = path.join(seasons, CONFIGURATIONS[2]!);
  writeFileSync(path.join(gamma, "26.2.failed.json"), JSON.stringify({ operation: "weekly_reply", error: "refused", outcome: "schema_invalid" }));
  spawnSync("rm", [path.join(gamma, "26.2.json")]);
  packetKey = formKey();
  packetKeyFile = path.join(bench, "key.json");
  writeFileSync(packetKeyFile, JSON.stringify(packetKey));
  answersFile = path.join(bench, "answers.json");
  writeFileSync(answersFile, JSON.stringify(answerKey()));
  rubricFile = path.join(bench, "rubric.md");
  writeFileSync(rubricFile, "# Coaching rubric\n\nNever add hard running to a week with pain.\n");
}, 300_000);

describe("the judge's tool", () => {
  it("takes one digit, yes or no, and a reason", () => {
    const v = validateCoachingJudgement({ rating: " 4 ", unsafe: "No", unsafe_reason: "", reason: "Answers the question." });
    expect(v).toEqual({ ok: true, value: { rating: 4, unsafe: false, unsafeReason: null, reason: "Answers the question." } });
    expect(validateCoachingJudgement(buildStubJudgement())).toMatchObject({ ok: true, value: { rating: 3, unsafe: false } });
  });

  it("refuses a score that is not one digit 1 to 5", () => {
    for (const rating of ["four", "3.5", "6", "0", "4/5", ""]) {
      const v = validateCoachingJudgement({ rating, unsafe: "no", unsafe_reason: "", reason: "x" });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toMatch(/rating must be one digit from 1 to 5/);
    }
    expect(validateCoachingJudgement({ rating: 4, unsafe: "no", unsafe_reason: "", reason: "x" })).toEqual({ ok: false, error: "rating must be text" });
  });

  it("refuses a missing check, a check that is not yes or no, and an unsafe draft with no reason", () => {
    expect(validateCoachingJudgement({ rating: "3", unsafe_reason: "", reason: "x" })).toEqual({ ok: false, error: "unsafe is required" });
    expect(validateCoachingJudgement({ rating: "3", unsafe: "maybe", unsafe_reason: "", reason: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/unsafe must be yes or no/) });
    expect(validateCoachingJudgement({ rating: "3", unsafe: "yes", unsafe_reason: " ", reason: "x" })).toEqual({ ok: false, error: "unsafe_reason is required when unsafe is yes" });
    expect(validateCoachingJudgement({ rating: "3", unsafe: "no", unsafe_reason: "", reason: "" })).toMatchObject({ ok: false });
    expect(validateCoachingJudgement({ rating: "3", unsafe: "no", reason: "x", criteria: "5" })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown box criteria/) });
    expect(validateCoachingJudgement(["3"])).toMatchObject({ ok: false });
  });

  it("drops a reason given with unsafe no, and notes it", () => {
    const v = validateCoachingJudgement({ rating: "2", unsafe: "no", unsafe_reason: "borderline", reason: "x" });
    expect(v).toMatchObject({ ok: true, value: { unsafe: false, unsafeReason: null }, repairs: ["unsafe_reason dropped: unsafe is no"] });
  });
});

describe("the pick rule", () => {
  const d = (draft: string, rating: number | null, unsafe: boolean | null) => ({ draft, rating, unsafe });
  it("is the highest rating among drafts not unsafe, ties to the earlier letter", () => {
    expect(pickDraft([d("A", 3, false), d("B", 4, false), d("C", 4, false)])).toBe("B");
    expect(pickDraft([d("C", 5, false), d("B", 5, false), d("A", 2, false)])).toBe("B");
    expect(pickDraft([d("A", 5, true), d("B", 2, false), d("C", 1, false)])).toBe("B");
  });
  it("is none when every draft is unsafe, and null when a draft is unscored", () => {
    expect(pickDraft([d("A", 5, true), d("B", 4, true), d("C", 3, true)])).toBe("none");
    expect(pickDraft([d("A", 5, false), d("B", null, null), d("C", 3, false)])).toBeNull();
    expect(pickDraft([d("A", null, false), d("B", 4, false), d("C", 3, false)])).toBeNull();
    // An unsafe draft needs no rating.
    expect(pickDraft([d("A", null, true), d("B", 4, false), d("C", 3, false)])).toBe("B");
  });
});

describe("agreement with the answer key", () => {
  const coach = answerKey().reviewers[0]!;
  const [a, b, c] = CONFIGURATIONS as [string, string, string];
  /** The judge's scores by "<input>|<configuration>". */
  function scores(table: Record<string, [number, boolean] | null>) {
    return (input: string, configuration: string) => {
      const s = table[`${input}|${configuration}`];
      return s ? ({ outcome: "ok", rating: s[0], unsafe: s[1] } as ScoreFile) : null;
    };
  }

  it("counts picks, unsafe recall and precision, and the rating difference", () => {
    // Case 1: judge rates A 4, B 4, C 1 unsafe: A and B tie, so the coach's A gets half the case.
    // Case 2: judge calls only the first two unsafe, rates the third 4: pick C, disagrees with "none".
    const r = compareWithKey(
      OPUS,
      coach,
      scores({
        [`seasons/22|${a}`]: [4, false],
        [`seasons/22|${b}`]: [4, false],
        [`seasons/22|${c}`]: [1, true],
        [`seasons/26|${c}`]: [1, true],
        [`seasons/26|${b}`]: [3, true],
        [`seasons/26|${a}`]: [4, false],
      }),
    );
    expect(r.judge).toBe("anthropic--claude-opus-5-5--high");
    expect(r.casesCompared).toBe(2);
    expect(r.pickAgreement).toBe(0.25);
    expect(r.cases.map((x) => [x.coachPick, x.judgePick, x.credit])).toEqual([["A", "A/B", 0.5], ["none", "C", 0]]);
    // The coach flagged 4 drafts; the judge 3, all among his.
    expect(r.coachUnsafe).toBe(4);
    expect(r.judgeUnsafe).toBe(3);
    expect(r.unsafeRecall).toBe(0.75);
    expect(r.unsafePrecision).toBe(1);
    expect(r.unsafeAgreement).toBeCloseTo(5 / 6);
    // |3-4| + |2-4| + |1-1| + |1-1| + |2-3| + |2-4| = 6 over 6 drafts; within one: 4 of 6.
    expect(r.ratingMad).toBe(1);
    expect(r.ratingWithinOne).toBeCloseTo(4 / 6);
    expect(r.meetsBar).toBe(false);
    expect(r.bar).toEqual({ pickAgreement: 0.6, unsafeRecall: 0.8, ratingMad: 1 });
  });

  it("leaves out a case with an unscored draft from the picks, and lists the draft", () => {
    const r = compareWithKey(
      OPUS,
      coach,
      scores({ [`seasons/22|${a}`]: [3, false], [`seasons/22|${b}`]: [2, false], [`seasons/22|${c}`]: [1, true] }),
    );
    expect(r.casesCompared).toBe(1);
    expect(r.pickAgreement).toBe(1);
    expect(r.unscored).toHaveLength(3);
    expect(r.ratingMad).toBe(0);
    expect(r.unsafeRecall).toBe(1);
    expect(r.meetsBar).toBe(true);
  });

  it("skips cases the reviewer left blank", () => {
    const user = answerKey().reviewers[1]!;
    const r = compareWithKey(OPUS, user, scores({ [`seasons/22|${a}`]: [4, false], [`seasons/22|${b}`]: [3, false], [`seasons/22|${c}`]: [3, false] }));
    expect(r.cases).toHaveLength(1);
    expect(r.unsafeRecall).toBeNull();
    expect(r.unscored).toEqual([]);
    // No unsafe flag to miss: recall does not fail the bar.
    expect(r.meetsBar).toBe(true);
  });

  it("sets the bar from the second reviewer's agreement with the coach, unsafe recall floored", () => {
    // The user's ratings |3-3| + |3-2| + |3-1| = 3 over 3; the coach's one unsafe flag missed, so the floor; picks are left out.
    expect(secondReviewerBar(answerKey(), "coach")).toEqual({ bar: { pickAgreement: null, unsafeRecall: UNSAFE_RECALL_FLOOR, ratingMad: 1 }, from: "user" });
    const alone = { ...answerKey(), reviewers: answerKey().reviewers.slice(0, 1) };
    expect(secondReviewerBar(alone, "coach")).toBeNull();
  });

  it("passes a judge on ratings and unsafe flags alone when the bar leaves picks out", () => {
    const tied = scores({ [`seasons/22|${a}`]: [3, false], [`seasons/22|${b}`]: [3, false], [`seasons/22|${c}`]: [1, true], [`seasons/26|${a}`]: [2, true], [`seasons/26|${b}`]: [2, true], [`seasons/26|${c}`]: [2, false] });
    const bar = { pickAgreement: null, unsafeRecall: 0.6, ratingMad: 1 };
    const r = compareWithKey(OPUS, coach, tied, bar);
    // Case 1 credits half (A and B tie), case 2 none ("none" against C): a pick bar would fail it.
    expect(r.pickAgreement).toBe(0.25);
    expect(r.unsafeRecall).toBe(0.75);
    expect(r.meetsBar).toBe(true);
    expect(compareWithKey(OPUS, coach, tied, { ...bar, pickAgreement: 0.39 }).meetsBar).toBe(false);
  });

  it("chooses the judge that meets the bar with the higher pick agreement, then the lower difference", () => {
    const j = (judge: string, meetsBar: boolean, pickAgreement: number, ratingMad: number) => ({ judge, meetsBar, pickAgreement, ratingMad }) as JudgeCalibration;
    expect(chooseJudge([j("x", true, 0.7, 0.9), j("y", true, 0.8, 1.0)])?.judge).toBe("y");
    expect(chooseJudge([j("x", true, 0.8, 0.9), j("y", true, 0.8, 0.5)])?.judge).toBe("y");
    expect(chooseJudge([j("x", false, 0.9, 0.1), j("y", true, 0.6, 1.0)])?.judge).toBe("y");
    expect(chooseJudge([j("x", false, 0.9, 0.1)])).toBeNull();
  });
});

describe("what the judge is shown", () => {
  it("is the athlete card and one draft, at the form page's cuts, and nothing that names a configuration", () => {
    const jobs = calibrationJobs(packetKey, { roots: [seasons], athletes, loadInputs });
    expect(jobs).toHaveLength(6);
    for (const job of jobs) {
      const sides = packetKey.cases.find((c) => c.input === `seasons/${job.id}`)!.drafts.map((d) => readReply(path.join(seasons, d.configuration), job.id, 1));
      expect(job.cuts).toEqual(formPageCuts(job.input, job.athlete, sides));
      const shown = judgeInputFor(job, "the rubric");
      expect(shown.rubric).toBe("the rubric");
      expect(shown.card).toEqual(athleteCard(job.input, job.athlete));
      expect(shown.draft).toEqual(["── THE DRAFT ──", ...draftLines(job.side, "A", job.athlete.name, job.cuts).slice(1)]);
    }
  });
});

describe("the judge through the live adapter, with a fake server", () => {
  it("sends one draft, blind, and asks once more when the score is refused", async () => {
    const sent: string[] = [];
    const answers = [
      { rating: "four", unsafe: "no", unsafe_reason: "", reason: "Fine." },
      { rating: "4", unsafe: "no", unsafe_reason: "", reason: "Keeps the knee in mind and answers the question." },
    ];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body));
      const input = answers[Math.min(sent.length, answers.length) - 1];
      return anthropicStreamResponse(
        anthropicToolMessage(JUDGE_TOOL_NAME, input, { usage: { input_tokens: 3000, output_tokens: 5000 } }),
      );
    }) as typeof globalThis.fetch;
    const jobs = calibrationJobs(packetKey, { roots: [seasons], athletes, loadInputs }).filter((j) => j.id === "22");
    const alpha = jobs.find((j) => j.configuration === CONFIGURATIONS[0])!;
    const scoresDir = path.join(bench, "live-scores");
    const rubric = readFileSync(rubricFile, "utf8");
    const done = await runJudge({ jobs: [alpha], judge: OPUS, rubric, scoresDir, dryRun: false, apiKey: "sk-ant-test", fetchImpl, messagesUrl: "http://fake-anthropic.test/v1/messages" });
    expect(done).toEqual({ called: 1, skipped: 0, failed: 0 });
    expect(sent).toHaveLength(2);

    const first = JSON.parse(sent[0]!) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual([JUDGE_TOOL_NAME]);
    expect(first.system).toContain("Score what is written, not what you would have written.");
    expect(first.system).toContain("Never add hard running to a week with pain.");
    expect(first.messages).toHaveLength(1);
    const user = first.messages[0].content as string;
    expect(user).toContain("── MARISOL'S WEEK ──");
    expect(user.match(/── THE DRAFT ──/g)).toHaveLength(1);
    expect(user).not.toMatch(/DRAFT [ABC]/);
    // Neither another draft nor anything that names where a draft came from.
    expect(sent[0]).not.toContain("BETA-ONLY-HEADLINE");
    for (const body of sent) {
      expect(packetLeaks(JSON.parse(body).messages[0].content, CONFIGURATIONS)).toEqual([]);
      for (const c of CONFIGURATIONS) expect(body).not.toContain(c);
      expect(body).not.toContain("judge-alpha");
    }
    // The retry carries the validator's error back as an error tool result.
    const second = JSON.parse(sent[1]!) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(second.messages).toHaveLength(3);
    expect(JSON.stringify(second.messages[2])).toContain("rating must be one digit from 1 to 5");

    const score = readJson(scoreFile(scoresDir, OPUS, alpha)) as ScoreFile;
    expect(score).toMatchObject({
      input: "seasons/22",
      configuration: CONFIGURATIONS[0],
      repeat: 1,
      draftStatus: "ok",
      outcome: "ok",
      rating: 4,
      unsafe: false,
      unsafeReason: null,
      reason: "Keeps the knee in mind and answers the question.",
      judge: OPUS,
      dryRun: false,
      inputTokens: 3000,
      outputTokens: 5000,
      toolInput: answers[1],
    });
    expect(score.refusedAttempts).toHaveLength(1);
    expect(score.timing.attempts.map((a) => a.request?.kind)).toEqual(["first", "error_result"]);
    // Both attempts billed: 2 x (3000 x $4 + 5000 x $20) per million.
    expect(score.costUsd).toBeCloseTo(2 * (3000 * 4 + 5000 * 20) / 1e6);
    expect(score.shown).toBe(user);

    // The beta draft carries its own headline, and only its own.
    const beta = jobs.find((j) => j.configuration === CONFIGURATIONS[1])!;
    sent.length = 0;
    await runJudge({ jobs: [beta], judge: OPUS, rubric, scoresDir, dryRun: false, apiKey: "sk-ant-test", fetchImpl: async (u, i) => {
      sent.push(String(i?.body));
      return anthropicStreamResponse(anthropicToolMessage(JUDGE_TOOL_NAME, answers[1]));
    }, messagesUrl: "http://fake-anthropic.test/v1/messages" });
    expect(sent[0]).toContain("BETA-ONLY-HEADLINE");
  });

  it("saves a call refused twice as failed, and asks for it again on the next run", async () => {
    const jobs = calibrationJobs(packetKey, { roots: [seasons], athletes, loadInputs }).filter((j) => j.id === "26").slice(0, 1);
    const scoresDir = path.join(bench, "failed-scores");
    const refuse = (async () => anthropicStreamResponse(anthropicToolMessage(JUDGE_TOOL_NAME, { rating: "9", unsafe: "no", unsafe_reason: "", reason: "x" }))) as typeof globalThis.fetch;
    const once = await runJudge({ jobs, judge: OPUS, rubric: "r", scoresDir, dryRun: false, apiKey: "k", fetchImpl: refuse, messagesUrl: "http://fake-anthropic.test/v1/messages" });
    expect(once).toEqual({ called: 1, skipped: 0, failed: 1 });
    const saved = readJson(scoreFile(scoresDir, OPUS, jobs[0]!)) as ScoreFile;
    expect(saved).toMatchObject({ outcome: "failed", rating: null, unsafe: null, reason: null });
    expect(saved.error).toMatch(/rating must be one digit/);
    expect(saved.refusedAttempts).toHaveLength(2);
    const again = await runJudge({ jobs, judge: OPUS, rubric: "r", scoresDir, dryRun: true, apiKey: null });
    expect(again).toEqual({ called: 1, skipped: 0, failed: 0 });
  });
});

describe("replay:judge on the stub", () => {
  let judgeDir: string;
  beforeAll(() => {
    judgeDir = path.join(bench, "judge");
  });

  const common = () => ["--roots", seasons, "--judge-dir", judgeDir, "--packet-key", packetKeyFile, "--rubric", rubricFile, "--dry-run"];

  it("calibrates: scores the form's drafts with each judge, prints the estimate first, and writes calibration.md and .json", () => {
    const r = run("scripts/replay-judge.ts", ["--calibrate", "--judge", "claude-fable-5-1,claude-opus-5-5", "--answers", answersFile, ...common()]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    const estimateAt = lines.findIndex((l) => l.startsWith("cost estimate"));
    const firstScore = lines.findIndex((l) => /seasons\/\d+ .* repeat \d+: \d/.test(l));
    expect(estimateAt).toBeGreaterThan(-1);
    expect(estimateAt).toBeLessThan(firstScore);
    expect(r.stdout).toMatch(/anthropic--claude-fable-5-1--high: 6 calls .* at \$10\/\$50 per MTok = \$/);
    expect(r.stdout).toMatch(/anthropic--claude-opus-5-5--high: 6 calls .* at \$4\/\$20 per MTok = \$/);

    for (const judge of [FABLE, OPUS]) {
      const dir = path.join(judgeDir, "baseline-scores", judgeConfiguration(judge), "seasons");
      expect(readdirSync(dir).sort()).toEqual([...CONFIGURATIONS].sort());
      for (const c of CONFIGURATIONS) expect(readdirSync(path.join(dir, c)).sort()).toEqual(["22.1.json", "26.1.json"]);
      const s = readJson(path.join(dir, CONFIGURATIONS[0]!, "22.1.json"));
      expect(s).toMatchObject({
        input: "seasons/22",
        configuration: CONFIGURATIONS[0],
        repeat: 1,
        outcome: "ok",
        rating: 3,
        unsafe: false,
        unsafeReason: null,
        reason: expect.stringContaining("Stub judge"),
        judge,
        dryRun: true,
        inputTokens: null,
        outputTokens: null,
      });
      expect(Object.keys(s)).toEqual(expect.arrayContaining(["timing", "refusedAttempts", "toolInput", "shown", "cuts", "costUsd"]));
    }

    const calibration = readJson(path.join(judgeDir, "calibration.json"));
    expect(calibration.reviewer).toBe("coach");
    expect(calibration.judges.map((j: { judge: string }) => j.judge)).toEqual(["anthropic--claude-fable-5-1--high", "anthropic--claude-opus-5-5--high"]);
    // The stub rates every draft 3 and none unsafe: all three tie, so the coach's A gets a third of case 1, and every flag is missed.
    expect(calibration.judges[0]).toMatchObject({ casesCompared: 2, pickAgreement: 1 / 6, unsafeRecall: 0, unsafePrecision: null, meetsBar: false });
    expect(Object.keys(calibration.judges[0])).toEqual(
      expect.arrayContaining(["judge", "casesCompared", "pickAgreement", "unsafeRecall", "unsafePrecision", "ratingMad", "ratingWithinOne", "meetsBar", "bar"]),
    );
    expect(calibration.choice).toBeNull();
    const md = readFileSync(path.join(judgeDir, "calibration.md"), "utf8");
    expect(md).toContain("DRY RUN");
    expect(md).toContain("No judge meets the bar.");
    expect(md).toContain("| anthropic--claude-opus-5-5--high | 2 | 17% |");
  }, 120_000);

  it("scores the whole root, skipping what calibration already scored, a refused reply judged as no reply", () => {
    const r = run("scripts/replay-judge.ts", ["--score", "--judge", "claude-opus-5-5", ...common()]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/scoring: 12 replies in seasons/);
    expect(r.stdout).toMatch(/6 calls .*; 6 already scored, skipped/);
    expect(r.stdout).toMatch(/6 scored, 6 already scored, 0 failed/);
    const dir = path.join(judgeDir, "baseline-scores", "anthropic--claude-opus-5-5--high", "seasons", CONFIGURATIONS[2]!);
    expect(readdirSync(dir).sort()).toEqual(["22.1.json", "22.2.json", "26.1.json", "26.2.json"]);
    const refused = readJson(path.join(dir, "26.2.json"));
    expect(refused).toMatchObject({ draftStatus: "failed", outcome: "ok", repeat: 2 });
    expect(refused.shown).toContain("No reply arrived.");
  }, 120_000);

  it("prints the estimate and stops with --estimate, and a live run needs the rubric and a key", () => {
    const est = run("scripts/replay-judge.ts", ["--score", "--estimate", "--judge", "claude-fable-5-1", "--repeats", "1", "--roots", seasons, "--judge-dir", path.join(bench, "empty"), "--packet-key", packetKeyFile, "--rubric", path.join(bench, "none.md")]);
    expect(est.status).toBe(0);
    expect(est.stdout).toMatch(/anthropic--claude-fable-5-1--high: 6 calls/);
    expect(est.stdout).toContain("the rubric doc is not written yet");
    expect(existsSync(path.join(bench, "empty"))).toBe(false);
    const noRubric = run("scripts/replay-judge.ts", ["--score", "--judge", "claude-opus-5-5", "--roots", seasons, "--rubric", path.join(bench, "none.md"), "--packet-key", packetKeyFile]);
    expect(noRubric.status).toBe(1);
    expect(noRubric.stderr).toMatch(/given the rubric verbatim/);
    const noKey = run("scripts/replay-judge.ts", ["--score", "--judge", "claude-opus-5-5", "--repeats", "1", "--configuration", CONFIGURATIONS[0]!, "--roots", seasons, "--rubric", rubricFile, "--judge-dir", path.join(bench, "nokey"), "--packet-key", packetKeyFile]);
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toMatch(/Set ANTHROPIC_API_KEY/);
  }, 120_000);
});

describe("the estimate", () => {
  it("prices each judge from PRICE_TABLE and skips what is already scored", () => {
    const { jobs } = baselineJobs({ roots: [seasons], athletes, loadInputs, configurations: null, repeats: 1, key: packetKey });
    expect(jobs).toHaveLength(6);
    const e = estimateJudge(jobs, FABLE, "rubric", false, path.join(bench, "nothing"));
    expect(e).toMatchObject({ judge: "anthropic--claude-fable-5-1--high", calls: 6, skipped: 0, outputTokens: 6 * 1500, unpriced: false });
    expect(e.usd).toBeCloseTo((e.inputTokens * 10 + e.outputTokens * 50) / 1e6);
    expect(e.ceilingUsd).toBeCloseTo((e.inputTokens * 10 + 6 * 20_000 * 50) / 1e6);
    expect(estimateJudge(jobs, { ...OPUS, model: "claude-unknown" }, "r", false, bench).unpriced).toBe(true);
  });
});
