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
  COACH_STANCE_SUMMARY,
  COACH_SYSTEM_STANCE,
  DOSSIER_AUDIT_SYSTEM_PROMPT,
  DOSSIER_CORRECTION_SYSTEM_PROMPT,
  DOSSIER_V1_SYSTEM_PROMPT,
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
  withCanonicalStance,
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

describe("safety callout limits in the tool schema", () => {
  it("tells the model the same limits the validator enforces", async () => {
    const { safetyCalloutsJsonSchema, MAX_SAFETY_CALLOUT_BODY, MAX_SAFETY_CALLOUT_TITLE, MAX_SAFETY_CALLOUTS } =
      await import("../src/llm/index.js");
    const schema = safetyCalloutsJsonSchema() as {
      maxItems: number;
      items: { properties: { title: { maxLength: number }; body: { maxLength: number } } };
    };
    expect(schema.maxItems).toBe(MAX_SAFETY_CALLOUTS);
    expect(schema.items.properties.title.maxLength).toBe(MAX_SAFETY_CALLOUT_TITLE);
    expect(schema.items.properties.body.maxLength).toBe(MAX_SAFETY_CALLOUT_BODY);
  });
});

describe("About you drafts on the live model (mocked Anthropic HTTP)", () => {
  const DRAFT = {
    summaryBullets: ["Goal: Lakeshore Marathon on Sun Nov 15, aiming for 3:30.", "You run Tue, Wed, Thu, Sat and Sun."],
    proposedBody: [
      "# About you",
      "",
      "## Stance",
      "Model-written stance that must not survive.",
      "",
      "## Goal",
      "Lakeshore Marathon on Sun Nov 15, aiming for 3:30.",
    ].join("\n"),
  };

  function capture() {
    const seen: Array<{ system: string; user: string; tool: string }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        system: string;
        tools: Array<{ name: string }>;
        messages: Array<{ content: string }>;
      };
      seen.push({ system: body.system, user: body.messages[0]!.content, tool: body.tools[0]!.name });
      return anthropicStreamResponse(anthropicToolMessage("submit_about_you", DRAFT));
    }) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({ fetchImpl, readApiKey: async () => API_KEY });
    return { port, seen };
  }

  it("onboarding draft goes to the model, with the canonical Stance put back", async () => {
    const { port, seen } = capture();
    const draft = await port.generateDossierV1({
      answers: { goal: "Lakeshore Marathon, 3:30", schedule: "Tue Wed Thu Sat Sun" },
      prefills: { available: false },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tool).toBe("submit_about_you");
    expect(seen[0]!.system).toBe(DOSSIER_V1_SYSTEM_PROMPT);
    expect(seen[0]!.user).toContain("Lakeshore Marathon, 3:30");
    expect(draft.summaryBullets).toEqual(DRAFT.summaryBullets);
    expect(draft.proposedBody).toContain(`## Stance\n${COACH_STANCE_SUMMARY}`);
    expect(draft.proposedBody).not.toContain("Model-written stance");
    expect(draft.proposedBody).toContain("## Goal");
  });

  it("Fix something sends the athlete's sentence and the current document", async () => {
    const { port, seen } = capture();
    await port.generateDossierCorrection({
      athleteMessage: "I can run on Mondays now.",
      currentDossier: { versionId: 3, body: "# About you\n\n## Schedule\nTue Thu" },
      week: { isoWeek: "2026-W42" },
    });
    expect(seen[0]!.system).toBe(DOSSIER_CORRECTION_SYSTEM_PROMPT);
    expect(seen[0]!.user).toContain("I can run on Mondays now.");
    expect(seen[0]!.user).toContain("## Schedule\nTue Thu");
    expect(seen[0]!.user).toContain("This week: Oct 12 – 18");
    expect(seen[0]!.user).not.toMatch(/2026-W42/);
  });

  it("tidy-up gives the model dates in the athlete's format, not raw ones", async () => {
    const { port, seen } = capture();
    await port.generateDossierAudit({
      currentDossier: { versionId: 7, body: "# About you\n\n## Coach update (Oct 5 – 11)\n- Achilles quiet" },
      week: { isoWeek: "2026-W42" },
      nowIso: "2026-10-14T23:20:00.000Z",
      intervalWeeks: 5,
    });
    expect(seen[0]!.system).toBe(DOSSIER_AUDIT_SYSTEM_PROMPT);
    expect(seen[0]!.user).toContain("Today: Wed Oct 14 (week of Oct 12 – 18)");
    expect(seen[0]!.user).toContain("Next tidy-up due: Wed Nov 18 (every 5 weeks)");
    expect(seen[0]!.user).not.toMatch(/2026-W42|2026-11-18/);
  });

  it("rejects a draft with no note-card lines", async () => {
    const fetchImpl = vi.fn(async () =>
      anthropicStreamResponse(
        anthropicToolMessage("submit_about_you", { summaryBullets: [], proposedBody: "# About you" }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({ fetchImpl, readApiKey: async () => API_KEY });
    await expect(
      port.generateDossierV1({ answers: { goal: "g", schedule: "s" }, prefills: { available: false } }),
    ).rejects.toBeInstanceOf(LlmSchemaError);
  });

  it("all three prompts carry the persona, vocabulary and writing rules", () => {
    for (const p of [DOSSIER_V1_SYSTEM_PROMPT, DOSSIER_CORRECTION_SYSTEM_PROMPT, DOSSIER_AUDIT_SYSTEM_PROMPT]) {
      expect(p).toMatch(PERSONA_IDENTITY);
      expect(p).toMatch(NO_SIGN_OFF);
      expect(p).toMatch(/never write them or a short form such as W43/);
      expect(p).toMatch(/never as 2026-10-19/);
      expect(p).toMatch(/Do not write a Stance section/);
    }
  });

  it("withCanonicalStance adds a missing title and Stance, and keeps the other sections in order", () => {
    const out = withCanonicalStance("## Goal\nRun 3:30\n\n## Stance\nold\n\n## Schedule\nTue");
    expect(out).toBe(
      `# About you\n\n## Stance\n${COACH_STANCE_SUMMARY}\n\n## Goal\nRun 3:30\n\n## Schedule\nTue`,
    );
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
