import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  buildStubWeeklyReply,
  createStubLlmPort,
  expectedPlanDates,
  MAX_HEADLINE_LENGTH,
  validateWeeklyReply,
  WEEKLY_SYSTEM_PROMPT,
} from "../src/llm/index.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
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

function reply(overrides: Record<string, unknown>) {
  return {
    headline: "A steady week. Keep the easy days easy.",
    analysis: "## Flags\n- Sleep is short.",
    prescribedWeek: {
      week: "2026-W44",
      days: expectedPlanDates(WEEK_START).map((date) => ({ date, dayType: "rest", run: null })),
    },
    ...overrides,
  };
}

describe("the weekly headline is validated", () => {
  it("keeps a headline within the cap as written", () => {
    const checked = validateWeeklyReply(reply({ headline: "  A steady week.  " }), WEEK_START);
    expect(checked.ok && checked.value.headline).toBe("A steady week.");
    expect(checked.ok && checked.repairs).toBeUndefined();
  });

  it("cuts a long headline at a word, ends it with an ellipsis, and notes the repair", () => {
    const long = "word ".repeat(100).trim();
    const checked = validateWeeklyReply(reply({ headline: long }), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.headline.length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH);
    expect(checked.value.headline).toMatch(/word…$/);
    expect(checked.repairs).toEqual([
      `headline cut from ${long.length} to ${checked.value.headline.length} chars`,
    ]);
  });

  it("fails closed when the headline is missing, empty or not a string", () => {
    for (const headline of [undefined, "", "   ", 42, null]) {
      const checked = validateWeeklyReply(reply({ headline }), WEEK_START);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.error).toMatch(/headline/);
    }
  });

  it("tells the model what the headline is", () => {
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/headline is the sentence you would say if you could say only one thing/);
  });

  it("keeps internal words out of the stub's headline", () => {
    const packet = buildModelPacket({
      dossier: { versionId: 1, body: "Easy base building." },
      recapMarkdown: "## Summary\nSteady week.",
      thread: [],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
        weekSessionId: "00000000-0000-4000-8000-000000000001",
      },
    });
    const { headline } = buildStubWeeklyReply(packet);
    expect(headline.trim()).not.toBe("");
    expect(bannedTermsIn(headline)).toEqual([]);
  });
});

describe("the weekly headline is stored and shown", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  function app() {
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
  }

  async function readTheWeek(a: ReturnType<typeof app>) {
    await acceptAndReady();
    const week = await json(await a.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(a, week.id as string);
    const res = await a.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: week.id, recapMarkdown: "## Summary\nSteady week." }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    return {
      weekSessionId: week.id as string,
      headline: (body.reply as { headline: string }).headline,
      planSessionId: (body.prescribed as { weekSessionId: string }).weekSessionId,
    };
  }

  it("stores the headline beside the full read on the plan", async () => {
    const a = app();
    const { headline, planSessionId } = await readTheWeek(a);
    const got = await json(await a.request(`/weeks/${planSessionId}/prescribed`));
    const record = got.prescribed as { analysis: string; readSections: { headline: string } };
    expect(record.readSections.headline).toBe(headline);
    expect(record.analysis.trim()).not.toBe("");
  });

  it("keeps the headline when Coach Cade changes a day from chat", async () => {
    const a = app();
    const { headline, planSessionId } = await readTheWeek(a);
    // A day patch re-saves the plan; the headline must survive it.
    const before = await json(await a.request(`/weeks/${planSessionId}/prescribed`));
    const record = before.prescribed as {
      plan: { week: string; days: Array<Record<string, unknown>> };
      analysis: string;
      readSections: { headline: string };
    };
    await savePrescribedWeek({
      weekSessionId: planSessionId,
      plan: record.plan as never,
      analysis: record.analysis,
      readSections: record.readSections,
      at: new Date("2026-10-27T15:00:00.000Z"),
    });
    const after = await json(await a.request(`/weeks/${planSessionId}/prescribed`));
    expect((after.prescribed as { readSections: unknown }).readSections).toEqual(record.readSections);
    expect(record.readSections.headline).toBe(headline);
  });

  it("leaves plans made before the headline with no sections", async () => {
    const a = app();
    await acceptAndReady();
    const week = await json(await a.request("/weeks/current", { method: "POST" }));
    await savePrescribedWeek({
      weekSessionId: week.id as string,
      plan: reply({}).prescribedWeek as never,
      analysis: "## Headline\nAn older read.",
      at: new Date("2026-10-21T15:00:00.000Z"),
    });
    const got = await json(await a.request(`/weeks/${week.id as string}/prescribed`));
    expect((got.prescribed as { readSections: unknown }).readSections).toBeNull();
  });

  it("shows the headline on History, not the read's first paragraph", async () => {
    const a = app();
    await acceptAndReady();
    const week = await json(await a.request("/weeks/current", { method: "POST" }));
    await savePrescribedWeek({
      weekSessionId: week.id as string,
      plan: reply({}).prescribedWeek as never,
      analysis: "## Headline\nThe read's own first paragraph.",
      readSections: { headline: "The headline Coach Cade chose." },
      at: new Date("2026-10-21T15:00:00.000Z"),
    });
    const weeks = (await json(await a.request("/weeks"))).weeks as Array<{
      id: string;
      coachHeadline: string | null;
    }>;
    expect(weeks.find((w) => w.id === week.id)?.coachHeadline).toBe(
      "The headline Coach Cade chose.",
    );
  });
});
