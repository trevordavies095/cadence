import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { assertNoGpsFields } from "../src/tempo/sanitize.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

describe("TempoPort export zip", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("list/get workouts offline with distance, duration, HR, splits, time-series", async () => {
    const port = createExportTempoPort({ exportPath: FIXTURE_ZIP });

    const listed = await port.listWorkouts({ page: 1, pageSize: 10 });
    expect(listed.totalCount).toBe(3);
    expect(listed.items).toHaveLength(3);
    // default sort startedAt desc
    expect(listed.items[0]!.id).toBe(W2);
    expect(listed.items[0]!.distanceM).toBe(5000);
    expect(listed.items[0]!.durationS).toBe(1800);
    expect(listed.items[0]!.avgHeartRateBpm).toBe(145);
    expect(listed.items[0]!.hasRoute).toBe(true);
    expect(listed.items[0]).not.toHaveProperty("route");
    assertNoGpsFields(listed);

    const detail = await port.getWorkout(W1);
    expect(detail).not.toBeNull();
    expect(detail!.distanceM).toBe(10000);
    expect(detail!.durationS).toBe(3600);
    expect(detail!.avgHeartRateBpm).toBe(140);
    expect(detail!.splits).toHaveLength(2);
    expect(detail!.splits[0]!.avgHeartRateBpm).toBe(138);
    expect(detail!.timeSeries).toBeDefined();
    expect(detail!.timeSeries!.length).toBe(5);
    expect(detail!.timeSeries![2]!.heartRateBpm).toBe(140);
    expect(detail).not.toHaveProperty("route");
    expect(detail).not.toHaveProperty("rawGpxData");
    expect(detail).not.toHaveProperty("rawFitData");
    expect(JSON.stringify(detail)).not.toContain("SHOULD_NOT_LEAK");
    expect(JSON.stringify(detail)).not.toContain("LineString");
    assertNoGpsFields(detail);

    expect(await port.getWorkout("00000000-0000-4000-8000-000000000099")).toBeNull();
  });

  it("filters by week window and exposes shoes/settings shapes", async () => {
    const port = createExportTempoPort({ exportPath: FIXTURE_ZIP });

    const week = await port.listWorkouts({
      startDate: "2026-10-19T00:00:00.000Z",
      endDate: "2026-10-25T23:59:59.999Z",
      sortBy: "startedAt",
      sortOrder: "asc",
    });
    expect(week.totalCount).toBe(2);
    expect(week.items.map((w) => w.id)).toEqual([W1, W2]);

    const settings = await port.getExportSettings();
    expect(settings).toMatchObject({
      unitPreference: "imperial",
      zone2MinBpm: 150,
    });
    const shoes = await port.listExportShoes();
    expect(shoes).toHaveLength(1);
    expect(shoes[0]).toMatchObject({ brand: "ASICS", model: "Nimbus 28" });
  });

  it("port getSettings/listShoes/getBestEfforts normalize export athlete reads", async () => {
    const port = createExportTempoPort({ exportPath: FIXTURE_ZIP });

    const settings = await port.getSettings();
    expect(settings.unitPreference).toBe("imperial");
    expect(settings.defaultShoeId).toBe("4ca636b8-b06a-43aa-9252-c5ef643a2e0e");
    expect(settings.heartRateZones.calculationMethod).toBe("Custom");
    expect(settings.heartRateZones.zones).toHaveLength(5);
    expect(settings.heartRateZones.zones[1]).toMatchObject({
      zoneNumber: 2,
      minBpm: 150,
      maxBpm: 167,
    });

    const shoes = await port.listShoes();
    expect(shoes).toHaveLength(1);
    expect(shoes[0]).toMatchObject({
      brand: "ASICS",
      model: "Nimbus 28",
      isRetired: false,
    });
    expect(shoes[0]).not.toHaveProperty("workouts");
    expect(await port.listShoes({ status: "retired" })).toHaveLength(0);
    expect(await port.listShoes({ status: "all" })).toHaveLength(1);

    const efforts = await port.getBestEfforts();
    expect(efforts).toEqual({ distances: [] });
  });

  it("GET /tempo/settings|shoes|best-efforts serve export TempoPort", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
    });

    const settingsRes = await app.request("/tempo/settings");
    expect(settingsRes.status).toBe(200);
    const settings = await json(settingsRes);
    expect(settings.unitPreference).toBe("imperial");
    expect(settings.heartRateZones.zones).toHaveLength(5);

    const shoesRes = await app.request("/tempo/shoes");
    expect(shoesRes.status).toBe(200);
    const shoes = await json(shoesRes);
    expect(shoes).toHaveLength(1);
    expect(shoes[0]).toMatchObject({ brand: "ASICS", model: "Nimbus 28" });
    expect(JSON.stringify(shoes)).not.toContain("workouts");

    const beRes = await app.request("/tempo/best-efforts");
    expect(beRes.status).toBe(200);
    expect(await json(beRes)).toEqual({ distances: [] });
  });

  it("week-loop seam uses export TempoPort without live Tempo", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });

    const weekRes = await app.request("/weeks/current", { method: "POST" });
    expect(weekRes.status).toBe(201);
    const week = await json(weekRes);
    expect(week.isoWeek).toBe("2026-W43");

    const listRes = await app.request(
      `/tempo/workouts?startDate=${encodeURIComponent(week.start as string)}&endDate=${encodeURIComponent(week.end as string)}&sortBy=startedAt&sortOrder=asc`,
    );
    expect(listRes.status).toBe(200);
    const body = await json(listRes);
    expect(body.totalCount).toBe(2);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual([W1, W2]);
    expect(JSON.stringify(body)).not.toContain("LineString");
    expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");

    const getRes = await app.request(`/tempo/workouts/${W1}`);
    expect(getRes.status).toBe(200);
    const detail = await json(getRes);
    expect(detail.splits).toHaveLength(2);
    expect(detail.timeSeries).toHaveLength(5);
    assertNoGpsFields(detail);
  });

  it("createApp honors TEMPO_EXPORT_PATH for default TempoPort", async () => {
    await acceptAndReady();
    process.env.TEMPO_EXPORT_PATH = FIXTURE_ZIP;
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const res = await app.request("/tempo/workouts?pageSize=5");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.totalCount).toBe(3);
  });
});
