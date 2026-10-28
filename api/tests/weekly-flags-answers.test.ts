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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const WEEK_START = "2026-10-26";
const QUESTIONS = "## Questions for coach\n\n1. Is 3:30 still sensible?\n2. Heavy legs Monday after a 20-miler, normal?\n";

function reply(overrides: Record<string, unknown>) {
  return {
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek: {
      week: "2026-W44",
      days: expectedPlanDates(WEEK_START).map((date) => ({ date, dayType: "rest", run: null })),
    },
    ...overrides,
  };
}

const flag = (title = "Sleep", detail = "Down to 6.8 hours. Protect it.") => ({ title, detail });
const answer = (question = "Is 3:30 still sensible?", answer = "Yes, with one caveat.") => ({
  question,
  answer,
});

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
  it("keeps them as written when they fit, and treats missing ones as none", () => {
    const checked = validateWeeklyReply(reply({ flags: [flag()], answers: [answer()] }), WEEK_START);
    expect(checked.ok && checked.value.flags).toEqual([flag()]);
    expect(checked.ok && checked.value.answers).toEqual([answer()]);
    expect(checked.ok && checked.repairs).toBeUndefined();

    const none = validateWeeklyReply(reply({}), WEEK_START);
    expect(none.ok && none.value.flags).toEqual([]);
    expect(none.ok && none.value.answers).toEqual([]);
  });

  it("cuts a long flag title or detail at a word and notes each cut", () => {
    const title = "word ".repeat(30).trim();
    const detail = "word ".repeat(80).trim();
    const checked = validateWeeklyReply(reply({ flags: [flag(title, detail)] }), WEEK_START);
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
    const checked = validateWeeklyReply(reply({ answers: [answer(undefined, long)] }), WEEK_START);
    expect(checked.ok && checked.value.answers![0]!.answer).toBe(long);
  });

  it("fails closed on more than five flags or eight answers", () => {
    const sixFlags = validateWeeklyReply(reply({ flags: Array(6).fill(flag()) }), WEEK_START);
    expect(sixFlags.ok).toBe(false);
    const nineAnswers = validateWeeklyReply(reply({ answers: Array(9).fill(answer()) }), WEEK_START);
    expect(nineAnswers.ok).toBe(false);
    expect(validateWeeklyReply(reply({ flags: Array(5).fill(flag()) }), WEEK_START).ok).toBe(true);
    expect(validateWeeklyReply(reply({ answers: Array(8).fill(answer()) }), WEEK_START).ok).toBe(true);
  });

  it("fails closed on a flag or answer with a missing part", () => {
    for (const bad of [
      { flags: [{ title: "Sleep" }] },
      { flags: [{ title: "", detail: "x" }] },
      { flags: "Sleep" },
      { answers: [{ question: "Why?" }] },
      { answers: [{ question: "Why?", answer: "  " }] },
      { answers: {} },
    ]) {
      expect(validateWeeklyReply(reply(bad), WEEK_START).ok).toBe(false);
    }
  });

  it("tells the model what flags and answers are", () => {
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/Flags are what you are watching, not a summary/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/question quoted exactly as they wrote it/);
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
  it("answers each check-in question, quoting it as the athlete wrote it", () => {
    const { answers } = buildStubWeeklyReply(packet(`## Summary\nSteady week.\n\n${QUESTIONS}`));
    expect(answers!.map((a) => a.question)).toEqual([
      "Is 3:30 still sensible?",
      "Heavy legs Monday after a 20-miler, normal?",
    ]);
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
      body: JSON.stringify({ weekSessionId: week.id, recapMarkdown: `## Summary\nSteady week.\n\n${QUESTIONS}` }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const sections = (body.prescribed as {
      readSections: { flags: unknown[]; answers: Array<{ question: string }> };
    }).readSections;
    expect(sections.flags.length).toBeGreaterThan(0);
    expect(sections.answers.map((a) => a.question)).toEqual([
      "Is 3:30 still sensible?",
      "Heavy legs Monday after a 20-miler, normal?",
    ]);
  });
});
