import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { ensureWeekSession, listWeekSessions } from "../src/week/store.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const TZ = "America/New_York";
const MONDAY_W43 = new FixedClock(new Date("2026-10-19T15:00:00.000Z"));
const SATURDAY_W43 = new FixedClock(new Date("2026-10-24T15:00:00.000Z"));
const SUNDAY_W43 = new FixedClock(new Date("2026-10-25T15:00:00.000Z"));
const MONDAY_W44 = new FixedClock(new Date("2026-10-26T15:00:00.000Z"));

type App = ReturnType<typeof createApp>;

function makeApp(clock: FixedClock): App {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock,
    llmPort: createStubLlmPort(),
    athleteTimezone: TZ,
  });
}

async function put(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function configureConnections(app: App) {
  expect(
    (
      await put(app, "/settings/tempo", {
        baseUrl: "http://localhost:5001",
        apiKey: "tmp_loop_handoff_test_key",
      })
    ).status,
  ).toBe(200);
  expect(
    (await put(app, "/settings/anthropic", { apiKey: "sk-ant-loop-handoff-key" }))
      .status,
  ).toBe(200);
}

async function setupAthlete(app: App) {
  await configureConnections(app);
  const res = await put(app, "/dossier", { body: "# Coach notes\n\nBase fitness." });
  expect([200, 201]).toContain(res.status);
}

async function loopStatus(app: App) {
  return json(await app.request("/loop-status"));
}

async function savePlanForW44() {
  const next = await ensureWeekSession("2026-W44", TZ);
  await savePrescribedWeek({
    weekSessionId: next.session.id,
    plan: { week: "2026-W44", days: [] },
    analysis: "Next week.",
  });
}

describe("loop phases follow the Sunday handoff (#80)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    await acceptAndReady();
  });

  it("Monday without check-in is mid_week", async () => {
    const app = makeApp(MONDAY_W43);
    await setupAthlete(app);
    const body = await loopStatus(app);
    expect(body.phase).toBe("mid_week");
    expect(body.week.isoWeek).toBe("2026-W43");
    expect(body.flags).toMatchObject({
      checkIn: "needed",
      weekEnding: false,
      hasPlan: false,
      currentWeekHasPlan: false,
    });
  });

  it("Saturday without check-in needs_check_in", async () => {
    const app = makeApp(SATURDAY_W43);
    await setupAthlete(app);
    const body = await loopStatus(app);
    expect(body.phase).toBe("needs_check_in");
    expect(body.flags).toMatchObject({ weekEnding: true, checkIn: "needed" });
  });

  it("Sunday after check-in without a W44 plan needs_plan, read-only", async () => {
    const app = makeApp(SUNDAY_W43);
    await setupAthlete(app);
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string, "finish");

    const body = await loopStatus(app);
    expect(body.phase).toBe("needs_plan");
    expect(body.headline).toBe("Plan next week");
    expect(body.primaryCta).toMatchObject({ label: "Plan next week", href: "/plan" });
    expect(body.flags).toMatchObject({ hasPlan: false, checkIn: "finished" });

    // Loop status must not create the W44 session.
    const sessions = await listWeekSessions();
    expect(sessions.map((s) => s.isoWeek)).toEqual(["2026-W43"]);
  });

  it("Sunday after the W44 plan is week_ending", async () => {
    const app = makeApp(SUNDAY_W43);
    await setupAthlete(app);
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string, "finish");
    await savePlanForW44();

    const body = await loopStatus(app);
    expect(body.phase).toBe("week_ending");
    expect(body.flags).toMatchObject({
      hasPlan: true,
      currentWeekHasPlan: false,
      weekEnding: true,
    });
    // The stepper is gone: Home no longer draws the loop.
    expect(body).not.toHaveProperty("stepper");
  });

  it("the following Monday on W44 is mid_week with Sunday's plan as current", async () => {
    const sunday = makeApp(SUNDAY_W43);
    await setupAthlete(sunday);
    const week = await json(await sunday.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(sunday, week.id as string, "finish");
    await savePlanForW44();

    const body = await loopStatus(makeApp(MONDAY_W44));
    expect(body.phase).toBe("mid_week");
    expect(body.week.isoWeek).toBe("2026-W44");
    expect(body.flags).toMatchObject({
      currentWeekHasPlan: true,
      hasPlan: false,
      weekEnding: false,
    });
  });

  describe("earlier phases keep priority on a week-ending day", () => {
    it("setup_incomplete", async () => {
      const body = await loopStatus(makeApp(SATURDAY_W43));
      expect(body.phase).toBe("setup_incomplete");
    });

    it("needs_onboarding", async () => {
      const app = makeApp(SATURDAY_W43);
      await configureConnections(app);
      expect((await loopStatus(app)).phase).toBe("needs_onboarding");
    });

    it("onboarding_review beats needs_check_in", async () => {
      const app = makeApp(SATURDAY_W43);
      await configureConnections(app);
      const saved = await app.request("/onboarding/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: { goal: "Half marathon in January", schedule: "Tue Thu Sat" },
        }),
      });
      expect(saved.status).toBe(201);
      expect((await loopStatus(app)).phase).toBe("onboarding_review");
    });

    it("a waiting tidy-up never outranks the check-in or the plan", async () => {
      const app = makeApp(SATURDAY_W43);
      await setupAthlete(app);
      const res = await app.request("/dossier/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "audit",
          summaryBullets: ["Tidied"],
          proposedBody: "# Coach notes\n\nTidied.",
        }),
      });
      expect(res.status).toBe(201);
      const waiting = await loopStatus(app);
      expect(waiting.phase).toBe("needs_check_in");
      expect(waiting.flags).toMatchObject({ auditPending: true });

      const week = await json(await app.request("/weeks/current", { method: "POST" }));
      await unlockPlanCheckIn(app, week.id as string, "finish");
      const planned = await loopStatus(app);
      expect(planned.phase).toBe("needs_plan");
      expect(planned.flags).toMatchObject({ auditPending: true });
    });
  });
});
