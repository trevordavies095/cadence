import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { buildStubWeeklyReply } from "../src/llm/index.js";
import { resolveAppVersion } from "../src/llmCallLog/appVersion.js";
import type {
  LlmCallRecord,
  LlmCallRecorder,
} from "../src/llmCallLog/index.js";
import { createPostgresLlmCallRecorder } from "../src/llmCallLog/recorder.js";
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
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const API_KEY = "sk-ant-test-key-fixture-xyz";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Flow = "weekly" | "midweek";

const FLOWS: Array<{
  flow: Flow;
  operation: string;
  tool: string;
  okStatus: number;
}> = [
  {
    flow: "weekly",
    operation: "weekly_reply",
    tool: "submit_weekly_reply",
    okStatus: 200,
  },
  {
    flow: "midweek",
    operation: "mid_week_chat",
    tool: "submit_mid_week_chat_reply",
    okStatus: 201,
  },
];

describe("LLM call log: failed calls (#69)", () => {
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

  /** Delegates to the real Postgres recorder and remembers the ids written. */
  function capturingRecorder(inner?: LlmCallRecorder) {
    const real = inner ?? createPostgresLlmCallRecorder();
    const ids: string[] = [];
    const recorder: LlmCallRecorder = {
      record: async (row: LlmCallRecord) => {
        ids.push(row.id);
        await real.record(row);
      },
      get: (id) => real.get(id),
    };
    return { recorder, ids };
  }

  async function liveApp(
    fetchImpl: typeof globalThis.fetch,
    llmCallRecorder: LlmCallRecorder,
    opts: { withKey?: boolean } = {},
  ) {
    await acceptAndReady();
    if (opts.withKey !== false) {
      await putAnthropicConnection(
        API_KEY,
        new SecretProtector(TEST_DATA_PROTECTION_KEY),
      );
    }
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmFetch: fetchImpl,
      llmCallRecorder,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;
    return { app, weekSessionId };
  }

  async function trigger(
    flow: Flow,
    app: ReturnType<typeof createApp>,
    weekSessionId: string,
  ): Promise<Response> {
    if (flow === "weekly") {
      await unlockPlanCheckIn(app, weekSessionId);
      return app.request("/week/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
      });
    }
    return app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How is my week going?" }),
    });
  }

  /**
   * The last call's row. A weekly reply refused for its shape is asked for once
   * more, so those flows log two calls; everything else logs one.
   */
  async function fetchRow(
    app: ReturnType<typeof createApp>,
    ids: string[],
    attempts = 1,
  ) {
    expect(ids).toHaveLength(attempts);
    const res = await app.request(`/llm-calls/${ids.at(-1)}`);
    expect(res.status).toBe(200);
    const row = await json(res);
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    return row;
  }

  for (const { flow, operation, tool } of FLOWS) {
    describe(`${operation}`, () => {
      function expectCommon(
        row: Record<string, unknown>,
        weekSessionId: string,
      ) {
        expect(row).toMatchObject({
          operation,
          provider: "anthropic",
          model: "claude-opus-4-7",
          appVersion: resolveAppVersion(),
          weekSessionId,
        });
        expect(row.latencyMs).toEqual(expect.any(Number));
        const request = row.request as { tools: Array<{ name: string }> };
        expect(request.tools[0]!.name).toBe(tool);
      }

      it("records http_error with the status and keeps the 502", async () => {
        const fetchImpl = vi.fn(async () =>
          jsonResponse({ type: "error", error: { type: "overloaded" } }, 529),
        ) as unknown as typeof globalThis.fetch;
        const { recorder, ids } = capturingRecorder();
        const { app, weekSessionId } = await liveApp(fetchImpl, recorder);

        const res = await trigger(flow, app, weekSessionId);
        expect(res.status).toBe(502);

        const row = await fetchRow(app, ids);
        expectCommon(row, weekSessionId);
        expect(row).toMatchObject({
          outcome: "http_error",
          httpStatus: 529,
          errorMessage: expect.stringContaining("529"),
        });
        expect(row.responseRaw).toContain("overloaded");
      });

      it("records transport_error on a fetch failure and keeps the 502", async () => {
        const fetchImpl = vi.fn(async () => {
          throw new TypeError("fetch failed: ECONNRESET");
        }) as unknown as typeof globalThis.fetch;
        const { recorder, ids } = capturingRecorder();
        const { app, weekSessionId } = await liveApp(fetchImpl, recorder);

        const res = await trigger(flow, app, weekSessionId);
        expect(res.status).toBe(502);

        const row = await fetchRow(app, ids);
        expectCommon(row, weekSessionId);
        expect(row).toMatchObject({
          outcome: "transport_error",
          httpStatus: null,
          responseRaw: null,
          errorMessage: expect.stringContaining("ECONNRESET"),
        });
      });

      it("records schema_invalid with the raw text for a non-event-stream body", async () => {
        const fetchImpl = vi.fn(
          async () =>
            new Response("<html>gateway garbage</html>", { status: 200 }),
        ) as unknown as typeof globalThis.fetch;
        const { recorder, ids } = capturingRecorder();
        const { app, weekSessionId } = await liveApp(fetchImpl, recorder);

        const res = await trigger(flow, app, weekSessionId);
        expect(res.status).toBe(502);

        const row = await fetchRow(app, ids, flow === "weekly" ? 2 : 1);
        expectCommon(row, weekSessionId);
        expect(row).toMatchObject({
          outcome: "schema_invalid",
          httpStatus: 200,
          responseRaw: "<html>gateway garbage</html>",
          errorMessage: expect.stringMatching(/not a valid event stream/),
        });
      });

      it("records schema_invalid when the tool block is missing", async () => {
        const fetchImpl = vi.fn(async () =>
          anthropicStreamResponse({
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
            content: [{ type: "text", text: "no tool here" }],
          }),
        ) as unknown as typeof globalThis.fetch;
        const { recorder, ids } = capturingRecorder();
        const { app, weekSessionId } = await liveApp(fetchImpl, recorder);

        const res = await trigger(flow, app, weekSessionId);
        expect(res.status).toBe(502);

        const row = await fetchRow(app, ids, flow === "weekly" ? 2 : 1);
        expectCommon(row, weekSessionId);
        expect(row).toMatchObject({
          outcome: "schema_invalid",
          httpStatus: 200,
          stopReason: "end_turn",
          inputTokens: 10,
          outputTokens: 2,
          errorMessage: expect.stringContaining(tool),
        });
        expect(row.responseRaw).toContain("no tool here");
      });

      it("records schema_invalid when adapter validation fails", async () => {
        const fetchImpl = vi.fn(async () =>
          anthropicStreamResponse({
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 5 },
            content: [
              {
                type: "tool_use",
                id: "toolu_x",
                name: tool,
                input: { unexpected: true },
              },
            ],
          }),
        ) as unknown as typeof globalThis.fetch;
        const { recorder, ids } = capturingRecorder();
        const { app, weekSessionId } = await liveApp(fetchImpl, recorder);

        const res = await trigger(flow, app, weekSessionId);
        expect(res.status).toBe(502);

        const row = await fetchRow(app, ids, flow === "weekly" ? 2 : 1);
        expectCommon(row, weekSessionId);
        expect(row).toMatchObject({
          outcome: "schema_invalid",
          httpStatus: 200,
          stopReason: "tool_use",
        });
        expect(row.errorMessage).toEqual(expect.any(String));
        expect(row.responseRaw).toContain("unexpected");
      });

      it("writes no row when the API key is missing", async () => {
        const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
        const { recorder, ids } = capturingRecorder();
        const { app, weekSessionId } = await liveApp(fetchImpl, recorder, {
          withKey: false,
        });

        const res = await trigger(flow, app, weekSessionId);
        expect(res.status).toBe(400);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(ids).toHaveLength(0);
      });

      it("keeps the failure response and warns when the recorder throws", async () => {
        const fetchImpl = vi.fn(async () =>
          jsonResponse({ error: "boom" }, 500),
        ) as unknown as typeof globalThis.fetch;
        const throwing: LlmCallRecorder = {
          record: vi.fn(async () => {
            throw new Error("log down");
          }),
          get: vi.fn(async () => null),
        };
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const { app, weekSessionId } = await liveApp(fetchImpl, throwing);
          const res = await trigger(flow, app, weekSessionId);
          expect(res.status).toBe(502);
          expect(throwing.record).toHaveBeenCalledTimes(1);
          expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining("[llm-call-log] row dropped"),
          );
        } finally {
          errSpy.mockRestore();
        }
      });
    });
  }

  it("keeps a successful reply unchanged when the recorder throws (weekly)", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicStreamResponse({
        stop_reason: "tool_use",
        usage: {},
        content: [
          {
            type: "tool_use",
            id: "t",
            name: "submit_weekly_reply",
            input: buildStubWeeklyReply(samplePacket()),
          },
        ],
      }),
    ) as unknown as typeof globalThis.fetch;
    const throwing: LlmCallRecorder = {
      record: vi.fn(async () => {
        throw new Error("log down");
      }),
      get: vi.fn(async () => null),
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app, weekSessionId } = await liveApp(fetchImpl, throwing);
      const res = await trigger("weekly", app, weekSessionId);
      expect(res.status).toBe(200);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("[llm-call-log] row dropped"),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
