import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  buildStubAttachedRunFeedback,
  buildStubMidWeekChatReply,
  createAnthropicLlmPort,
  createStubLlmPort,
  validateMidWeekChatReply,
  type MidWeekChatReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, toAttachment } from "../src/packet/index.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/** Known Monday run in the scrubbed export mini pack. */
const W1 = "11111111-1111-4111-8111-111111111111";

const API_KEY = "sk-ant-test-key-fixture-xyz";

function anthropicMidWeekToolResponse(reply: MidWeekChatReply): Response {
  return anthropicStreamResponse(
    anthropicToolMessage("submit_mid_week_chat_reply", reply, {
      id: "msg_midweek_test",
    }),
  );
}

describe("mid-week attach coach feedback stub (#37)", () => {
  it("builds deterministic feedback from attachment metrics", async () => {
    const tempo = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const detail = await tempo.getWorkout(W1);
    expect(detail).toBeTruthy();
    const attachment = toAttachment(detail!);
    expect(attachment).toBeTruthy();

    const packet = buildModelPacket({
      dossier: { versionId: 1, body: "Keep easy volume capped." },
      recapMarkdown: null,
      thread: [
        {
          role: "athlete",
          body: "How did Monday look?",
          createdAt: "2026-10-21T15:00:00.000Z",
        },
      ],
      attachments: [attachment!],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
      },
    });

    const feedback = buildStubAttachedRunFeedback(packet);
    expect(feedback).toContain("Attached run feedback");
    expect(feedback).toContain("Monday 10k");
    expect(feedback).toContain("10.0 km");
    expect(feedback).toContain("1:00:00");
    expect(feedback).toContain("6:00/km");
    expect(feedback).toContain("avg HR 140 bpm");
    expect(feedback).toMatch(/do not diagnose/i);

    const a = buildStubMidWeekChatReply(packet);
    const b = buildStubMidWeekChatReply(packet);
    expect(a.body).toBe(b.body);
    expect(a.body).toContain(feedback!);

    const validated = validateMidWeekChatReply(a);
    expect(validated.ok).toBe(true);
  });

  it("omits attach feedback when packet has no attachments", () => {
    const packet = buildModelPacket({
      dossier: null,
      recapMarkdown: null,
      thread: [{ role: "athlete", body: "Feeling flat today." }],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
      },
    });
    expect(buildStubAttachedRunFeedback(packet)).toBeNull();
    const reply = buildStubMidWeekChatReply(packet);
    expect(reply.body).toContain("No run attached");
    expect(reply.body).not.toContain("Attached run feedback");
  });
});

describe("mid-week attach coach feedback API (#37)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    delete process.env.LLM_PROVIDER;
  });

  it("attach → stub coach feedback message on current week thread", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Thoughts on this Monday run?",
        attachmentWorkoutId: W1,
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    const coach = body.coachMessage as Record<string, unknown>;
    expect(coach.role).toBe("coach");
    expect(String(coach.body)).toContain("Attached run feedback");
    expect(String(coach.body)).toContain("10.0 km");
    expect(String(coach.body)).toContain("Monday 10k");

    const listed = await json(
      await app.request(`/thread?weekSessionId=${week.id as string}`),
    );
    const messages = listed.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("coach");
    expect(String(messages[1]!.body)).toContain("Attached run feedback");
  });

  it("live Anthropic path posts mid-week tool and persists feedback", async () => {
    await acceptAndReady();
    const liveBody =
      "Solid aerobic Monday — 10k at easy pace looks controlled. Keep Thursday honest.";
    let sawMidWeekTool = false;

    const fetchImpl = vi.fn(async (_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as {
        tool_choice?: { type: string };
        stream?: boolean;
        system?: string;
        messages?: Array<{ content: string }>;
      };
      expect(parsed.tool_choice).toEqual({ type: "auto" });
      expect(parsed.stream).toBe(true);
      expect(parsed.system).toContain("submit_mid_week_chat_reply");
      expect(parsed.system).toMatch(/do not diagnose/i);
      expect(parsed.system).toMatch(/workout attachments/i);
      expect(parsed.messages?.[0]?.content).toMatch(/workout attachment/i);
      expect(parsed.messages?.[0]?.content).toContain(W1);
      sawMidWeekTool = true;
      return anthropicMidWeekToolResponse({ body: liveBody });
    }) as unknown as typeof globalThis.fetch;

    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createAnthropicLlmPort({
        fetchImpl,
        readApiKey: async () => API_KEY,
      }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "How was Monday?",
        attachmentWorkoutId: W1,
      }),
    });
    expect(res.status).toBe(201);
    expect(sawMidWeekTool).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const body = await json(res);
    expect((body.coachMessage as { body: string }).body).toBe(liveBody);

    const listed = await json(
      await app.request(`/thread?weekSessionId=${week.id as string}`),
    );
    const messages = listed.messages as Array<Record<string, unknown>>;
    expect(messages[1]!.body).toBe(liveBody);
  });

  it("surfaces missing Anthropic key as 400 on mid-week chat", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createAnthropicLlmPort({
        readApiKey: async () => null,
        fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
      }),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Need feedback",
        attachmentWorkoutId: W1,
      }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("llm_not_configured");
  });
});
