import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  buildStubWeeklyReply,
  createAnthropicLlmPort,
  createStubLlmPort,
  expectedPlanDates,
  TESTED_COACH_MODEL,
  validateWeeklyReply,
  type LlmPort,
  type WeeklyReply,
} from "../src/llm/index.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { saveCoachModel } from "../src/settings/coachModelStore.js";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const WEEK_START = "2026-10-26";

function plan() {
  return {
    week: "2026-W44",
    days: expectedPlanDates(WEEK_START).map((date) => ({ date, dayType: "rest", run: null })),
  };
}

describe("a plan sent as a string", () => {
  const reply = (prescribedWeek: unknown) => ({
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek,
  });

  it("is parsed and accepted when the string is well-formed, with the repair noted", () => {
    const checked = validateWeeklyReply(reply(JSON.stringify(plan())), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.prescribedWeek.days).toHaveLength(7);
    expect(checked.repairs).toContain("prescribedWeek arrived as a string of JSON and was parsed");
  });

  it("is refused when the string is malformed", () => {
    const broken = JSON.stringify(plan()).replace('"rest","run":null}', '"rest","run":null}}');
    expect(validateWeeklyReply(reply(broken), WEEK_START).ok).toBe(false);
  });
});

function samplePacket(): ModelPacket {
  return buildModelPacket({
    dossier: { versionId: 1, body: "Keep Achilles easy; cap quality." },
    recapMarkdown: "## Summary\nSteady aerobic week.",
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

/** The same plan a week late: every date outside the plan week. */
function aWeekLate(reply: WeeklyReply): WeeklyReply {
  const later = (ymd: string) => {
    const d = new Date(`${ymd}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  };
  return {
    ...reply,
    prescribedWeek: {
      ...reply.prescribedWeek,
      days: reply.prescribedWeek.days.map((day) => ({ ...day, date: later(day.date) })),
    },
  };
}

describe("a refused weekly reply is asked for once more", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  type Answer = "good" | "refused" | "a week late";

  /**
   * The live adapter against a fake server whose replies are `answers` in
   * order, then good ones. Every request is kept, and the call log in memory.
   * `beforeAnswer` runs while each request is out.
   */
  async function liveServer(
    answers: Answer[],
    beforeAnswer: (request: number) => Promise<void> = async () => {},
  ) {
    await putAnthropicConnection("sk-ant-first-key", new SecretProtector(TEST_DATA_PROTECTION_KEY));
    const packet = samplePacket();
    const sent: Array<{ url: string; key: string | null; body: string }> = [];
    const rows: LlmCallRecord[] = [];
    const recorder = {
      record: async (row: LlmCallRecord) => {
        rows.push(row);
      },
      get: async () => null,
    } as unknown as LlmCallRecorder;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        key: new Headers(init?.headers).get("x-api-key"),
        body: String(init?.body),
      });
      await beforeAnswer(sent.length);
      const answer = answers[sent.length - 1] ?? "good";
      const good = buildStubWeeklyReply(packet);
      const toolInput =
        answer === "good"
          ? good
          : answer === "a week late"
            ? aWeekLate(good)
            : { headline: "", prescribedWeek: null };
      return anthropicStreamResponse(anthropicToolMessage("submit_weekly_reply", toolInput));
    }) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: "http://fake-anthropic.test/v1/messages",
      recorder,
    });
    return { port, packet, sent, rows };
  }

  async function askForReply(port: LlmPort, packet?: ModelPacket) {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: port,
    });
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        packet
          ? { weekSessionId: week.id, packet }
          : { weekSessionId: week.id, recapMarkdown: "## Summary\nSteady week." },
      ),
    });
  }

  it("answers on the first try without asking again", async () => {
    const { port, packet, sent } = await liveServer([]);
    expect((await askForReply(port, packet)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("recovers when the model's reply is refused the first time", async () => {
    const { port, packet, sent } = await liveServer(["refused"]);
    const res = await askForReply(port, packet);
    expect(res.status).toBe(200);
    expect((await json(res)).prescribed).toBeTruthy();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe(sent[0]!.body);
  });

  it("hands both attempts the one model and effort it resolved for the run", async () => {
    const { port, packet, sent } = await liveServer(["refused"]);
    expect((await askForReply(port, packet)).status).toBe(200);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(JSON.parse(call.body)).toMatchObject({
        model: TESTED_COACH_MODEL.model,
        output_config: { effort: TESTED_COACH_MODEL.effort },
      });
    }
    expect(sent[1]!.body).toBe(sent[0]!.body);
  });

  it("sends both live attempts to the same URL, key, model and effort when Settings change in between", async () => {
    const protector = new SecretProtector(TEST_DATA_PROTECTION_KEY);
    const { port, packet, sent } = await liveServer(["refused"], async (request) => {
      if (request !== 1) return;
      // Settings change while the first attempt is out; it comes back refused for its shape.
      await putAnthropicConnection("sk-ant-second-key", protector);
      await saveCoachModel({ provider: "anthropic", model: "claude-opus-5-5", effort: "low" });
    });
    await saveCoachModel({ provider: "anthropic", model: "claude-opus-4-6", effort: "high" });

    expect((await askForReply(port, packet)).status).toBe(200);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.url).toBe("http://fake-anthropic.test/v1/messages");
      expect(call.key).toBe("sk-ant-first-key");
      expect(JSON.parse(call.body)).toMatchObject({
        model: "claude-opus-4-6",
        output_config: { effort: "high" },
      });
    }
    expect(sent[1]!.body).toBe(sent[0]!.body);
  });

  it("logs both attempts on the one target, the second linked to the first, and links the read to the second", async () => {
    const { port, packet, rows } = await liveServer(["refused"]);
    const res = await askForReply(port, packet);
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: "schema_invalid", parentCallId: null });
    expect(rows[1]).toMatchObject({ outcome: "ok", parentCallId: rows[0]!.id });
    expect(rows[1]!.model).toBe(rows[0]!.model);
    expect(rows[1]!.request).toEqual(rows[0]!.request);
    const body = await json(res);
    expect((body.coachMessage as { llmCallId: string }).llmCallId).toBe(rows[1]!.id);
  });

  it("refuses a plan for the wrong week inside the adapter and asks for it once more", async () => {
    const { port, packet, sent, rows } = await liveServer(["a week late"]);
    const res = await askForReply(port, packet);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(rows[0]).toMatchObject({
      outcome: "schema_invalid",
      errorMessage: expect.stringContaining(`date must be ${WEEK_START}`),
    });
    const days = (await json(res)).prescribed as { plan: { days: Array<{ date: string }> } };
    expect(days.plan.days.map((d) => d.date)).toEqual(expectedPlanDates(WEEK_START));
  });

  it("reports a plan for the wrong week twice as a failure, after two requests", async () => {
    const { port, packet, sent, rows } = await liveServer(["a week late", "a week late"]);
    const res = await askForReply(port, packet);
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_schema_invalid");
    expect(sent).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(["schema_invalid", "schema_invalid"]);
  });

  it("the route's final check refuses a bad reply a port hands back, and does not ask again", async () => {
    const stub = createStubLlmPort();
    let calls = 0;
    const port: LlmPort = {
      ...stub,
      async generateWeeklyReply(p, o) {
        calls += 1;
        return { ...(await stub.generateWeeklyReply(p, o)), headline: "" } as WeeklyReply;
      },
    };
    const res = await askForReply(port);
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_schema_invalid");
    expect(calls).toBe(1);
  });

  it("asks only once more, then reports the failure", async () => {
    const { port, packet, sent } = await liveServer(["refused", "refused", "refused"]);
    const res = await askForReply(port, packet);
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_schema_invalid");
    expect(sent).toHaveLength(2);
  });

  it("asks once more when the first live reply stops at the output cap", async () => {
    await putAnthropicConnection("sk-ant-first-key", new SecretProtector(TEST_DATA_PROTECTION_KEY));
    const packet = samplePacket();
    const bodies: Array<{ max_tokens: number }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { max_tokens: number });
      if (bodies.length > 1) {
        return anthropicStreamResponse(
          anthropicToolMessage("submit_weekly_reply", buildStubWeeklyReply(packet)),
        );
      }
      return anthropicStreamResponse({
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 20_000 },
        content: [{ type: "text", text: "thinking ran long" }],
      });
    }) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: "http://fake-anthropic.test/v1/messages",
    });

    expect((await askForReply(port, packet)).status).toBe(200);
    expect(bodies.map((b) => b.max_tokens)).toEqual([20_000, 20_000]);
  });
});
