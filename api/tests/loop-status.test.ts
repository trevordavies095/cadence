import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { ensureWeekSession } from "../src/week/store.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { saveSubjectiveAnswers } from "../src/recap/subjectiveStore.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const MIDWEEK = new FixedClock(new Date("2026-10-21T15:00:00.000Z")); // Wed
const WEEKEND = new FixedClock(new Date("2026-10-25T15:00:00.000Z")); // Sun

async function configureSetup(app: ReturnType<typeof createApp>) {
  expect(
    (
      await app.request("/settings/tempo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://localhost:5001",
          apiKey: "tmp_loop_status_test_key",
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/settings/anthropic", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-loop-status-test-key" }),
      })
    ).status,
  ).toBe(200);
}

async function installDossier(app: ReturnType<typeof createApp>) {
  const res = await app.request("/dossier", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "# Coach notes\n\nBase fitness." }),
  });
  expect([200, 201]).toContain(res.status);
}

describe("GET /loop-status (#46)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("requires disclaimer", async () => {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    expect((await app.request("/loop-status")).status).toBe(403);
  });

  it("setup incomplete when Tempo or Anthropic missing", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("setup_incomplete");
    expect(body.primaryCta).toMatchObject({
      label: "Finish setup",
      href: "/settings",
    });
  });

  it("needs_onboarding when setup done but no profile yet", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("needs_onboarding");
    expect(body.primaryCta).toMatchObject({
      label: "Start",
      href: "/onboarding",
    });
  });

  it("onboarding_review once the answers are in and the coach's draft waits", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);

    const saved = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: { schedule: "Tue Thu Sat" },
        goal: { kind: "race", distance: "half", raceName: "Half marathon in January" },
      }),
    });
    expect(saved.status).toBe(201);

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("onboarding_review");
    expect(body.headline).toBe("Here’s what Coach Cade understood");
    expect(body.primaryCta).toMatchObject({
      label: "Have a look",
      href: "/dossier",
    });
    expect(body.secondaryCta).toBeNull();
    expect(body.flags).toMatchObject({ onboardingComplete: false });

    // Saying "looks right" installs version 1 and the loop moves on.
    const pending = (await json(await app.request("/dossier/proposals")))
      .proposals as Array<{ id: number }>;
    await app.request(`/dossier/proposals/${pending[0]!.id}/accept`, {
      method: "POST",
    });
    const after = await json(await app.request("/loop-status"));
    expect(after.phase).not.toBe("onboarding_review");
    expect(after.phase).not.toBe("needs_onboarding");
  });

  it("there is no pending_notes phase: notes apply on their own and never take the page", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const created = await app.request("/dossier/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summaryBullets: ["Ease calf load"],
        proposedBody: "# Coach notes\n\nEase calf load.",
      }),
    });
    expect(created.status).toBe(201);

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("mid_week");
    expect(body.flags).not.toHaveProperty("pendingNotesCount");
    expect(body.flags).toMatchObject({ auditPending: false });
  });

  it("a tidy-up waiting for a yes is a flag, not a phase", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const created = await app.request("/dossier/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "audit",
        summaryBullets: ["Tidied"],
        proposedBody: "# Coach notes\n\nTidied.",
      }),
    });
    expect(created.status).toBe(201);

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("mid_week");
    expect(body.flags).toMatchObject({ auditPending: true });
  });

  it("needs_check_in when week is ending, notes clear and no subjective yet", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: WEEKEND,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("needs_check_in");
    expect(body.primaryCta).toMatchObject({
      label: "Start check-in",
      href: "/check-in",
    });
    // Skip lives inside the check-in; a home link only reopened the form.
    expect(body.secondaryCta).toBeNull();
  });

  it("mid_week (not needs_check_in) before the week is ending", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("mid_week");
    expect(body.flags).toMatchObject({ checkIn: "needed", weekEnding: false });
  });

  it("needs_plan after check-in with no next-week plan", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await saveSubjectiveAnswers(new Date(), week.id as string, {
      week: week.isoWeek as string,
      runs: [],
      weekly: {},
    });

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("needs_plan");
    expect(body.primaryCta).toMatchObject({
      label: "Plan next week",
      href: "/plan",
    });
    expect(body.headline).toBe("Plan next week");
    expect(body.flags).toMatchObject({
      checkIn: "finished",
      hasPlan: false,
      currentWeekHasPlan: false,
    });
  });

  it("mid_week when current week has a plan and check-in is not due yet", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: week.id as string,
      plan: {
        week: week.isoWeek as string,
        days: [],
      },
      analysis: "Steady week.",
    });

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("mid_week");
    expect(body.primaryCta).toMatchObject({
      label: "Log how it went",
      href: "/chat",
    });
    expect(body.flags).toMatchObject({
      currentWeekHasPlan: true,
      hasPlan: false,
    });
  });

  it("week_ending on weekend with next week’s plan in place", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: WEEKEND,
      athleteTimezone: "UTC",
      llmPort: createStubLlmPort(),
    });
    await configureSetup(app);
    await installDossier(app);

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;
    await saveSubjectiveAnswers(new Date(), weekSessionId, {
      week: week.isoWeek as string,
      runs: [],
      weekly: {},
    });
    const next = await ensureWeekSession(new Date(), "2026-W44", "UTC");
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: next.session.id,
      plan: {
        week: "2026-W44",
        days: [],
      },
      analysis: "Next week.",
    });

    const body = await json(await app.request("/loop-status"));
    expect(body.phase).toBe("week_ending");
    // The week rolls over by itself: nothing to close out or start.
    expect(body.primaryCta).toBeNull();
    expect(body.secondaryCta).toBeNull();
    expect(body.flags).toMatchObject({ weekEnding: true, hasPlan: true });
  });
});

describe("loop status with offline sources (#6)", () => {
  const ENV_KEYS = ["CADENCE_DEMO", "TEMPO_EXPORT_PATH", "LLM_PROVIDER"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.CADENCE_DEMO;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** The app wires its own ports from the env, as the server does. */
  async function setupPhase() {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: MIDWEEK,
    });
    const body = await json(await app.request("/loop-status"));
    return body.phase as string;
  }

  it("an export and the stub are enough, with no saved connections and no demo flag", async () => {
    process.env.TEMPO_EXPORT_PATH = "/demo/tempo-export.zip";
    process.env.LLM_PROVIDER = "stub";
    expect(await setupPhase()).toBe("needs_onboarding");
  });

  it("the stub is the default model", async () => {
    process.env.TEMPO_EXPORT_PATH = "/demo/tempo-export.zip";
    delete process.env.LLM_PROVIDER;
    expect(await setupPhase()).toBe("needs_onboarding");
  });

  it.each(["anthropic", "live"])("LLM_PROVIDER=%s still needs a saved Anthropic key", async (provider) => {
    process.env.TEMPO_EXPORT_PATH = "/demo/tempo-export.zip";
    process.env.LLM_PROVIDER = provider;
    expect(await setupPhase()).toBe("setup_incomplete");
  });

  it("still needs Tempo when there is no export", async () => {
    delete process.env.TEMPO_EXPORT_PATH;
    process.env.LLM_PROVIDER = "stub";
    expect(await setupPhase()).toBe("setup_incomplete");
  });

  it("the demo counts the same way", async () => {
    process.env.CADENCE_DEMO = "1";
    process.env.TEMPO_EXPORT_PATH = "/demo/tempo-export.zip";
    process.env.LLM_PROVIDER = "stub";
    expect(await setupPhase()).toBe("needs_onboarding");
  });
});
