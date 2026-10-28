import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  type MidWeekChatReply,
  type WeeklyReply,
} from "../src/llm/index.js";
import { resolveAppVersion } from "../src/llmCallLog/appVersion.js";
import type { LlmCallRecorder } from "../src/llmCallLog/index.js";
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
const USAGE = {
  input_tokens: 1234,
  output_tokens: 567,
  cache_read_input_tokens: 89,
  cache_creation_input_tokens: 12,
};

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
      // Synthetic on purpose: the log must use the route's validated session.
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
  });
}

function anthropicResponse(toolName: string, input: unknown): Response {
  return anthropicStreamResponse(
    anthropicToolMessage(toolName, input, { usage: USAGE }),
  );
}

describe("LLM call log (#68 tracer)", () => {
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

  async function liveApp(
    fetchImpl: typeof globalThis.fetch,
    llmCallRecorder?: LlmCallRecorder,
  ) {
    await acceptAndReady();
    await putAnthropicConnection(
      API_KEY,
      new SecretProtector(TEST_DATA_PROTECTION_KEY),
    );
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
    return { app, weekSessionId: week.id as string };
  }

  async function coachMessages(
    app: ReturnType<typeof createApp>,
    weekSessionId: string,
  ) {
    const listed = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    return (listed.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role === "coach",
    );
  }

  it("records a successful weekly reply and links the coach message", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicResponse(
        "submit_weekly_reply",
        buildStubWeeklyReply(samplePacket()),
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

    const [coach] = await coachMessages(app, weekSessionId);
    const callId = coach!.llmCallId as string;
    expect(callId).toMatch(/^[0-9a-f-]{36}$/);

    const rowRes = await app.request(`/llm-calls/${callId}`);
    expect(rowRes.status).toBe(200);
    const row = await json(rowRes);
    expect(row).toMatchObject({
      id: callId,
      operation: "weekly_reply",
      provider: "anthropic",
      model: "claude-opus-4-7",
      appVersion: resolveAppVersion(),
      weekSessionId,
      parentCallId: null,
      httpStatus: 200,
      stopReason: "tool_use",
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 89,
      cacheCreationTokens: 12,
      outcome: "ok",
      errorMessage: null,
    });
    expect(row.latencyMs).toEqual(expect.any(Number));

    const request = row.request as {
      system: string;
      tools: Array<{ name: string }>;
      messages: Array<{ content: string }>;
    };
    expect(request.system).toMatch(/do not diagnose/i);
    expect(request.system).toMatch(/Lead with the conclusion/);
    expect(request.tools[0]!.name).toBe("submit_weekly_reply");
    expect(request.messages[0]!.content).toContain("Keep Achilles easy");
    const raw = JSON.parse(row.responseRaw as string) as { usage: unknown };
    expect(raw.usage).toEqual(USAGE);
    expect(JSON.stringify(row)).not.toContain(API_KEY);
  });

  it("cuts an over-long headline at a word and logs the cut as a repair", async () => {
    const long = `${"Big week, steady legs, and the goal is still live. ".repeat(8)}End.`;
    const fetchImpl = vi.fn(async () =>
      anthropicResponse("submit_weekly_reply", {
        ...buildStubWeeklyReply(samplePacket()),
        headline: long,
      }),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);
    await unlockPlanCheckIn(app, weekSessionId);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const stored = (body.prescribed as { readSections: { headline: string } }).readSections;
    expect(stored.headline.length).toBeLessThanOrEqual(280);
    expect(stored.headline.endsWith("…")).toBe(true);
    expect(long.startsWith(stored.headline.slice(0, -1))).toBe(true);

    const [coach] = await coachMessages(app, weekSessionId);
    const row = await json(await app.request(`/llm-calls/${coach!.llmCallId as string}`));
    expect(row.outcome).toBe("repaired");
    expect(row.errorMessage).toMatch(/headline cut from \d+ to \d+ chars/);
  });

  it("records a successful mid-week chat and links the coach message", async () => {
    const reply: MidWeekChatReply = { body: "Good week. Keep Thursday easy." };
    const fetchImpl = vi.fn(async () =>
      anthropicResponse("submit_mid_week_chat_reply", reply),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);

    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How is my week going?" }),
    });
    expect(res.status).toBe(201);
    const created = (await json(res)).coachMessage as Record<string, unknown>;

    const [coach] = await coachMessages(app, weekSessionId);
    expect(coach!.id).toBe(created.id);
    const callId = coach!.llmCallId as string;

    const row = await json(await app.request(`/llm-calls/${callId}`));
    expect(row).toMatchObject({
      id: callId,
      operation: "mid_week_chat",
      provider: "anthropic",
      weekSessionId,
      outcome: "ok",
      inputTokens: 1234,
      stopReason: "tool_use",
    });
    const request = row.request as { system: string };
    expect(request.system).toMatch(/Lead with the conclusion/);
    expect(request.system).toMatch(/first sentence is the answer/);
    expect(JSON.stringify(row)).not.toContain(API_KEY);
  });

  const LONG_CALLOUT = {
    title: "Achilles",
    body:
      "Keep the next few days easy and flat. ".repeat(60) +
      "If it gets sharper, see a clinician.",
    severity: "caution",
  };

  async function expectRepairedRow(
    app: ReturnType<typeof createApp>,
    callId: string,
  ) {
    const row = await json(await app.request(`/llm-calls/${callId}`));
    expect(row).toMatchObject({ id: callId, outcome: "repaired" });
    expect(row.errorMessage).toMatch(
      /^safetyCallouts\[0\]\.body cut from \d+ to \d+ chars, escalation line added$/,
    );
    const listed = await json(await app.request("/llm-calls?outcome=repaired"));
    expect(JSON.stringify(listed)).toContain(callId);
  }

  it("delivers a weekly reply with an over-long callout and logs it as repaired (#4)", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicResponse("submit_weekly_reply", {
        ...buildStubWeeklyReply(samplePacket()),
        safetyCallouts: [LONG_CALLOUT],
      }),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);
    await unlockPlanCheckIn(app, weekSessionId);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
    expect(res.status).toBe(200);

    const [coach] = await coachMessages(app, weekSessionId);
    const [callout] = coach!.safetyCallouts as Array<{ body: string }>;
    expect(callout!.body.length).toBeLessThanOrEqual(1200);
    expect(callout!.body).toMatch(/see a qualified clinician\.$/);
    await expectRepairedRow(app, coach!.llmCallId as string);
  });

  it("delivers a chat reply with an over-long callout and logs it as repaired (#4)", async () => {
    const reply = { body: "Ease off this week.", safetyCallouts: [LONG_CALLOUT] };
    const fetchImpl = vi.fn(async () =>
      anthropicResponse("submit_mid_week_chat_reply", reply),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);

    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "My Achilles twinged today." }),
    });
    expect(res.status).toBe(201);

    const [coach] = await coachMessages(app, weekSessionId);
    const [callout] = coach!.safetyCallouts as Array<{ body: string }>;
    expect(callout!.body.length).toBeLessThanOrEqual(1200);
    await expectRepairedRow(app, coach!.llmCallId as string);
  });

  it("leaves the call id null on messages no model call produced", async () => {
    const reply: MidWeekChatReply = buildStubMidWeekChatReply(samplePacket());
    const fetchImpl = vi.fn(async () =>
      anthropicResponse("submit_mid_week_chat_reply", reply),
    ) as unknown as typeof globalThis.fetch;
    const { app, weekSessionId } = await liveApp(fetchImpl);
    await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hello coach" }),
    });

    const listed = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    const athlete = (listed.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "athlete",
    );
    expect(athlete!.llmCallId).toBeNull();
  });

  it("returns 404 for an unknown call id and 403 before the disclaimer", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const gated = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      llmFetch: fetchImpl,
    });
    const blocked = await gated.request(
      "/llm-calls/00000000-0000-4000-8000-000000000099",
    );
    expect(blocked.status).toBe(403);

    const { app } = await liveApp(fetchImpl);
    const missing = await app.request(
      "/llm-calls/00000000-0000-4000-8000-000000000099",
    );
    expect(missing.status).toBe(404);
    const malformed = await app.request("/llm-calls/not-a-uuid");
    expect(malformed.status).toBe(404);
  });

  it("still returns the coach reply when the log write fails", async () => {
    const failing: LlmCallRecorder = {
      record: vi.fn(async () => {
        throw new Error("log down");
      }),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      exportAll: vi.fn(async function* () {}),
    };
    const reply: MidWeekChatReply = { body: "Reply survives a dead log." };
    const fetchImpl = vi.fn(async () =>
      anthropicResponse("submit_mid_week_chat_reply", reply),
    ) as unknown as typeof globalThis.fetch;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, weekSessionId } = await liveApp(fetchImpl, failing);

    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Anyone there?" }),
    });
    expect(res.status).toBe(201);
    expect(
      ((await json(res)).coachMessage as { body: string }).body,
    ).toBe(reply.body);
    expect(failing.record).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[llm-call-log] row dropped"),
    );
    errSpy.mockRestore();
  });
});

describe("resolveAppVersion", () => {
  it("prefers APP_VERSION, then the Docker git commit, then dev", () => {
    expect(
      resolveAppVersion({ APP_VERSION: "abc123", CADENCE_GIT_COMMIT: "zzz" }),
    ).toBe("abc123");
    expect(resolveAppVersion({ CADENCE_GIT_COMMIT: "zzz" })).toBe("zzz");
    expect(resolveAppVersion({ APP_VERSION: "  " })).toBe("dev");
    expect(resolveAppVersion({})).toBe("dev");
  });
});
