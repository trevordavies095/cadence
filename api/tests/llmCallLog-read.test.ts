import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  TEST_DATA_PROTECTION_KEY,
  acceptAndReady,
  resetAppTables,
} from "./helpers.js";
import {
  createPostgresLlmCallRecorder,
  type LlmCallRecord,
} from "../src/llmCallLog/index.js";
import { migrate } from "../src/migrate.js";

const recorder = createPostgresLlmCallRecorder();
const SESSION_A = "00000000-0000-4000-8000-0000000000a1";
const SESSION_B = "00000000-0000-4000-8000-0000000000b2";

function row(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    id: randomUUID(),
    operation: "weekly_reply",
    provider: "anthropic",
    model: "claude-test",
    appVersion: "1.2.3",
    weekSessionId: SESSION_A,
    parentCallId: null,
    request: { messages: [{ role: "user", content: "hello" }] },
    responseRaw: '{"raw":"response"}',
    httpStatus: 200,
    latencyMs: 42,
    stopReason: "tool_use",
    inputTokens: 10,
    outputTokens: 20,
    thinkingTokens: 7,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
    outcome: "ok",
    errorMessage: null,
    ...overrides,
  };
}

/** Insert sequentially so created_at strictly increases. */
async function seed(rows: LlmCallRecord[]) {
  for (const r of rows) {
    await recorder.record(r);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeApp() {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    llmCallRecorder: recorder,
  });
}

describe("LLM call log read API (#72)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("returns 403 on both endpoints before the disclaimer is accepted", async () => {
    const app = makeApp();
    expect((await app.request("/llm-calls")).status).toBe(403);
    expect((await app.request("/llm-calls/export")).status).toBe(403);
  });

  describe("GET /llm-calls", () => {
    it("lists summary rows newest first with no bodies", async () => {
      await acceptAndReady();
      const first = row({ errorMessage: "first" });
      const second = row({ errorMessage: "second" });
      const third = row({ errorMessage: "third" });
      await seed([first, second, third]);

      const res = await makeApp().request("/llm-calls");
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
      for (const r of rows) {
        expect(r).not.toHaveProperty("request");
        expect(r).not.toHaveProperty("responseRaw");
      }
      expect(rows[0]).toEqual({
        id: third.id,
        createdAt: expect.any(String),
        operation: "weekly_reply",
        provider: "anthropic",
        model: "claude-test",
        appVersion: "1.2.3",
        weekSessionId: SESSION_A,
        parentCallId: null,
        outcome: "ok",
        httpStatus: 200,
        latencyMs: 42,
        stopReason: "tool_use",
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        errorMessage: "third",
      });
    });

    it("returns an empty array for an empty log", async () => {
      await acceptAndReady();
      const res = await makeApp().request("/llm-calls");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("filters by weekSessionId, operation and outcome, alone and combined", async () => {
      await acceptAndReady();
      const a = row({ weekSessionId: SESSION_A, operation: "weekly_reply", outcome: "ok" });
      const b = row({ weekSessionId: SESSION_A, operation: "mid_week_chat", outcome: "ok" });
      const c = row({
        weekSessionId: SESSION_B,
        operation: "weekly_reply",
        outcome: "http_error",
        httpStatus: 500,
      });
      const d = row({
        weekSessionId: SESSION_A,
        operation: "weekly_reply",
        outcome: "schema_invalid",
      });
      await seed([a, b, c, d]);
      const app = makeApp();
      const ids = async (qs: string) =>
        (
          (await (await app.request(`/llm-calls?${qs}`)).json()) as Array<{
            id: string;
          }>
        ).map((r) => r.id);

      expect(await ids(`weekSessionId=${SESSION_A}`)).toEqual([d.id, b.id, a.id]);
      expect(await ids(`weekSessionId=${SESSION_B}`)).toEqual([c.id]);
      expect(await ids("operation=weekly_reply")).toEqual([d.id, c.id, a.id]);
      expect(await ids("outcome=http_error")).toEqual([c.id]);
      expect(await ids(`weekSessionId=${SESSION_A}&operation=weekly_reply`)).toEqual([
        d.id,
        a.id,
      ]);
      expect(await ids("operation=weekly_reply&outcome=ok")).toEqual([a.id]);
      expect(
        await ids(`weekSessionId=${SESSION_A}&operation=weekly_reply&outcome=schema_invalid`),
      ).toEqual([d.id]);
      expect(await ids(`weekSessionId=${SESSION_B}&outcome=ok`)).toEqual([]);
      expect(await ids("operation=dossier_audit")).toEqual([]);
      expect(await ids("weekSessionId=not-a-uuid")).toEqual([]);
    });
  });

  describe("GET /llm-calls/export", () => {
    it("streams every full row as NDJSON, oldest first", async () => {
      await acceptAndReady();
      const first = row({ request: { n: 1 }, responseRaw: "raw-1" });
      const second = row({
        request: { n: 2 },
        responseRaw: null,
        outcome: "transport_error",
        httpStatus: null,
        errorMessage: "boom",
      });
      const third = row({ request: null, responseRaw: "raw-3" });
      await seed([first, second, third]);

      const res = await makeApp().request("/llm-calls/export");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const text = await res.text();
      expect(text.endsWith("\n")).toBe(true);
      const lines = text.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(parsed.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
      expect(parsed[0]).toMatchObject({
        request: { n: 1 },
        responseRaw: "raw-1",
        operation: "weekly_reply",
        createdAt: expect.any(String),
      });
      expect(parsed[1]).toMatchObject({
        request: { n: 2 },
        responseRaw: null,
        outcome: "transport_error",
        errorMessage: "boom",
      });
      expect(parsed[2]).toMatchObject({ request: null, responseRaw: "raw-3" });
    });

    it("is not treated as an id and returns an empty body for an empty log", async () => {
      await acceptAndReady();
      const res = await makeApp().request("/llm-calls/export");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await res.text()).toBe("");
    });

    it("exports a log larger than one batch without losing or reordering rows", async () => {
      await acceptAndReady();
      const rows = Array.from({ length: 450 }, (_, i) =>
        row({ errorMessage: `row-${i}`, request: null, responseRaw: null }),
      );
      for (const r of rows) await recorder.record(r);

      const text = await (await makeApp().request("/llm-calls/export")).text();
      const parsed = text
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; createdAt: string });
      expect(parsed).toHaveLength(450);
      expect(new Set(parsed.map((r) => r.id)).size).toBe(450);
      const times = parsed.map((r) => r.createdAt);
      expect([...times].sort()).toEqual(times);
    });

    it("still serves single rows at /llm-calls/:id", async () => {
      await acceptAndReady();
      const r = row();
      await seed([r]);
      const res = await makeApp().request(`/llm-calls/${r.id}`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { id: string }).toMatchObject({ id: r.id });
    });
  });
});
