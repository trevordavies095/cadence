import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { resolveSelfHostedIdleTimeoutMs } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import {
  acceptAndReady,
  anthropicSseEvents,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const BASE_URL = "http://omlx.local:8000";
const SERVER_KEY = "omlx-local-key-ab12";
const ANTHROPIC_KEY = "sk-ant-test-key-fixture-xyz";
const MODEL = "qwen3-8b";
const CHAT_TOOL = "submit_mid_week_chat_reply";

type App = ReturnType<typeof createApp>;

/** A complete self-hosted chat reply: no thinking block, as a local server sends. */
function chatReplyStream(): Response {
  return new Response(
    anthropicSseEvents(
      anthropicToolMessage(CHAT_TOOL, { body: "Good week. Keep Thursday easy." }, { model: MODEL }),
      { thinking: false },
    ).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * A Messages server that says nothing until the test answers: the request
 * stays open until `answer` is called or the adapter aborts it.
 */
function silentServer() {
  let signal: AbortSignal | undefined;
  let answer: ((res: Response) => void) | undefined;
  let called!: () => void;
  const reached = new Promise<void>((resolve) => {
    called = resolve;
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/v1/models")) {
      return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] });
    }
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      answer = resolve;
      signal?.addEventListener("abort", () => reject(signal!.reason));
      called();
    });
  }) as typeof globalThis.fetch;
  return {
    fetchImpl,
    reached,
    aborted: () => signal?.aborted ?? false,
    answer: (res: Response) => answer!(res),
  };
}

function appWith(fetchImpl: typeof globalThis.fetch): App {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    llmFetch: fetchImpl,
  });
}

function send(app: App, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function useSelfHosted(app: App) {
  expect(
    (await send(app, "/settings/self-hosted", "PUT", { baseUrl: BASE_URL, apiKey: SERVER_KEY }))
      .status,
  ).toBe(200);
  expect(
    (await send(app, "/settings/coach-model", "PUT", {
      provider: "self_hosted",
      model: MODEL,
      effort: "high",
    })).status,
  ).toBe(200);
}

async function openWeek(app: App): Promise<string> {
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  return week.id as string;
}

function chat(app: App, weekSessionId: string) {
  return send(app, `/weeks/${weekSessionId}/chat`, "POST", { body: "How is my week going?" });
}

async function logRows(app: App) {
  return (await json(await app.request("/llm-calls"))) as unknown as Array<Record<string, unknown>>;
}

/**
 * Sends a chat to a server that stays silent, with only the timers faked, and
 * returns the pending response plus the server to drive.
 */
async function chatToSilentServer(provider: "self_hosted" | "anthropic") {
  const server = silentServer();
  const app = appWith(server.fetchImpl);
  if (provider === "self_hosted") await useSelfHosted(app);
  else await putAnthropicConnection(ANTHROPIC_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const weekSessionId = await openWeek(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = chat(app, weekSessionId);
  await server.reached;
  return { app, server, pending };
}

const ENV_KEYS = ["LLM_PROVIDER", "SELF_HOSTED_IDLE_TIMEOUT_MS", "ANTHROPIC_TIMEOUT_MS"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  await acceptAndReady();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.LLM_PROVIDER = "anthropic";
  delete process.env.SELF_HOSTED_IDLE_TIMEOUT_MS;
  delete process.env.ANTHROPIC_TIMEOUT_MS;
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveSelfHostedIdleTimeoutMs", () => {
  it("defaults to 10 minutes and accepts only positive integer milliseconds", () => {
    expect(resolveSelfHostedIdleTimeoutMs({})).toBe(600_000);
    expect(resolveSelfHostedIdleTimeoutMs({ SELF_HOSTED_IDLE_TIMEOUT_MS: "120000" })).toBe(120_000);
    expect(resolveSelfHostedIdleTimeoutMs({ SELF_HOSTED_IDLE_TIMEOUT_MS: " 90000 " })).toBe(90_000);
    for (const bad of ["", "abc", "0", "-5", "1.5", "60s"]) {
      expect(resolveSelfHostedIdleTimeoutMs({ SELF_HOSTED_IDLE_TIMEOUT_MS: bad })).toBe(600_000);
    }
  });

  it("does not read the Anthropic overall-cap variable", () => {
    expect(resolveSelfHostedIdleTimeoutMs({ ANTHROPIC_TIMEOUT_MS: "1500" })).toBe(600_000);
  });
});

describe("a self-hosted call on slow hardware", () => {
  it("keeps waiting through 90 seconds of silence and then answers", async () => {
    const { app, server, pending } = await chatToSilentServer("self_hosted");

    await vi.advanceTimersByTimeAsync(90_000);
    expect(server.aborted()).toBe(false);
    server.answer(chatReplyStream());

    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(201);
    const [row] = await logRows(app);
    expect(row).toMatchObject({ provider: "self_hosted", outcome: "ok" });
  });

  it("aborts once silent past 600 seconds, naming the model server, and logs it", async () => {
    const { app, server, pending } = await chatToSilentServer("self_hosted");

    await vi.advanceTimersByTimeAsync(599_000);
    expect(server.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.aborted()).toBe(true);

    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({
      error: "llm_transport_error",
      message: "The model server sent nothing for 600000ms; aborted",
    });
    const rows = await logRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "self_hosted",
      serverHost: "omlx.local",
      outcome: "transport_error",
      httpStatus: null,
      errorMessage: "The model server sent nothing for 600000ms; aborted",
    });
  });

  it("honours SELF_HOSTED_IDLE_TIMEOUT_MS", async () => {
    process.env.SELF_HOSTED_IDLE_TIMEOUT_MS = "120000";
    const { server, pending } = await chatToSilentServer("self_hosted");

    await vi.advanceTimersByTimeAsync(119_000);
    expect(server.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(502);
    expect((await json(res)).message).toBe("The model server sent nothing for 120000ms; aborted");
  });

  it("ignores an invalid SELF_HOSTED_IDLE_TIMEOUT_MS and keeps 600 seconds", async () => {
    process.env.SELF_HOSTED_IDLE_TIMEOUT_MS = "ten minutes";
    const { server, pending } = await chatToSilentServer("self_hosted");

    await vi.advanceTimersByTimeAsync(599_000);
    expect(server.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    const res = await pending;
    vi.useRealTimers();
    expect((await json(res)).message).toBe("The model server sent nothing for 600000ms; aborted");
  });

  it("still stops at the overall cap, with self-hosted wording", async () => {
    process.env.ANTHROPIC_TIMEOUT_MS = "300000";
    const { server, pending } = await chatToSilentServer("self_hosted");

    await vi.advanceTimersByTimeAsync(299_000);
    expect(server.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(502);
    expect((await json(res)).message).toBe(
      "The model server call exceeded 300000ms overall; aborted",
    );
  });
});

describe("an Anthropic call beside the self-hosted limit", () => {
  it("still aborts after 60 seconds of silence, with the Anthropic wording, whatever the self-hosted override", async () => {
    process.env.SELF_HOSTED_IDLE_TIMEOUT_MS = "900000";
    const { app, server, pending } = await chatToSilentServer("anthropic");

    await vi.advanceTimersByTimeAsync(59_000);
    expect(server.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({
      error: "llm_transport_error",
      message: "Anthropic stream idle for 60000ms; aborted",
    });
    const [row] = await logRows(app);
    expect(row).toMatchObject({ provider: "anthropic", outcome: "transport_error" });
  });
});

describe("self-hosted error wording", () => {
  function failingServer(respond: () => Promise<Response>) {
    return (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/models")) {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] });
      }
      return respond();
    }) as typeof globalThis.fetch;
  }

  async function chatSelfHosted(respond: () => Promise<Response>) {
    const app = appWith(failingServer(respond));
    await useSelfHosted(app);
    const res = await chat(app, await openWeek(app));
    return { app, res };
  }

  it("a 401 with an Anthropic-shaped error body surfaces the server's message, and the row records it", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key for this oMLX server" },
    });
    const { app, res } = await chatSelfHosted(
      async () =>
        new Response(errorBody, { status: 401, headers: { "content-type": "application/json" } }),
    );

    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({
      error: "llm_http_error",
      status: 401,
      message: "The model server returned 401: Invalid API key for this oMLX server",
    });
    const [row] = await logRows(app);
    expect(row).toMatchObject({
      provider: "self_hosted",
      serverHost: "omlx.local",
      outcome: "http_error",
      httpStatus: 401,
      errorMessage: "The model server returned 401: Invalid API key for this oMLX server",
    });
  });

  it("a body in another shape is quoted, cut to its first 200 characters", async () => {
    const page = `<html><body>${"Bad gateway. ".repeat(40)}</body></html>`;
    const { res } = await chatSelfHosted(async () => new Response(page, { status: 502 }));

    const body = await json(res);
    expect(body.status).toBe(502);
    expect(body.message).toBe(`The model server returned 502: ${page.slice(0, 200)}`);
  });

  it("JSON that is not an Anthropic error is quoted as text", async () => {
    const detail = JSON.stringify({ detail: "model qwen3-8b is not loaded" });
    const { res } = await chatSelfHosted(async () => new Response(detail, { status: 404 }));
    expect((await json(res)).message).toBe(`The model server returned 404: ${detail}`);
  });

  it("an empty body gives the status alone", async () => {
    const { res } = await chatSelfHosted(async () => new Response("", { status: 500 }));
    expect((await json(res)).message).toBe("The model server returned 500");
  });

  it("an unreachable server is a transport error naming the model server, and the row records it", async () => {
    const { app, res } = await chatSelfHosted(async () => {
      throw new TypeError("fetch failed");
    });

    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({
      error: "llm_transport_error",
      message: "Could not reach the model server: fetch failed",
    });
    const [row] = await logRows(app);
    expect(row).toMatchObject({
      provider: "self_hosted",
      outcome: "transport_error",
      errorMessage: "Could not reach the model server: fetch failed",
    });
  });

  it("a stream that stops before message_stop names the model server", async () => {
    const frames = anthropicSseEvents(
      anthropicToolMessage(CHAT_TOOL, { body: "Good week." }, { model: MODEL }),
      { thinking: false },
    );
    const cut = frames.filter((f) => !f.startsWith("event: message_stop")).join("");
    const { res } = await chatSelfHosted(
      async () =>
        new Response(cut, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    expect(await json(res)).toEqual({
      error: "llm_transport_error",
      message: "The model server's stream ended before message_stop",
    });
  });

  it("Anthropic keeps its wording for the same 401", async () => {
    await putAnthropicConnection(ANTHROPIC_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
    const app = appWith(
      failingServer(
        async () =>
          new Response(
            JSON.stringify({
              type: "error",
              error: { type: "authentication_error", message: "invalid x-api-key" },
            }),
            { status: 401 },
          ),
      ),
    );
    const res = await chat(app, await openWeek(app));
    expect(await json(res)).toEqual({
      error: "llm_http_error",
      status: 401,
      message: "Anthropic Messages API returned 401",
    });
  });
});
