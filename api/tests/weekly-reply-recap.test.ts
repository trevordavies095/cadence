import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { buildStubWeeklyReply } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
import { saveWeekRecap } from "../src/recap/recapStore.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const STORED_RECAP =
  "# Weekly Recap\n\n## Subjective\nSUBJ-MARKER-STORED rpe 5, felt 7";
const EXPLICIT_RECAP = "## Explicit\nEXPLICIT-MARKER-XYZ";

function stubReply() {
  return buildStubWeeklyReply(
    buildModelPacket({
      dossier: null,
      recapMarkdown: null,
      thread: [],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
        weekSessionId: "00000000-0000-4000-8000-000000000001",
      },
    }),
  );
}

describe("weekly reply fills recap from stored week recap (#79)", () => {
  let prevProvider: string | undefined;
  let bodies: string[];

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    bodies = [];
    prevProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "anthropic";
    return () => {
      if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevProvider;
    };
  });

  async function liveApp() {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return anthropicStreamResponse(
        anthropicToolMessage("submit_weekly_reply", stubReply()),
      );
    }) as unknown as typeof globalThis.fetch;
    await acceptAndReady();
    await putAnthropicConnection(
      "sk-ant-test-key-fixture-xyz",
      new SecretProtector(TEST_DATA_PROTECTION_KEY),
    );
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmFetch: fetchImpl,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, weekSessionId: week.id as string };
  }

  function reply(
    app: ReturnType<typeof createApp>,
    payload: Record<string, unknown>,
  ) {
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** The user messages of the single captured Anthropic request. */
  function userContent(): string {
    expect(bodies).toHaveLength(1);
    return JSON.stringify(JSON.parse(bodies[0]!).messages);
  }

  it("fills the recap from the stored week recap when the request has none", async () => {
    const { app, weekSessionId } = await liveApp();
    await unlockPlanCheckIn(app, weekSessionId, "finish");
    await saveWeekRecap({
      at: new Date(),
      weekSessionId,
      markdown: STORED_RECAP,
      subjective: "present",
    });

    const res = await reply(app, { weekSessionId });
    expect(res.status).toBe(200);
    expect(userContent()).toContain("SUBJ-MARKER-STORED");
  });

  it("an explicit recapMarkdown wins over the stored recap", async () => {
    const { app, weekSessionId } = await liveApp();
    await unlockPlanCheckIn(app, weekSessionId, "finish");
    await saveWeekRecap({
      at: new Date(),
      weekSessionId,
      markdown: STORED_RECAP,
      subjective: "present",
    });

    const res = await reply(app, {
      weekSessionId,
      recapMarkdown: EXPLICIT_RECAP,
    });
    expect(res.status).toBe(200);
    const content = userContent();
    expect(content).toContain("EXPLICIT-MARKER-XYZ");
    expect(content).not.toContain("SUBJ-MARKER-STORED");
  });

  it("sends no recap when the week has none stored", async () => {
    const { app, weekSessionId } = await liveApp();
    await unlockPlanCheckIn(app, weekSessionId, "finish");

    const res = await reply(app, { weekSessionId });
    expect(res.status).toBe(200);
    const content = userContent();
    expect(content).toContain('\\"recapMarkdown\\":null');
    expect(content).not.toContain("Weekly Recap");
  });
});
