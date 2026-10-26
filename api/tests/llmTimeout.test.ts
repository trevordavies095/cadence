import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { resolveAnthropicTimeoutMs } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const API_KEY = "sk-ant-test-key-fixture-xyz";

describe("resolveAnthropicTimeoutMs", () => {
  it("defaults to 15 minutes and accepts only positive integer milliseconds", () => {
    expect(resolveAnthropicTimeoutMs({})).toBe(900_000);
    expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: "1500" })).toBe(
      1500,
    );
    for (const bad of ["", "abc", "0", "-5", "1.5"]) {
      expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: bad })).toBe(
        900_000,
      );
    }
  });
});

describe("Anthropic request timeout (live adapter)", () => {
  let prevProvider: string | undefined;
  let prevTimeout: string | undefined;

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    prevProvider = process.env.LLM_PROVIDER;
    prevTimeout = process.env.ANTHROPIC_TIMEOUT_MS;
    process.env.LLM_PROVIDER = "anthropic";
    return () => {
      if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevProvider;
      if (prevTimeout === undefined) delete process.env.ANTHROPIC_TIMEOUT_MS;
      else process.env.ANTHROPIC_TIMEOUT_MS = prevTimeout;
    };
  });

  it("aborts at ANTHROPIC_TIMEOUT_MS and logs transport_error", async () => {
    process.env.ANTHROPIC_TIMEOUT_MS = "50";
    // Never answers: only the adapter's timeout signal ends the request.
    const hangingFetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as typeof globalThis.fetch;

    await acceptAndReady();
    await putAnthropicConnection(
      API_KEY,
      new SecretProtector(TEST_DATA_PROTECTION_KEY),
    );
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmFetch: hangingFetch,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Quick question" }),
    });
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_transport_error");

    const rows = (await (
      await app.request("/llm-calls?outcome=transport_error")
    ).json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("mid_week_chat");
    expect(rows[0]!.latencyMs as number).toBeGreaterThanOrEqual(45);
    expect(rows[0]!.latencyMs as number).toBeLessThan(5000);
  });
});
