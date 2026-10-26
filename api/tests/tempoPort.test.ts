import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { createLiveTempoPort } from "../src/tempo/liveHttp.js";
import type { TempoPort } from "../src/tempo/port.js";
import { assertNoGpsFields } from "../src/tempo/sanitize.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const WORKOUT_ID = "550e8400-e29b-41d4-a716-446655440000";

const listFixture = {
  items: [
    {
      id: WORKOUT_ID,
      startedAt: "2026-10-18T12:00:00.000Z",
      durationS: 3600,
      distanceM: 10000,
      avgPaceS: 360,
      name: "Easy 10k",
      runType: "Easy Run",
      avgHeartRateBpm: 140,
      hasRoute: true,
      route: {
        type: "LineString",
        coordinates: [
          [-77.6, 43.1],
          [-77.61, 43.11],
        ],
      },
      splitsCount: 2,
      media: [],
    },
  ],
  page: 1,
  pageSize: 20,
  totalCount: 1,
  totalPages: 1,
};

const detailFixture = {
  ...listFixture.items[0],
  notes: "Felt steady",
  splits: [
    {
      idx: 0,
      kind: "lap",
      distanceM: 1609,
      durationS: 540,
      paceS: 335,
      avgHeartRateBpm: 138,
    },
  ],
  rawGpxData: { should: "never leak" },
  rawFitData: { should: "never leak" },
};

function mockFetchSequence(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): typeof globalThis.fetch {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = handlers[i++];
    if (!handler) {
      throw new Error(`Unexpected fetch #${i} to ${url}`);
    }
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
}

describe("TempoPort live HTTP + API seam", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    // Shell/manual E2E often exports TEMPO_EXPORT_PATH to the full athlete zip;
    // live-adapter tests must not pick that up (loads forever → timeout).
    delete process.env.TEMPO_EXPORT_PATH;
    await resetAppTables();
  });

  it("live port list/get uses Bearer key and strips GPS fields", async () => {
    const fetchImpl = mockFetchSequence([
      (url, init) => {
        expect(url).toBe(
          "http://tempo.test/workouts?page=1&pageSize=10&startDate=2026-10-01T00%3A00%3A00.000Z",
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer tmp_fixture_key_abcd",
        );
        return new Response(JSON.stringify(listFixture), { status: 200 });
      },
      (url, init) => {
        expect(url).toBe(`http://tempo.test/workouts/${WORKOUT_ID}`);
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer tmp_fixture_key_abcd",
        );
        return new Response(JSON.stringify(detailFixture), { status: 200 });
      },
    ]);

    const port = createLiveTempoPort({
      fetchImpl,
      readCredentials: async () => ({
        baseUrl: "http://tempo.test",
        apiKey: "tmp_fixture_key_abcd",
      }),
    });

    const listed = await port.listWorkouts({
      page: 1,
      pageSize: 10,
      startDate: "2026-10-01T00:00:00.000Z",
    });
    expect(listed.totalCount).toBe(1);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.id).toBe(WORKOUT_ID);
    expect(listed.items[0]!.name).toBe("Easy 10k");
    expect(listed.items[0]!.hasRoute).toBe(true);
    expect(listed.items[0]).not.toHaveProperty("route");
    assertNoGpsFields(listed);

    const detail = await port.getWorkout(WORKOUT_ID);
    expect(detail).not.toBeNull();
    expect(detail!.notes).toBe("Felt steady");
    expect(detail!.splits).toHaveLength(1);
    expect(detail).not.toHaveProperty("route");
    expect(detail).not.toHaveProperty("rawGpxData");
    expect(detail).not.toHaveProperty("rawFitData");
    assertNoGpsFields(detail);
  });

  it("GET /tempo/workouts exercises injected TempoPort (no live Tempo)", async () => {
    await acceptAndReady();
    const fakePort: TempoPort = {
      async listWorkouts() {
        return {
          items: [
            {
              id: WORKOUT_ID,
              startedAt: "2026-10-18T12:00:00.000Z",
              durationS: 1800,
              distanceM: 5000,
              avgPaceS: 360,
              name: "Stub 5k",
              hasRoute: false,
            },
          ],
          page: 1,
          pageSize: 20,
          totalCount: 1,
          totalPages: 1,
        };
      },
      async getWorkout(id) {
        if (id !== WORKOUT_ID) return null;
        return {
          id: WORKOUT_ID,
          startedAt: "2026-10-18T12:00:00.000Z",
          durationS: 1800,
          distanceM: 5000,
          avgPaceS: 360,
          name: "Stub 5k",
          splits: [],
          hasRoute: false,
        };
      },
      async getSettings() {
        return {
          unitPreference: "metric",
          heartRateZones: { calculationMethod: "AgeBased", zones: [] },
        };
      },
      async listShoes() {
        return [];
      },
      async getBestEfforts() {
        return { distances: [] };
      },
    };

    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort: fakePort,
    });

    const listRes = await app.request("/tempo/workouts");
    expect(listRes.status).toBe(200);
    const listBody = await json(listRes);
    expect(listBody.totalCount).toBe(1);
    const items = listBody.items as Array<Record<string, unknown>>;
    expect(items[0]!.name).toBe("Stub 5k");
    expect(JSON.stringify(listBody)).not.toContain("route");

    const getRes = await app.request(`/tempo/workouts/${WORKOUT_ID}`);
    expect(getRes.status).toBe(200);
    const getBody = await json(getRes);
    expect(getBody.id).toBe(WORKOUT_ID);
    expect(getBody).not.toHaveProperty("route");

    expect((await app.request("/tempo/workouts/not-a-uuid")).status).toBe(400);
    expect(
      (await app.request("/tempo/workouts/00000000-0000-4000-8000-000000000099"))
        .status,
    ).toBe(404);
  });

  it("live adapter reads encrypted Tempo settings for Authorization", async () => {
    await acceptAndReady();
    const apiKey = "tmp_stored_secret_key_wxyz";
    const fetchImpl = mockFetchSequence([
      (_url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${apiKey}`,
        );
        return new Response(JSON.stringify(listFixture), { status: 200 });
      },
    ]);

    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoFetch: fetchImpl,
    });

    const put = await app.request("/settings/tempo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://tempo.test/",
        apiKey,
      }),
    });
    expect(put.status).toBe(200);

    const listRes = await app.request("/tempo/workouts?pageSize=20");
    expect(listRes.status).toBe(200);
    const body = await json(listRes);
    expect(body.totalCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain("LineString");
    expect(JSON.stringify(body)).not.toContain("-77.6");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tempo workout routes stay gated until disclaimer accept", async () => {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort: {
        listWorkouts: async () => ({
          items: [],
          page: 1,
          pageSize: 20,
          totalCount: 0,
          totalPages: 0,
        }),
        getWorkout: async () => null,
        getSettings: async () => ({
          unitPreference: "metric",
          heartRateZones: { calculationMethod: "AgeBased", zones: [] },
        }),
        listShoes: async () => [],
        getBestEfforts: async () => ({ distances: [] }),
      },
    });
    expect((await app.request("/tempo/workouts")).status).toBe(403);
    expect((await app.request(`/tempo/workouts/${WORKOUT_ID}`)).status).toBe(
      403,
    );
    expect((await app.request("/tempo/settings")).status).toBe(403);
    expect((await app.request("/tempo/shoes")).status).toBe(403);
    expect((await app.request("/tempo/best-efforts")).status).toBe(403);
  });

  it("live port settings/shoes/best-efforts use Bearer and normalize shapes", async () => {
    const shoeId = "4ca636b8-b06a-43aa-9252-c5ef643a2e0e";
    const bodies: Record<string, unknown> = {
      "http://tempo.test/settings/unit-preference": {
        unitPreference: "imperial",
      },
      "http://tempo.test/settings/heart-rate-zones": {
        calculationMethod: "Custom",
        zones: [
          { zoneNumber: 1, minBpm: 100, maxBpm: 120 },
          { zoneNumber: 2, minBpm: 120, maxBpm: 140 },
        ],
      },
      "http://tempo.test/settings/default-shoe": {
        defaultShoeId: shoeId,
        brand: "ASICS",
        model: "Nimbus",
      },
      "http://tempo.test/shoes?status=active": [
        {
          id: shoeId,
          brand: "ASICS",
          model: "Nimbus 28",
          isRetired: false,
          totalMileage: 42.5,
          unit: "miles",
          createdAt: "2026-10-10T17:45:51.641878Z",
          updatedAt: "2026-10-10T17:45:51.641927Z",
        },
      ],
      "http://tempo.test/stats/best-efforts": {
        distances: [
          {
            distance: "5K",
            distanceM: 5000,
            timeS: 1500,
            workoutId: WORKOUT_ID,
            workoutDate: "2026-10-18T12:00:00.000Z",
          },
        ],
      },
    };

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer tmp_fixture_key_abcd",
      );
      const body = bodies[url];
      if (body === undefined) {
        throw new Error(`Unexpected fetch to ${url}`);
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const port = createLiveTempoPort({
      fetchImpl,
      readCredentials: async () => ({
        baseUrl: "http://tempo.test",
        apiKey: "tmp_fixture_key_abcd",
      }),
    });

    const settings = await port.getSettings();
    expect(settings.unitPreference).toBe("imperial");
    expect(settings.defaultShoeId).toBe(shoeId);
    expect(settings.heartRateZones.zones).toHaveLength(2);
    expect(settings.heartRateZones.zones[1]).toMatchObject({
      zoneNumber: 2,
      minBpm: 120,
      maxBpm: 140,
    });

    const shoes = await port.listShoes();
    expect(shoes).toHaveLength(1);
    expect(shoes[0]).toMatchObject({ brand: "ASICS", model: "Nimbus 28" });
    expect(shoes[0]).not.toHaveProperty("workouts");

    const efforts = await port.getBestEfforts();
    expect(efforts.distances).toHaveLength(1);
    expect(efforts.distances[0]!.distance).toBe("5K");
    expect(efforts.distances[0]!.timeS).toBe(1500);
  });

  it("returns tempo_not_configured when settings missing", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoFetch: vi.fn() as unknown as typeof globalThis.fetch,
    });
    const res = await app.request("/tempo/workouts");
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "tempo_not_configured" });
  });
});
