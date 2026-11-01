import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { TESTED_COACH_MODEL } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { acceptAndReady, json, resetAppTables, TEST_DATA_PROTECTION_KEY } from "./helpers.js";

const BASE_URL = "http://omlx.local:8000";
const SERVER_KEY = "omlx-local-key-ab12";
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** What oMLX lists: plain ids, `model:profile` ids, and a display name now and then. */
const LISTING = [
  { id: "qwen3-8b", object: "model", owned_by: "omlx" },
  { id: "qwen3-8b:thinking", object: "model", owned_by: "omlx" },
  { id: "gemma-3-27b", object: "model", display_name: "Gemma 3 27B" },
];

type ListingCall = { url: string; xApiKey: string | null; authorization: string | null };

/**
 * One fake for both listings. The self-hosted server answers `/v1/models` with
 * `listing` (a number = that HTTP status, "throw" = unreachable). Anthropic's
 * listing is never reached because no Anthropic key is saved.
 */
function fakeServers(options: { listing?: unknown[] | number | "throw" } = {}) {
  const listings: ListingCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.anthropic.com")) throw new Error(`unexpected call to ${url}`);
    if (!url.endsWith("/v1/models")) throw new Error(`unexpected call to ${url}`);
    const headers = new Headers(init?.headers);
    listings.push({ url, xApiKey: headers.get("x-api-key"), authorization: headers.get("authorization") });
    const listing = options.listing ?? LISTING;
    if (listing === "throw") throw new TypeError("fetch failed");
    if (typeof listing === "number") return new Response("nope", { status: listing });
    return Response.json({ object: "list", data: listing });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, listings };
}

function appWith(fetchImpl: typeof globalThis.fetch) {
  return createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY, llmFetch: fetchImpl });
}

type App = ReturnType<typeof appWith>;

function send(app: App, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function connect(app: App, body: { baseUrl: string; apiKey?: string } = { baseUrl: BASE_URL, apiKey: SERVER_KEY }) {
  expect((await send(app, "/settings/self-hosted", "PUT", body)).status).toBe(200);
}

const putChoice = (app: App, body: unknown) => send(app, "/settings/coach-model", "PUT", body);
const view = async (app: App) => json(await app.request("/settings/coach-model"));
const summary = async (app: App) => json(await app.request("/settings"));

async function savedRows() {
  const result = await pool.query("SELECT provider, model, effort FROM coach_model_settings");
  return result.rows;
}

const qwenThinking = { id: "qwen3-8b:thinking", displayName: "qwen3-8b:thinking", tested: false, efforts: ALL_EFFORTS };

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  await acceptAndReady();
});

describe("the provider in the coach setting", () => {
  it("with nothing saved, is Anthropic at the tested default, as before", async () => {
    const { fetchImpl, listings } = fakeServers();
    const app = appWith(fetchImpl);
    expect(await view(app)).toEqual({
      provider: "anthropic",
      saved: null,
      effective: TESTED_COACH_MODEL,
      tested: TESTED_COACH_MODEL,
      models: [{ id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tested: true, efforts: ALL_EFFORTS }],
      fallback: "no_key",
    });
    expect(await summary(app)).toMatchObject({ provider: "anthropic", host: null });
    expect(listings).toEqual([]);
  });

  it("an existing row with no provider column reads as Anthropic", async () => {
    await pool.query(
      "INSERT INTO coach_model_settings (id, model, effort) VALUES (1, 'claude-opus-4-7', 'high')",
    );
    expect(await savedRows()).toEqual([{ provider: "anthropic", model: "claude-opus-4-7", effort: "high" }]);
    await expect(
      pool.query("UPDATE coach_model_settings SET provider = 'openai' WHERE id = 1"),
    ).rejects.toThrow(/coach_model_settings_provider_check/);
  });

  it("self-hosted lists the server's models as given, and saves a listed one", async () => {
    const { fetchImpl, listings } = fakeServers();
    const app = appWith(fetchImpl);
    await connect(app);

    const res = await putChoice(app, { provider: "self_hosted", model: "qwen3-8b:thinking", effort: "High" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      provider: "self_hosted",
      saved: { model: "qwen3-8b:thinking", effort: "high" },
      effective: { model: "qwen3-8b:thinking", effort: "high" },
      tested: TESTED_COACH_MODEL,
      models: [
        { id: "qwen3-8b", displayName: "qwen3-8b", tested: false, efforts: ALL_EFFORTS },
        qwenThinking,
        { id: "gemma-3-27b", displayName: "Gemma 3 27B", tested: false, efforts: ALL_EFFORTS },
      ],
      fallback: null,
    });
    expect(await savedRows()).toEqual([{ provider: "self_hosted", model: "qwen3-8b:thinking", effort: "high" }]);
    expect(listings[0]).toEqual({
      url: `${BASE_URL}/v1/models`,
      xApiKey: SERVER_KEY,
      authorization: `Bearer ${SERVER_KEY}`,
    });
    expect(await summary(app)).toMatchObject({ provider: "self_hosted", host: "omlx.local" });
  });

  it("sends no key headers when the server has no key, and does not double a /v1 base URL", async () => {
    const { fetchImpl, listings } = fakeServers();
    const app = appWith(fetchImpl);
    await connect(app, { baseUrl: "http://192.168.1.20:8080/v1/" });
    expect((await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "low" })).status).toBe(200);
    expect(listings[0]).toEqual({
      url: "http://192.168.1.20:8080/v1/models",
      xApiKey: null,
      authorization: null,
    });
    expect(await summary(app)).toMatchObject({ provider: "self_hosted", host: "192.168.1.20" });
  });

  it("refuses an unlisted model, an Anthropic model, a bad effort and a bad provider, and saves nothing", async () => {
    const app = appWith(fakeServers().fetchImpl);
    await connect(app);

    for (const [body, error] of [
      [{ provider: "self_hosted", model: "llama-3.3-70b", effort: "high" }, "unknown_model"],
      [{ provider: "self_hosted", model: "claude-opus-4-7", effort: "xhigh" }, "unknown_model"],
      [{ provider: "self_hosted", model: "qwen3-8b", effort: "extra" }, "invalid_effort"],
      [{ provider: "self_hosted", model: "qwen3-8b" }, "model_and_effort_required"],
      [{ provider: "openai", model: "gpt-5", effort: "high" }, "invalid_provider"],
    ] as const) {
      const res = await putChoice(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe(error);
    }
    expect(await savedRows()).toEqual([]);
  });

  it("refuses self-hosted when no server is saved", async () => {
    const { fetchImpl, listings } = fakeServers();
    const res = await putChoice(appWith(fetchImpl), { provider: "self_hosted", model: "qwen3-8b", effort: "high" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("no_self_hosted_connection");
    expect(listings).toEqual([]);
    expect(await savedRows()).toEqual([]);
  });

  it("switching back to Anthropic refuses the self-hosted model, and carries nothing across", async () => {
    const app = appWith(fakeServers().fetchImpl);
    await connect(app);
    await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "high" });

    const res = await putChoice(app, { provider: "anthropic", model: "qwen3-8b", effort: "high" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unknown_model");

    const switched = await putChoice(app, { provider: "anthropic", model: "claude-opus-4-7", effort: "medium" });
    expect(switched.status).toBe(200);
    const body = await json(switched);
    expect(body.provider).toBe("anthropic");
    expect(body.models.map((m: { id: string }) => m.id)).toEqual(["claude-opus-4-7"]);
    expect(await savedRows()).toEqual([{ provider: "anthropic", model: "claude-opus-4-7", effort: "medium" }]);
  });

  it("DELETE goes back to Anthropic at the tested default", async () => {
    const app = appWith(fakeServers().fetchImpl);
    await connect(app);
    await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "high" });

    const cleared = await json(await app.request("/settings/coach-model", { method: "DELETE" }));
    expect(cleared).toMatchObject({
      provider: "anthropic",
      saved: null,
      effective: TESTED_COACH_MODEL,
      fallback: "no_key",
    });
    expect(await savedRows()).toEqual([]);
    expect(await summary(app)).toMatchObject({ provider: "anthropic", host: null });
  });
});

describe("asking for another provider's catalogue", () => {
  const ask = async (app: App, provider: string) => app.request(`/settings/coach-model?provider=${provider}`);

  it("lists the server's models while Anthropic is still saved, and saves nothing", async () => {
    const app = appWith(fakeServers().fetchImpl);
    await putChoice(app, { model: "claude-opus-4-7", effort: "high" });
    await connect(app);

    const res = await ask(app, "self_hosted");
    expect(res.status).toBe(200);
    const got = await json(res);
    expect(got).toMatchObject({ provider: "self_hosted", saved: null, fallback: null });
    expect(got.models.map((m: { id: string }) => m.id)).toEqual(["qwen3-8b", "qwen3-8b:thinking", "gemma-3-27b"]);
    expect(await savedRows()).toEqual([{ provider: "anthropic", model: "claude-opus-4-7", effort: "high" }]);
    // The saved provider's view is unchanged.
    expect(await view(app)).toMatchObject({ provider: "anthropic", saved: { model: "claude-opus-4-7", effort: "high" } });
  });

  it("with no server saved, offers nothing, with no_connection", async () => {
    const { fetchImpl, listings } = fakeServers();
    const got = await json(await ask(appWith(fetchImpl), "self_hosted"));
    expect(got).toMatchObject({ provider: "self_hosted", saved: null, models: [], fallback: "no_connection" });
    expect(listings).toEqual([]);
  });

  it("asks for Anthropic's while self-hosted is saved, with no saved choice carried across", async () => {
    const app = appWith(fakeServers().fetchImpl);
    await connect(app);
    await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "low" });
    expect(await json(await ask(app, "anthropic"))).toMatchObject({
      provider: "anthropic",
      saved: null,
      effective: TESTED_COACH_MODEL,
      fallback: "no_key",
    });
    expect(await json(await ask(app, "self_hosted"))).toMatchObject({
      provider: "self_hosted",
      saved: { model: "qwen3-8b", effort: "low" },
    });
  });

  it("refuses an unknown provider", async () => {
    const res = await ask(appWith(fakeServers().fetchImpl), "openai");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_provider");
  });
});

describe("when the self-hosted listing is not there", () => {
  it("a failed listing offers only the saved model, and accepts it at any effort", async () => {
    const working = fakeServers();
    const app0 = appWith(working.fetchImpl);
    await connect(app0);
    await putChoice(app0, { provider: "self_hosted", model: "qwen3-8b:thinking", effort: "high" });

    // A fresh app: no cached listing, and the server now answers 500.
    const app = appWith(fakeServers({ listing: 500 }).fetchImpl);
    const got = await view(app);
    expect(got).toMatchObject({ provider: "self_hosted", fallback: "unavailable" });
    expect(got.models).toEqual([qwenThinking]);

    const same = await putChoice(app, { provider: "self_hosted", model: "qwen3-8b:thinking", effort: "low" });
    expect(same.status).toBe(200);
    expect(await savedRows()).toEqual([{ provider: "self_hosted", model: "qwen3-8b:thinking", effort: "low" }]);

    const other = await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "low" });
    expect(other.status).toBe(400);
    expect((await json(other)).error).toBe("unknown_model");
  });

  it("an unreachable server is unavailable too, and offers nothing when nothing self-hosted is saved", async () => {
    const app = appWith(fakeServers({ listing: "throw" }).fetchImpl);
    await connect(app);
    const res = await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "high" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unknown_model");
    expect(await savedRows()).toEqual([]);
  });

  it("with the server cleared, still shows the saved model, with no_connection", async () => {
    const { fetchImpl, listings } = fakeServers();
    const app = appWith(fetchImpl);
    await connect(app);
    await putChoice(app, { provider: "self_hosted", model: "gemma-3-27b", effort: "max" });
    expect(listings).toHaveLength(1);

    await app.request("/settings/self-hosted", { method: "DELETE" });
    const got = await view(app);
    expect(got).toMatchObject({
      provider: "self_hosted",
      saved: { model: "gemma-3-27b", effort: "max" },
      fallback: "no_connection",
    });
    expect(got.models).toEqual([
      { id: "gemma-3-27b", displayName: "gemma-3-27b", tested: false, efforts: ALL_EFFORTS },
    ]);
    expect(listings).toHaveLength(1);
    expect(await summary(app)).toMatchObject({ provider: "self_hosted", host: null });
  });
});

describe("the self-hosted listing cache", () => {
  it("reuses the listing, and asks again once the connection is saved or cleared", async () => {
    const { fetchImpl, listings } = fakeServers();
    const app = appWith(fetchImpl);
    await connect(app);
    await putChoice(app, { provider: "self_hosted", model: "qwen3-8b", effort: "high" });
    await view(app);
    await view(app);
    expect(listings).toHaveLength(1);

    await connect(app, { baseUrl: "http://studio.local:8000", apiKey: "another-key-9876" });
    await view(app);
    expect(listings.map((l) => [l.url, l.xApiKey])).toEqual([
      [`${BASE_URL}/v1/models`, SERVER_KEY],
      ["http://studio.local:8000/v1/models", "another-key-9876"],
    ]);

    await app.request("/settings/self-hosted", { method: "DELETE" });
    await connect(app);
    await view(app);
    expect(listings).toHaveLength(3);
    expect(listings[2]!.url).toBe(`${BASE_URL}/v1/models`);
  });
});
