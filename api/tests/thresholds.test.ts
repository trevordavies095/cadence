import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { thresholdPhrase, type ModelPacketCoaching } from "../src/packet/index.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import type { TempoAthleteSettings, TempoPort } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const BASE = "http://tempo.test";
const WORKOUT_ID = "550e8400-e29b-41d4-a716-446655440000";

/** Tempo's shipped HeartRateZonesDocument (docs/openapi.json). */
const ZONES_DOC = {
  calculationMethod: "Karvonen",
  age: null,
  restingHeartRateBpm: 52,
  maxHeartRateBpm: 188,
  observedMaxHeartRateBpm: 194,
  zones: [
    { zoneNumber: 1, minBpm: 120, maxBpm: 136 },
    { zoneNumber: 2, minBpm: 136, maxBpm: 150 },
    { zoneNumber: 3, minBpm: 150, maxBpm: 163 },
    { zoneNumber: 4, minBpm: 163, maxBpm: 175 },
    { zoneNumber: 5, minBpm: 175, maxBpm: 188 },
  ],
};

/** Tempo's shipped ThresholdsDocument (docs/openapi.json). */
const THRESHOLDS_DOC = {
  thresholdPaceS: 250,
  thresholdHeartRateBpm: 171,
  suggestedThresholdPaceS: 254,
  suggestedFrom: {
    distance: "5K",
    timeS: 1185,
    workoutDate: "2026-03-02",
    workoutId: WORKOUT_ID,
  },
};

function livePort(routes: Record<string, { status: number; body?: unknown }>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const route = routes[String(input)];
    if (!route) return new Response("", { status: 404 });
    return new Response(
      route.body === undefined ? "" : JSON.stringify(route.body),
      { status: route.status },
    );
  }) as unknown as typeof globalThis.fetch;
  return createLiveTempoPort({
    fetchImpl,
    readCredentials: async () => ({ baseUrl: BASE, apiKey: "tmp_thresholds" }),
  });
}

function settingsRoutes(thresholds?: { status: number; body?: unknown }) {
  return {
    [`${BASE}/settings/unit-preference`]: {
      status: 200,
      body: { unitPreference: "metric" },
    },
    [`${BASE}/settings/heart-rate-zones`]: { status: 200, body: ZONES_DOC },
    [`${BASE}/settings/default-shoe`]: {
      status: 200,
      body: { defaultShoeId: null },
    },
    ...(thresholds ? { [`${BASE}/settings/thresholds`]: thresholds } : {}),
  };
}

describe("athlete settings carry thresholds and observed max HR (coaching-bias 15)", () => {
  it("the live port reads both endpoints in Tempo's shipped shapes", async () => {
    const port = livePort(settingsRoutes({ status: 200, body: THRESHOLDS_DOC }));
    const settings = await port.getSettings();
    expect(settings.heartRateZones.maxHeartRateBpm).toBe(188);
    expect(settings.heartRateZones.observedMaxHeartRateBpm).toBe(194);
    expect(settings.thresholds).toEqual({
      thresholdPaceS: 250,
      thresholdHeartRateBpm: 171,
      suggestedThresholdPaceS: 254,
      suggestedFrom: {
        distance: "5K",
        timeS: 1185,
        workoutDate: "2026-03-02",
        workoutId: WORKOUT_ID,
      },
    });
  });

  it("nothing set and no qualifying effort reads as nulls", async () => {
    const port = livePort(
      settingsRoutes({
        status: 200,
        body: {
          thresholdPaceS: null,
          thresholdHeartRateBpm: null,
          suggestedThresholdPaceS: null,
        },
      }),
    );
    const settings = await port.getSettings();
    expect(settings.thresholds).toEqual({
      thresholdPaceS: null,
      thresholdHeartRateBpm: null,
      suggestedThresholdPaceS: null,
      suggestedFrom: null,
    });
  });

  it("an observed max of null (no HR data) stays null", async () => {
    const port = livePort({
      ...settingsRoutes({ status: 200, body: THRESHOLDS_DOC }),
      [`${BASE}/settings/heart-rate-zones`]: {
        status: 200,
        body: { ...ZONES_DOC, observedMaxHeartRateBpm: null },
      },
    });
    const settings = await port.getSettings();
    expect(settings.heartRateZones.observedMaxHeartRateBpm).toBeNull();
  });

  it("an older Tempo without /settings/thresholds (404) leaves thresholds undefined", async () => {
    const port = livePort(settingsRoutes({ status: 404 }));
    const settings = await port.getSettings();
    expect(settings).not.toHaveProperty("thresholds");
    expect(settings.heartRateZones.zones).toHaveLength(5);
  });

  it("a failing thresholds call does not fail the settings read", async () => {
    const port = livePort(settingsRoutes({ status: 500 }));
    const settings = await port.getSettings();
    expect(settings.thresholds).toBeUndefined();
    expect(settings.unitPreference).toBe("metric");
  });

  it("export mode leaves thresholds undefined", async () => {
    const port = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const settings = await port.getSettings();
    expect(settings.thresholds).toBeUndefined();
    expect(settings.heartRateZones.observedMaxHeartRateBpm).toBeUndefined();
  });
});

/** Sun Oct 25 2026: focus week 2026-W43. */
const SUN = "2026-10-25T15:00:00.000Z";
const HALF = { kind: "race", distance: "half", raceDate: "2027-03-07" } as const;

describe("the packet's coaching block carries thresholds and max HR (coaching-bias 15)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });
  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function chatPacket(getSettings: TempoPort["getSettings"]) {
    await acceptAndReady();
    const exportPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(SUN)),
      athleteTimezone: "America/New_York",
      tempoPort: { ...exportPort, getSettings },
      llmPort: createStubLlmPort(),
    });
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: BASE, apiKey: "tmp_thresholds" }],
      ["/settings/anthropic", { apiKey: "sk-ant-thresholds" }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
      ["/goal", HALF],
    ] as const) {
      const res = await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.ok).toBe(true);
    }
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const res = await app.request(`/weeks/${week.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "How is the build going?" }),
    });
    expect(res.status).toBe(201);
    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    return lastPacket.packet;
  }

  const liveSettings: TempoAthleteSettings = {
    unitPreference: "metric",
    heartRateZones: {
      calculationMethod: "Karvonen",
      restingHeartRateBpm: 52,
      maxHeartRateBpm: 188,
      observedMaxHeartRateBpm: 194,
      zones: ZONES_DOC.zones,
    },
    thresholds: THRESHOLDS_DOC,
  };

  it("carries set and suggested threshold, threshold HR, max and observed max", async () => {
    const packet = await chatPacket(async () => liveSettings);
    expect(packet.coaching).toEqual({
      phase: "base",
      weeksToRace: 19,
      thresholdPaceS: 250,
      thresholdHeartRateBpm: 171,
      suggestedThresholdPaceS: 254,
      suggestedThresholdFrom: {
        distance: "5K",
        timeS: 1185,
        workoutDate: "2026-03-02",
      },
      maxHeartRateBpm: 188,
      observedMaxHeartRateBpm: 194,
    });
  });

  it("leaves unknown values out", async () => {
    const packet = await chatPacket(async () => ({
      ...liveSettings,
      heartRateZones: { ...liveSettings.heartRateZones, observedMaxHeartRateBpm: null },
      thresholds: {
        thresholdPaceS: null,
        thresholdHeartRateBpm: null,
        suggestedThresholdPaceS: null,
        suggestedFrom: null,
      },
    }));
    expect(packet.coaching).toEqual({
      phase: "base",
      weeksToRace: 19,
      maxHeartRateBpm: 188,
    });
  });

  it("a failing settings read still sends the reply, without the settings fields", async () => {
    const packet = await chatPacket(async () => {
      throw new Error("tempo down");
    });
    expect(packet.coaching).toEqual({ phase: "base", weeksToRace: 19 });
  });
});

describe("thresholdPhrase (coaching-bias 15)", () => {
  const base: ModelPacketCoaching = { phase: "build" };
  const suggested: ModelPacketCoaching = {
    ...base,
    suggestedThresholdPaceS: 254,
    suggestedThresholdFrom: { distance: "5K", timeS: 1185, workoutDate: "2026-03-02" },
  };

  it("names the athlete-set threshold", () => {
    expect(thresholdPhrase({ ...suggested, thresholdPaceS: 250 }, "metric")).toBe(
      "Threshold pace 4:10/km (set in your running log)",
    );
  });

  it("else the suggested threshold with its source", () => {
    expect(thresholdPhrase(suggested, "metric")).toBe(
      "Threshold pace 4:14/km (suggested by your running log from your 5K on Mar 2)",
    );
  });

  it("else nothing", () => {
    expect(thresholdPhrase(base, "metric")).toBeNull();
    expect(thresholdPhrase(null, "metric")).toBeNull();
  });

  it("prints the pace in the athlete's unit", () => {
    // 250 s/km is 402.3 s/mi.
    expect(thresholdPhrase({ ...base, thresholdPaceS: 250 }, "imperial")).toBe(
      "Threshold pace 6:42/mi (set in your running log)",
    );
    expect(thresholdPhrase(suggested, "imperial")).toBe(
      "Threshold pace 6:49/mi (suggested by your running log from your 5K on Mar 2)",
    );
  });

  it("a suggestion without a readable source still names the running log", () => {
    const { suggestedThresholdFrom: _drop, ...noSource } = suggested;
    expect(thresholdPhrase(noSource, "metric")).toBe(
      "Threshold pace 4:14/km (suggested by your running log)",
    );
  });

  it("rounds to whole seconds without printing :60", () => {
    expect(thresholdPhrase({ ...base, thresholdPaceS: 299.6 }, "metric")).toBe(
      "Threshold pace 5:00/km (set in your running log)",
    );
  });
});
