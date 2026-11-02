/**
 * The weekly read on flat boxes (plan-as-text ticket 06), through the app with
 * a fake model server: what the server is sent (the tool definition and the
 * prompt), and what the athlete gets (the stored plan, the read sections, the
 * notices, the call log row, the Plan page and Home JSON).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import type { TrainingGoal } from "../src/goal/types.js";
import {
  buildStubWeeklyForm,
  buildStubWeeklyReply,
  expectedPlanDates,
  validateWeeklyReply,
  type PrescribedDay,
  type PrescribedWeek,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";
import { planLines, planLinesWith, weeklyForm } from "./weeklyForms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const API_KEY = "sk-ant-test-key-fixture-xyz";
/** Wednesday of 2026-W43; the read plans 2026-W44. */
const NOW = new Date("2026-10-21T15:00:00.000Z");
/** Wednesday of the plan week, for reading Home while the plan is this week's. */
const PLAN_WEEK_NOW = new Date("2026-10-28T15:00:00.000Z");
const PLAN_MONDAY = "2026-10-26";
const DATES = expectedPlanDates(PLAN_MONDAY);
const MI = 1609.344;

function packet(
  unit: "imperial" | "metric" = "imperial",
  extra: { recapMarkdown?: string } = {},
): ModelPacket {
  return buildModelPacket({
    dossier: null,
    recapMarkdown: extra.recapMarkdown ?? "## Summary\nSteady aerobic week.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    },
    coaching: { phase: "base", unitPreference: unit },
  });
}

type Sent = {
  system: string;
  messages: Array<{ content: string }>;
  tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
  strict?: unknown;
};

/** The app against a fake model server answering every weekly call with `reply()`. */
async function liveApp(reply: () => unknown) {
  await acceptAndReady();
  await putAnthropicConnection(API_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return anthropicStreamResponse(anthropicToolMessage("submit_weekly_reply", reply()));
  }) as unknown as typeof globalThis.fetch;
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmFetch: fetchImpl,
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  const weekSessionId = week.id as string;
  await unlockPlanCheckIn(app, weekSessionId);
  return { app, weekSessionId, sent };
}

async function postReply(
  app: ReturnType<typeof createApp>,
  weekSessionId: string,
  p: ModelPacket = packet(),
) {
  return app.request("/week/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ weekSessionId, packet: p }),
  });
}

type StoredRecord = {
  weekSessionId: string;
  plan: PrescribedWeek;
  readSections: { headline: string; flags: unknown[]; answers: unknown[] } | null;
  safetyCallouts: unknown[] | null;
};

/** Reply through the route, then the plan as the Plan page reads it. */
async function storedPlan(form: unknown, p: ModelPacket = packet()) {
  const { app, weekSessionId } = await liveApp(() => form);
  const res = await postReply(app, weekSessionId, p);
  const body = await json(res);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const planSessionId = (body.prescribed as StoredRecord).weekSessionId;
  const page = await json(await app.request(`/weeks/${planSessionId}/prescribed`));
  return { app, body, page, record: page.prescribed as StoredRecord, coachMessage: body.coachMessage as Record<string, unknown> };
}

const PROPERTY_NAMES = [
  "headline",
  "flags",
  "answers",
  "analysis",
  "plan",
  "settingsProposalBullets",
  "safetyCallouts",
];

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

let prevProvider: string | undefined;
beforeEach(async () => {
  await resetAppTables();
  prevProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "anthropic";
  return () => {
    if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prevProvider;
  };
});

describe("what the model server is sent for the weekly read", () => {
  it("a tool with only string and list-of-string boxes, each described, a plan box and no nested plan", async () => {
    const { app, weekSessionId, sent } = await liveApp(() => buildStubWeeklyForm(packet()));
    expect((await postReply(app, weekSessionId)).status).toBe(200);
    const [tool] = sent[0]!.tools;
    expect(tool!.name).toBe("submit_weekly_reply");
    const schema = tool!.input_schema as {
      properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([...PROPERTY_NAMES].sort());
    expect(schema.required).toEqual(["headline", "analysis", "plan"]);
    for (const [name, prop] of Object.entries(schema.properties)) {
      expect(prop.description, name).toMatch(/\w/);
      if (prop.type === "array") expect(prop.items, name).toEqual({ type: "string" });
      else expect(prop.type, name).toBe("string");
    }
    expect(JSON.stringify(sent[0]!.tools)).not.toContain("prescribedWeek");
    expect(sent[0]).not.toHaveProperty("strict");
    expect(JSON.stringify(sent[0]!.tools)).not.toContain("strict");
  });

  it("names the athlete's unit in the plan box, for an imperial and a metric athlete", async () => {
    const { app, weekSessionId, sent } = await liveApp(() => buildStubWeeklyForm(packet()));
    await postReply(app, weekSessionId, packet("imperial"));
    await postReply(app, weekSessionId, packet("metric"));
    const planBox = (s: Sent) =>
      (s.tools[0]!.input_schema as { properties: { plan: { description: string } } }).properties.plan.description;
    expect(planBox(sent[0]!)).toMatch(/distance in miles/);
    expect(planBox(sent[0]!)).toContain(`Example: Tue ${DATES[1]}: easy, 5 mi,`);
    expect(planBox(sent[1]!)).toMatch(/distance in kilometres/);
    expect(planBox(sent[1]!)).toContain(`Example: Tue ${DATES[1]}: easy, 8 km,`);
    // The grammar: the day types and that every number carries its unit.
    expect(planBox(sent[0]!)).toMatch(/rest, easy, quality, long, race or other/);
    expect(planBox(sent[0]!)).toMatch(/every number carries its unit/);
  });

  it("the prompt lists the seven dates, the unit and an example line, and asks for no question quoted and no week id", async () => {
    const { app, weekSessionId, sent } = await liveApp(() => buildStubWeeklyForm(packet()));
    await postReply(app, weekSessionId, packet("imperial"));
    await postReply(app, weekSessionId, packet("metric"));
    const [imperial, metric] = sent.map((s) => s.messages[0]!.content);
    expect(imperial).toContain(`for these dates Mon–Sun: ${DATES.join(", ")}`);
    expect(imperial).toContain(`Plan week Monday (YYYY-MM-DD): ${PLAN_MONDAY}`);
    expect(imperial).toContain("Write distances in miles.");
    expect(metric).toContain("Write distances in kilometres.");
    expect(imperial).toContain(`Example plan line: Tue ${DATES[1]}: easy, 5 mi,`);
    expect(imperial).toMatch(/The plan box is the plan/);
    expect(imperial).toMatch(/do not restate the plan in it day by day/);
    for (const text of [imperial!, sent[0]!.system]) {
      expect(text).not.toMatch(/quoted? (exactly|as written)/i);
      expect(text).not.toMatch(/prescribedWeek|ISO label|ISO week id/);
    }
  });
});

describe("a plan box of seven well-formed lines", () => {
  it("is stored in today's shape for an imperial athlete: metres and seconds, run type from day type, line and parsed, week from the plan week", async () => {
    const lines = planLinesWith(PLAN_MONDAY, 5, "easy, am 5 mi, pm 3 mi, both easy.");
    const { record } = await storedPlan(weeklyForm(PLAN_MONDAY, { plan: lines.join("\n") }), packet("imperial"));
    expect(record.plan.week).toBe("2026-W44");
    const days = record.plan.days;
    expect(days.map((d) => d.date)).toEqual(DATES);
    expect(days.map((d) => d.line)).toEqual(lines);
    expect(days.every((d) => d.parsed === true)).toBe(true);
    for (const d of days) if (d.run) expect(d.run.type).toBe(d.dayType);
    // Rest: no run.
    expect(days[0]).toMatchObject({ dayType: "rest", run: null, notes: "Sleep in." });
    // Distance, converted from miles; the rest of the line is the notes.
    expect(days[1]).toMatchObject({
      dayType: "easy",
      run: { type: "easy", distanceM: Math.round(5 * MI) },
      notes: "HR under 150, flat route.",
      strength: null,
    });
    expect(days[1]!.run).toMatchObject({ structure: null, paceOrHr: null, shoes: null });
    expect(days[2]!.run).toMatchObject({ type: "quality", distanceM: Math.round(6 * MI) });
    // Time only.
    expect(days[3]!.run).toMatchObject({ type: "easy", distanceM: 0, durationS: 2400 });
    // An other day with no amount is not a run.
    expect(days[4]).toMatchObject({ dayType: "other", run: null, notes: "strength: squats, lunges and core." });
    // A double stores the first run.
    expect(days[5]!.run).toMatchObject({ distanceM: Math.round(5 * MI) });
    expect(days[6]!.run).toMatchObject({ type: "long", distanceM: Math.round(10 * MI) });
  });

  it("reads kilometres for a metric athlete, and a range as its first number", async () => {
    const { record } = await storedPlan(
      weeklyForm(PLAN_MONDAY, { plan: planLines(PLAN_MONDAY, "metric").join("\n") }),
      packet("metric"),
    );
    const days = record.plan.days;
    expect(days[1]!.run!.distanceM).toBe(5000);
    expect(days[2]!.run!.distanceM).toBe(6000);
    expect(days[5]).toMatchObject({ line: `Sat ${DATES[5]}: easy, 3-4 km, shakeout.`, run: { distanceM: 3000 } });
    expect(days[6]!.run!.distanceM).toBe(10000);
  });

  it("logs the call as ok", async () => {
    const { app, coachMessage } = await storedPlan(weeklyForm(PLAN_MONDAY));
    const row = await json(await app.request(`/llm-calls/${coachMessage.llmCallId as string}`));
    expect(row).toMatchObject({ outcome: "ok", errorMessage: null });
  });
});

describe("a plan box with a day Cadence cannot file", () => {
  it("stores six parsed days and the bare-number day unparsed, and logs the call as repaired, naming the day", async () => {
    const lines = planLinesWith(PLAN_MONDAY, 3, "easy 5, relaxed.");
    const { app, record, coachMessage } = await storedPlan(weeklyForm(PLAN_MONDAY, { plan: lines.join("\n") }));
    const days = record.plan.days;
    expect(days.filter((d) => d.parsed === true)).toHaveLength(6);
    expect(days[3]).toEqual({
      date: DATES[3],
      dayType: "other",
      run: null,
      notes: lines[3],
      line: lines[3],
      parsed: false,
    });
    // The read is kept.
    expect(record.readSections?.headline).toBe("A steady week. Keep the easy days easy.");
    const row = await json(await app.request(`/llm-calls/${coachMessage.llmCallId as string}`));
    expect(row).toMatchObject({ outcome: "repaired" });
    expect(row.errorMessage).toBe(`plan ${DATES[3]} not filed: no distance unit`);
  });

  it("refuses a reply whose plan box is empty or missing, after asking once more", async () => {
    for (const plan of ["", "   \n  ", undefined, null]) {
      await resetAppTables();
      const { app, weekSessionId, sent } = await liveApp(() => weeklyForm(PLAN_MONDAY, { plan }));
      const res = await postReply(app, weekSessionId);
      expect(res.status, String(plan)).toBe(502);
      expect(await json(res)).toMatchObject({
        error: "llm_schema_invalid",
        message: "plan is required: seven lines, one per day",
      });
      expect(sent).toHaveLength(2);
    }
  });

  it("refuses a plan box with no line for any day of the plan week", async () => {
    const { app, weekSessionId } = await liveApp(() =>
      weeklyForm(PLAN_MONDAY, { plan: "Next week builds on this one.\nKeep it easy." }),
    );
    const res = await postReply(app, weekSessionId);
    expect(res.status).toBe(502);
    expect((await json(res)).message).toMatch(/^plan has no line for any day/);
  });
});

describe("the read's other boxes in today's stored shapes", () => {
  it("flags with and without a colon, answers as strings, notices with and without a severity word", async () => {
    const asked = "## Questions for coach\n\n1. Is 3:30 still sensible?\n";
    const { record, coachMessage } = await storedPlan(
      weeklyForm(PLAN_MONDAY, {
        flags: ["Sleep: Down to 6.8 hours. Protect it.", "Watch the calf after Sunday"],
        answers: ["Yes, with one caveat: keep the long run easy."],
        safetyCallouts: [
          "Urgent: Stop and get checked. Chest pain on a run needs a doctor today.",
          "Calf tightness is worth a physio visit. If it gets worse, stop running on it.",
          "Info: Ease the hills.",
        ],
      }),
      packet("imperial", { recapMarkdown: `## Summary\nSteady week.\n\n${asked}` }),
    );
    expect(record.readSections).toEqual({
      headline: "A steady week. Keep the easy days easy.",
      flags: [
        { title: "Sleep", detail: "Down to 6.8 hours. Protect it." },
        { title: "Watch the calf after Sunday", detail: "" },
      ],
      answers: [
        { question: "Is 3:30 still sensible?", answer: "Yes, with one caveat: keep the long run easy." },
      ],
    });
    const callouts = [
      { title: "Stop and get checked.", body: "Chest pain on a run needs a doctor today.", severity: "urgent" },
      {
        title: "Calf tightness is worth a physio visit.",
        body: "If it gets worse, stop running on it.",
        severity: "caution",
      },
      { title: "Ease the hills.", body: "", severity: "info" },
    ];
    expect(record.safetyCallouts).toEqual(callouts);
    expect(coachMessage.safetyCallouts).toEqual(callouts);
  });
});

describe("the offline coach's weekly form", () => {
  const GOALS: Array<TrainingGoal | null> = [
    null,
    { kind: "race", distance: "marathon" } as TrainingGoal,
    { kind: "speed", distance: "5k" } as TrainingGoal,
    { kind: "fitness" } as TrainingGoal,
    { kind: "return", startingPoint: "20 min easy" } as TrainingGoal,
  ];

  it("is flat boxes with seven plan lines that all parse, for every goal and both units", () => {
    for (const goal of GOALS) {
      for (const unit of ["imperial", "metric"] as const) {
        const p = buildModelPacket({
          dossier: null,
          recapMarkdown: "## Summary\nSteady week.",
          thread: [],
          attachments: [],
          week: { isoWeek: "2026-W43", start: "2026-10-19T00:00:00.000Z", end: "2026-10-25T23:59:59.999Z" },
          goal,
          coaching: { phase: "base", unitPreference: unit },
        });
        const form = buildStubWeeklyForm(p);
        for (const [key, value] of Object.entries(form)) {
          const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
          expect(ok, key).toBe(true);
        }
        expect(form.plan.split("\n")).toHaveLength(7);
        expect(form.plan).toMatch(goal?.kind === "return" ? / min\./ : unit === "metric" ? / km\./ : / mi\./);
        const checked = validateWeeklyReply(form, PLAN_MONDAY, { unit });
        expect(checked.ok).toBe(true);
        if (!checked.ok) continue;
        expect(checked.repairs, `${goal?.kind} ${unit}`).toBeUndefined();
        expect(checked.value.prescribedWeek.days.every((d) => d.parsed === true)).toBe(true);
        expect(checked.value).toEqual(buildStubWeeklyReply(p));
      }
    }
  });
});

describe("the Plan page and Home for a parsed week", () => {
  /** Home's strip, totals and today, read on the plan week's Wednesday. */
  async function home() {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(PLAN_WEEK_NOW),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });
    // Home lays out the week once setup is done (as in home.test.ts).
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_plan_lines_key" }],
      ["/settings/anthropic", { apiKey: API_KEY }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
    ] as const) {
      const res = await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.ok, route).toBe(true);
    }
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    expect(week.isoWeek).toBe("2026-W44");
    return json(await app.request("/home"));
  }

  it("gives Home the same strip, totals and today as the same plan stored without lines", async () => {
    const { record, page } = await storedPlan(weeklyForm(PLAN_MONDAY));
    expect(page.unitPreference).toBeDefined();
    const fromLines = await home();

    // The same days as a plan stored before lines: no line, no parsed.
    const plain: PrescribedWeek = {
      week: record.plan.week,
      days: record.plan.days.map(({ line: _line, parsed: _parsed, ...day }): PrescribedDay => day),
    };
    const planSessionId = record.weekSessionId;
    await resetAppTables();
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(PLAN_WEEK_NOW),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    expect(week.isoWeek).toBe("2026-W44");
    await savePrescribedWeek({ at: PLAN_WEEK_NOW, weekSessionId: week.id as string, plan: plain, analysis: "x" });
    const fromFields = await home();

    expect(planSessionId).toBeTruthy();
    expect(fromLines.week).toEqual(fromFields.week);
    expect(fromLines.totals).toEqual(fromFields.totals);
    const strip = fromLines.week as Array<Record<string, unknown>>;
    expect(strip.map((d) => d.plannedDistanceM)).toEqual(
      record.plan.days.map((d) => (d.run ? d.run.distanceM : null)),
    );
    // Today (Wednesday) is the quality day, with its line for the card.
    const { line, parsed, ...todayFields } = fromLines.today as PrescribedDay;
    expect(todayFields).toEqual(fromFields.today);
    expect(line).toBe(record.plan.days[2]!.line);
    expect(parsed).toBe(true);
  });
});
