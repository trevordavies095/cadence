import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import {
  assertPacketHasNoPiiOrGps,
  buildModelPacket,
} from "../src/packet/index.js";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
/** Sun Oct 25 2026: the focus week is 2026-W43, Monday Oct 19. */
const SUN = "2026-10-25T15:00:00.000Z";

const HALF = {
  kind: "race",
  distance: "half",
  raceName: "Shamrock Half",
  raceDate: "2027-03-07",
  target: "under 1:45",
} as const;

const RETURN = {
  kind: "return",
  startingPoint: "Six weeks off with a calf strain",
  since: "2026-10-05",
} as const;

// The export fixture's zones are Custom with zone 5 topping out at 201, so the
// coaching block carries that as max HR. Export mode has no thresholds.

describe("the packet carries the goal (coaching-bias 10)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });
  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function ready(goal?: unknown) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(SUN)),
      athleteTimezone: "America/New_York",
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_goal_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-goal-key" }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
    ] as const) {
      await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (goal !== undefined) {
      const res = await app.request("/goal", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(goal),
      });
      expect(res.status).toBe(201);
    }
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    return { app, id: week.id as string };
  }

  async function chat(app: Awaited<ReturnType<typeof ready>>["app"], id: string) {
    const res = await app.request(`/weeks/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How is the build going?" }),
    });
    expect(res.status).toBe(201);
    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    return lastPacket;
  }

  it("a race goal goes with a conversation reply, with weeks to race for the focus week", async () => {
    const { app, id } = await ready(HALF);
    const lastPacket = await chat(app, id);
    expect(lastPacket.packet.goal).toEqual(HALF);
    // Oct 19 2026 to Mar 7 2027 is 139 days: 19 whole weeks, base.
    expect(lastPacket.packet.coaching).toEqual({
      phase: "base",
      weeksToRace: 19,
      unitPreference: "imperial",
      maxHeartRateBpm: 201,
    });
  });

  it("the weekly read resolves coaching for the plan week (N+1)", async () => {
    const { app, id } = await ready(HALF);
    const res = await app.request(`/weeks/${id}/recap?skip_subjective=true`);
    expect(res.status).toBe(200);
    await waitForReplyRunsIdle();

    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket.summary.weekSessionId).toBe(id);
    expect(lastPacket.packet.planWeek.startDate).toBe("2026-10-26");
    expect(lastPacket.packet.goal).toEqual(HALF);
    // Oct 26 2026 to Mar 7 2027 is 132 days: 18 whole weeks, base.
    expect(lastPacket.packet.coaching).toEqual({
      phase: "base",
      weeksToRace: 18,
      unitPreference: "imperial",
      maxHeartRateBpm: 201,
    });
  });

  it("a return goal goes with a conversation reply", async () => {
    const { app, id } = await ready(RETURN);
    const lastPacket = await chat(app, id);
    expect(lastPacket.packet.goal).toEqual(RETURN);
    expect(lastPacket.packet.coaching).toEqual({
      phase: "recovery",
      unitPreference: "imperial",
      maxHeartRateBpm: 201,
    });
  });

  it("with no goal stored both fields are null in the conversation and the weekly read", async () => {
    const { app, id } = await ready();
    const chatPacket = await chat(app, id);
    expect(chatPacket.packet.goal).toBeNull();
    expect(chatPacket.packet.coaching).toBeNull();

    await app.request(`/weeks/${id}/recap?skip_subjective=true`);
    await waitForReplyRunsIdle();
    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket.packet.planWeek).toBeTruthy();
    expect(lastPacket.packet.goal).toBeNull();
    expect(lastPacket.packet.coaching).toBeNull();
  });

  it("marks a race that has passed and drops weeks to race", async () => {
    const past = { kind: "race", distance: "10k", raceName: "Harbour 10k", raceDate: "2026-10-11" };
    const { app, id } = await ready(past);
    const lastPacket = await chat(app, id);
    expect(lastPacket.packet.goal).toEqual(past);
    expect(lastPacket.packet.coaching).toEqual({
      phase: "recovery",
      racePassed: true,
      unitPreference: "imperial",
      maxHeartRateBpm: 201,
    });
  });

  it("the race name is not identity: identity hints neither scrub nor reject it", async () => {
    const { app, id } = await ready({ ...HALF, raceName: "Riley's Shamrock Half" });
    const res = await app.request("/packet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: id,
        identityHints: { names: ["Riley"], emails: ["riley@example.com"] },
      }),
    });
    expect(res.status).toBe(200);
    const { packet, lastPacket } = await json(res);
    expect(packet.goal.raceName).toBe("Riley's Shamrock Half");
    expect(lastPacket.packet.goal.raceName).toBe("Riley's Shamrock Half");
    expect(lastPacket.summary.weekSessionId).toBe(id);
  });
});

describe("buildModelPacket goal pass-through", () => {
  it("copies goal and coaching untouched while still scrubbing free text", () => {
    const hints = { names: ["Riley Doe"] };
    const goal = {
      kind: "race" as const,
      distance: "marathon" as const,
      raceName: "Riley Doe Memorial Marathon",
      raceDate: "2027-04-18",
    };
    const packet = buildModelPacket({
      dossier: { versionId: 1, body: "Riley Doe runs mornings." },
      goal,
      coaching: { phase: "build", weeksToRace: 8 },
      identityHints: hints,
    });
    expect(packet.dossier?.body).not.toContain("Riley Doe");
    expect(packet.goal).toEqual(goal);
    expect(packet.coaching).toEqual({ phase: "build", weeksToRace: 8 });
    expect(() =>
      assertPacketHasNoPiiOrGps(packet, {
        identityHints: hints,
        forbiddenSubstrings: hints.names,
      }),
    ).not.toThrow();
  });

  it("defaults both fields to null", () => {
    const packet = buildModelPacket({});
    expect(packet.goal).toBeNull();
    expect(packet.coaching).toBeNull();
  });
});
