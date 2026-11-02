import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { pool } from "../src/db.js";
import {
  buildStubWeeklyForm,
  createAnthropicLlmPort,
  TESTED_COACH_MODEL,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { saveCoachModel } from "../src/settings/coachModelStore.js";
import type { RuntimeSources } from "../src/settings/sources.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const API_KEY = "sk-ant-test-key-coach-model";
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

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

/** A `GET /v1/models` entry with the capabilities the catalogue reads. */
function listed(id: string, displayName: string, createdAt: string, efforts: string[], adaptive = true) {
  return {
    type: "model",
    id,
    display_name: displayName,
    created_at: createdAt,
    capabilities: {
      thinking: { supported: true, types: { adaptive: { supported: adaptive }, enabled: { supported: true } } },
      effort: Object.fromEntries(ALL_EFFORTS.map((e) => [e, { supported: efforts.includes(e) }])),
    },
  };
}

const OPUS_4_7 = listed("claude-opus-4-7", "Claude Opus 4.7", "2026-04-16T00:00:00Z", ALL_EFFORTS);
const OPUS_5_5 = listed("claude-opus-5-5", "Claude Opus 5.5", "2026-09-10T00:00:00Z", ALL_EFFORTS);
const OPUS_4_6 = listed("claude-opus-4-6", "Claude Opus 4.6", "2026-02-05T00:00:00Z", ["low", "medium", "high", "max"]);
const HAIKU_4_5 = listed("claude-haiku-4-5", "Claude Haiku 4.5", "2025-10-01T00:00:00Z", [], false);
const LISTING = [HAIKU_4_5, OPUS_4_6, OPUS_4_7, OPUS_5_5];

type SentBody = { model: string; output_config: { effort: string } };

/**
 * One fake Anthropic for both the model listing and coach calls. `listing` is
 * what `/v1/models` returns (a number = that HTTP status); `reply` answers a
 * Messages call by attempt number.
 */
function fakeAnthropic(options: {
  listing?: unknown[] | number;
  reply?: (attempt: number) => Promise<Response> | Response;
} = {}) {
  const sent: SentBody[] = [];
  const listings: Array<string | null> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/models")) {
      listings.push(new Headers(init?.headers).get("x-api-key"));
      const listing = options.listing ?? LISTING;
      if (typeof listing === "number") return new Response("nope", { status: listing });
      return Response.json({ data: listing, has_more: false });
    }
    sent.push(JSON.parse(String(init?.body)) as SentBody);
    if (!options.reply) throw new Error(`unexpected call to ${url}`);
    return options.reply(sent.length);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, sent, listings };
}

function settingsApp(fetchImpl: typeof globalThis.fetch, sources?: RuntimeSources) {
  return createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY, sources, llmFetch: fetchImpl });
}

async function saveKey() {
  await putAnthropicConnection(API_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
}

function put(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/settings/coach-model", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function view(app: ReturnType<typeof createApp>) {
  return json(await app.request("/settings/coach-model"));
}

async function savedRows() {
  const result = await pool.query("SELECT provider, model, effort FROM coach_model_settings");
  return result.rows;
}

const goodReply = () =>
  anthropicStreamResponse(
    anthropicToolMessage("submit_weekly_reply", buildStubWeeklyForm(samplePacket())),
  );

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
});

describe("coach model setting", () => {
  it("with no key, offers the tested default at every effort without asking Anthropic", async () => {
    await acceptAndReady();
    const { fetchImpl, listings } = fakeAnthropic();
    const got = await view(settingsApp(fetchImpl));
    expect(got.provider).toBe("anthropic");
    expect(got.saved).toBeNull();
    expect(got.effective).toEqual(TESTED_COACH_MODEL);
    expect(got.tested).toEqual(TESTED_COACH_MODEL);
    expect(got.models).toEqual([
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tested: true, efforts: ALL_EFFORTS },
    ]);
    expect(got.fallback).toBe("no_key");
    expect(listings).toEqual([]);
  });

  it("saves a supported effort, and DELETE goes back to the tested default", async () => {
    await acceptAndReady();
    const app = settingsApp(fakeAnthropic().fetchImpl);

    const saved = await put(app, { model: "claude-opus-4-7", effort: "Medium" });
    expect(saved.status).toBe(200);
    const body = await json(saved);
    expect(body.saved).toEqual({ model: "claude-opus-4-7", effort: "medium" });
    expect(body.effective).toEqual({ model: "claude-opus-4-7", effort: "medium" });
    expect(await savedRows()).toEqual([{ provider: "anthropic", model: "claude-opus-4-7", effort: "medium" }]);

    const cleared = await json(await app.request("/settings/coach-model", { method: "DELETE" }));
    expect(cleared.saved).toBeNull();
    expect(cleared.effective).toEqual(TESTED_COACH_MODEL);
    expect(await savedRows()).toEqual([]);
  });

  it("refuses what it cannot check, and saves nothing", async () => {
    await acceptAndReady();
    const app = settingsApp(fakeAnthropic().fetchImpl);

    for (const [body, error] of [
      [{ model: "claude-haiku-4-5", effort: "high" }, "unknown_model"],
      [{ model: "claude-opus-4-7", effort: "extra" }, "invalid_effort"],
      [{ model: "claude-opus-4-7" }, "model_and_effort_required"],
      [{ effort: "high" }, "model_and_effort_required"],
      ["{not json", "invalid_json"],
    ] as const) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe(error);
    }
    expect(await savedRows()).toEqual([]);
  });

  it("is behind the disclaimer", async () => {
    const res = await settingsApp(fakeAnthropic().fetchImpl).request("/settings/coach-model");
    expect(res.status).toBe(403);
  });

  it("accepts writes in stub and demo modes, so the demo season can set its effort", async () => {
    await acceptAndReady();
    const app = settingsApp(fakeAnthropic().fetchImpl, { tempo: "export", model: "stub", demo: true });
    const res = await put(app, { model: "claude-opus-4-7", effort: "medium" });
    expect(res.status).toBe(200);
    expect(await savedRows()).toEqual([{ provider: "anthropic", model: "claude-opus-4-7", effort: "medium" }]);
  });
});

describe("the models the athlete's key can use", () => {
  it("lists adaptive models with their efforts, tested default first, the rest newest first", async () => {
    await acceptAndReady();
    await saveKey();
    const { fetchImpl, listings } = fakeAnthropic();
    const got = await view(settingsApp(fetchImpl));
    expect(listings).toEqual([API_KEY]);
    expect(got.fallback).toBeNull();
    expect(got.models).toEqual([
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tested: true, efforts: ALL_EFFORTS },
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", tested: false, efforts: ALL_EFFORTS },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", tested: false, efforts: ["low", "medium", "high", "max"] },
    ]);
  });

  it("keeps the tested default first even when the listing leaves it out", async () => {
    await acceptAndReady();
    await saveKey();
    const got = await view(settingsApp(fakeAnthropic({ listing: [OPUS_5_5] }).fetchImpl));
    expect(got.models.map((m: { id: string; tested: boolean }) => [m.id, m.tested])).toEqual([
      ["claude-opus-4-7", true],
      ["claude-opus-5-5", false],
    ]);
  });

  it("refuses a model that can't take Cadence's request, and an effort the model lacks", async () => {
    await acceptAndReady();
    await saveKey();
    const app = settingsApp(fakeAnthropic().fetchImpl);

    const haiku = await put(app, { model: "claude-haiku-4-5", effort: "high" });
    expect(haiku.status).toBe(400);
    expect((await json(haiku)).error).toBe("unknown_model");

    const xhigh = await put(app, { model: "claude-opus-4-6", effort: "xhigh" });
    expect(xhigh.status).toBe(400);
    expect((await json(xhigh)).error).toBe("effort_not_supported");
    expect(await savedRows()).toEqual([]);
  });

  it("a listed model at a supported effort is what the next coach call sends", async () => {
    await acceptAndReady();
    await saveKey();
    const fake = fakeAnthropic({ reply: () => goodReply() });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmFetch: fake.fetchImpl,
      llmPort: createAnthropicLlmPort({ fetchImpl: fake.fetchImpl, readApiKey: async () => API_KEY }),
    });
    expect((await put(app, { model: "claude-opus-4-6", effort: "high" })).status).toBe(200);

    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: week.id, packet: samplePacket() }),
    });
    expect(res.status).toBe(200);
    expect(fake.sent[0]).toMatchObject({ model: "claude-opus-4-6", output_config: { effort: "high" } });
  });

  it("reuses the listing, and asks again once the key changes", async () => {
    await acceptAndReady();
    await saveKey();
    const { fetchImpl, listings } = fakeAnthropic();
    const app = settingsApp(fetchImpl);

    await view(app);
    await view(app);
    expect(listings).toHaveLength(1);

    await app.request("/settings/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-another-key" }),
    });
    await view(app);
    expect(listings).toEqual([API_KEY, "sk-ant-another-key"]);

    await app.request("/settings/anthropic", { method: "DELETE" });
    expect((await view(app)).fallback).toBe("no_key");
    expect(listings).toHaveLength(2);
  });

  it("when the listing fails, offers only the tested default and the saved model, and refuses the rest", async () => {
    await acceptAndReady();
    await saveKey();
    await saveCoachModel({ provider: "anthropic", model: "claude-opus-4-6", effort: "high" });
    const app = settingsApp(fakeAnthropic({ listing: 503 }).fetchImpl);

    const got = await view(app);
    expect(got.fallback).toBe("unavailable");
    expect(got.models).toEqual([
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tested: true, efforts: ALL_EFFORTS },
      { id: "claude-opus-4-6", displayName: "claude-opus-4-6", tested: false, efforts: ["high"] },
    ]);

    const res = await put(app, { model: "claude-opus-5-5", effort: "high" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unknown_model");
    expect((await put(app, { model: "claude-opus-4-7", effort: "low" })).status).toBe(200);
  });

  it("a saved model the listing no longer has is still shown, and a call to it fails with Anthropic's message", async () => {
    await acceptAndReady();
    await saveKey();
    await saveCoachModel({ provider: "anthropic", model: "claude-opus-4-5", effort: "high" });
    const fake = fakeAnthropic({
      listing: [OPUS_4_7, OPUS_5_5],
      reply: () => new Response('{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-4-5"}}', { status: 404 }),
    });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmFetch: fake.fetchImpl,
      llmPort: createAnthropicLlmPort({ fetchImpl: fake.fetchImpl, readApiKey: async () => API_KEY }),
    });

    const got = await view(app);
    expect(got.models.at(-1)).toEqual({ id: "claude-opus-4-5", displayName: "claude-opus-4-5", tested: false, efforts: ["high"] });

    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: week.id, packet: samplePacket() }),
    });
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_http_error");
    // No fallback to another model: one call, on the saved one.
    expect(fake.sent.map((b) => b.model)).toEqual(["claude-opus-4-5"]);
  });
});

describe("coach calls follow the saved setting", () => {
  async function liveApp(respond: (attempt: number) => Promise<Response>) {
    await acceptAndReady();
    const fake = fakeAnthropic({ reply: respond });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmFetch: fake.fetchImpl,
      llmPort: createAnthropicLlmPort({ fetchImpl: fake.fetchImpl, readApiKey: async () => API_KEY }),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(app, weekSessionId);
    return { app, weekSessionId, sent: fake.sent };
  }

  function askForReply(app: ReturnType<typeof createApp>, weekSessionId: string) {
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
  }

  it("the next call sends the saved effort and logs it, with no restart", async () => {
    const { app, weekSessionId, sent } = await liveApp(async () => goodReply());
    expect((await put(app, { model: "claude-opus-4-7", effort: "medium" })).status).toBe(200);

    expect((await askForReply(app, weekSessionId)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "claude-opus-4-7", output_config: { effort: "medium" } });

    const list = (await json(await app.request("/llm-calls"))) as unknown as Array<{ id: string }>;
    const row = await json(await app.request(`/llm-calls/${list[0]!.id}`));
    expect(row.model).toBe("claude-opus-4-7");
    expect(row.request).toMatchObject({ output_config: { effort: "medium" } });
  });

  it("a reply asked once more keeps the pair it started with, even if Settings changes in between", async () => {
    const { app, weekSessionId, sent } = await liveApp(async (attempt) => {
      if (attempt > 1) return goodReply();
      // The athlete changes Settings while the first attempt is out; it comes back refused for its shape.
      await saveCoachModel({ provider: "anthropic", model: "claude-opus-4-7", effort: "low" });
      return anthropicStreamResponse(
        anthropicToolMessage("submit_weekly_reply", { headline: "", prescribedWeek: null }),
      );
    });
    await put(app, { model: "claude-opus-4-7", effort: "medium" });

    expect((await askForReply(app, weekSessionId)).status).toBe(200);
    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(body).toMatchObject({ model: "claude-opus-4-7", output_config: { effort: "medium" } });
    }
  });
});
