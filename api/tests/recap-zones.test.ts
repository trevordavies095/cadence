import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import {
  buildDenseHrPerSecond,
  computeWeekZoneDistribution,
  pctFromZoneSeconds,
  samplesFromTimeSeries,
  secondsPerZoneFromDense,
  zoneIndexForBpm,
} from "../src/recap/zones.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type {
  TempoHeartRateZone,
  TempoPort,
  TempoWorkoutDetail,
} from "../src/tempo/port.js";
import { assertNoGpsFields } from "../src/tempo/sanitize.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const fiveZones: TempoHeartRateZone[] = [
  { zoneNumber: 1, minBpm: 100, maxBpm: 120 },
  { zoneNumber: 2, minBpm: 121, maxBpm: 140 },
  { zoneNumber: 3, minBpm: 141, maxBpm: 160 },
  { zoneNumber: 4, minBpm: 161, maxBpm: 175 },
  { zoneNumber: 5, minBpm: 176, maxBpm: 195 },
];

describe("zone distribution math", () => {
  it("buckets BPM and forwards fills sparse samples", () => {
    const sorted = [...fiveZones].sort((a, b) => a.zoneNumber - b.zoneNumber);
    expect(zoneIndexForBpm(115, sorted)).toBe(0);
    expect(zoneIndexForBpm(121, sorted)).toBe(1);
    expect(zoneIndexForBpm(99, sorted)).toBe(0);
    expect(zoneIndexForBpm(200, sorted)).toBe(4);

    const samples = samplesFromTimeSeries([
      { elapsedSeconds: 0, heartRateBpm: 120 },
      { elapsedSeconds: 2, heartRateBpm: 130 },
    ]);
    const dense = buildDenseHrPerSecond(samples, 3);
    expect(dense).toEqual([120, 120, 130]);
    expect(secondsPerZoneFromDense(dense!, sorted)).toEqual([2, 1, 0, 0, 0]);
    expect(pctFromZoneSeconds([1, 1, 0, 0, 1]).z1).toBeCloseTo(33.3, 0);
  });

  it("notes empty weeks and missing HR samples", () => {
    const empty = computeWeekZoneDistribution({ zones: fiveZones, workouts: [] });
    expect(empty.note).toContain("No workouts");
    expect(empty.noHrTimeSeriesInWeek).toBe(true);

    const noZones = computeWeekZoneDistribution({ zones: [], workouts: [] });
    expect(noZones.note).toContain("No HR zones");

    const noHr: TempoWorkoutDetail = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      startedAt: "2026-10-20T12:00:00.000Z",
      durationS: 600,
      distanceM: 1000,
      avgPaceS: 360,
      splits: [],
    };
    const missing = computeWeekZoneDistribution({
      zones: fiveZones,
      workouts: [noHr],
    });
    expect(missing.totalHrSeconds).toBe(0);
    expect(missing.note).toMatch(/No usable HR samples/i);
  });
});

describe("weekly recap HR zone distribution (#20)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("returns zone section with plausible totals for fixture ISO week", async () => {
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
    const weekSessionId = week.id as string;

    const res = await app.request(
      `/weeks/${weekSessionId}/recap/zones?format=json`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.isoWeek).toBe("2026-W43");
    expect(body.range).toEqual({
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    });

    const zones = body.zones as TempoHeartRateZone[];
    expect(zones).toHaveLength(5);
    expect(zones[0]).toMatchObject({
      zoneNumber: 1,
      minBpm: 129,
      maxBpm: 150,
    });
    expect(zones[1]).toMatchObject({
      zoneNumber: 2,
      minBpm: 150,
      maxBpm: 167,
    });

    const dist = body.distribution as {
      totalHrSeconds: number;
      zoneSeconds: number[];
      zonePct: Record<string, number>;
      z1z2Pct: number;
      z1z2TargetMet?: boolean;
      noHrTimeSeriesInWeek: boolean;
    };
    // Two fixture runs (3600s + 1800s) with HR samples forward-filled.
    expect(dist.totalHrSeconds).toBe(5400);
    expect(dist.zoneSeconds).toHaveLength(5);
    expect(dist.zoneSeconds.reduce((a, b) => a + b, 0)).toBe(5400);
    expect(dist.zonePct.z1).toBe(100);
    expect(dist.z1z2Pct).toBe(100);
    // No goal stored: the fitness column, so no target and no met flag.
    expect(dist.z1z2TargetMet).toBeUndefined();
    expect(body.easyShareTarget).toBeNull();
    expect(dist.noHrTimeSeriesInWeek).toBe(false);

    const markdown = body.markdown as string;
    expect(markdown).toContain("## HR zone distribution (week total)");
    expect(markdown).toContain("Z1 ");
    expect(markdown).toContain("100%");
    expect(markdown).toContain(
      "Easy-running share: 100% (zones 1 and 2 of time with heart rate).",
    );
    expect(markdown).not.toContain("Target");
    expect(markdown).not.toContain("LineString");
    expect(markdown).not.toContain("SHOULD_NOT_LEAK");
    assertNoGpsFields(body);

    const mdRes = await app.request(
      `/weeks/${weekSessionId}/recap/zones?format=markdown`,
    );
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await mdRes.text()).toBe(markdown);
  });

  it("degrades gracefully when workouts lack HR time-series", async () => {
    await acceptAndReady();

    const stubPort: TempoPort = {
      async listWorkouts() {
        return {
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              startedAt: "2026-10-20T12:00:00.000Z",
              durationS: 1800,
              distanceM: 5000,
              avgPaceS: 360,
              avgHeartRateBpm: 140,
              runType: "Easy Run",
            },
          ],
          page: 1,
          pageSize: 100,
          totalCount: 1,
          totalPages: 1,
        };
      },
      async getWorkout(id) {
        return {
          id,
          startedAt: "2026-10-20T12:00:00.000Z",
          durationS: 1800,
          distanceM: 5000,
          avgPaceS: 360,
          avgHeartRateBpm: 140,
          runType: "Easy Run",
          splits: [],
          // no timeSeries
        };
      },
      async getSettings() {
        return {
          unitPreference: "metric",
          heartRateZones: {
            calculationMethod: "Custom",
            zones: fiveZones,
          },
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
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: stubPort,
    });

    const weekRes = await app.request("/weeks/current", { method: "POST" });
    expect(weekRes.status).toBe(201);
    const week = await json(weekRes);

    const res = await app.request(
      `/weeks/${week.id as string}/recap/zones?format=json`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const dist = body.distribution as {
      totalHrSeconds: number;
      noHrTimeSeriesInWeek: boolean;
      note?: string;
    };
    expect(dist.totalHrSeconds).toBe(0);
    expect(dist.noHrTimeSeriesInWeek).toBe(true);
    expect(dist.note).toMatch(/No usable HR samples/i);
    expect(body.markdown as string).toContain(
      "## HR zone distribution (week total)",
    );
    expect(body.markdown as string).toMatch(/No usable HR samples/i);
  });

  it("requires disclaimer and rejects unknown week session", async () => {
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });

    const blocked = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/zones",
    );
    expect(blocked.status).toBe(403);

    await acceptAndReady();
    const missing = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/zones",
    );
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({
      error: "week_session_not_found",
    });
  });
});
