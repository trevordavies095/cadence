import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  buildStubWeeklyReply,
  createStubLlmPort,
  expectedPlanDates,
  validateWeeklyReply,
  WEEKLY_SYSTEM_PROMPT,
} from "../src/llm/index.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";
import { weeklyForm } from "./weeklyForms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const WEEK_START = "2026-10-26";
const QUESTIONS = "## Questions for coach\n\n1. Is 3:30 still sensible?\n2. Heavy legs Monday after a 20-miler, normal?\n";
const ONE_QUESTION = "## Questions for coach\n\n1. Is 3:30 still sensible?\n";

/** A weekly form with no flags or answers unless `overrides` gives them. */
function reply(overrides: Record<string, unknown>) {
  return weeklyForm(WEEK_START, { flags: undefined, answers: undefined, ...overrides });
}

/** Flags arrive as "title: detail", one per line; answers as one markdown string. */
const flag = (title = "Sleep", detail = "Down to 6.8 hours. Protect it.") => `${title}: ${detail}`;
const answer = (text = "Yes, with one caveat.") => text;
const ASKED = ["Is 3:30 still sensible?"];

function packet(recapMarkdown: string) {
  return buildModelPacket({
    dossier: { versionId: 1, body: "Right Achilles niggle in September." },
    recapMarkdown,
    thread: [],
    attachments: [],
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
  });
}

describe("flags and answers are validated", () => {
  it("stores them in today's shapes when they fit, and treats missing ones as none", () => {
    const checked = validateWeeklyReply(reply({ flags: flag(), answers: answer() }), WEEK_START, {
      questions: ASKED,
    });
    expect(checked.ok && checked.value.flags).toEqual([
      { title: "Sleep", detail: "Down to 6.8 hours. Protect it." },
    ]);
    expect(checked.ok && checked.value.answers).toEqual([
      { question: "Is 3:30 still sensible?", answer: "Yes, with one caveat." },
    ]);
    expect(checked.ok && checked.repairs).toBeUndefined();

    const none = validateWeeklyReply(reply({}), WEEK_START);
    expect(none.ok && none.value.flags).toEqual([]);
    expect(none.ok && none.value.answers).toEqual([]);
  });

  it("splits a flag on its first colon, and keeps a line with no colon whole as the title", () => {
    const checked = validateWeeklyReply(
      reply({
        flags: [
          "Pace: 8:30/mi on Thursday was quicker than planned.",
          "Watch the calf after Sunday",
          "Long run: ",
        ].join("\n"),
      }),
      WEEK_START,
    );
    expect(checked.ok && checked.value.flags).toEqual([
      { title: "Pace", detail: "8:30/mi on Thursday was quicker than planned." },
      { title: "Watch the calf after Sunday", detail: "" },
      { title: "Long run:", detail: "" },
    ]);
  });

  it("stores the answer box as one answer, with the question only when the check-in asked exactly one", () => {
    const text = "**Yes.**\n\nAnd heavy legs after a 20 are normal.";
    const paired = validateWeeklyReply(reply({ answers: text }), WEEK_START, {
      questions: ["Is 3:30 still sensible?"],
    });
    expect(paired.ok && paired.value.answers).toEqual([
      { question: "Is 3:30 still sensible?", answer: text },
    ]);
    // Two check-in questions, or none (a question from the conversation):
    // Cadence cannot tell which part answers which question, so it names none.
    for (const questions of [["Is 3:30 still sensible?", "Heavy legs Monday, normal?"], []]) {
      const unpaired = validateWeeklyReply(reply({ answers: text }), WEEK_START, { questions });
      expect(unpaired.ok && unpaired.value.answers).toEqual([{ question: "", answer: text }]);
    }
    // An empty or blank box is no answer.
    for (const blank of ["", "  \n "]) {
      const none = validateWeeklyReply(reply({ answers: blank }), WEEK_START, { questions: ASKED });
      expect(none.ok && none.value.answers).toEqual([]);
    }
  });

  it("cuts a long flag title or detail at a word and notes each cut", () => {
    const title = "word ".repeat(30).trim();
    const detail = "word ".repeat(80).trim();
    const checked = validateWeeklyReply(reply({ flags: flag(title, detail) }), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const [f] = checked.value.flags!;
    expect(f!.title.length).toBeLessThanOrEqual(80);
    expect(f!.detail.length).toBeLessThanOrEqual(280);
    expect(f!.title).toMatch(/…$/);
    expect(checked.repairs).toEqual([
      `flags[0].title cut from ${title.length} to ${f!.title.length} chars`,
      `flags[0].detail cut from ${detail.length} to ${f!.detail.length} chars`,
    ]);
  });

  it("never cuts an answer, however long", () => {
    const long = "A careful answer. ".repeat(100).trim();
    const checked = validateWeeklyReply(reply({ answers: answer(long) }), WEEK_START);
    expect(checked.ok && checked.value.answers![0]!.answer).toBe(long);
  });

  it("keeps the first five flag lines and drops the rest, noting it", () => {
    const six = validateWeeklyReply(
      reply({ flags: [1, 2, 3, 4, 5, 6].map((n) => flag(`Flag ${n}`)).join("\n") }),
      WEEK_START,
    );
    expect(six.ok && six.value.flags!.map((f) => f.title)).toEqual([
      "Flag 1",
      "Flag 2",
      "Flag 3",
      "Flag 4",
      "Flag 5",
    ]);
    expect(six.ok && six.repairs).toEqual(["flags had 6 lines: the first 5 kept, 1 dropped"]);
    const five = validateWeeklyReply(reply({ flags: Array(5).fill(flag()).join("\n") }), WEEK_START);
    expect(five.ok && five.repairs).toBeUndefined();
  });

  it("fails closed on a box that is neither a string nor a list of strings", () => {
    for (const bad of [
      { flags: [{ title: "Sleep", detail: "Short." }] },
      { flags: 42 },
      { answers: [{ question: "Why?", answer: "Because." }] },
      { answers: [42] },
      { answers: {} },
      { safetyCallouts: [{ title: "See a physio", body: "Now." }] },
      { settingsProposalBullets: { a: "b" } },
    ]) {
      expect(validateWeeklyReply(reply(bad), WEEK_START).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("reads an optional box sent as null as absent", () => {
    for (const field of ["flags", "answers", "settingsProposalBullets", "safetyCallouts"]) {
      const checked = validateWeeklyReply(reply({ [field]: null }), WEEK_START);
      expect(checked.ok, field).toBe(true);
      if (!checked.ok) continue;
      expect(checked.repairs, field).toBeUndefined();
      expect(checked.value.flags).toEqual([]);
      expect(checked.value.answers).toEqual([]);
      expect(checked.value.settingsProposalBullets).toBeUndefined();
      expect(checked.value.safetyCallouts).toBeUndefined();
    }
  });

  it("drops blank lines in a box of lines without a note", () => {
    const checked = validateWeeklyReply(
      reply({
        flags: `\n${flag()}\n   \n`,
        answers: `${answer()}\n   `,
        settingsProposalBullets: "Long runs on Saturdays now.\n\n",
        safetyCallouts: " \nCaution: See a physio. The calf has hurt for a week.",
      }),
      WEEK_START,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.flags).toHaveLength(1);
    expect(checked.value.answers).toEqual([{ question: "", answer: answer() }]);
    expect(checked.value.settingsProposalBullets).toEqual(["Long runs on Saturdays now."]);
    expect(checked.value.safetyCallouts).toHaveLength(1);
    expect(checked.repairs).toBeUndefined();
  });

  it("tells the model what flags and answers are", () => {
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/Flags are what you are watching, not a summary/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/one per line, each a few-word title, a colon, and one line of detail/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/Write the answers only, not the questions/);
    expect(WEEKLY_SYSTEM_PROMPT).not.toMatch(/quoted exactly/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/do not restate the headline, flags or answers/i);
  });

  it("carries the replay's fixes: corrections first, parts that stand alone, no repeated tables", () => {
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/A correction comes first/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/never point to something "above" or "below"/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/never repeat an answer's table or list/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/as a list or as a table/);
  });

  it("names the internal words the model reached for in the replay", () => {
    for (const word of ["RPE", "mid-week", "prescribed"]) {
      expect(WEEKLY_SYSTEM_PROMPT).toContain(word);
    }
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/how hard it felt/);
  });
});

describe("the stub's flags and answers", () => {
  it("answers the check-in in one answer, quoting a single question as the athlete wrote it", () => {
    const one = buildStubWeeklyReply(packet(`## Summary\nSteady week.\n\n${ONE_QUESTION}`)).answers;
    expect(one!.map((a) => a.question)).toEqual(["Is 3:30 still sensible?"]);
    const two = buildStubWeeklyReply(packet(`## Summary\nSteady week.\n\n${QUESTIONS}`)).answers;
    expect(two!.map((a) => a.question)).toEqual([""]);
  });

  it("gives no answers when the athlete asked nothing", () => {
    expect(buildStubWeeklyReply(packet("## Summary\nSteady week.")).answers).toEqual([]);
  });

  it("keeps internal words out of flags and answers", () => {
    const r = buildStubWeeklyReply(packet(`## Summary\nSteady week.\n\n${QUESTIONS}`));
    const text = [...r.flags!.flatMap((f) => [f.title, f.detail]), ...r.answers!.map((a) => a.answer)].join("\n");
    expect(bannedTermsIn(text)).toEqual([]);
  });
});

describe("flags and answers are stored with the plan", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("stores them beside the headline", async () => {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: week.id, recapMarkdown: `## Summary\nSteady week.\n\n${ONE_QUESTION}` }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const sections = (body.prescribed as {
      readSections: { flags: unknown[]; answers: Array<{ question: string }> };
    }).readSections;
    expect(sections.flags.length).toBeGreaterThan(0);
    expect(sections.answers.map((a) => a.question)).toEqual(["Is 3:30 still sensible?"]);
  });
});
