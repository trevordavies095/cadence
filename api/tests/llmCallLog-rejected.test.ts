import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import type { LlmCallOptions, LlmPort } from "../src/llm/index.js";
import { resolveAppVersion } from "../src/llmCallLog/appVersion.js";
import {
  createPostgresLlmCallRecorder,
  type LlmCallRecord,
  type LlmCallRecorder,
} from "../src/llmCallLog/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
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

describe("LLM call log: route rejections (#70)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  /** Port whose adapter "accepted" the call (parent row ok) but returns junk. */
  async function setup() {
    const inner = createPostgresLlmCallRecorder();
    const captured: LlmCallRecord[] = [];
    const recorder: LlmCallRecorder = {
      record: async (row) => {
        captured.push(row);
        await inner.record(row);
      },
      get: (id) => inner.get(id),
    };
    const seenCallIds: string[] = [];
    const parent = async (
      operation: "weekly_reply" | "mid_week_chat",
      options?: LlmCallOptions,
    ) => {
      seenCallIds.push(options!.callId!);
      await recorder.record({
        id: options!.callId!,
        operation,
        provider: "anthropic",
        model: "claude-opus-4-7",
        appVersion: resolveAppVersion(),
        weekSessionId: options!.weekSessionId ?? null,
        parentCallId: null,
        request: { messages: [] },
        responseRaw: "{}",
        httpStatus: 200,
        latencyMs: 5,
        stopReason: "tool_use",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        outcome: "ok",
        errorMessage: null,
      });
    };
    const llmPort = {
      generateWeeklyReply: async (_p: ModelPacket, o?: LlmCallOptions) => {
        await parent("weekly_reply", o);
        return { analysis: "", prescribedWeek: null } as never;
      },
      generateMidWeekChatReply: async (_p: ModelPacket, o?: LlmCallOptions) => {
        await parent("mid_week_chat", o);
        return { body: "   " } as never;
      },
    } as unknown as LlmPort;

    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort,
      llmCallRecorder: recorder,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, weekSessionId: week.id as string, captured, seenCallIds };
  }

  async function expectRejectedChild(
    app: ReturnType<typeof createApp>,
    captured: LlmCallRecord[],
    seenCallIds: string[],
    operation: string,
    weekSessionId: string,
  ) {
    expect(seenCallIds).toHaveLength(1);
    const callId = seenCallIds[0]!;
    const childRecord = captured.find((r) => r.outcome === "rejected_by_route");
    expect(childRecord).toBeDefined();

    const child = await json(
      await app.request(`/llm-calls/${childRecord!.id}`),
    );
    expect(child.id).not.toBe(callId);
    expect(child).toMatchObject({
      operation,
      provider: "anthropic",
      model: "claude-opus-4-7",
      appVersion: resolveAppVersion(),
      weekSessionId,
      parentCallId: callId,
      request: null,
      responseRaw: null,
      outcome: "rejected_by_route",
    });
    expect(child.errorMessage).toEqual(expect.any(String));
    expect((child.errorMessage as string).length).toBeGreaterThan(0);

    const parent = await json(await app.request(`/llm-calls/${callId}`));
    expect(parent).toMatchObject({
      outcome: "ok",
      parentCallId: null,
      request: { messages: [] },
      responseRaw: "{}",
    });
    return child;
  }

  async function coachCount(
    app: ReturnType<typeof createApp>,
    weekSessionId: string,
  ) {
    const listed = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    return (listed.messages as Array<{ role: string }>).filter(
      (m) => m.role === "coach",
    ).length;
  }

  it("records a rejected_by_route child for a weekly reply the route refuses", async () => {
    const { app, weekSessionId, captured, seenCallIds } = await setup();
    await unlockPlanCheckIn(app, weekSessionId);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error).toBe("llm_schema_invalid");

    const child = await expectRejectedChild(
      app,
      captured,
      seenCallIds,
      "weekly_reply",
      weekSessionId,
    );
    expect(child.errorMessage).toBe(body.message);
    expect(await coachCount(app, weekSessionId)).toBe(0);
  });

  it("records a rejected_by_route child for a mid-week chat reply the route refuses", async () => {
    const { app, weekSessionId, captured, seenCallIds } = await setup();

    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How is my week going?" }),
    });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error).toBe("llm_schema_invalid");

    const child = await expectRejectedChild(
      app,
      captured,
      seenCallIds,
      "mid_week_chat",
      weekSessionId,
    );
    expect(child.errorMessage).toBe(body.message);
    expect(await coachCount(app, weekSessionId)).toBe(0);
  });
});
