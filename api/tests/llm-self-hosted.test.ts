import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { pool } from "../src/db.js";
import { buildStubWeeklyReply } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { coachSetupNudge } from "../src/settings/coachSetup.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  anthropicSseEvents,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const BASE_URL = "http://omlx.local:8000";
const SERVER_KEY = "omlx-local-key-ab12";
const ANTHROPIC_KEY = "sk-ant-test-key-fixture-xyz";
const MODEL = "qwen3-8b";
const W1 = "11111111-1111-4111-8111-111111111111";

/** The request body keys Anthropic mode sends today, in order. */
const REQUEST_KEYS = [
  "model",
  "max_tokens",
  "system",
  "tools",
  "thinking",
  "output_config",
  "tool_choice",
  "stream",
  "messages",
];

const ABOUT_YOU_DRAFT = {
  summaryBullets: ["You run Tue, Thu and Sat.", "Goal: a half marathon in April."],
  proposedBody: "# About you\n\n## Goal\nHalf marathon in April.\n\n## Schedule\nTue, Thu, Sat.",
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
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
  });
}

/** A reply each tool's validator accepts. */
function replyFor(toolName: string): unknown {
  if (toolName === "submit_weekly_reply") return buildStubWeeklyReply(samplePacket());
  if (toolName === "submit_mid_week_chat_reply") {
    return { body: "Good week. Keep Thursday easy." };
  }
  return ABOUT_YOU_DRAFT;
}

/**
 * The self-hosted fixture: an Anthropic-shaped stream with a tool_use block and
 * no thinking block, and usage without thinking tokens. With `usage: false`
 * the stream carries no usage at all.
 */
function thinkingLessStream(toolName: string, options: { usage?: boolean } = {}): Response {
  let frames = anthropicSseEvents(
    anthropicToolMessage(toolName, replyFor(toolName), {
      model: MODEL,
      usage: { input_tokens: 2100, output_tokens: 340 },
    }),
    { thinking: false },
  );
  if (options.usage === false) {
    frames = frames.map((frame) => {
      const [eventLine, dataLine] = frame.trimEnd().split("\n");
      const data = JSON.parse(dataLine!.slice("data: ".length)) as Record<string, unknown>;
      delete data.usage;
      if (data.message && typeof data.message === "object") {
        delete (data.message as Record<string, unknown>).usage;
      }
      return `${eventLine}\ndata: ${JSON.stringify(data)}\n\n`;
    });
  }
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An Anthropic stream, with the thinking block the real API sends. */
function anthropicStream(toolName: string): Response {
  return new Response(
    anthropicSseEvents(anthropicToolMessage(toolName, replyFor(toolName))).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

type SentCall = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * One fake for the self-hosted server (listing + Messages) and Anthropic. The
 * Messages answer is the thinking-less fixture on the self-hosted server and a
 * thinking stream on Anthropic. `respond` overrides the self-hosted answer.
 */
function fakeServers(
  options: {
    usage?: boolean;
    respond?: (toolName: string, n: number) => Response;
  } = {},
) {
  const sent: SentCall[] = [];
  let selfHostedCalls = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url, headers, body });
    const toolName = (body.tools as Array<{ name: string }>)[0]!.name;
    if (url.startsWith("https://api.anthropic.com")) return anthropicStream(toolName);
    selfHostedCalls += 1;
    return options.respond
      ? options.respond(toolName, selfHostedCalls)
      : thinkingLessStream(toolName, { usage: options.usage });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, sent };
}

type App = ReturnType<typeof createApp>;

function appWith(fetchImpl: typeof globalThis.fetch): App {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
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

async function useSelfHosted(
  app: App,
  connection: { baseUrl: string; apiKey?: string } = { baseUrl: BASE_URL, apiKey: SERVER_KEY },
  effort = "high",
) {
  expect((await send(app, "/settings/self-hosted", "PUT", connection)).status).toBe(200);
  const res = await send(app, "/settings/coach-model", "PUT", {
    provider: "self_hosted",
    model: MODEL,
    effort,
  });
  expect(res.status).toBe(200);
}

async function openWeek(app: App): Promise<string> {
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  return week.id as string;
}

function chat(app: App, weekSessionId: string, body: Record<string, unknown>) {
  return send(app, `/weeks/${weekSessionId}/chat`, "POST", body);
}

async function logRows(app: App) {
  return (await json(await app.request("/llm-calls"))) as unknown as Array<Record<string, unknown>>;
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

describe("a coach call to a self-hosted server", () => {
  it("goes to the base URL's Messages path with thinking enabled, the effort, and both key headers", async () => {
    const { fetchImpl, sent } = fakeServers();
    const app = appWith(fetchImpl);
    await useSelfHosted(app);
    const weekSessionId = await openWeek(app);
    await unlockPlanCheckIn(app, weekSessionId);

    const res = await send(app, "/week/reply", "POST", { weekSessionId, packet: samplePacket() });
    expect(res.status).toBe(200);

    expect(sent).toHaveLength(1);
    const call = sent[0]!;
    expect(call.url).toBe(`${BASE_URL}/v1/messages`);
    expect(call.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": SERVER_KEY,
      authorization: `Bearer ${SERVER_KEY}`,
      "anthropic-version": "2023-06-01",
    });
    expect(Object.keys(call.body)).toEqual(REQUEST_KEYS.filter((k) => k !== "thinking"));
    expect(call.body).toMatchObject({
      model: MODEL,
      max_tokens: 64_000,
      output_config: { effort: "high" },
      tool_choice: { type: "auto" },
      stream: true,
    });
    expect(call.body).not.toHaveProperty("thinking");
    expect((call.body.tools as Array<{ name: string }>)[0]!.name).toBe("submit_weekly_reply");
    expect(call.body.system).toMatch(/do not diagnose/i);
  });

  it("does not double a /v1 base URL, and sends neither key header when there is no key", async () => {
    const { fetchImpl, sent } = fakeServers();
    const app = appWith(fetchImpl);
    await useSelfHosted(app, { baseUrl: "http://192.168.1.20:8080/v1" }, "low");
    const weekSessionId = await openWeek(app);

    expect((await chat(app, weekSessionId, { body: "How is my week going?" })).status).toBe(201);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://192.168.1.20:8080/v1/messages");
    expect(sent[0]!.headers).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
    expect(sent[0]!.body).toMatchObject({
      model: MODEL,
      output_config: { effort: "low" },
    });
    const [row] = await logRows(app);
    expect(row).toMatchObject({ provider: "self_hosted", serverHost: "192.168.1.20" });
  });

  it("with no server saved, is not configured with self-hosted wording, and sends nothing", async () => {
    const { fetchImpl, sent } = fakeServers();
    const app = appWith(fetchImpl);
    await useSelfHosted(app);
    expect((await app.request("/settings/self-hosted", { method: "DELETE" })).status).toBe(200);
    const weekSessionId = await openWeek(app);

    const res = await chat(app, weekSessionId, { body: "Anyone there?" });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: "llm_not_configured",
      message: coachSetupNudge("self_hosted"),
    });

    await unlockPlanCheckIn(app, weekSessionId);
    const weekly = await send(app, "/week/reply", "POST", { weekSessionId, packet: samplePacket() });
    expect(weekly.status).toBe(400);
    expect((await json(weekly)).message).toBe(coachSetupNudge("self_hosted"));

    expect(sent).toEqual([]);
    expect(await logRows(app)).toEqual([]);
  });

  it("asks once more on the same server, model and effort when the first weekly reply is refused for its shape", async () => {
    const { fetchImpl, sent } = fakeServers({
      respond: (toolName, n) =>
        n === 1
          ? new Response(
              anthropicSseEvents(
                anthropicToolMessage(toolName, { analysis: "ok", prescribedWeek: { days: [] } }),
                { thinking: false },
              ).join(""),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            )
          : thinkingLessStream(toolName),
    });
    const app = appWith(fetchImpl);
    await useSelfHosted(app);
    const weekSessionId = await openWeek(app);
    await unlockPlanCheckIn(app, weekSessionId);

    const res = await send(app, "/week/reply", "POST", { weekSessionId, packet: samplePacket() });
    expect(res.status).toBe(200);
    expect(sent.map((c) => [c.url, c.body.model, c.body.output_config])).toEqual([
      [`${BASE_URL}/v1/messages`, MODEL, { effort: "high" }],
      [`${BASE_URL}/v1/messages`, MODEL, { effort: "high" }],
    ]);
    const rows = await logRows(app);
    expect(rows.map((r) => [r.outcome, r.provider, r.serverHost])).toEqual([
      ["ok", "self_hosted", "omlx.local"],
      ["schema_invalid", "self_hosted", "omlx.local"],
    ]);
  });
});

describe("every coach operation on a stream with no thinking block", () => {
  async function selfHostedApp(options: { usage?: boolean } = {}) {
    const servers = fakeServers(options);
    const app = appWith(servers.fetchImpl);
    await useSelfHosted(app);
    return { app, ...servers };
  }

  async function expectOneSelfHostedRow(app: App, operation: string) {
    const rows = await logRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation,
      provider: "self_hosted",
      serverHost: "omlx.local",
      model: MODEL,
      outcome: "ok",
      stopReason: "tool_use",
      inputTokens: 2100,
      outputTokens: 340,
      thinkingTokens: null,
    });
  }

  it("weekly reply", async () => {
    const { app, sent } = await selfHostedApp();
    const weekSessionId = await openWeek(app);
    await unlockPlanCheckIn(app, weekSessionId);
    const res = await send(app, "/week/reply", "POST", { weekSessionId, packet: samplePacket() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.reply as { prescribedWeek: { days: unknown[] } }).prescribedWeek.days).toHaveLength(7);
    expect(sent).toHaveLength(1);
    await expectOneSelfHostedRow(app, "weekly_reply");
  });

  it("mid-week chat", async () => {
    const { app } = await selfHostedApp();
    const weekSessionId = await openWeek(app);
    const res = await chat(app, weekSessionId, { body: "How is my week going?" });
    expect(res.status).toBe(201);
    expect(((await json(res)).coachMessage as { body: string }).body).toBe(
      "Good week. Keep Thursday easy.",
    );
    await expectOneSelfHostedRow(app, "mid_week_chat");
  });

  it("attached-run question", async () => {
    const { app, sent } = await selfHostedApp();
    const weekSessionId = await openWeek(app);
    const res = await chat(app, weekSessionId, {
      body: "How did Monday's 10k look?",
      attachmentWorkoutId: W1,
    });
    expect(res.status).toBe(201);
    expect((sent[0]!.body.messages as Array<{ content: string }>)[0]!.content).toContain(W1);
    await expectOneSelfHostedRow(app, "mid_week_chat");
  });

  it("About you first draft", async () => {
    const { app, sent } = await selfHostedApp();
    const weekSessionId = await openWeek(app);
    const res = await send(app, "/onboarding/answers", "POST", {
      answers: {
        goal: "Half marathon in April",
        schedule: "Tue/Thu/Sat, ~5 hrs/week",
        injuries_constraints: "Left calf tight after hills",
        preferences: "Long run Saturday",
      },
      goal: { kind: "race", distance: "half", raceName: "Half marathon in April" },
      weekSessionId,
    });
    expect(res.status).toBe(201);
    const proposal = (await json(res)).proposal as { summaryBullets: string[] };
    expect(proposal.summaryBullets).toEqual(ABOUT_YOU_DRAFT.summaryBullets);
    expect((sent[0]!.body.tools as Array<{ name: string }>)[0]!.name).toBe("submit_about_you");
    await expectOneSelfHostedRow(app, "dossier_v1");
  });

  it("About you correction", async () => {
    const { app } = await selfHostedApp();
    expect((await send(app, "/dossier", "PUT", { body: "# About you\n\n## Schedule\nTue Thu" })).status).toBe(201);
    const weekSessionId = await openWeek(app);
    const res = await send(app, "/dossier/corrections", "POST", {
      body: "I can run on Mondays now.",
      weekSessionId,
    });
    expect(res.status).toBe(201);
    await expectOneSelfHostedRow(app, "dossier_correction");
  });

  it("About you audit", async () => {
    const { app } = await selfHostedApp();
    expect((await send(app, "/dossier", "PUT", { body: "# About you\n\n## Schedule\nTue Thu" })).status).toBe(201);
    const res = await send(app, "/dossier/audits", "POST", { force: true });
    expect(res.status).toBe(201);
    await expectOneSelfHostedRow(app, "dossier_audit");
  });

  it("a stream with no usage block parses, and the row records nulls", async () => {
    const { app } = await selfHostedApp({ usage: false });
    const weekSessionId = await openWeek(app);
    expect((await chat(app, weekSessionId, { body: "How is my week going?" })).status).toBe(201);
    const [row] = await logRows(app);
    expect(row).toMatchObject({
      provider: "self_hosted",
      serverHost: "omlx.local",
      outcome: "ok",
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });
});

describe("Anthropic mode beside self-hosted", () => {
  /** What an Anthropic chat call sends today, checked field by field. */
  function expectTodaysAnthropicRequest(call: SentCall, model: string, effort: string) {
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    });
    expect(Object.keys(call.body)).toEqual(REQUEST_KEYS);
    expect(call.body).toMatchObject({
      model,
      max_tokens: 64_000,
      output_config: { effort },
      tool_choice: { type: "auto" },
      stream: true,
    });
    expect(call.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  }

  it("with nothing saved, a call is today's Anthropic request at the tested default, with no host", async () => {
    await putAnthropicConnection(ANTHROPIC_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
    const { fetchImpl, sent } = fakeServers();
    const app = appWith(fetchImpl);
    const weekSessionId = await openWeek(app);
    expect((await chat(app, weekSessionId, { body: "How is my week going?" })).status).toBe(201);

    expect(sent).toHaveLength(1);
    expectTodaysAnthropicRequest(sent[0]!, "claude-opus-4-7", "xhigh");
    const [row] = await logRows(app);
    expect(row).toMatchObject({ provider: "anthropic", serverHost: null, model: "claude-opus-4-7" });
  });

  it("switching back to Anthropic restores today's request; only thinking, model and effort differed", async () => {
    await putAnthropicConnection(ANTHROPIC_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
    const { fetchImpl, sent } = fakeServers();
    const app = appWith(fetchImpl);
    await useSelfHosted(app);
    const weekSessionId = await openWeek(app);
    expect((await chat(app, weekSessionId, { body: "First question" })).status).toBe(201);

    const back = await send(app, "/settings/coach-model", "PUT", {
      provider: "anthropic",
      model: "claude-opus-4-7",
      effort: "medium",
    });
    expect(back.status).toBe(200);
    expect((await chat(app, weekSessionId, { body: "Second question" })).status).toBe(201);

    expect(sent).toHaveLength(2);
    const [selfHosted, anthropic] = sent as [SentCall, SentCall];
    expectTodaysAnthropicRequest(anthropic, "claude-opus-4-7", "medium");
    // Same system prompt, reply tool, max_tokens, tool_choice and stream.
    const shared = (b: Record<string, unknown>) => ({
      system: b.system,
      tools: b.tools,
      max_tokens: b.max_tokens,
      tool_choice: b.tool_choice,
      stream: b.stream,
    });
    expect(shared(selfHosted.body)).toEqual(shared(anthropic.body));

    const rows = await logRows(app);
    expect(rows.map((r) => [r.provider, r.serverHost, r.model])).toEqual([
      ["anthropic", null, "claude-opus-4-7"],
      ["self_hosted", "omlx.local", MODEL],
    ]);
  });
});

describe("call log migration", () => {
  it("allows self_hosted, adds server_host, and still refuses an unknown provider", async () => {
    const insert = (provider: string, host: string | null) =>
      pool.query(
        `INSERT INTO llm_call_log (id, operation, provider, server_host, app_version, outcome)
         VALUES (gen_random_uuid(), 'weekly_reply', $1, $2, 'test', 'ok')`,
        [provider, host],
      );
    await expect(insert("self_hosted", "omlx.local")).resolves.toBeTruthy();
    await expect(insert("anthropic", null)).resolves.toBeTruthy();
    await expect(insert("openai", null)).rejects.toThrow(/llm_call_log_provider_check/);
    // Running the migration again keeps the rows and the constraint.
    await migrate();
    const { rows } = await pool.query(
      "SELECT provider, server_host FROM llm_call_log ORDER BY provider",
    );
    expect(rows).toEqual([
      { provider: "anthropic", server_host: null },
      { provider: "self_hosted", server_host: "omlx.local" },
    ]);
  });
});
