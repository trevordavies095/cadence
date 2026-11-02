import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { buildStubWeeklyReply, validateWeeklyReply } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
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
const ANTHROPIC_KEY = "sk-ant-test-key-fixture-xyz";
const SELF_HOSTED_URL = "http://omlx.local:8000";
const SELF_HOSTED_MODEL = "qwen3-8b";

/**
 * Anthropic's strict tool use limits, per request, counted across every strict
 * tool sent. Cadence sends one tool per call, so each tool must fit alone.
 * Source: Anthropic's structured outputs docs,
 * https://docs.claude.com/en/docs/build-with-claude/structured-outputs
 * (fetched 2026-11-01). Going over is a 400, not a warning.
 */
const STRICT_MAX_OPTIONAL_PARAMETERS = 24;
const STRICT_MAX_UNION_PARAMETERS = 16;
/** Strict mode accepts `minItems` of 0 or 1 only (same docs). */
const STRICT_MAX_MIN_ITEMS = 1;
/** Keywords strict mode does not support (same docs); any of them is a 400. */
const STRICT_UNSUPPORTED_KEYWORDS = [
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "multipleOf",
] as const;

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

function replyFor(toolName: string): unknown {
  if (toolName === "submit_weekly_reply") return buildStubWeeklyReply(samplePacket());
  if (toolName === "submit_mid_week_chat_reply") return { body: "Good week. Keep Thursday easy." };
  return ABOUT_YOU_DRAFT;
}

type SentTool = { name: string; description: string; input_schema: Record<string, unknown>; strict?: unknown };
type SentBody = { tools: SentTool[]; messages: Array<{ role: string; content: unknown }> };

function fakeAnthropic() {
  const sent: SentBody[] = [];
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/v1/models")) {
      return Response.json({ object: "list", data: [{ id: SELF_HOSTED_MODEL, object: "model" }] });
    }
    const body = JSON.parse(String(init?.body)) as SentBody;
    sent.push(body);
    urls.push(String(input));
    const toolName = body.tools[0]!.name;
    return new Response(
      anthropicSseEvents(anthropicToolMessage(toolName, replyFor(toolName))).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, sent, urls };
}

type App = ReturnType<typeof createApp>;

function send(app: App, p: string, method: string, body?: unknown) {
  return app.request(p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function openWeek(app: App): Promise<string> {
  return (await json(await app.request("/weeks/current", { method: "POST" }))).id as string;
}

type Provider = "anthropic" | "self_hosted";

/**
 * Drive each of the five coach operations once and return the request body each
 * sent, to Anthropic (the default) or to a self-hosted server.
 */
async function sentByOperation(provider: Provider = "anthropic"): Promise<Record<string, SentBody>> {
  await putAnthropicConnection(ANTHROPIC_KEY, new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const { fetchImpl, sent, urls } = fakeAnthropic();
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmFetch: fetchImpl,
  });
  if (provider === "self_hosted") {
    expect((await send(app, "/settings/self-hosted", "PUT", { baseUrl: SELF_HOSTED_URL })).status).toBe(200);
    expect(
      (
        await send(app, "/settings/coach-model", "PUT", {
          provider: "self_hosted",
          model: SELF_HOSTED_MODEL,
          effort: "high",
        })
      ).status,
    ).toBe(200);
  }
  const out: Record<string, SentBody> = {};
  const take = (operation: string) => {
    expect(sent, operation).toHaveLength(1);
    expect(urls.pop(), operation).toBe(
      provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : `${SELF_HOSTED_URL}/v1/messages`,
    );
    out[operation] = sent.pop()!;
  };

  // Onboarding first: it is refused once an About you document exists.
  const weekSessionId = await openWeek(app);
  const onboarding = await send(app, "/onboarding/answers", "POST", {
    answers: {
      goal: "Half marathon in April",
      schedule: "Tue/Thu/Sat, ~5 hrs/week",
      injuries_constraints: "Left calf tight after hills",
      preferences: "Long run Saturday",
    },
    goal: { kind: "race", distance: "half", raceName: "Half marathon in April" },
    weekSessionId,
  });
  expect(onboarding.status).toBe(201);
  take("About you first draft");

  await unlockPlanCheckIn(app, weekSessionId);
  expect((await send(app, "/week/reply", "POST", { weekSessionId, packet: samplePacket() })).status).toBe(200);
  take("weekly reply");

  expect(
    (await send(app, `/weeks/${weekSessionId}/chat`, "POST", { body: "How is my week going?" })).status,
  ).toBe(201);
  take("mid-week reply");

  expect((await send(app, "/dossier", "PUT", { body: "# About you\n\n## Schedule\nTue Thu" })).status).toBe(201);
  expect(
    (await send(app, "/dossier/corrections", "POST", { body: "I can run on Mondays now.", weekSessionId })).status,
  ).toBe(201);
  take("correction");

  expect((await send(app, "/dossier/audits", "POST", { force: true })).status).toBe(201);
  take("audit");
  return out;
}

type Walk = { optional: number; unions: number; problems: string[] };

function isObjectSchema(node: Record<string, unknown>): boolean {
  const t = node.type;
  return t === "object" || (Array.isArray(t) && t.includes("object")) || "properties" in node;
}

/**
 * Walk a JSON schema at every depth: count optional parameters (properties not
 * in their object's `required`) and union parameters (type arrays or `anyOf`),
 * and note anything strict mode refuses.
 */
function walk(node: unknown, at: string, acc: Walk): Walk {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, `${at}[${i}]`, acc));
    return acc;
  }
  if (typeof node !== "object" || node === null) return acc;
  const schema = node as Record<string, unknown>;

  if (Array.isArray(schema.type) || Array.isArray(schema.anyOf)) acc.unions += 1;
  for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
    if (keyword in schema) acc.problems.push(`${at}: ${keyword}`);
  }
  if (typeof schema.minItems === "number" && schema.minItems > STRICT_MAX_MIN_ITEMS) {
    acc.problems.push(`${at}: minItems ${schema.minItems}`);
  }
  if (isObjectSchema(schema)) {
    if (schema.additionalProperties !== false) acc.problems.push(`${at}: additionalProperties is not false`);
    if (!Array.isArray(schema.required)) acc.problems.push(`${at}: no required`);
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const [name, child] of Object.entries(properties)) {
      if (!required.has(name)) acc.optional += 1;
      walk(child, `${at}.${name}`, acc);
    }
  }
  if ("items" in schema) walk(schema.items, `${at}[]`, acc);
  for (const key of ["anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) walk(schema[key], `${at}.${key}`, acc);
  }
  return acc;
}

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

let prevProvider: string | undefined;

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

describe("every tool the adapter sends fits Anthropic's strict mode", () => {
  it("each of the five operations sends one tool inside the limits, with no unsupported keyword", async () => {
    const sent = await sentByOperation();
    expect(Object.keys(sent)).toEqual([
      "About you first draft",
      "weekly reply",
      "mid-week reply",
      "correction",
      "audit",
    ]);
    const counts: Record<string, { tool: string; optional: number; unions: number }> = {};
    for (const [operation, body] of Object.entries(sent)) {
      expect(body.tools, operation).toHaveLength(1);
      const tool = body.tools[0]!;
      expect(tool.strict, operation).toBe(true);
      const result = walk(tool.input_schema, tool.name, { optional: 0, unions: 0, problems: [] });
      expect(result.problems, operation).toEqual([]);
      expect(result.optional, operation).toBeLessThanOrEqual(STRICT_MAX_OPTIONAL_PARAMETERS);
      expect(result.unions, operation).toBeLessThanOrEqual(STRICT_MAX_UNION_PARAMETERS);
      counts[operation] = { tool: tool.name, optional: result.optional, unions: result.unions };
    }
    // Pinned so a schema edit that moves the counts shows up as a diff here.
    expect(counts).toEqual({
      "weekly reply": { tool: "submit_weekly_reply", optional: 12, unions: 7 },
      "mid-week reply": { tool: "submit_mid_week_chat_reply", optional: 12, unions: 7 },
      "About you first draft": { tool: "submit_about_you", optional: 0, unions: 0 },
      correction: { tool: "submit_about_you", optional: 0, unions: 0 },
      audit: { tool: "submit_about_you", optional: 0, unions: 0 },
    });
  });

  it("the walker catches what strict mode refuses", () => {
    const bad = {
      type: "object",
      properties: {
        days: { type: "array", minItems: 7, maxItems: 7, items: { type: "object", properties: {} } },
        name: { type: ["string", "null"], maxLength: 10 },
      },
    };
    expect(walk(bad, "t", { optional: 0, unions: 0, problems: [] })).toEqual({
      optional: 2,
      unions: 1,
      problems: [
        "t: additionalProperties is not false",
        "t: no required",
        "t.days: maxItems",
        "t.days: minItems 7",
        "t.days[]: additionalProperties is not false",
        "t.days[]: no required",
        "t.name: maxLength",
      ],
    });
  });
});

describe("every tool is sent strict, on either provider", () => {
  for (const provider of ["anthropic", "self_hosted"] as const) {
    it(`${provider}: each of the five operations sends its tool with strict: true beside name, description and input_schema`, async () => {
      const sent = await sentByOperation(provider);
      expect(Object.keys(sent)).toHaveLength(5);
      for (const [operation, body] of Object.entries(sent)) {
        expect(body.tools, operation).toHaveLength(1);
        for (const tool of body.tools) {
          expect(Object.keys(tool), operation).toEqual(["name", "description", "input_schema", "strict"]);
          expect(tool.strict, operation).toBe(true);
        }
      }
    });
  }

  it("Anthropic and self-hosted send the same tools", async () => {
    const anthropic = await sentByOperation("anthropic");
    await resetAppTables();
    await acceptAndReady();
    const selfHosted = await sentByOperation("self_hosted");
    for (const operation of Object.keys(anthropic)) {
      expect(selfHosted[operation]!.tools, operation).toEqual(anthropic[operation]!.tools);
    }
  });
});

describe("the seven-day rule lives in the prompt and the validator, not the schema", () => {
  it("the weekly tool's days carry no minItems or maxItems, and the user turn lists the seven dates", async () => {
    const weekly = (await sentByOperation())["weekly reply"]!;
    const properties = weekly.tools[0]!.input_schema.properties as Record<
      string,
      { properties: Record<string, Record<string, unknown>> }
    >;
    const days = properties.prescribedWeek!.properties.days!;
    expect(days).not.toHaveProperty("minItems");
    expect(days).not.toHaveProperty("maxItems");
    expect(String(weekly.messages[0]!.content)).toContain(
      "prescribedWeek.days must use these exact dates Mon–Sun: 2026-10-26, 2026-10-27, 2026-10-28, 2026-10-29, 2026-10-30, 2026-10-31, 2026-11-01",
    );
  });

  it("the validator refuses a week of six days", () => {
    const reply = buildStubWeeklyReply(samplePacket());
    const six = {
      ...reply,
      prescribedWeek: { ...reply.prescribedWeek, days: reply.prescribedWeek.days.slice(0, 6) },
    };
    expect(validateWeeklyReply(six, "2026-10-26")).toEqual({
      ok: false,
      error: "prescribedWeek.days must contain exactly 7 entries (Mon–Sun)",
    });
  });
});
