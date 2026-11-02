/**
 * Mid-week changes in the plan grammar (plan-as-text ticket 10): Coach Cade
 * writes the changed days as plan lines in the `changes` box, through the
 * live adapter against a fake model server. Only dates with a line change; a
 * line that does not parse changes its own date only, stored unparsed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  createAnthropicLlmPort,
  expectedPlanDates,
  validateMidWeekChatReply,
  type PrescribedDay,
  type PrescribedWeek,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  fakeCoachServer,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const WEEK_START = "2026-10-19";
const DATES = expectedPlanDates(WEEK_START);
const [MON, , , THU, , SAT, SUN] = DATES as [string, string, string, string, string, string, string];
/** Wednesday 2026-10-21: Monday and Tuesday are past. */
const NOW = new Date("2026-10-21T15:00:00.000Z");
const MI = 1609.344;
const TOOL = "submit_mid_week_chat_reply";

/** Week of Oct 19 – 25 with quality on Thursday and a long run on Sunday. */
function plan(): PrescribedWeek {
  return {
    week: "2026-W43",
    days: DATES.map((date, i) =>
      i === 3
        ? { date, dayType: "quality" as const, run: { type: "quality" as const, distanceM: 12000, structure: "threshold reps" } }
        : i === 6
          ? { date, dayType: "long" as const, run: { type: "long" as const, distanceM: 18000 } }
          : { date, dayType: "easy" as const, run: { type: "easy" as const, distanceM: 8000 } },
    ),
  };
}

type CoachMessage = { body: string; planChanges: PrescribedDay[] | null };

async function liveApp(answers: unknown[]) {
  await acceptAndReady();
  await putAnthropicConnection("sk-ant-test", new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const server = fakeCoachServer(TOOL, answers);
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    llmPort: createAnthropicLlmPort({
      fetchImpl: server.fetchImpl,
      recorder: server.recorder,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: "http://fake-anthropic.test/v1/messages",
    }),
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  const weekSessionId = week.id as string;
  await savePrescribedWeek({ at: NOW, weekSessionId, plan: plan(), analysis: "Seeded." });
  const send = async (body: string) => {
    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const out = await json(res);
    expect(res.status, JSON.stringify(out).slice(0, 300)).toBe(201);
    return out.coachMessage as CoachMessage;
  };
  const storedPlan = async () =>
    ((await json(await app.request(`/weeks/${weekSessionId}/prescribed`))).prescribed as { plan: PrescribedWeek }).plan;
  const listedCoach = async () =>
    ((await json(await app.request(`/thread?weekSessionId=${weekSessionId}`))).messages as Array<CoachMessage & { role: string }>).filter(
      (m) => m.role === "coach",
    );
  return { ...server, send, storedPlan, listedCoach };
}

/** Days of the stored plan other than `dates`, compared with the seeded plan. */
function untouched(stored: PrescribedWeek, dates: string[]) {
  const seeded = plan().days.filter((d) => !dates.includes(d.date));
  expect(stored.days.filter((d) => !dates.includes(d.date))).toEqual(seeded);
}

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  delete process.env.TEMPO_EXPORT_PATH;
});

describe("Coach Cade changes days with plan lines", () => {
  it("two well-formed lines replace exactly those two days, and the card names both", async () => {
    const thu = `Thu ${THU}: easy, 4 mi, keep it relaxed.`;
    const sun = `Sun ${SUN}: long, 10 mi, steady and flat.`;
    const { send, storedPlan, listedCoach, rows } = await liveApp([
      { body: "Legs are heavy, so Thursday goes easy and Sunday shortens.", changes: `${thu}\n${sun}` },
    ]);
    const reply = await send("Legs are heavy, can we ease off?");

    expect(reply.planChanges!.map((d) => d.date)).toEqual([THU, SUN]);
    expect(reply.planChanges![0]).toMatchObject({
      date: THU,
      dayType: "easy",
      run: { type: "easy", distanceM: Math.round(4 * MI) },
      line: thu,
      parsed: true,
    });
    expect(reply.planChanges![1]).toMatchObject({
      date: SUN,
      dayType: "long",
      run: { type: "long", distanceM: Math.round(10 * MI) },
      line: sun,
      parsed: true,
    });

    const stored = await storedPlan();
    expect(stored.days[3]).toEqual(reply.planChanges![0]);
    expect(stored.days[6]).toEqual(reply.planChanges![1]);
    untouched(stored, [THU, SUN]);
    expect((await listedCoach())[0]!.planChanges).toEqual(reply.planChanges);
    expect(rows.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("a line for a past day is ignored unless allowPastDayPatches is true", async () => {
    const mon = `Mon ${MON}: rest, swapped after the fact.`;
    const { send, storedPlan } = await liveApp([
      { body: "Monday was a rest day in the end.", changes: mon },
      { body: "Monday was a rest day in the end.", changes: mon, allowPastDayPatches: true },
    ]);
    expect((await send("I skipped Monday.")).planChanges).toBeNull();
    untouched(await storedPlan(), []);

    const allowed = await send("Can you mark Monday as rest?");
    expect(allowed.planChanges).toEqual([
      expect.objectContaining({ date: MON, dayType: "rest", run: null, line: mon, parsed: true }),
    ]);
    const stored = await storedPlan();
    expect(stored.days[0]).toMatchObject({ dayType: "rest", line: mon });
    untouched(stored, [MON]);
  });

  it("an unparsable line stores its own date unparsed; the other five days are untouched; the card shows both", async () => {
    const thu = `Thu ${THU}: easy, 4 mi.`;
    const sat = `Sat ${SAT}: easy 5, by feel.`;
    const { send, storedPlan, rows } = await liveApp([
      { body: "Thursday eases off and Saturday stays short.", changes: `${thu}\n${sat}` },
    ]);
    const reply = await send("Can we ease Thursday and Saturday?");

    expect(reply.planChanges).toHaveLength(2);
    expect(reply.planChanges![0]).toMatchObject({ date: THU, line: thu, parsed: true });
    expect(reply.planChanges![1]).toEqual({
      date: SAT,
      dayType: "other",
      run: null,
      notes: sat,
      line: sat,
      parsed: false,
    });
    const stored = await storedPlan();
    expect(stored.days[3]).toMatchObject({ date: THU, parsed: true });
    expect(stored.days[5]).toMatchObject({ date: SAT, parsed: false, line: sat });
    untouched(stored, [THU, SAT]);
    expect(rows.map((r) => r.outcome)).toEqual(["repaired"]);
    expect(rows[0]!.errorMessage).toContain(`changes ${SAT} not filed: no distance unit`);
  });

  it("a line for a date outside the week is dropped and noted in the call log", async () => {
    const { send, storedPlan, rows } = await liveApp([
      { body: "Next Monday starts easy.", changes: "Mon 2026-10-26: easy, 3 mi." },
    ]);
    expect((await send("What about next Monday?")).planChanges).toBeNull();
    untouched(await storedPlan(), []);
    expect(rows.map((r) => r.outcome)).toEqual(["repaired"]);
    expect(rows[0]!.errorMessage).toContain("changes line for 2026-10-26 dropped: outside the plan week");
  });

  it.each([
    ["an empty", { body: "Keep the week as it is.", changes: "" }],
    ["an absent", { body: "Keep the week as it is." }],
    ["a null", { body: "Keep the week as it is.", changes: null }],
  ])("%s changes box leaves the plan untouched and makes no card", async (_label, answer) => {
    const { send, storedPlan, rows } = await liveApp([answer]);
    expect((await send("Should I change anything?")).planChanges).toBeNull();
    untouched(await storedPlan(), []);
    expect(rows.map((r) => r.outcome)).toEqual(["ok"]);
  });
});

describe("the mid-week form's validator", () => {
  it("lists the week's dates whose line failed as planFailures, not the dates with no line or outside the week", () => {
    const checked = validateMidWeekChatReply(
      {
        body: "Changes.",
        changes: [`Thu ${THU}: easy 5, by feel.`, `Fri ${DATES[4]}: easy.`, `Sun ${SUN}: long, 9 mi.`, "Mon 2026-10-26: easy, 3 mi."].join("\n"),
      },
      WEEK_START,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.planFailures).toEqual([
      { date: THU, reason: "no distance unit" },
      { date: DATES[4], reason: "no distance or duration" },
    ]);
    expect(checked.value.prescribedDayPatches!.map((d) => [d.date, d.parsed])).toEqual([
      [THU, false],
      [DATES[4], false],
      [SUN, true],
    ]);
  });

  it("has no planFailures when every line parses or there are no changes", () => {
    const parsed = validateMidWeekChatReply({ body: "b", changes: `Sun ${SUN}: long, 9 mi.` }, WEEK_START);
    expect(parsed.ok && parsed.planFailures).toBeUndefined();
    const none = validateMidWeekChatReply({ body: "b" });
    expect(none.ok && none.planFailures).toBeUndefined();
    expect(none.ok && none.value.prescribedDayPatches).toBeUndefined();
  });

  it("reads null optional boxes as absent and drops blank lines, as on the weekly form", () => {
    const checked = validateMidWeekChatReply({
      body: "b",
      settingsProposalBullets: null,
      safetyCallouts: ["", "Urgent: Chest pain. Stop and get it checked today."],
      allowPastDayPatches: null,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.settingsProposalBullets).toBeUndefined();
    expect(checked.value.safetyCallouts).toEqual([
      { title: "Chest pain.", body: "Stop and get it checked today.", severity: "urgent" },
    ]);
    expect(checked.value.allowPastDayPatches).toBeUndefined();
  });

  it("refuses a changes box that is not text", () => {
    const checked = validateMidWeekChatReply({ body: "b", changes: [`Sun ${SUN}: long, 9 mi.`] }, WEEK_START);
    expect(checked).toEqual({ ok: false, error: "changes must be a string of plan lines" });
  });
});

describe("what the model server is sent for a mid-week reply", () => {
  function packetFor(unit: "imperial" | "metric", withPlan = true): ModelPacket {
    return buildModelPacket({
      dossier: null,
      recapMarkdown: null,
      thread: [{ role: "athlete", body: "Can we ease Thursday?" }],
      attachments: [],
      week: { isoWeek: "2026-W43", start: `${WEEK_START}T00:00:00.000Z`, end: "2026-10-25T23:59:59.999Z" },
      prescribedWeek: withPlan ? plan() : null,
      coaching: { phase: "base", unitPreference: unit },
    });
  }

  async function sentFor(p: ModelPacket) {
    const sent: Array<{ system: string; messages: Array<{ content: string }>; tools: Array<{ name: string; input_schema: Record<string, unknown> }> }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return anthropicStreamResponse(anthropicToolMessage(TOOL, { body: "Fine." }));
    }) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({ fetchImpl, readApiKey: async () => "sk-ant-test" });
    await port.generateMidWeekChatReply(p);
    return sent[0]!;
  }

  it("a tool with only string, list-of-string and boolean boxes, each described, a changes box and no day objects", async () => {
    const sent = await sentFor(packetFor("imperial"));
    const [tool] = sent.tools;
    expect(tool!.name).toBe(TOOL);
    const schema = tool!.input_schema as {
      properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["allowPastDayPatches", "body", "changes", "safetyCallouts", "settingsProposalBullets"],
    );
    expect(schema.required).toEqual(["body"]);
    for (const [name, prop] of Object.entries(schema.properties)) {
      expect(prop.description, name).toMatch(/\w/);
      if (prop.type === "array") expect(prop.items, name).toEqual({ type: "string" });
      else expect(["string", "boolean"], name).toContain(prop.type);
    }
    expect(schema.properties.allowPastDayPatches!.type).toBe("boolean");
    expect(JSON.stringify(sent.tools)).not.toContain("prescribedDayPatches");
  });

  it("names the athlete's unit and gives an example line in the changes box, for an imperial and a metric athlete", async () => {
    const changesBox = (s: Awaited<ReturnType<typeof sentFor>>) =>
      (s.tools[0]!.input_schema as { properties: { changes: { description: string } } }).properties.changes.description;
    const imperial = changesBox(await sentFor(packetFor("imperial")));
    const metric = changesBox(await sentFor(packetFor("metric")));
    expect(imperial).toMatch(/distance in miles/);
    expect(imperial).toContain(`Example: Tue ${DATES[1]}: easy, 5 mi,`);
    expect(metric).toMatch(/distance in kilometres/);
    expect(metric).toContain(`Example: Tue ${DATES[1]}: easy, 8 km,`);
    expect(imperial).toMatch(/rest, easy, quality, long, race or other/);
    expect(imperial).toMatch(/Only the days you write change/);
  });

  it("the prompt asks for one line per changed day on the listed dates, or prose with changes empty when there is no plan", async () => {
    const withPlan = await sentFor(packetFor("metric"));
    const prompt = withPlan.messages[0]!.content;
    expect(prompt).toContain(`write one line per changed day in the changes box, using only these dates: ${DATES.join(", ")}`);
    expect(prompt).toContain("Past days stay as they are unless allowPastDayPatches is true.");
    expect(prompt).toContain("Write distances in kilometres.");
    expect(prompt).toContain(`Example change line: Tue ${DATES[1]}: easy, 8 km,`);
    expect(prompt).toContain("Do not rewrite the whole week unless the athlete asks.");
    expect(prompt).not.toContain("prescribedDayPatches");
    expect(withPlan.system).toMatch(/write those days in the changes box/);
    expect(withPlan.system).not.toContain("prescribedDayPatches");

    const noPlan = (await sentFor(packetFor("imperial", false))).messages[0]!.content;
    expect(noPlan).toContain("No plan for this week in the packet: reply in prose and leave changes empty.");
  });
});
