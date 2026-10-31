import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type {
  TempoPort,
  TempoWeeklyRecapStats,
} from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

type Counts = {
  getWorkout: number;
  getWorkoutTimeSeries: number;
  getWeeklyRecapStats: number;
};

/**
 * The fixture week (2026-W43 in the export pack: two runs, 3600 s + 1800 s,
 * all Z1 by the per-second method) behind a counting fake port. With `stats`
 * the port also answers the weekly recap, as the live port does.
 */
function fixturePort(stats?: TempoWeeklyRecapStats | "throws") {
  const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
  const counts: Counts = {
    getWorkout: 0,
    getWorkoutTimeSeries: 0,
    getWeeklyRecapStats: 0,
  };
  const port: TempoPort = {
    listWorkouts: (q) => base.listWorkouts(q),
    getSettings: () => base.getSettings(),
    listShoes: (q) => base.listShoes(q),
    getBestEfforts: () => base.getBestEfforts(),
    async getWorkout(id) {
      counts.getWorkout += 1;
      return base.getWorkout(id);
    },
    async getWorkoutTimeSeries(id) {
      counts.getWorkoutTimeSeries += 1;
      const d = await base.getWorkout(id);
      return d?.timeSeries ?? [];
    },
  };
  if (stats !== undefined) {
    port.getWeeklyRecapStats = async () => {
      counts.getWeeklyRecapStats += 1;
      if (stats === "throws") throw new Error("boom");
      return stats;
    };
  }
  return { port, counts };
}

/**
 * The log's stored per-run zone seconds for the fixture week. Tempo buckets
 * on its own, so it can land a couple of seconds off the per-second method.
 */
const FIXTURE_LOG_STATS: TempoWeeklyRecapStats = {
  runs: { current: 2, previous: 0, trailingAvg: 0 },
  distanceM: { current: 15000, previous: 0, trailingAvg: 0 },
  durationS: { current: 5400, previous: 0, trailingAvg: 0 },
  zoneSecondsZ1: { current: 5398 },
  zoneSecondsZ2: { current: 2 },
  zoneSecondsZ3: { current: 0 },
  zoneSecondsZ4: { current: 0 },
  zoneSecondsZ5: { current: 0 },
};

function withoutZ5(): TempoWeeklyRecapStats {
  const { zoneSecondsZ5: _drop, ...rest } = FIXTURE_LOG_STATS;
  return rest;
}

function makeApp(port: TempoPort) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    tempoPort: port,
  });
}

async function openWeek(app: ReturnType<typeof makeApp>): Promise<string> {
  const res = await app.request("/weeks/current", { method: "POST" });
  expect([200, 201]).toContain(res.status);
  const week = await json(res);
  expect(week.isoWeek).toBe("2026-W43");
  return week.id as string;
}

type ZonesBody = {
  zoneSource: string;
  distribution: {
    totalHrSeconds: number;
    zoneSeconds: number[];
    zonePct: Record<string, number>;
    z1z2Pct: number;
    z1z2TargetMet?: boolean;
  };
  markdown: string;
};

async function zonesFor(port: TempoPort): Promise<ZonesBody> {
  const app = makeApp(port);
  const id = await openWeek(app);
  const res = await app.request(`/weeks/${id}/recap/zones?format=json`);
  expect(res.status).toBe(200);
  return (await json(res)) as unknown as ZonesBody;
}

describe("zones section from the log's weekly zone aggregate (#12)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("uses the five zone buckets and makes no per-run detail or series calls", async () => {
    const { port, counts } = fixturePort(FIXTURE_LOG_STATS);
    const body = await zonesFor(port);

    expect(body.zoneSource).toBe("weekly-recap");
    expect(body.distribution.zoneSeconds).toEqual([5398, 2, 0, 0, 0]);
    expect(body.distribution.totalHrSeconds).toBe(5400);
    expect(counts.getWeeklyRecapStats).toBe(1);
    expect(counts.getWorkout).toBe(0);
    expect(counts.getWorkoutTimeSeries).toBe(0);
  });

  it("prints the same zone share either way on the fixture week", async () => {
    const perSecond = await zonesFor(fixturePort().port);
    await resetAppTables();
    await acceptAndReady();
    const aggregate = await zonesFor(fixturePort(FIXTURE_LOG_STATS).port);

    expect(perSecond.zoneSource).toBe("time-series");
    expect(aggregate.zoneSource).toBe("weekly-recap");
    for (const z of ["z1", "z2", "z3", "z4", "z5"]) {
      expect(
        Math.abs(
          aggregate.distribution.zonePct[z]! - perSecond.distribution.zonePct[z]!,
        ),
      ).toBeLessThanOrEqual(0.1);
    }
    expect(aggregate.distribution.z1z2Pct).toBeCloseTo(
      perSecond.distribution.z1z2Pct,
      1,
    );
    expect(aggregate.markdown).toBe(perSecond.markdown);
    expect(aggregate.markdown).toContain("Easy-running share: 100% (zones 1 and 2");
  });

  it("falls back to the per-second method when any bucket is null", async () => {
    const { port, counts } = fixturePort(withoutZ5());
    const body = await zonesFor(port);

    expect(body.zoneSource).toBe("time-series");
    expect(body.distribution.zoneSeconds).toEqual([5400, 0, 0, 0, 0]);
    expect(counts.getWorkout).toBeGreaterThan(0);
  });

  it("falls back to the per-second method when the weekly recap fails", async () => {
    const { port, counts } = fixturePort("throws");
    const body = await zonesFor(port);

    expect(body.zoneSource).toBe("time-series");
    expect(body.distribution.totalHrSeconds).toBe(5400);
    expect(counts.getWorkout).toBeGreaterThan(0);
  });

  it("export mode (no weekly recap) keeps the per-second method", async () => {
    const body = await zonesFor(createExportTempoPort({ exportPath: FIXTURE_ZIP }));
    expect(body.zoneSource).toBe("time-series");
    expect(body.distribution.zoneSeconds).toEqual([5400, 0, 0, 0, 0]);
  });

  it("fetches the weekly stats once per report and shares them with the summary", async () => {
    const { port, counts } = fixturePort(FIXTURE_LOG_STATS);
    const app = makeApp(port);
    const id = await openWeek(app);

    const skeleton = await app.request(`/weeks/${id}/recap/skeleton?format=json`);
    expect(skeleton.status).toBe(200);
    expect(counts.getWeeklyRecapStats).toBe(1);

    const before = counts.getWeeklyRecapStats;
    const report = await json(
      await app.request(`/weeks/${id}/recap?skip_subjective=1`),
    );
    expect(report.status).toBe("report");
    expect(counts.getWeeklyRecapStats - before).toBe(1);

    const md = report.reportMarkdown as string;
    // Summary took prev / 3-wk from the same stats; zones from its buckets.
    expect(md).toContain("## HR zone distribution (week total)");
    expect(md).toContain("Easy-running share: 100% (zones 1 and 2");
  });
});
