import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  buildStubWeeklyReply,
  createAnthropicLlmPort,
  createCoachTargetResolver,
  createStubLlmPort,
  expectedPlanDates,
  LlmSchemaError,
  TESTED_COACH_MODEL,
  validateWeeklyReply,
  type CoachTarget,
  type LlmPort,
  type WeeklyReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { saveCoachModel } from "../src/settings/coachModelStore.js";
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
const WEEK_START = "2026-10-26";

function plan() {
  return {
    week: "2026-W44",
    days: expectedPlanDates(WEEK_START).map((date) => ({ date, dayType: "rest", run: null })),
  };
}

describe("a plan sent as a string", () => {
  const reply = (prescribedWeek: unknown) => ({
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek,
  });

  it("is parsed and accepted when the string is well-formed, with the repair noted", () => {
    const checked = validateWeeklyReply(reply(JSON.stringify(plan())), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.prescribedWeek.days).toHaveLength(7);
    expect(checked.repairs).toContain("prescribedWeek arrived as a string of JSON and was parsed");
  });

  it("is refused when the string is malformed", () => {
    const broken = JSON.stringify(plan()).replace('"rest","run":null}', '"rest","run":null}}');
    expect(validateWeeklyReply(reply(broken), WEEK_START).ok).toBe(false);
  });
});

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

describe("a refused weekly reply is asked for once more", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  /**
   * A stub whose first replies fail in the given ways, then answer normally. It
   * resolves its target from saved settings, as the live adapter does, and
   * `beforeAttempt` runs as each attempt starts.
   */
  function flakyPort(
    failures: Array<"throws" | "invalid">,
    beforeAttempt: (attempt: number) => Promise<void> = async () => {},
  ) {
    const stub = createStubLlmPort();
    let calls = 0;
    const coachTargets: Array<CoachTarget | undefined> = [];
    const port: LlmPort = {
      ...stub,
      resolveCoachTarget: createCoachTargetResolver({ dataProtectionKey: TEST_DATA_PROTECTION_KEY }),
      async generateWeeklyReply(packet, options) {
        coachTargets.push(options?.coachTarget);
        const failure = failures[calls];
        calls += 1;
        await beforeAttempt(calls);
        if (failure === "throws") throw new LlmSchemaError("prescribedWeek must be an object");
        const reply = await stub.generateWeeklyReply(packet, options);
        if (failure === "invalid") return { ...reply, headline: "" } as WeeklyReply;
        return reply;
      },
    };
    return { port, calls: () => calls, coachTargets };
  }

  async function askForReply(port: LlmPort, packet?: ModelPacket) {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: port,
    });
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        packet
          ? { weekSessionId: week.id, packet }
          : { weekSessionId: week.id, recapMarkdown: "## Summary\nSteady week." },
      ),
    });
  }

  it("answers on the first try without asking again", async () => {
    const { port, calls } = flakyPort([]);
    expect((await askForReply(port)).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("recovers when the model's reply is refused the first time", async () => {
    const { port, calls } = flakyPort(["throws"]);
    const res = await askForReply(port);
    expect(res.status).toBe(200);
    expect((await json(res)).prescribed).toBeTruthy();
    expect(calls()).toBe(2);
  });

  it("hands both attempts the one model and effort it resolved for the run", async () => {
    const { port, coachTargets } = flakyPort(["throws"]);
    expect((await askForReply(port)).status).toBe(200);
    expect(coachTargets).toHaveLength(2);
    expect(coachTargets[0]).toMatchObject(TESTED_COACH_MODEL);
    expect(coachTargets[1]).toBe(coachTargets[0]);
  });

  it("hands both attempts the one target, even if the key and model change in between", async () => {
    await putAnthropicConnection("sk-ant-first-key", new SecretProtector(TEST_DATA_PROTECTION_KEY));
    await saveCoachModel({ model: "claude-opus-4-6", effort: "high" });
    const { port, coachTargets } = flakyPort(["throws"], async (attempt) => {
      if (attempt !== 1) return;
      await putAnthropicConnection("sk-ant-second-key", new SecretProtector(TEST_DATA_PROTECTION_KEY));
      await saveCoachModel({ model: "claude-opus-5-5", effort: "low" });
    });
    expect((await askForReply(port)).status).toBe(200);
    expect(coachTargets).toHaveLength(2);
    expect(coachTargets[0]).toEqual({
      provider: "anthropic",
      messagesUrl: "https://api.anthropic.com/v1/messages",
      credentials: { apiKey: "sk-ant-first-key" },
      model: "claude-opus-4-6",
      effort: "high",
    });
    expect(coachTargets[1]).toBe(coachTargets[0]);
  });

  it("sends both live attempts to the same URL, key, model and effort when Settings change in between", async () => {
    const protector = new SecretProtector(TEST_DATA_PROTECTION_KEY);
    await putAnthropicConnection("sk-ant-first-key", protector);
    await saveCoachModel({ model: "claude-opus-4-6", effort: "high" });
    const packet = samplePacket();
    const sent: Array<{ url: string; key: string | null; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        key: new Headers(init?.headers).get("x-api-key"),
        body: String(init?.body),
      });
      if (sent.length > 1) {
        return anthropicStreamResponse(
          anthropicToolMessage("submit_weekly_reply", buildStubWeeklyReply(packet)),
        );
      }
      // Settings change while the first attempt is out; it comes back refused for its shape.
      await putAnthropicConnection("sk-ant-second-key", protector);
      await saveCoachModel({ model: "claude-opus-5-5", effort: "low" });
      return anthropicStreamResponse(
        anthropicToolMessage("submit_weekly_reply", { headline: "", prescribedWeek: null }),
      );
    }) as unknown as typeof globalThis.fetch;
    const port = createAnthropicLlmPort({
      fetchImpl,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: "http://fake-anthropic.test/v1/messages",
    });

    expect((await askForReply(port, packet)).status).toBe(200);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.url).toBe("http://fake-anthropic.test/v1/messages");
      expect(call.key).toBe("sk-ant-first-key");
      expect(JSON.parse(call.body)).toMatchObject({
        model: "claude-opus-4-6",
        output_config: { effort: "high" },
      });
    }
    expect(sent[1]!.body).toBe(sent[0]!.body);
  });

  it("recovers when the route's own check refuses the first reply", async () => {
    const { port, calls } = flakyPort(["invalid"]);
    expect((await askForReply(port)).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("asks only once more, then reports the failure", async () => {
    const { port, calls } = flakyPort(["throws", "throws", "throws"]);
    const res = await askForReply(port);
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_schema_invalid");
    expect(calls()).toBe(2);
  });
});
