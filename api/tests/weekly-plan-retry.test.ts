/**
 * The retry carries the parse errors (plan-as-text ticket 08), through the app
 * with a fake model server: a weekly plan with days Cadence could not read is
 * asked for once more, quoting the failed dates and reasons as an error tool
 * result after the assistant turn as received, and only those dates are taken
 * from the second reply. A reply with no tool call gets one plain "call the
 * tool" turn. Two requests at most, on one target, both logged and linked.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  createAnthropicLlmPort,
  expectedPlanDates,
  type AttemptReport,
  type PrescribedWeek,
} from "../src/llm/index.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  retryTurns,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
  type FakeAnthropicMessage,
} from "./helpers.js";
import { planLines, weeklyForm } from "./weeklyForms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const NOW = new Date("2026-10-21T15:00:00.000Z");
const PLAN_MONDAY = "2026-10-26";
const DATES = expectedPlanDates(PLAN_MONDAY);
const MESSAGES_URL = "http://fake-anthropic.test/v1/messages";
const KEY = "sk-ant-retry-key";
const THINKING = "Weighing load, recent runs and the athlete's note.";

function packet(): ModelPacket {
  return buildModelPacket({
    dossier: null,
    recapMarkdown: "## Summary\nSteady aerobic week.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    },
    coaching: { phase: "base", unitPreference: "imperial" },
  });
}

const GOOD = planLines(PLAN_MONDAY);
/** Thursday a bare number, Saturday no day type word; the rest well formed. */
const TWO_BAD = [...GOOD];
TWO_BAD[3] = `Thu ${DATES[3]}: easy 5, relaxed.`;
TWO_BAD[5] = `Sat ${DATES[5]}: 3 mi with friends.`;
const TWO_BAD_MESSAGE =
  `Thu ${DATES[3]}: no distance unit.\nSat ${DATES[5]}: no day type word.\n\n` +
  "Send the plan box again with these lines fixed. Change nothing else.";

type Sent = { url: string; key: string | null; raw: string; body: Record<string, unknown> };

/**
 * The live adapter, through the app, against a fake server answering request
 * n with `answers[n - 1]` (a tool input, or a whole message), then the last.
 */
async function liveApp(answers: Array<unknown | { message: FakeAnthropicMessage }>) {
  await acceptAndReady();
  await putAnthropicConnection(KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const sent: Sent[] = [];
  const rows: LlmCallRecord[] = [];
  const recorder = {
    record: async (row: LlmCallRecord) => {
      rows.push(row);
    },
    get: async (id: string) => rows.find((r) => r.id === id) ?? null,
    list: async () => [],
    async *exportAll() {},
  } as unknown as LlmCallRecorder;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body);
    sent.push({
      url: String(input),
      key: new Headers(init?.headers).get("x-api-key"),
      raw,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    const answer = answers[Math.min(sent.length, answers.length) - 1];
    const message =
      answer && typeof answer === "object" && "message" in answer
        ? (answer as { message: FakeAnthropicMessage }).message
        : anthropicToolMessage("submit_weekly_reply", answer);
    return anthropicStreamResponse(message);
  }) as unknown as typeof globalThis.fetch;
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmPort: createAnthropicLlmPort({
      fetchImpl,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: MESSAGES_URL,
      recorder,
    }),
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  const weekSessionId = week.id as string;
  await unlockPlanCheckIn(app, weekSessionId);
  return { app, weekSessionId, sent, rows };
}

async function reply(answers: Array<unknown | { message: FakeAnthropicMessage }>) {
  const live = await liveApp(answers);
  const res = await live.app.request("/week/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ weekSessionId: live.weekSessionId, packet: packet() }),
  });
  const body = await json(res);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const plan = (body.prescribed as { plan: PrescribedWeek; readSections: { headline: string } | null });
  return { ...live, body, plan: plan.plan, readSections: plan.readSections };
}

/** The tool_use block the fake server sends for `input`, as the assistant turn carries it. */
function toolUse(input: unknown) {
  return { type: "tool_use", id: "toolu_test", name: "submit_weekly_reply", input };
}

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  delete process.env.TEMPO_EXPORT_PATH;
});

describe("a plan with days Cadence could not read is asked for once more, those dates alone", () => {
  it("sends one retry: the user turn, the assistant turn as received, and an error tool result naming each date and reason", async () => {
    const first = weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") });
    const { sent } = await reply([first, { plan: GOOD.join("\n") }]);
    expect(sent).toHaveLength(2);
    const added = retryTurns(sent[0]!.raw, sent[1]!.raw);
    expect((sent[1]!.body.messages as unknown[])[0]).toEqual((sent[0]!.body.messages as unknown[])[0]);
    expect(added).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: THINKING, signature: "sig_test_fixture" }, toolUse(first)],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_test", is_error: true, content: TWO_BAD_MESSAGE }],
      },
    ]);
    // Thinking settings are the first request's: adaptive on Anthropic.
    expect(sent[1]!.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("takes only the failed dates from the second reply: a changed Tuesday there does not alter the stored Tuesday", async () => {
    const second = [...GOOD];
    second[1] = `Tue ${DATES[1]}: quality, 8 mi, hard.`;
    const { plan, readSections } = await reply([
      weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") }),
      weeklyForm(PLAN_MONDAY, { headline: "A different headline.", plan: second.join("\n") }),
    ]);
    expect(plan.days.every((d) => d.parsed === true)).toBe(true);
    expect(plan.days[1]).toMatchObject({ dayType: "easy", line: GOOD[1] });
    expect(plan.days[3]).toMatchObject({ line: GOOD[3], parsed: true });
    expect(plan.days[5]).toMatchObject({ line: GOOD[5], parsed: true });
    // The read comes from the first reply.
    expect(readSections?.headline).toBe("A steady week. Keep the easy days easy.");
  });

  it("keeps a date that fails again unparsed, with the first reply's line", async () => {
    const second = [...GOOD];
    second[5] = `Sat ${DATES[5]}: 4 mi with the club.`;
    const { plan, rows } = await reply([
      weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") }),
      { plan: second.join("\n") },
    ]);
    expect(plan.days[3]).toMatchObject({ line: GOOD[3], parsed: true });
    expect(plan.days[5]).toMatchObject({ line: TWO_BAD[5], parsed: false, run: null });
    expect(rows[1]!.errorMessage).toBe(
      `plan ${DATES[3]} filed by the retry; plan ${DATES[5]} still not filed: no day type word`,
    );
  });

  it("quotes a missing date and an out-of-week line too, and files the missing date from the retry", async () => {
    const first = [...TWO_BAD];
    first.splice(4, 1); // no Friday
    first.push("Mon 2026-11-02: easy, 4 mi.");
    const { sent, plan } = await reply([
      weeklyForm(PLAN_MONDAY, { plan: first.join("\n") }),
      { plan: GOOD.join("\n") },
    ]);
    const added = retryTurns(sent[0]!.raw, sent[1]!.raw);
    expect((added[1]!.content as Array<{ content: string }>)[0]!.content).toBe(
      `Thu ${DATES[3]}: no distance unit.\nFri ${DATES[4]}: no line.\nSat ${DATES[5]}: no day type word.\n` +
        "Mon 2026-11-02: outside the plan week.\n\n" +
        "Send the plan box again with these lines fixed. Change nothing else.",
    );
    expect(plan.days.map((d) => d.parsed)).toEqual([true, true, true, true, true, true, true]);
    expect(plan.days.map((d) => d.date)).toEqual(DATES);
  });

  it("logs both rows on one target, the retry linked to the first and naming the dates it fixed; the read links to the first", async () => {
    const { sent, rows, body } = await reply([
      weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") }),
      { plan: GOOD.join("\n") },
    ]);
    expect(sent.map((s) => [s.url, s.key])).toEqual([
      [MESSAGES_URL, KEY],
      [MESSAGES_URL, KEY],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      outcome: "repaired",
      parentCallId: null,
      errorMessage: `plan ${DATES[3]} not filed: no distance unit; plan ${DATES[5]} not filed: no day type word`,
    });
    expect(rows[1]).toMatchObject({
      outcome: "repaired",
      parentCallId: rows[0]!.id,
      errorMessage: `plan ${DATES[3]} filed by the retry; plan ${DATES[5]} filed by the retry`,
    });
    expect(rows[1]!.model).toBe(rows[0]!.model);
    expect((rows[1]!.request as { output_config: unknown }).output_config).toEqual(
      (rows[0]!.request as { output_config: unknown }).output_config,
    );
    expect((body.coachMessage as { llmCallId: string }).llmCallId).toBe(rows[0]!.id);
  });

  it("keeps the first reply as it was when the retry is refused outright, and never sends a third request", async () => {
    const { sent, plan, rows } = await reply([
      weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") }),
      { plan: "" },
    ]);
    expect(sent).toHaveLength(2);
    expect(plan.days[3]).toMatchObject({ line: TWO_BAD[3], parsed: false });
    expect(plan.days[5]).toMatchObject({ line: TWO_BAD[5], parsed: false });
    expect(plan.days.filter((d) => d.parsed)).toHaveLength(5);
    expect(rows.map((r) => r.outcome)).toEqual(["repaired", "schema_invalid"]);
    expect(rows[1]).toMatchObject({
      parentCallId: rows[0]!.id,
      errorMessage: "plan is required: seven lines, one per day",
    });
  });

  it("keeps the unparsed days and the read when the retry stops at the output cap", async () => {
    const { sent, plan, readSections } = await reply([
      weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") }),
      { message: { stop_reason: "max_tokens", content: [{ type: "text", text: "ran long" }] } },
    ]);
    expect(sent).toHaveLength(2);
    expect(plan.days.filter((d) => d.parsed === false).map((d) => d.date)).toEqual([DATES[3], DATES[5]]);
    expect(readSections?.headline).toBe("A steady week. Keep the easy days easy.");
  });

  it("never sends a third request when the retry's lines fail again", async () => {
    const { sent } = await reply([weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") })]);
    expect(sent).toHaveLength(2);
  });

  it("sends no retry when every day parses", async () => {
    const { sent, rows } = await reply([weeklyForm(PLAN_MONDAY)]);
    expect(sent).toHaveLength(1);
    expect(rows.map((r) => r.outcome)).toEqual(["ok"]);
  });
});

describe("a reply with no tool call is asked once to call the tool", () => {
  it("follows the assistant turn as received with one plain-text turn, and takes the second reply whole", async () => {
    const { sent, plan, rows } = await reply([
      { message: { stop_reason: "end_turn", content: [{ type: "text", text: "Here is your plan." }] } },
      weeklyForm(PLAN_MONDAY),
    ]);
    expect(sent).toHaveLength(2);
    expect(retryTurns(sent[0]!.raw, sent[1]!.raw)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: THINKING, signature: "sig_test_fixture" },
          { type: "text", text: "Here is your plan." },
        ],
      },
      { role: "user", content: "You did not call the tool. Call it now with your full answer." },
    ]);
    expect(plan.days.every((d) => d.parsed)).toBe(true);
    expect(rows.map((r) => r.outcome)).toEqual(["schema_invalid", "ok"]);
    expect(rows[1]!.parentCallId).toBe(rows[0]!.id);
  });

  it("never sends a third request when the second reply calls no tool either", async () => {
    const live = await liveApp([
      { message: { stop_reason: "end_turn", content: [{ type: "text", text: "No tool." }] } },
    ]);
    const res = await live.app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: live.weekSessionId, packet: packet() }),
    });
    expect(res.status).toBe(502);
    expect(live.sent).toHaveLength(2);
  });
});

describe("the adapter reports each attempt's turns", () => {
  it("names a fix retry, its turns, the dates it was asked for and the dates it fixed", async () => {
    await putAnthropicConnection(KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
    const answers = [weeklyForm(PLAN_MONDAY, { plan: TWO_BAD.join("\n") }), { plan: GOOD.join("\n") }];
    let n = 0;
    const fetchImpl = (async () =>
      anthropicStreamResponse(anthropicToolMessage("submit_weekly_reply", answers[n++]))) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: MESSAGES_URL,
      recorder: { record: async () => {}, get: async () => null } as unknown as LlmCallRecorder,
    });
    const reports: AttemptReport[] = [];
    const reply = await port.generateWeeklyReply(packet(), { callId: "weekly-1", onAttempt: (r) => reports.push(r) });
    expect(reply.prescribedWeek.days.every((d) => d.parsed)).toBe(true);
    expect(reports.map((r) => [r.attempt, r.error, r.request])).toEqual([
      [1, null, { kind: "first", turns: ["user: text"] }],
      [
        2,
        null,
        {
          kind: "fix_lines",
          turns: ["user: text", "assistant: thinking, tool_use", "user: tool_result (error)"],
          fixDates: [DATES[3], DATES[5]],
          fixed: [DATES[3], DATES[5]],
        },
      ],
    ]);
    expect(reports[0]!.callId).toBe("weekly-1");
    expect(reports[1]!.callId).not.toBe("weekly-1");
  });
});
