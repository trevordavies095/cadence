import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  COACH_SYSTEM_STANCE,
  MIDWEEK_SYSTEM_PROMPT,
  WEEKLY_SYSTEM_PROMPT,
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  createAnthropicLlmPort,
  LlmHttpError,
  LlmNotConfiguredError,
  LlmSchemaError,
  LlmTransportError,
  resolveDefaultLlmPort,
  validateMidWeekChatReply,
  validateWeeklyReply,
  type MidWeekChatReply,
  type WeeklyReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const WEEK_START = "2026-10-19";
const ISO_WEEK = "2026-W43";
// The weekly reply plans the week AFTER the reviewed week (N+1).
const PLAN_WEEK_START = "2026-10-26";
const PLAN_ISO_WEEK = "2026-W44";
const API_KEY = "sk-ant-test-key-fixture-xyz";

function samplePacket(): ModelPacket {
  return buildModelPacket({
    dossier: {
      versionId: 1,
      body: "Keep Achilles easy; cap quality.",
    },
    recapMarkdown: "## Summary\nSteady aerobic week.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: ISO_WEEK,
      start: `${WEEK_START}T00:00:00.000Z`,
      end: "2026-10-25T23:59:59.999Z",
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
  });
}

function anthropicToolResponse(reply: WeeklyReply): Response {
  return anthropicStreamResponse(
    anthropicToolMessage("submit_weekly_reply", reply),
  );
}

function anthropicMidWeekToolResponse(reply: MidWeekChatReply): Response {
  return anthropicStreamResponse(
    anthropicToolMessage("submit_mid_week_chat_reply", reply, {
      id: "msg_midweek",
    }),
  );
}

const PERSONA_IDENTITY = /You are Coach Cade, a running coach/;
const NO_SIGN_OFF =
  /Do not sign off with your name or refer to yourself by name or in the third person unless the athlete asks who you are/;

describe("Coach Cade persona in system prompts", () => {
  it("onboarding/dossier stance carries identity and no-sign-off", () => {
    expect(COACH_SYSTEM_STANCE).toMatch(PERSONA_IDENTITY);
    expect(COACH_SYSTEM_STANCE).toMatch(NO_SIGN_OFF);
  });
  it("weekly and mid-week prompts open with identity and carry no-sign-off", () => {
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/^You are Coach Cade, a running coach producing a weekly training plan\./);
    expect(MIDWEEK_SYSTEM_PROMPT).toMatch(/^You are Coach Cade, a running coach answering a mid-week check-in\./);
    for (const p of [WEEKLY_SYSTEM_PROMPT, MIDWEEK_SYSTEM_PROMPT]) {
      expect(p).toMatch(NO_SIGN_OFF);
    }
  });
});

describe("createAnthropicLlmPort (mocked Anthropic HTTP)", () => {
  it("posts Messages API with stored key and returns validated weekly reply", async () => {
    const packet = samplePacket();
    const expected = buildStubWeeklyReply(packet);
    let sawAuth = false;
    let sawToolChoice = false;

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(API_KEY);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      sawAuth = true;
      const body = JSON.parse(String(init?.body)) as {
        tool_choice?: { type: string };
        stream?: boolean;
        system?: string;
        messages?: Array<{ content: string }>;
      };
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect(body.stream).toBe(true);
      expect(body.system).toContain("submit_weekly_reply");
      sawToolChoice = true;
      expect(body.system).toMatch(/do not diagnose/i);
      expect(body.system).toMatch(PERSONA_IDENTITY);
      expect(body.system).toMatch(NO_SIGN_OFF);
      expect(body.messages?.[0]?.content).toContain(PLAN_WEEK_START);
      return anthropicToolResponse(expected);
    }) as unknown as typeof globalThis.fetch;

    const port = createAnthropicLlmPort({
      fetchImpl,
      readApiKey: async () => API_KEY,
    });

    const reply = await port.generateWeeklyReply(packet);
    expect(sawAuth).toBe(true);
    expect(sawToolChoice).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const checked = validateWeeklyReply(reply, PLAN_WEEK_START);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value.prescribedWeek.week).toBe(PLAN_ISO_WEEK);
      expect(checked.value.prescribedWeek.days).toHaveLength(7);
    }
  });

  it("throws LlmNotConfiguredError when key is missing", async () => {
    const port = createAnthropicLlmPort({
      fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
      readApiKey: async () => null,
    });
    await expect(port.generateWeeklyReply(samplePacket())).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    );
  });

  it("throws LlmHttpError on Anthropic non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("nope", { status: 401 }),
    ) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      readApiKey: async () => API_KEY,
    });
    await expect(port.generateWeeklyReply(samplePacket())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof LlmHttpError &&
        err.status === 401 &&
        err.code === "llm_http_error",
    );
  });

  it("throws LlmTransportError on fetch failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      readApiKey: async () => API_KEY,
    });
    await expect(port.generateWeeklyReply(samplePacket())).rejects.toBeInstanceOf(
      LlmTransportError,
    );
  });

  it("throws LlmSchemaError when tool payload fails validation", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicToolResponse({
        analysis: "ok",
        prescribedWeek: { week: ISO_WEEK, days: [] },
      }),
    ) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      readApiKey: async () => API_KEY,
    });
    await expect(port.generateWeeklyReply(samplePacket())).rejects.toBeInstanceOf(
      LlmSchemaError,
    );
  });

  it("posts mid-week tool for generateMidWeekChatReply when enabled", async () => {
    const packet = samplePacket();
    packet.attachments = [
      {
        workoutId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-10-20T12:00:00.000Z",
        durationS: 3600,
        distanceM: 10000,
        avgPaceS: 360,
        avgHeartRateBpm: 140,
        activityName: "Monday 10k",
      },
    ];
    const expected = buildStubMidWeekChatReply(packet);
    let sawTool = false;

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(API_KEY);
      const body = JSON.parse(String(init?.body)) as {
        tool_choice?: { type: string };
        stream?: boolean;
        system?: string;
        messages?: Array<{ content: string }>;
      };
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect(body.stream).toBe(true);
      expect(body.system).toContain("submit_mid_week_chat_reply");
      expect(body.system).toMatch(/workout attachments/i);
      expect(body.system).toMatch(/do not diagnose/i);
      expect(body.system).toMatch(PERSONA_IDENTITY);
      expect(body.system).toMatch(NO_SIGN_OFF);
      expect(body.messages?.[0]?.content).toContain("Monday 10k");
      sawTool = true;
      return anthropicMidWeekToolResponse(expected);
    }) as unknown as typeof globalThis.fetch;

    const port = createAnthropicLlmPort({
      fetchImpl,
      readApiKey: async () => API_KEY,
    });

    const reply = await port.generateMidWeekChatReply(packet);
    expect(sawTool).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const checked = validateMidWeekChatReply(reply);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value.body).toContain("Attached run feedback");
    }
  });

  it("throws LlmNotConfiguredError for mid-week when key is missing", async () => {
    const port = createAnthropicLlmPort({
      fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
      readApiKey: async () => null,
    });
    await expect(
      port.generateMidWeekChatReply(samplePacket()),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

describe("resolveDefaultLlmPort + createApp LLM_PROVIDER", () => {
  const prevProvider = process.env.LLM_PROVIDER;

  beforeEach(() => {
    delete process.env.LLM_PROVIDER;
  });

  afterEach(() => {
    if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prevProvider;
  });

  it("defaults to stub (CI)", async () => {
    const port = resolveDefaultLlmPort({ env: {} });
    const reply = await port.generateWeeklyReply(samplePacket());
    expect(reply.analysis).toContain("Headline");
  });

  it("selects anthropic when LLM_PROVIDER=anthropic", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicToolResponse(buildStubWeeklyReply(samplePacket())),
    ) as unknown as typeof globalThis.fetch;
    const port = resolveDefaultLlmPort({
      env: { LLM_PROVIDER: "anthropic" },
      fetchImpl,
      readApiKey: async () => API_KEY,
    });
    await port.generateWeeklyReply(samplePacket());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("POST /week/reply live Anthropic error surfacing", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.LLM_PROVIDER;
  });

  async function openUnlockedWeek(app: ReturnType<typeof createApp>) {
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await unlockPlanCheckIn(app, week.id as string);
    return week.id as string;
  }

  it("surfaces missing key as 400 llm_not_configured", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createAnthropicLlmPort({
        readApiKey: async () => null,
        fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
      }),
    });
    const weekSessionId = await openUnlockedWeek(app);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe("llm_not_configured");
  });

  it("surfaces Anthropic HTTP errors as 502 llm_http_error", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createAnthropicLlmPort({
        readApiKey: async () => API_KEY,
        fetchImpl: vi.fn(async () =>
          new Response("rate limited", { status: 429 }),
        ) as unknown as typeof globalThis.fetch,
      }),
    });
    const weekSessionId = await openUnlockedWeek(app);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
    });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error).toBe("llm_http_error");
    expect(body.status).toBe(429);
  });

  it("createApp with LLM_PROVIDER=anthropic uses encrypted settings key", async () => {
    await acceptAndReady();
    const protector = new SecretProtector(TEST_DATA_PROTECTION_KEY);
    await putAnthropicConnection(API_KEY, protector);

    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "anthropic";
    try {
      const fetchImpl = vi.fn(async (_url, init) => {
        expect(new Headers(init?.headers).get("x-api-key")).toBe(API_KEY);
        return anthropicToolResponse(buildStubWeeklyReply(samplePacket()));
      }) as unknown as typeof globalThis.fetch;

      const app = createApp({
        dataProtectionKey: TEST_DATA_PROTECTION_KEY,
        clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
        llmFetch: fetchImpl,
      });
      const weekSessionId = await openUnlockedWeek(app);

      const res = await app.request("/week/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekSessionId, packet: samplePacket() }),
      });
      expect(res.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const body = await json(res);
      expect((body.reply as WeeklyReply).prescribedWeek.days).toHaveLength(7);
    } finally {
      if (prev === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prev;
    }
  });
});
