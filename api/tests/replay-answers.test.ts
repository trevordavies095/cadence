/**
 * The answer key (scripts/replayAnswers.ts, through scripts/replay-answers.ts):
 * the coaching review form's responses read back from a hand-written CSV in
 * the shape Google Sheets exports, over a three-case test form built with the
 * real form's questions. No real response is used.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkboxTicks,
  compare,
  comparisonDoc,
  expectedColumns,
  headerMatches,
  parseCsv,
  perConfiguration,
  readAnswers,
  rubricDoc,
  type AnswerKey,
} from "../scripts/replayAnswers.js";
import { caseQuestions, CLOSING, formScript, IF_YOU_HAVE_TIME, type CoachPacketKey, type FormPayload } from "../scripts/replayCoachPacket.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Two required cases, the "If you have time" page, one optional case and the last page, as the builder lays them out. */
const payload: FormPayload = {
  title: "Coaching review",
  description: "Test form.",
  items: [
    { kind: "text", title: "Who is filling this in?", required: true },
    { kind: "page", title: "Case 1 of 3 · Alex · marathon in 9 weeks", help: "card" },
    ...caseQuestions("Alex", true),
    { kind: "page", title: "Case 2 of 3 · Alex · marathon in 8 weeks", help: "card" },
    ...caseQuestions("Alex", true),
    { kind: "page", title: IF_YOU_HAVE_TIME, help: "optional" },
    { kind: "page", title: "Case 3 of 3 · Blair · 5K", help: "card" },
    ...caseQuestions("Blair", false),
    ...CLOSING,
  ],
};

const draft = (letter: "A" | "B" | "C", configuration: string, input: string) => ({ draft: letter, configuration, input, repeat: 1 as const, status: "ok" as const });
const key: CoachPacketKey = {
  seed: 5,
  generatedAt: "2026-11-03T00:00:00.000Z",
  roots: ["seasons"],
  configurations: ["cfg-a", "cfg-b", "cfg-c", "cfg-d"],
  appearances: { "cfg-a": 3, "cfg-b": 2, "cfg-c": 2, "cfg-d": 2 },
  cases: [
    { case: 1, input: "seasons/1", scenario: "niggle", safetyCritical: true, drafts: [draft("A", "cfg-a", "seasons/1"), draft("B", "cfg-b", "seasons/1"), draft("C", "cfg-c", "seasons/1")] },
    { case: 2, input: "seasons/2", scenario: "illness", safetyCritical: true, drafts: [draft("A", "cfg-d", "seasons/2"), draft("B", "cfg-a", "seasons/2"), draft("C", "cfg-b", "seasons/2")] },
    { case: 3, input: "seasons/3", scenario: "taper", safetyCritical: false, drafts: [draft("A", "cfg-c", "seasons/3"), draft("B", "cfg-d", "seasons/3"), draft("C", "cfg-a", "seasons/3")] },
  ],
  notes: [],
};

const NAMES = { coach: "Pat Coach", user: "Sam Runner" };

/**
 * As Sheets exports it: Timestamp, then one column per question in form order,
 * a grid as one column per row; case 2's pick and case 3's first rating carry
 * a de-duplication suffix. Rows: the coach's first try, the user, someone
 * else, then the coach again (the one that counts). The user leaves case 3
 * blank; the coach ticks a letter and "All are safe" on case 1.
 */
const HEADER = [
  "Timestamp",
  "Who is filling this in?",
  "Which draft would you send?",
  "Is any draft unsafe for Alex this week?",
  "Rate each draft, 1 (poor) to 5 (great) [A]",
  "Rate each draft, 1 (poor) to 5 (great) [B]",
  "Rate each draft, 1 (poor) to 5 (great) [C]",
  "Optional: in one line, what would you have told Alex?",
  "Which draft would you send?.1",
  "Is any draft unsafe for Alex this week?",
  "Rate each draft, 1 (poor) to 5 (great) [A]",
  "Rate each draft, 1 (poor) to 5 (great) [B]",
  "Rate each draft, 1 (poor) to 5 (great) [C]",
  "Optional: in one line, what would you have told Alex?",
  "Which draft would you send?",
  "Is any draft unsafe for Blair this week?",
  "Rate each draft, 1 (poor) to 5 (great) [A] 2",
  "Rate each draft, 1 (poor) to 5 (great) [B]",
  "Rate each draft, 1 (poor) to 5 (great) [C]",
  "Optional: in one line, what would you have told Blair?",
  "What matters most when you judge a reply? Tick up to three.",
  "Anything else we should know?",
]
  // Sheets quotes a title with a comma in it.
  .map((t) => (t.includes(",") ? `"${t}"` : t))
  .join(",");
const CSV = [
  HEADER,
  `11/3/2026 9:00:00,Pat Coach,A,All are safe,3,3,3,,A,All are safe,3,3,3,,,,,,,,,`,
  `11/3/2026 10:15:02,Sam Runner,B,All are safe,4,3,5,"Rest the knee, then ""test"" it",A,C,3,2,1,,,,,,,,"Keeping the athlete safe, Answering their question, Sleep, mostly",`,
  `11/3/2026 11:00:00,Someone Else,A,All are safe,1,1,1,,A,All are safe,1,1,1,,,,,,,,,`,
  `11/4/2026 8:30:45,  pat  coach ,C,"A, All are safe",2,3,5,"Knee first.",A,C,3,4,1,"Stay in bed.",None of them,All are safe,2,2,1,,"Keeping the athlete safe, Sensible mileage and long run","Good work.\nMore next time."`,
  "",
].join("\r\n");

const read = (csv = CSV) => readAnswers({ csv, payload, key, names: NAMES, generatedAt: "2026-11-04T12:00:00.000Z" });

describe("reading the responses", () => {
  it("parses quoted fields, doubled quotes, line breaks and CRLF, and drops blank lines", () => {
    expect(parseCsv('\uFEFFa,"b, c","d ""e"""\r\n"f\ng",,\n\n')).toEqual([
      ["a", "b, c", 'd "e"'],
      ["f\ng", "", ""],
    ]);
  });

  it("expects Timestamp and then every question in form order, a grid as one column per row", () => {
    const columns = expectedColumns(payload);
    expect(["Timestamp", ...columns.map((c) => c.title)]).toEqual(parseCsv(HEADER)[0]!.map((h) => h.replace("send?.1", "send?").replace("[A] 2", "[A]")));
    expect(columns.map((c) => c.section)).toEqual(["who", ...Array(6).fill(1), ...Array(6).fill(2), ...Array(6).fill(3), "closing", "closing"]);
  });

  it("accepts a de-duplication suffix and nothing else", () => {
    const title = "Which draft would you send?";
    for (const h of [title, `${title}.1`, `${title}_2`, `${title} 2`, `${title} (3)`]) expect(headerMatches(h, title), h).toBe(true);
    for (const h of [`${title}x`, "Which draft would you pick?", `${title} [A]`]) expect(headerMatches(h, title), h).toBe(false);
    const grid = "Rate each draft, 1 (poor) to 5 (great) [B]";
    for (const h of [grid, `${grid}.2`, "Rate each draft, 1 (poor) to 5 (great).2 [B]", "Rate each draft, 1 (poor) to 5 (great) 2 [B]"]) expect(headerMatches(h, grid), h).toBe(true);
    expect(headerMatches("Rate each draft, 1 (poor) to 5 (great) [C]", grid)).toBe(false);
  });

  it("fails loudly on the first header that is not the form's, and on a missing or extra column", () => {
    expect(() => read(CSV.replace("Is any draft unsafe for Blair this week?", "Is any draft unsafe for Alex this week?"))).toThrow(
      /CSV column 16: "Is any draft unsafe for Alex this week\?" where the form has "Is any draft unsafe for Blair this week\?"/,
    );
    expect(() => read(CSV.replace(",Anything else we should know?", ""))).toThrow(/CSV column 22: missing/);
    expect(() => read(CSV.replace("Anything else we should know?", "Anything else we should know?,Score"))).toThrow(/CSV column 23: "Score" is not on the form/);
    // A trailing empty header, as a sheet with a blank column exports, is fine.
    expect(() => read(CSV.replace("Anything else we should know?", "Anything else we should know?,"))).not.toThrow();
  });

  it("refuses a form that does not match the key", () => {
    const short: FormPayload = { ...payload, items: payload.items.filter((it) => !("title" in it && /^Case 3 /.test(it.title))) };
    expect(() => readAnswers({ csv: CSV, payload: short, key, names: NAMES })).toThrow(/cases 1, 2 and the key 1, 2, 3|the form has cases/i);
  });

  it("maps each response to coach or user by name, the latest of two wins, and someone else is skipped and listed", () => {
    const { answerKey, problems } = read();
    expect(answerKey.reviewers.map((r) => [r.reviewer, r.submittedAt])).toEqual([
      ["coach", "11/4/2026 8:30:45"],
      ["user", "11/3/2026 10:15:02"],
    ]);
    expect(problems).toContain("Row 4 (11/3/2026 11:00:00): \"Who is filling this in?\" matches neither name given; skipped.");
    expect(problems).toContain("Row 2: the coach answered again in row 5; the later response is used.");
    // The names typed are never written.
    expect(JSON.stringify(answerKey)).not.toMatch(/pat|sam|someone/i);
    expect(answerKey.formSeed).toBe(5);
  });

  it("joins every answer to its configuration, input and repeat through the key", () => {
    const coach = read().answerKey.reviewers[0]!;
    expect(coach.cases[1]).toEqual({
      case: 2,
      input: "seasons/2",
      answered: true,
      pick: "A",
      comment: "Stay in bed.",
      drafts: [
        { draft: "A", configuration: "cfg-d", repeat: 1, rating: 3, unsafe: false },
        { draft: "B", configuration: "cfg-a", repeat: 1, rating: 4, unsafe: false },
        { draft: "C", configuration: "cfg-b", repeat: 1, rating: 1, unsafe: true },
      ],
    });
    expect(coach.cases[2]!.pick).toBe("none");
    expect(coach.anythingElse).toBe("Good work.\nMore next time.");
  });

  it("reads 'All are safe' as every draft safe, and a letter with it as that letter unsafe, listed as a problem", () => {
    const { answerKey, problems } = read();
    const [coach, user] = answerKey.reviewers;
    expect(user!.cases[0]!.drafts.map((d) => d.unsafe)).toEqual([false, false, false]);
    expect(coach!.cases[0]!.drafts.map((d) => d.unsafe)).toEqual([true, false, false]);
    expect(problems).toContain('coach, case 1: ticked "All are safe" and A; recorded A as unsafe.');
  });

  it("leaves an optional case left blank unanswered, with nulls", () => {
    const user = read().answerKey.reviewers[1]!;
    expect(user.cases[2]).toEqual({
      case: 3,
      input: "seasons/3",
      answered: false,
      pick: null,
      comment: null,
      drafts: [
        { draft: "A", configuration: "cfg-c", repeat: 1, rating: null, unsafe: null },
        { draft: "B", configuration: "cfg-d", repeat: 1, rating: null, unsafe: null },
        { draft: "C", configuration: "cfg-a", repeat: 1, rating: null, unsafe: null },
      ],
    });
    expect(user.cases[0]!.comment).toBe('Rest the knee, then "test" it');
  });

  it("splits what matters most into the choices and the typed Other, commas and all", () => {
    const [coach, user] = read().answerKey.reviewers;
    expect(user!.priorities).toEqual(["Keeping the athlete safe", "Answering their question"]);
    expect(user!.otherPriority).toBe("Sleep, mostly");
    expect(coach!.priorities).toEqual(["Keeping the athlete safe", "Sensible mileage and long run"]);
    expect(coach!.otherPriority).toBeNull();
    expect(checkboxTicks("", ["A"])).toEqual({ ticked: [], other: null });
  });

  it("reads ticks joined with ';' as the form's own CSV download writes them", () => {
    expect(checkboxTicks("A;B;C", ["A", "B", "C", "All are safe"])).toEqual({ ticked: ["A", "B", "C"], other: null });
    expect(checkboxTicks("A;All are safe", ["A", "B", "C", "All are safe"])).toEqual({ ticked: ["A", "All are safe"], other: null });
    expect(checkboxTicks("Keeping the athlete safe;Sleep, mostly", ["Keeping the athlete safe"])).toEqual({ ticked: ["Keeping the athlete safe"], other: "Sleep, mostly" });
  });

  it("lists a case answered in part and a value off the scale", () => {
    const row = `11/5/2026 7:00:00,Sam Runner,B,,4,,9,,A,C,3,2,1,,,,,,,,,`;
    const { answerKey, problems } = read(`${HEADER}\n${row}\n`);
    expect(answerKey.reviewers[0]!.cases[0]!.drafts.map((d) => [d.rating, d.unsafe])).toEqual([
      [4, null],
      [null, null],
      [null, null],
    ]);
    expect(problems).toContain('user, case 1 draft C: rating "9" is not 1 to 5; left out.');
    expect(problems).toContain("user, case 1: answered in part (no unsafe answer, a draft unrated).");
    expect(problems).toContain("No response from the coach yet.");
  });

  it("refuses the same name for both", () => {
    expect(() => readAnswers({ csv: CSV, payload, key, names: { coach: "Sam", user: " sam " } })).toThrow(/same name/);
  });
});

describe("the comparison", () => {
  const answerKey: AnswerKey = read().answerKey;
  const [coach, user] = answerKey.reviewers as [AnswerKey["reviewers"][number], AnswerKey["reviewers"][number]];

  it("compares picks, unsafe flags and ratings on the cases both answered", () => {
    const c = compare(coach, user);
    expect(c.bothAnswered).toEqual([1, 2]);
    expect(c.pick).toEqual({ agree: 1, of: 2 });
    expect(c.unsafe).toMatchObject({ agree: 5, of: 6, perDraft: { A: { agree: 1, of: 2 }, B: { agree: 2, of: 2 }, C: { agree: 2, of: 2 } } });
    expect(c.unsafe.onlyOne).toEqual([{ case: 1, draft: "A", flaggedBy: "coach" }]);
    // Differences 2, 0, 0 and 0, 2, 0.
    expect(c.rating.meanAbsDiff).toBeCloseTo(4 / 6);
    expect(c.rating).toMatchObject({ withinOne: 4, of: 6 });
    expect(c.pickedDifferently).toEqual([{ case: 1, input: "seasons/1", coach: "C", user: "B", coachComment: "Knee first.", userComment: 'Rest the knee, then "test" it' }]);
  });

  it("gives the coach's numbers per configuration", () => {
    const n = Object.fromEntries(perConfiguration(coach, key.configurations).map((x) => [x.configuration, x]));
    expect(n["cfg-a"]).toMatchObject({ drafts: 3, unsafe: 1, picked: 0, pickedOf: 3 });
    expect(n["cfg-a"]!.meanRating).toBeCloseTo(7 / 3);
    expect(n["cfg-b"]).toMatchObject({ drafts: 2, meanRating: 2, unsafe: 1, picked: 0, pickedOf: 2 });
    expect(n["cfg-c"]).toMatchObject({ drafts: 2, meanRating: 3.5, unsafe: 0, picked: 1, pickedOf: 2 });
    expect(n["cfg-d"]).toMatchObject({ drafts: 2, meanRating: 2.5, picked: 1, pickedOf: 2 });
  });

  it("writes the comparison and the rubric with the coach's ticks, and says so when the coach is not in", () => {
    const doc = comparisonDoc(answerKey, key);
    expect(doc).toContain("- Same pick: 1 of 2 (50%).");
    expect(doc).toContain("- Case 1, Draft A: the coach only.");
    expect(doc).toContain("| cfg-c | 2 | 3.50 | 0 | 1 of 2 (50%) |");
    const rubric = rubricDoc(answerKey);
    expect(rubric).toContain("- Keeping the athlete safe: the must-never checks.");
    expect(rubric).toContain("- Sensible mileage and long run: Progression.");
    // The rubric is published: no submission time from the form.
    expect(rubric).toContain("on the coaching review form.");
    expect(rubric).not.toContain("submitted");
    const userOnly: AnswerKey = { ...answerKey, reviewers: [user] };
    expect(rubricDoc(userOnly)).toContain("Not set yet");
    expect(comparisonDoc(userOnly, key)).toContain("The coach's answers are not in yet.");
  });
});

describe("the command", () => {
  it("writes the answer key, the rubric and the comparison, and prints the problems", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "answers-"));
    const file = (name: string) => path.join(dir, name);
    writeFileSync(file("responses.csv"), CSV);
    writeFileSync(file("form.gs"), formScript(payload));
    writeFileSync(file("key.json"), JSON.stringify(key));
    const run = spawnSync(
      path.join(api, "node_modules/.bin/tsx"),
      ["scripts/replay-answers.ts", "--csv", file("responses.csv"), "--coach", "Pat Coach", "--user", "Sam Runner", "--form", file("form.gs"), "--key", file("key.json"), "--out", file("answer-key.json"), "--rubric", file("rubric.md")],
      { cwd: api, encoding: "utf8" },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("answers: coach 3 of 3 cases, user 2 of 3 cases");
    expect(run.stdout).toContain("problem: Row 4");
    const written = JSON.parse(readFileSync(file("answer-key.json"), "utf8")) as AnswerKey;
    expect(written.reviewers.map((r) => r.reviewer)).toEqual(["coach", "user"]);
    for (const f of ["answer-key.json", "rubric.md", "comparison.md"]) expect(readFileSync(file(f), "utf8")).not.toMatch(/Pat|Sam Runner|Someone/);
  }, 60_000);
});
