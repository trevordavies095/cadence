import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  createStubLlmPort,
  LlmNotConfiguredError,
  type LlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { saveCoachModel } from "../src/settings/coachModelStore.js";
import type { RuntimeSources } from "../src/settings/sources.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const WED = new FixedClock(new Date("2026-10-21T15:00:00.000Z"));
const SAT = new FixedClock(new Date("2026-10-24T15:00:00.000Z"));

const ANTHROPIC_NUDGE = "Coach Cade isn’t connected yet. Add your Anthropic key in Settings.";
const SELF_HOSTED_NUDGE = "Coach Cade isn’t connected yet. Set up your model server in Settings.";

type App = ReturnType<typeof createApp>;

/** The live coach (an injected port counts as live), unless sources say otherwise. */
function appFor(options: { llmPort?: LlmPort; sources?: RuntimeSources; clock?: FixedClock } = {}) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: options.clock ?? WED,
    athleteTimezone: "America/New_York",
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmPort: options.llmPort ?? createStubLlmPort(),
    sources: options.sources,
  });
}

function put(app: App, route: string, body: unknown) {
  return app.request(route, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function connectTempo(app: App) {
  expect(
    (await put(app, "/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_coach_setup_key" })).status,
  ).toBe(200);
}

async function saveAnthropicKey(app: App) {
  expect((await put(app, "/settings/anthropic", { apiKey: "sk-ant-coach-setup-key" })).status).toBe(200);
}

async function connectModelServer(app: App) {
  expect((await put(app, "/settings/self-hosted", { baseUrl: "http://192.168.1.20:8000" })).status).toBe(200);
}

async function chooseSelfHosted() {
  await saveCoachModel({ provider: "self_hosted", model: "qwen3-8b", effort: "high" });
}

async function loopStatus(app: App) {
  return json(await app.request("/loop-status"));
}

/** A live coach whose every call finds no connection for the saved provider. */
function notConfiguredPort(): LlmPort {
  const port = createStubLlmPort();
  const refuse = async (): Promise<never> => {
    throw new LlmNotConfiguredError();
  };
  port.generateWeeklyReply = refuse;
  port.generateMidWeekChatReply = refuse;
  port.generateDossierV1 = refuse;
  return port;
}

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  await acceptAndReady();
});

describe("coach configured: one rule for onboarding, Home and the loop status", () => {
  it("a self-hosted server with no Anthropic key is set up", async () => {
    const app = appFor();
    await connectTempo(app);
    await chooseSelfHosted();
    await connectModelServer(app);

    const status = await loopStatus(app);
    expect(status.phase).toBe("needs_onboarding");
    expect(status.flags).toMatchObject({ setupComplete: true, coachConfigured: true });

    const home = await json(await appFor({ clock: SAT }).request("/home"));
    expect(home.banner).toMatchObject({ kind: "needs_onboarding" });

    const saved = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: { schedule: "Tue Thu Sat" },
        goal: { kind: "race", distance: "half", raceName: "Half marathon in January" },
      }),
    });
    expect(saved.status).toBe(201);
    expect((await json(saved)).llm).toMatchObject({ coachConfigured: true });
  });

  it("self-hosted chosen with no server saved is not set up, even with an Anthropic key", async () => {
    const app = appFor();
    await connectTempo(app);
    await saveAnthropicKey(app);
    await chooseSelfHosted();

    const status = await loopStatus(app);
    expect(status.phase).toBe("setup_incomplete");
    expect(status.flags).toMatchObject({ setupComplete: false, coachConfigured: false });
    expect(status.primaryCta).toMatchObject({ href: "/settings" });

    const home = await json(await appFor({ clock: SAT }).request("/home"));
    expect(home.banner).toMatchObject({ kind: "setup_incomplete" });
  });

  it("Anthropic still needs its key, and a saved server alone does not count", async () => {
    const app = appFor();
    await connectTempo(app);
    await connectModelServer(app);

    expect((await loopStatus(app)).flags).toMatchObject({ coachConfigured: false });

    await saveAnthropicKey(app);
    const status = await loopStatus(app);
    expect(status.phase).toBe("needs_onboarding");
    expect(status.flags).toMatchObject({ coachConfigured: true });
  });

  it("the stub needs nothing saved, whichever provider is chosen", async () => {
    await chooseSelfHosted();
    const app = appFor({ sources: { tempo: "export", model: "stub", demo: false } });

    const status = await loopStatus(app);
    expect(status.phase).toBe("needs_onboarding");
    expect(status.flags).toMatchObject({ coachConfigured: true });
  });

  it("the demo (stub coach, sample season) stays set up", async () => {
    const app = appFor({ sources: { tempo: "export", model: "stub", demo: true } });
    expect((await loopStatus(app)).flags).toMatchObject({ setupComplete: true, coachConfigured: true });
  });
});

describe("the not-configured error from a coach route names what to set up", () => {
  async function askMidWeek(app: App) {
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    return app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How should Saturday go?" }),
    });
  }

  function answerOnboarding(app: App) {
    return app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: { schedule: "Tue Thu Sat" },
        goal: { kind: "race", distance: "half", raceName: "Half marathon in January" },
      }),
    });
  }

  it("asks for the Anthropic key when Anthropic is the provider", async () => {
    const app = appFor({ llmPort: notConfiguredPort() });

    for (const res of [await askMidWeek(app), await answerOnboarding(app)]) {
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "llm_not_configured", message: ANTHROPIC_NUDGE });
    }
  });

  it("asks for the model server, and never names Anthropic, when self-hosted is the provider", async () => {
    await chooseSelfHosted();
    const app = appFor({ llmPort: notConfiguredPort() });

    for (const res of [await askMidWeek(app), await answerOnboarding(app)]) {
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body).toEqual({ error: "llm_not_configured", message: SELF_HOSTED_NUDGE });
      expect(JSON.stringify(body)).not.toMatch(/anthropic/i);
    }

    // The loop status and Home say nothing about Anthropic either.
    const status = await loopStatus(app);
    expect(JSON.stringify(status)).not.toMatch(/anthropic/i);
    const home = await appFor({ clock: SAT, llmPort: notConfiguredPort() }).request("/home");
    expect(JSON.stringify(await json(home))).not.toMatch(/anthropic/i);
  });
});
