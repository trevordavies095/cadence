import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  PROBE_CUT_RATIO,
  PROBE_SENT_TOKENS,
  PROBE_SYSTEM_PROMPT,
  PROBE_USER_PROMPT,
  PROBE_WORD,
} from "../src/settings/selfHostedConnectionTest.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const BASE_URL = "http://omlx.local:8000";
const SERVER_KEY = "omlx-local-key-ab12";
const MODEL = "qwen3-8b";
const LISTING = [{ id: MODEL, object: "model" }, { id: "gemma-3-27b", object: "model" }];

/** The fewest reported tokens that still pass: 90 percent of what was sent. */
const AT_90 = Math.ceil(PROBE_SENT_TOKENS * PROBE_CUT_RATIO);
const AT_89 = Math.floor(PROBE_SENT_TOKENS * 0.89);

type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };

type Probe =
  | { reply: string; usage?: Record<string, unknown> }
  | { status: number }
  | "throw"
  | "hang";

/**
 * The self-hosted server: `/v1/models` answers with `listing` (a number = that
 * status, "throw" = nothing answers), `/v1/messages` with `probe`. Every call
 * is kept; anything sent to Anthropic fails the test.
 */
function fakeServer(options: { listing?: number | "throw"; probe?: Probe } = {}) {
  const calls: Call[] = [];
  let listingsAfterSetup: number | "throw" | undefined;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("anthropic.com")) throw new Error(`unexpected call to ${url}`);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    if (url.endsWith("/v1/models")) {
      const listing = listingsAfterSetup;
      if (listing === "throw") throw new TypeError("fetch failed");
      if (typeof listing === "number") return new Response("nope", { status: listing });
      return Response.json({ object: "list", data: LISTING });
    }
    if (url.endsWith("/v1/messages")) {
      const probe = options.probe ?? { reply: PROBE_WORD };
      if (probe === "throw") throw new TypeError("fetch failed");
      if (probe === "hang") {
        // Headers arrive, then the server goes quiet until the request is aborted.
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if ("status" in probe) {
        return Response.json({ type: "error", error: { message: "model not found" } }, { status: probe.status });
      }
      return anthropicStreamResponse(
        {
          stop_reason: "end_turn",
          usage: probe.usage ?? { input_tokens: PROBE_SENT_TOKENS, output_tokens: 3 },
          content: [{ type: "text", text: probe.reply }],
        },
        { thinking: true },
      );
    }
    throw new Error(`unexpected call to ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetchImpl,
    calls,
    /** From now on the listing answers as the test asked; setup always lists. */
    arm() {
      listingsAfterSetup = options.listing;
      calls.length = 0;
    },
  };
}

type App = ReturnType<typeof createApp>;

function send(app: App, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A saved server with a key, and the coach set to a model on it. */
async function selfHostedApp(server: ReturnType<typeof fakeServer>, timeoutMs?: number) {
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    llmFetch: server.fetchImpl,
    selfHostedTestTimeoutMs: timeoutMs,
  });
  expect((await send(app, "/settings/self-hosted", "PUT", { baseUrl: BASE_URL, apiKey: SERVER_KEY })).status).toBe(200);
  expect(
    (await send(app, "/settings/coach-model", "PUT", { provider: "self_hosted", model: MODEL, effort: "high" })).status,
  ).toBe(200);
  server.arm();
  return app;
}

const runTest = (app: App, model = MODEL) => send(app, "/settings/self-hosted/test", "POST", { model });

const probeCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/v1/messages"));

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  await acceptAndReady();
});

describe("Test connection: the listing", () => {
  it("a refused key (401) is unauthorized, and the probe is not sent", async () => {
    const server = fakeServer({ listing: 401 });
    const app = await selfHostedApp(server);
    const res = await runTest(app);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      listing: { ok: false, reason: "unauthorized" },
      probe: { ok: false, reason: "not_run", sentTokens: PROBE_SENT_TOKENS, reportedTokens: null, wordFound: false },
    });
    expect(server.calls.map((c) => c.url)).toEqual([`${BASE_URL}/v1/models`]);
    expect(server.calls[0].headers.get("x-api-key")).toBe(SERVER_KEY);
    expect(server.calls[0].headers.get("authorization")).toBe(`Bearer ${SERVER_KEY}`);
  });

  it("403 is unauthorized, another status is http_error, no answer is unreachable", async () => {
    for (const [listing, reason] of [
      [403, "unauthorized"],
      [500, "http_error"],
      [404, "http_error"],
      ["throw", "unreachable"],
    ] as const) {
      await resetAppTables();
      await acceptAndReady();
      const server = fakeServer({ listing });
      const app = await selfHostedApp(server);
      const body = await json(await runTest(app));
      expect(body.listing).toEqual({ ok: false, reason });
      expect(body.probe).toMatchObject({ ok: false, reason: "not_run" });
      expect(probeCalls(server.calls)).toEqual([]);
    }
  });
});

describe("Test connection: the probe", () => {
  it("the full count with the word is ok, asked the way a coach call asks", async () => {
    const server = fakeServer({ probe: { reply: `${PROBE_WORD}` } });
    const app = await selfHostedApp(server);
    const res = await runTest(app);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      listing: { ok: true },
      probe: {
        ok: true,
        verdict: "ok",
        sentTokens: PROBE_SENT_TOKENS,
        reportedTokens: PROBE_SENT_TOKENS,
        wordFound: true,
      },
    });

    const [probe] = probeCalls(server.calls);
    expect(probe.url).toBe(`${BASE_URL}/v1/messages`);
    expect(probe.method).toBe("POST");
    expect(probe.headers.get("x-api-key")).toBe(SERVER_KEY);
    expect(probe.headers.get("authorization")).toBe(`Bearer ${SERVER_KEY}`);
    expect(probe.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(probe.body).toMatchObject({
      model: MODEL,
      system: PROBE_SYSTEM_PROMPT,
      thinking: { type: "enabled" },
      output_config: { effort: "low" },
      stream: true,
      messages: [{ role: "user", content: PROBE_USER_PROMPT }],
    });
    expect(probe.body?.max_tokens).toBeLessThanOrEqual(4_096);
    expect(probe.body).not.toHaveProperty("tools");
    expect(probe.body).not.toHaveProperty("tool_choice");
  });

  it("89 percent of the tokens is cut, even with the word", async () => {
    const server = fakeServer({ probe: { reply: PROBE_WORD, usage: { input_tokens: AT_89, output_tokens: 3 } } });
    const body = await json(await runTest(await selfHostedApp(server)));
    expect(body.probe).toEqual({
      ok: true,
      verdict: "cut",
      sentTokens: PROBE_SENT_TOKENS,
      reportedTokens: AT_89,
      wordFound: true,
    });
  });

  it("exactly 90 percent is ok; one token fewer is cut", async () => {
    const server = fakeServer({ probe: { reply: PROBE_WORD, usage: { input_tokens: AT_90, output_tokens: 3 } } });
    const body = await json(await runTest(await selfHostedApp(server)));
    expect(body.probe).toMatchObject({ ok: true, verdict: "ok", reportedTokens: AT_90, wordFound: true });

    await resetAppTables();
    await acceptAndReady();
    const short = fakeServer({ probe: { reply: PROBE_WORD, usage: { input_tokens: AT_90 - 1, output_tokens: 3 } } });
    const shortBody = await json(await runTest(await selfHostedApp(short)));
    expect(shortBody.probe).toMatchObject({ verdict: "cut", reportedTokens: AT_90 - 1 });
  });

  it("the full count without the word is cut", async () => {
    const server = fakeServer({ probe: { reply: "I could not find a code word." } });
    const body = await json(await runTest(await selfHostedApp(server)));
    expect(body.probe).toEqual({
      ok: true,
      verdict: "cut",
      sentTokens: PROBE_SENT_TOKENS,
      reportedTokens: PROBE_SENT_TOKENS,
      wordFound: false,
    });
  });

  it("the word is found in any case, and cached prompt tokens count as read", async () => {
    const server = fakeServer({
      probe: {
        reply: "Pelican.",
        usage: { input_tokens: 12, cache_read_input_tokens: PROBE_SENT_TOKENS - 12, output_tokens: 3 },
      },
    });
    const body = await json(await runTest(await selfHostedApp(server)));
    expect(body.probe).toMatchObject({ verdict: "ok", reportedTokens: PROBE_SENT_TOKENS, wordFound: true });
  });

  it("a probe the server refuses or never answers fails with a reason", async () => {
    for (const [probe, reason] of [
      [{ status: 404 }, "http_error"],
      [{ status: 401 }, "unauthorized"],
      ["throw", "unreachable"],
    ] as const) {
      await resetAppTables();
      await acceptAndReady();
      const body = await json(await runTest(await selfHostedApp(fakeServer({ probe }))));
      expect(body).toEqual({
        listing: { ok: true },
        probe: { ok: false, reason, sentTokens: PROBE_SENT_TOKENS, reportedTokens: null, wordFound: false },
      });
    }
  });

  it("a server that goes quiet past the route's timeout is a timeout", async () => {
    const server = fakeServer({ probe: "hang" });
    const body = await json(await runTest(await selfHostedApp(server, 50)));
    expect(body.probe).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("Test connection: who may run it", () => {
  it("is not refused while Anthropic is the saved provider, and only calls the saved server", async () => {
    // The athlete tests a server and a model they have picked but not saved yet.
    const server = fakeServer();
    const app = await selfHostedApp(server);
    expect((await send(app, "/settings/coach-model", "DELETE")).status).toBe(200);
    server.arm();
    const res = await runTest(app);
    expect(res.status).toBe(200);
    expect((await json(res)).probe).toMatchObject({ ok: true, verdict: "ok" });
    expect(server.calls.length).toBeGreaterThan(0);
    expect(server.calls.every((c) => c.url.startsWith(BASE_URL))).toBe(true);
  });

  it("with no server saved", async () => {
    const server = fakeServer();
    const app = await selfHostedApp(server);
    expect((await send(app, "/settings/self-hosted", "DELETE")).status).toBe(200);
    server.arm();
    const res = await runTest(app);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "no_self_hosted_connection" });
    expect(server.calls).toEqual([]);
  });

  it("with no model", async () => {
    const server = fakeServer();
    const app = await selfHostedApp(server);
    const res = await send(app, "/settings/self-hosted/test", "POST", {});
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "model_required" });
    expect(server.calls).toEqual([]);
  });
});

describe("the probe prompt", () => {
  it("is about 40k tokens, its count in step with its text, the word given once at the start", () => {
    const chars = PROBE_SYSTEM_PROMPT.length + PROBE_USER_PROMPT.length;
    expect(Math.round(chars / 4)).toBe(PROBE_SENT_TOKENS);
    expect(PROBE_SENT_TOKENS).toBeGreaterThan(38_000);
    expect(PROBE_SENT_TOKENS).toBeLessThan(42_000);
    expect(PROBE_USER_PROMPT.split(PROBE_WORD)).toHaveLength(2);
    expect(PROBE_USER_PROMPT.split("\n")[0]).toContain(PROBE_WORD);
    expect(PROBE_USER_PROMPT.toUpperCase().split(PROBE_WORD)).toHaveLength(2);
  });
});
