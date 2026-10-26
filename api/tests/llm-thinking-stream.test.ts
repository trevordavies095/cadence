import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  createAnthropicLlmPort,
  LlmHttpError,
  LlmSchemaError,
  LlmTransportError,
  resolveAnthropicEffort,
  resolveAnthropicTimeoutMs,
  type LlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import type {
  LlmCallRecord,
  LlmCallRecorder,
  LlmCallRow,
} from "../src/llmCallLog/types.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import {
  acceptAndReady,
  anthropicSseEvents,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
  type FakeAnthropicMessage,
} from "./helpers.js";

const API_KEY = "sk-ant-test-key-fixture-xyz";
const WEEKLY_TOOL = "submit_weekly_reply";
const MIDWEEK_TOOL = "submit_mid_week_chat_reply";
const THINKING_TEXT = "Checking the Achilles note before shaping Thursday.";

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

function memoryRecorder() {
  const rows: LlmCallRecord[] = [];
  const recorder: LlmCallRecorder = {
    record: async (row) => {
      rows.push(row);
    },
    get: async () => null,
    list: async () => [],
    exportAll: async function* (): AsyncGenerator<LlmCallRow> {},
  };
  return { rows, recorder };
}

type Flow = {
  name: string;
  tool: string;
  operation: string;
  call: (port: LlmPort, callId: string) => Promise<unknown>;
  okInput: () => unknown;
};

const FLOWS: Flow[] = [
  {
    name: "weekly reply",
    tool: WEEKLY_TOOL,
    operation: "weekly_reply",
    call: (port, callId) => port.generateWeeklyReply(samplePacket(), { callId }),
    okInput: () => buildStubWeeklyReply(samplePacket()),
  },
  {
    name: "mid-week chat",
    tool: MIDWEEK_TOOL,
    operation: "mid_week_chat",
    call: (port, callId) =>
      port.generateMidWeekChatReply(samplePacket(), { callId }),
    okInput: () => buildStubMidWeekChatReply(samplePacket()),
  },
];

function portWith(
  fetchImpl: typeof globalThis.fetch,
  recorder: LlmCallRecorder,
  extra: Partial<Parameters<typeof createAnthropicLlmPort>[0]> = {},
) {
  return createAnthropicLlmPort({
    fetchImpl,
    recorder,
    readApiKey: async () => API_KEY,
    ...extra,
  });
}

function fetchReturning(make: () => Response) {
  return vi.fn(async () => make()) as unknown as typeof globalThis.fetch &
    ReturnType<typeof vi.fn>;
}

/** A stream that sends `frames`, then stays open (optionally pinging). */
function hangingStream(frames: string[], pingEveryMs?: number): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      if (pingEveryMs) {
        timer = setInterval(() => {
          try {
            controller.enqueue(
              encoder.encode('event: ping\ndata: {"type": "ping"}\n\n'),
            );
          } catch {
            clearInterval(timer);
          }
        }, pingEveryMs);
      }
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("ANTHROPIC_EFFORT / timeout resolution", () => {
  it("defaults to xhigh and accepts the five levels", () => {
    expect(resolveAnthropicEffort({})).toBe("xhigh");
    expect(resolveAnthropicEffort({ ANTHROPIC_EFFORT: "  " })).toBe("xhigh");
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(resolveAnthropicEffort({ ANTHROPIC_EFFORT: level })).toBe(level);
    }
  });

  it("rejects an invalid value with a clear message", () => {
    expect(() => resolveAnthropicEffort({ ANTHROPIC_EFFORT: "extra" })).toThrow(
      /Invalid ANTHROPIC_EFFORT "extra".*low, medium, high, xhigh, max/,
    );
  });

  it("overall cap defaults to 15 minutes", () => {
    expect(resolveAnthropicTimeoutMs({})).toBe(900_000);
  });
});

for (const flow of FLOWS) {
  describe(`thinking + streaming adapter: ${flow.name}`, () => {
    it("sends adaptive thinking, effort, auto tool choice, max_tokens 64000 and stream", async () => {
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() =>
        anthropicStreamResponse(anthropicToolMessage(flow.tool, flow.okInput())),
      );
      await flow.call(portWith(fetchImpl, recorder, { effort: "high" }), "call-1");

      const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]![1] as RequestInit;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(body.output_config).toEqual({ effort: "high" });
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect(body.max_tokens).toBe(64000);
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("budget_tokens");
      expect(String(body.system)).toContain(flow.tool);
      expect(JSON.stringify(body.messages)).toContain(
        `Call the ${flow.tool} tool exactly once`,
      );
      expect(rows[0]!.request).toMatchObject({ stream: true, tool_choice: { type: "auto" } });
    });

    it("defaults effort from ANTHROPIC_EFFORT, else xhigh", async () => {
      const prev = process.env.ANTHROPIC_EFFORT;
      try {
        for (const [env, expected] of [
          [undefined, "xhigh"],
          ["max", "max"],
        ] as const) {
          if (env === undefined) delete process.env.ANTHROPIC_EFFORT;
          else process.env.ANTHROPIC_EFFORT = env;
          const { recorder } = memoryRecorder();
          const fetchImpl = fetchReturning(() =>
            anthropicStreamResponse(
              anthropicToolMessage(flow.tool, flow.okInput()),
            ),
          );
          await flow.call(portWith(fetchImpl, recorder), "call-e");
          const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]![1] as RequestInit;
          expect(JSON.parse(String(init.body)).output_config).toEqual({
            effort: expected,
          });
        }
      } finally {
        if (prev === undefined) delete process.env.ANTHROPIC_EFFORT;
        else process.env.ANTHROPIC_EFFORT = prev;
      }
    });

    it("reassembles thinking, text and tool_use and logs the non-streaming shape", async () => {
      const input = flow.okInput();
      const message: FakeAnthropicMessage = {
        id: "msg_think_1",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 900,
          output_tokens: 4200,
          output_tokens_details: { thinking_tokens: 3900 },
        },
        content: [
          { type: "thinking", thinking: THINKING_TEXT, signature: "sig_abc123" },
          { type: "text", text: "Here is my answer." },
          { type: "tool_use", id: "toolu_1", name: flow.tool, input },
        ],
      };
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() => anthropicStreamResponse(message));
      const reply = await flow.call(portWith(fetchImpl, recorder), "call-2");
      expect(reply).toEqual(input);

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        outcome: "ok",
        httpStatus: 200,
        stopReason: "tool_use",
        inputTokens: 900,
        outputTokens: 4200,
        thinkingTokens: 3900,
        errorMessage: null,
      });
      const raw = JSON.parse(row.responseRaw as string);
      expect(raw).toMatchObject({
        id: "msg_think_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        stop_reason: "tool_use",
      });
      expect(raw.usage).toMatchObject({
        input_tokens: 900,
        output_tokens: 4200,
        output_tokens_details: { thinking_tokens: 3900 },
      });
      expect(raw.content).toEqual([
        { type: "thinking", thinking: THINKING_TEXT, signature: "sig_abc123" },
        { type: "text", text: "Here is my answer." },
        { type: "tool_use", id: "toolu_1", name: flow.tool, input },
      ]);
    });

    it("reports a null thinking_tokens when usage omits it", async () => {
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() =>
        anthropicStreamResponse(anthropicToolMessage(flow.tool, flow.okInput())),
      );
      await flow.call(portWith(fetchImpl, recorder), "call-3");
      expect(rows[0]!.thinkingTokens).toBeNull();
    });

    it("treats a response with no reply tool call as schema_invalid", async () => {
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() =>
        anthropicStreamResponse({
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 15 },
          },
          content: [{ type: "text", text: "Just prose, no tool." }],
        }),
      );
      await expect(
        flow.call(portWith(fetchImpl, recorder), "call-4"),
      ).rejects.toBeInstanceOf(LlmSchemaError);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "schema_invalid",
        stopReason: "end_turn",
        thinkingTokens: 15,
        errorMessage: expect.stringContaining(flow.tool),
      });
      expect(rows[0]!.responseRaw).toContain("Just prose, no tool.");
    });

    it("maps a refusal stop_reason to schema_invalid with the category", async () => {
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() =>
        anthropicStreamResponse({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
          content: [{ type: "text", text: "I can't help with that." }],
        }),
      );
      await expect(
        flow.call(portWith(fetchImpl, recorder), "call-5"),
      ).rejects.toBeInstanceOf(LlmSchemaError);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "schema_invalid",
        stopReason: "refusal",
        errorMessage: expect.stringMatching(/refus.*category=cyber/),
      });
    });

    it("maps a refusal without a category to schema_invalid", async () => {
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() =>
        anthropicStreamResponse({
          stop_reason: "refusal",
          content: [{ type: "text", text: "No." }],
        }),
      );
      await expect(
        flow.call(portWith(fetchImpl, recorder), "call-6"),
      ).rejects.toBeInstanceOf(LlmSchemaError);
      expect(rows[0]!.errorMessage).toMatch(/stop_reason=refusal/);
      expect(rows[0]!.errorMessage).not.toContain("category");
    });

    it("maps max_tokens to schema_invalid even if a tool block was started", async () => {
      const { recorder, rows } = memoryRecorder();
      const fetchImpl = fetchReturning(() =>
        anthropicStreamResponse({
          stop_reason: "max_tokens",
          usage: {
            input_tokens: 5,
            output_tokens: 64000,
            output_tokens_details: { thinking_tokens: 64000 },
          },
          content: [
            { type: "thinking", thinking: "Still thinking...", signature: "s" },
          ],
        }),
      );
      await expect(
        flow.call(portWith(fetchImpl, recorder), "call-7"),
      ).rejects.toBeInstanceOf(LlmSchemaError);
      expect(rows[0]).toMatchObject({
        outcome: "schema_invalid",
        stopReason: "max_tokens",
        thinkingTokens: 64000,
        errorMessage: expect.stringContaining("max_tokens"),
      });
    });

    it("aborts after the idle limit with transport_error", async () => {
      const { recorder, rows } = memoryRecorder();
      const first = anthropicSseEvents(
        anthropicToolMessage(flow.tool, flow.okInput()),
      ).slice(0, 3);
      const fetchImpl = fetchReturning(() => hangingStream(first));
      const started = Date.now();
      await expect(
        flow.call(
          portWith(fetchImpl, recorder, { idleTimeoutMs: 60, timeoutMs: 10_000 }),
          "call-8",
        ),
      ).rejects.toBeInstanceOf(LlmTransportError);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "transport_error",
        errorMessage: expect.stringMatching(/idle/),
      });
      // The partial message is still logged for debugging.
      expect(JSON.parse(rows[0]!.responseRaw as string).id).toBe("msg_test");
    });

    it("aborts at the overall cap even while pings keep arriving", async () => {
      const { recorder, rows } = memoryRecorder();
      const start = anthropicSseEvents(
        anthropicToolMessage(flow.tool, flow.okInput()),
      ).slice(0, 1);
      const fetchImpl = fetchReturning(() => hangingStream(start, 10));
      await expect(
        flow.call(
          portWith(fetchImpl, recorder, { idleTimeoutMs: 5000, timeoutMs: 150 }),
          "call-9",
        ),
      ).rejects.toBeInstanceOf(LlmTransportError);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "transport_error",
        errorMessage: expect.stringMatching(/overall/),
      });
      expect(rows[0]!.latencyMs).toBeGreaterThanOrEqual(140);
    });

    it("maps HTTP 4xx and 5xx before streaming to http_error", async () => {
      for (const status of [400, 529]) {
        const { recorder, rows } = memoryRecorder();
        const fetchImpl = fetchReturning(
          () =>
            new Response(
              JSON.stringify({ type: "error", error: { type: "api_error" } }),
              { status, headers: { "content-type": "application/json" } },
            ),
        );
        await expect(
          flow.call(portWith(fetchImpl, recorder), `call-h${status}`),
        ).rejects.toSatisfy(
          (err: unknown) => err instanceof LlmHttpError && err.status === status,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome: "http_error",
          httpStatus: status,
          errorMessage: expect.stringContaining(String(status)),
        });
        expect(rows[0]!.responseRaw).toContain("api_error");
      }
    });

    it("maps a mid-stream error event to transport_error, logged once", async () => {
      const { recorder, rows } = memoryRecorder();
      const frames = anthropicSseEvents(
        anthropicToolMessage(flow.tool, flow.okInput()),
      ).slice(0, 4);
      frames.push(
        'event: error\ndata: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}\n\n',
      );
      const fetchImpl = fetchReturning(
        () =>
          new Response(frames.join(""), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      await expect(
        flow.call(portWith(fetchImpl, recorder), "call-10"),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof LlmTransportError && /overloaded_error/.test(err.message),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "transport_error",
        httpStatus: 200,
        errorMessage: expect.stringContaining("Overloaded"),
      });
    });

    it("maps a stream cut off before message_stop to transport_error", async () => {
      const { recorder, rows } = memoryRecorder();
      const frames = anthropicSseEvents(
        anthropicToolMessage(flow.tool, flow.okInput()),
      );
      const fetchImpl = fetchReturning(
        () =>
          new Response(frames.slice(0, -1).join(""), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      await expect(
        flow.call(portWith(fetchImpl, recorder), "call-11"),
      ).rejects.toBeInstanceOf(LlmTransportError);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("transport_error");
      expect(rows[0]!.errorMessage).toMatch(/message_stop/);
    });
  });
}

describe("thinking_tokens in the LLM call log (Postgres + routes)", () => {
  let prevProvider: string | undefined;

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    prevProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "anthropic";
    return () => {
      if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevProvider;
    };
  });

  async function liveApp(fetchImpl: typeof globalThis.fetch) {
    await acceptAndReady();
    await putAnthropicConnection(
      API_KEY,
      new SecretProtector(TEST_DATA_PROTECTION_KEY),
    );
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmFetch: fetchImpl,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, weekSessionId: week.id as string };
  }

  function thinkingMessage(tool: string, input: unknown): FakeAnthropicMessage {
    return {
      stop_reason: "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 700,
        output_tokens_details: { thinking_tokens: 612 },
      },
      content: [
        { type: "thinking", thinking: THINKING_TEXT, signature: "sig_db" },
        { type: "tool_use", id: "toolu_db", name: tool, input },
      ],
    };
  }

  async function expectLogged(
    app: ReturnType<typeof createApp>,
    operation: string,
  ) {
    const list = (await (await app.request("/llm-calls")).json()) as Array<
      Record<string, unknown>
    >;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ operation, thinkingTokens: 612, outcome: "ok" });
    const id = list[0]!.id as string;

    const got = await json(await app.request(`/llm-calls/${id}`));
    expect(got.thinkingTokens).toBe(612);
    const raw = JSON.parse(got.responseRaw as string);
    expect(raw.content[0]).toEqual({
      type: "thinking",
      thinking: THINKING_TEXT,
      signature: "sig_db",
    });
    expect(raw.usage.output_tokens_details.thinking_tokens).toBe(612);
    expect(got.request).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      stream: true,
    });

    const exported = (await (await app.request("/llm-calls/export")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(exported).toHaveLength(1);
    expect(exported[0]!.thinkingTokens).toBe(612);
  }

  it("stores and exposes thinking_tokens for the weekly reply", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicStreamResponse(
        thinkingMessage(WEEKLY_TOOL, buildStubWeeklyReply(samplePacket())),
      ),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);
    await unlockPlanCheckIn(app, weekSessionId);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
    expect(res.status).toBe(200);
    await expectLogged(app, "weekly_reply");
  });

  it("stores and exposes thinking_tokens for mid-week chat", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicStreamResponse(
        thinkingMessage(MIDWEEK_TOOL, { body: "Keep Thursday easy." }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);
    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How should Thursday look?" }),
    });
    expect(res.status).toBe(201);
    await expectLogged(app, "mid_week_chat");
  });

  it("exposes a null thinking_tokens for stub rows and rows without it", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicStreamResponse(
        anthropicToolMessage(MIDWEEK_TOOL, { body: "Fine." }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);
    await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Quick one" }),
    });
    const list = (await (await app.request("/llm-calls")).json()) as Array<
      Record<string, unknown>
    >;
    expect(list[0]).toHaveProperty("thinkingTokens", null);
  });
});
