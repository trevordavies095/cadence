import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import type { ModelPacket } from "../src/packet/index.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  recordedStreamResponse,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";
import { recordedWeeklyReplyAsForm } from "./weeklyForms.js";

/**
 * The weekly reply recorded from a real oMLX server by the smoke script
 * (scripts/smoke-self-hosted.ts --record), replayed byte for byte through the
 * app. The sidecar says which server, model and effort produced it.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "self-hosted");
const STEM = path.join(FIXTURES, "omlx-gpt-oss-weekly");
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

type Sidecar = {
  server: string;
  model: string;
  effort: string;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
};

const sidecar = JSON.parse(readFileSync(`${STEM}.json`, "utf8")) as Sidecar;
const packet = JSON.parse(readFileSync(`${STEM}.packet.json`, "utf8")) as ModelPacket;

const BASE_URL = "http://omlx.local:8000";

function appWith(chunkBytes?: number) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return Response.json({ object: "list", data: [{ id: sidecar.model, object: "model" }] });
    }
    sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    // The recording predates the plan box: its tool input is translated into the
    // weekly form; the stream around it (thinking, usage) is as recorded.
    return recordedStreamResponse(`${STEM}.sse`, { chunkBytes, rewrite: recordedWeeklyReplyAsForm });
  }) as unknown as typeof globalThis.fetch;
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmFetch: fetchImpl,
  });
  return { app, sent };
}

function send(app: ReturnType<typeof createApp>, route: string, method: string, body?: unknown) {
  return app.request(route, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let prevProvider: string | undefined;

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  await acceptAndReady();
  prevProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "anthropic";
});

afterEach(() => {
  if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevProvider;
});

describe(`the recorded ${sidecar.server} weekly reply (${sidecar.model} at ${sidecar.effort})`, () => {
  it.each([
    ["in one chunk", undefined],
    ["cut into network-sized chunks", 1_400],
  ])("validates through the app %s, and the log row records the host and its tokens", async (_label, chunkBytes) => {
    const { app, sent } = appWith(chunkBytes);
    expect((await send(app, "/settings/self-hosted", "PUT", { baseUrl: BASE_URL, apiKey: "test-key" })).status).toBe(200);
    expect(
      (
        await send(app, "/settings/coach-model", "PUT", {
          provider: "self_hosted",
          model: sidecar.model,
          effort: sidecar.effort,
        })
      ).status,
    ).toBe(200);
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(null, weekSessionId);

    const res = await send(app, "/week/reply", "POST", { weekSessionId, packet });
    const body = await json(res);
    expect(res.status, JSON.stringify(body).slice(0, 500)).toBe(200);
    const reply = body.reply as { analysis: string; prescribedWeek: { days: unknown[] } };
    expect(reply.analysis.trim()).not.toBe("");
    expect(reply.prescribedWeek.days).toHaveLength(7);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${BASE_URL}/v1/messages`);
    const rows = (await json(await app.request("/llm-calls"))) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "weekly_reply",
      provider: "self_hosted",
      serverHost: "omlx.local",
      model: sidecar.model,
      inputTokens: sidecar.inputTokens,
      outputTokens: sidecar.outputTokens,
      // Null when the server reports no thinking tokens.
      thinkingTokens: sidecar.thinkingTokens ?? null,
    });
    expect(["ok", "repaired"]).toContain(rows[0]!.outcome);
  });
});
