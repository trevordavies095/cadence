/**
 * "Add the details" on a day (plan-as-text ticket 09), through the app with a
 * fake model server: one unread day of a stored plan is sent back with a short
 * prompt on the model saved now, and filed when its new line reads. The other
 * days and the plan's week are untouched; a line that still does not read, or
 * reads for another date, stores nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { pool } from "../src/db.js";
import {
  createAnthropicLlmPort,
  createStubLlmPort,
  expectedPlanDates,
  type PrescribedWeek,
} from "../src/llm/index.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/index.js";
import { createPostgresLlmCallRecorder } from "../src/llmCallLog/recorder.js";
import { migrate } from "../src/migrate.js";
import { NO_PLAN_GIVEN_NOTE, parsePlanLines } from "../src/prescribed/planLines.js";
import {
  getPrescribedWeekBySessionId,
  savePrescribedWeek,
} from "../src/prescribed/store.js";
import { createPendingRun, finishRun } from "../src/replyRun/store.js";
import { PLAN_DAY_FIX_FAILED_MESSAGE } from "../src/routes/prescribed.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { saveCoachModel } from "../src/settings/coachModelStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { ensureWeekSession } from "../src/week/store.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";
import { planLines } from "./weeklyForms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const NOW = new Date("2026-10-21T15:00:00.000Z");
const MONDAY = "2026-10-19";
const DATES = expectedPlanDates(MONDAY);
const MESSAGES_URL = "http://fake-anthropic.test/v1/messages";
const KEY = "sk-ant-details-key";
const TOOL = "submit_plan_day";

/** Thursday a bare number; Saturday left out; the rest well formed. */
const LINES = planLines(MONDAY);
LINES[3] = `Thu ${DATES[3]}: easy 5, relaxed.`;
const THU_LINE = LINES[3]!;
const WRITTEN = LINES.filter((_, i) => i !== 5);
const GOOD_THU = `Thu ${DATES[3]}: easy, 5 mi, relaxed.`;

function storedPlan(): PrescribedWeek {
  const read = parsePlanLines({ text: WRITTEN.join("\n"), weekStartMonday: MONDAY, unit: "imperial" });
  return { week: "2026-W43", days: read.days };
}

type Sent = { url: string; body: Record<string, unknown>; raw: string };

async function setup(options: { answers?: unknown[]; stub?: boolean; sunday?: boolean } = {}) {
  await acceptAndReady();
  await putAnthropicConnection(KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const sent: Sent[] = [];
  const rows: LlmCallRecord[] = [];
  const recorder = {
    record: async (row: LlmCallRecord) => {
      rows.push(row);
    },
  } as unknown as LlmCallRecorder;
  const answers = options.answers ?? [{ line: GOOD_THU }];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body);
    sent.push({ url: String(input), raw, body: JSON.parse(raw) as Record<string, unknown> });
    const answer = answers[Math.min(sent.length, answers.length) - 1];
    return anthropicStreamResponse(anthropicToolMessage(TOOL, answer));
  }) as unknown as typeof globalThis.fetch;
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmPort: options.stub
      ? createStubLlmPort({ recorder: createPostgresLlmCallRecorder() })
      : createAnthropicLlmPort({
          fetchImpl,
          dataProtectionKey: TEST_DATA_PROTECTION_KEY,
          apiUrl: MESSAGES_URL,
          recorder,
        }),
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  const weekSessionId = week.id as string;
  let sundayCallId: string | null = null;
  if (options.sunday !== false) {
    // The reviewed week's reply run kept the Sunday call's id.
    const { session: reviewed } = await ensureWeekSession(NOW, "2026-W42", week.timezone as string);
    const run = await createPendingRun(NOW, reviewed.id);
    sundayCallId = "6f0e4c4e-3d6b-4b7b-9a51-0c1f3d2b9a10";
    await finishRun(run!.id, { status: "ok", llmCallId: sundayCallId, errorMessage: null, at: NOW });
  }
  await savePrescribedWeek({
    weekSessionId,
    plan: storedPlan(),
    analysis: "The read.",
    readSections: { headline: "A steady week.", flags: [], answers: [] },
    at: NOW,
  });
  const details = (date: string) =>
    app.request(`/weeks/${weekSessionId}/prescribed/details`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date }),
    });
  return { app, weekSessionId, sent, rows, details, sundayCallId };
}

async function storedRaw(weekSessionId: string) {
  const r = await pool.query<{ plan: string; analysis: string; read_sections: string }>(
    "SELECT plan::text AS plan, analysis, read_sections::text AS read_sections FROM prescribed_weeks WHERE week_session_id = $1",
    [weekSessionId],
  );
  return r.rows[0]!;
}

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  delete process.env.TEMPO_EXPORT_PATH;
});

describe("Add the details: one unread day asked for again", () => {
  it("sends exactly one request, on the model saved now, naming the date, its line and the reason, with no packet", async () => {
    const { sent, details } = await setup();
    // Changed after Sunday: the call goes out on this one.
    await saveCoachModel({ provider: "anthropic", model: "claude-sonnet-4-5", effort: "low" });
    const res = await details(DATES[3]!);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(MESSAGES_URL);
    const body = sent[0]!.body;
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.output_config).toEqual({ effort: "low" });
    const tools = body.tools as Array<{ name: string; input_schema: { properties: Record<string, { type: string; description: string }> } }>;
    expect(tools.map((t) => t.name)).toEqual([TOOL]);
    expect(Object.keys(tools[0]!.input_schema.properties)).toEqual(["line"]);
    expect(tools[0]!.input_schema.properties.line!.type).toBe("string");
    expect(tools[0]!.input_schema.properties.line!.description).toContain(`Example: Thu ${DATES[3]}: easy, 5 mi`);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    const prompt = messages[0]!.content;
    expect(prompt).toContain(`The day to fill in: Thu ${DATES[3]}.`);
    expect(prompt).toContain(`Its line as written: ${JSON.stringify(THU_LINE)}`);
    expect(prompt).toContain("Why Cadence could not read it: no distance unit.");
    expect(prompt).toContain(DATES.join(", "));
    expect(prompt).toContain("Write distances in miles.");
    expect(sent[0]!.raw).not.toMatch(/Model packet|recapMarkdown|dossier/i);
    expect(String(body.system)).toContain("Write one line for this date only");
  });

  it("files that day alone, parsed; the week, the other six days and the read are byte-identical", async () => {
    const { details, weekSessionId } = await setup();
    const before = await storedRaw(weekSessionId);
    const res = await details(DATES[3]!);
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.day).toMatchObject({ date: DATES[3], dayType: "easy", line: GOOD_THU, parsed: true });
    const after = await storedRaw(weekSessionId);
    const b = JSON.parse(before.plan) as PrescribedWeek;
    const a = JSON.parse(after.plan) as PrescribedWeek;
    expect(a.week).toBe(b.week);
    for (let i = 0; i < 7; i++) {
      if (i === 3) continue;
      expect(JSON.stringify(a.days[i])).toBe(JSON.stringify(b.days[i]));
    }
    expect(a.days[3]).toMatchObject({ parsed: true, line: GOOD_THU, run: { type: "easy" } });
    expect(after.analysis).toBe(before.analysis);
    expect(after.read_sections).toBe(before.read_sections);
    expect((out.prescribed as { plan: PrescribedWeek }).plan).toEqual(a);
  });

  it("fills a day the plan left out, saying no line was written", async () => {
    const sat = `Sat ${DATES[5]}: long, 10 mi, easy effort.`;
    const { details, sent, weekSessionId } = await setup({ answers: [{ line: sat }] });
    const res = await details(DATES[5]!);
    expect(res.status).toBe(200);
    const prompt = (sent[0]!.body.messages as Array<{ content: string }>)[0]!.content;
    expect(prompt).toContain("No line was written for this date.");
    expect(prompt).toContain("Why Cadence could not read it: no line.");
    const stored = await getPrescribedWeekBySessionId(weekSessionId);
    expect(stored!.plan.days[5]).toMatchObject({ dayType: "long", parsed: true, line: sat });
  });

  it("a reply that still does not read is asked for once more, then stores nothing and returns the message", async () => {
    const { details, sent, weekSessionId, rows } = await setup({
      answers: [{ line: `Thu ${DATES[3]}: easy 6.` }, { line: `Thu ${DATES[3]}: easy 6 again.` }],
    });
    const before = await storedRaw(weekSessionId);
    const res = await details(DATES[3]!);
    const out = await json(res);
    expect(res.status).toBe(422);
    expect(out).toEqual({ error: "plan_day_not_filed", message: PLAN_DAY_FIX_FAILED_MESSAGE });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.raw).toContain(`Thu ${DATES[3]}: no distance or duration.`);
    expect(sent[1]!.body.model).toBe(sent[0]!.body.model);
    expect((await storedRaw(weekSessionId)).plan).toBe(before.plan);
    expect(rows.map((r) => r.outcome)).toEqual(["schema_invalid", "schema_invalid"]);
    expect(rows[1]!.parentCallId).toBe(rows[0]!.id);
    expect(rows.every((r) => r.operation === "plan_day_fix")).toBe(true);
  });

  it("a line for another date stores nothing", async () => {
    const wed = `Wed ${DATES[2]}: easy, 4 mi, relaxed.`;
    const { details, sent, weekSessionId } = await setup({ answers: [{ line: wed }] });
    const before = await storedRaw(weekSessionId);
    const res = await details(DATES[3]!);
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.raw).toContain(`the line is for Wed ${DATES[2]}, not Thu ${DATES[3]}`);
    expect((await storedRaw(weekSessionId)).plan).toBe(before.plan);
  });

  it("the call log row is plan_day_fix, linked to the Sunday call", async () => {
    const { details, rows, sundayCallId, weekSessionId } = await setup();
    await details(DATES[3]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "plan_day_fix",
      outcome: "ok",
      parentCallId: sundayCallId,
      weekSessionId,
    });
  });

  it("links to nothing when the Sunday call cannot be found", async () => {
    const { details, rows } = await setup({ sunday: false });
    await details(DATES[3]!);
    expect(rows[0]).toMatchObject({ operation: "plan_day_fix", parentCallId: null });
  });

  it("refuses a day already filed, a date outside the plan week, and a week with no plan", async () => {
    const { app, details, sent } = await setup();
    const filed = await details(DATES[0]!);
    expect(filed.status).toBe(409);
    expect(await json(filed)).toMatchObject({ error: "plan_day_already_filed" });
    const outside = await details("2026-10-26");
    expect(outside.status).toBe(400);
    expect(await json(outside)).toMatchObject({ error: "date_outside_plan_week" });
    const bad = await details("Thursday");
    expect(bad.status).toBe(400);
    const next = await json(await app.request("/weeks/current", { method: "POST" }));
    const other = await json(
      await app.request(`/weeks/${next.id as string}/prescribed/next`),
    );
    const noPlan = await app.request(
      `/weeks/${(other.weekSession as { id: string }).id}/prescribed/details`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-10-29" }),
      },
    );
    expect(noPlan.status).toBe(404);
    expect(await json(noPlan)).toMatchObject({ error: "prescribed_week_not_found" });
    expect(sent).toHaveLength(0);
  });

  it("the stub fills the day with a well-formed line and logs it", async () => {
    const { details, weekSessionId } = await setup({ stub: true });
    const res = await details(DATES[5]!);
    expect(res.status).toBe(200);
    const stored = await getPrescribedWeekBySessionId(weekSessionId);
    expect(stored!.plan.days[5]).toMatchObject({ dayType: "easy", parsed: true });
    expect(stored!.plan.days[3]).toMatchObject({ parsed: false, line: THU_LINE });
    const r = await pool.query<{ operation: string; provider: string; parent_call_id: string | null }>(
      "SELECT operation, provider, parent_call_id::text FROM llm_call_log",
    );
    expect(r.rows).toEqual([
      { operation: "plan_day_fix", provider: "stub", parent_call_id: "6f0e4c4e-3d6b-4b7b-9a51-0c1f3d2b9a10" },
    ]);
  });

  it("the stored plan starts as the test means: Thursday unread, Saturday with no line", () => {
    const plan = storedPlan();
    expect(plan.days[3]).toMatchObject({ parsed: false, line: THU_LINE });
    expect(plan.days[5]).toMatchObject({ parsed: false, line: null, notes: NO_PLAN_GIVEN_NOTE });
  });
});
