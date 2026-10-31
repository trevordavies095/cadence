import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { appendGoal } from "../src/goal/store.js";
import type { TrainingGoal } from "../src/goal/types.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoPort, TempoWeeklyRecapStats } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/**
 * The fixture week (2026-W43, Monday Oct 19) with the log's zone buckets set
 * to 77% easy: below the 80% endurance target, above the 75% speed target.
 */
const STATS: TempoWeeklyRecapStats = {
  runs: { current: 2, previous: 0, trailingAvg: 0 },
  distanceM: { current: 15000, previous: 0, trailingAvg: 0 },
  durationS: { current: 5400, previous: 0, trailingAvg: 0 },
  zoneSecondsZ1: { current: 2000 },
  zoneSecondsZ2: { current: 2158 },
  zoneSecondsZ3: { current: 1000 },
  zoneSecondsZ4: { current: 242 },
  zoneSecondsZ5: { current: 0 },
};

/**
 * A normal 10k-block week (#34): one threshold and one interval session, with
 * warm-ups and recoveries in Z3, so 62% easy. Below 75%, and below 80%.
 */
const SPEED_BLOCK_STATS: TempoWeeklyRecapStats = {
  ...STATS,
  zoneSecondsZ1: { current: 1400 },
  zoneSecondsZ2: { current: 1948 },
  zoneSecondsZ3: { current: 1452 },
  zoneSecondsZ4: { current: 600 },
  zoneSecondsZ5: { current: 0 },
};

function port(stats: TempoWeeklyRecapStats): TempoPort {
  const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
  return { ...base, getWeeklyRecapStats: async () => stats };
}

function makeApp(stats: TempoWeeklyRecapStats) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    tempoPort: port(stats),
  });
}

type Zones = {
  easyShareTarget: number | null;
  easyShareVerdict: boolean;
  distribution: {
    z1z2Pct: number;
    z1z2TargetMet?: boolean | null;
    easyShareTarget: number | null;
  };
  markdown: string;
};

async function setup(goal: TrainingGoal | null, stats: TempoWeeklyRecapStats) {
  if (goal) await appendGoal(new Date("2026-10-01T12:00:00Z"), goal, "settings");
  const app = makeApp(stats);
  const res = await app.request("/weeks/current", { method: "POST" });
  const week = await json(res);
  expect(week.isoWeek).toBe("2026-W43");
  return { app, id: week.id as string };
}

async function zonesFor(
  goal: TrainingGoal | null,
  stats: TempoWeeklyRecapStats = STATS,
): Promise<Zones> {
  const { app, id } = await setup(goal, stats);
  const res = await app.request(`/weeks/${id}/recap/zones`);
  expect(res.status).toBe(200);
  return (await json(res)) as unknown as Zones;
}

async function reportFor(
  goal: TrainingGoal | null,
  stats: TempoWeeklyRecapStats = STATS,
) {
  const { app, id } = await setup(goal, stats);
  const res = await app.request(`/weeks/${id}/recap?skip_subjective=true`);
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.status).toBe("report");
  return body;
}

const SHARE_LINE =
  "Easy-running share: 77% (zones 1 and 2 of time with heart rate)";

describe("the report resolves the goal for the easy-running share (#07)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("half in build: 80% target, below it", async () => {
    // Dec 14 is eight weeks after Mon Oct 19: build.
    const goal: TrainingGoal = { kind: "race", distance: "half", raceDate: "2026-12-14" };
    const zones = await zonesFor(goal);
    expect(zones.easyShareTarget).toBe(80);
    expect(zones.distribution.easyShareTarget).toBe(80);
    expect(zones.distribution.z1z2TargetMet).toBe(false);
    expect(zones.markdown).toContain(SHARE_LINE);
    expect(zones.markdown).toContain("Target for this block: 80% or more.");
    expect(zones.markdown).toContain("below the target");
    expect(zones.markdown).not.toMatch(/marathon/i);

    await resetAppTables();
    await acceptAndReady();
    const report = await reportFor(goal);
    expect(report.phase).toBe("build");
    expect(report.goal).toBe("half");
    expect(report.goalContext).toMatchObject({ recapGoal: "half", phase: "build", weeksToRace: 8 });
    expect(report.sections.zones).toContain("Target for this block: 80% or more.");
  });

  it("half in taper: no target line", async () => {
    const zones = await zonesFor({ kind: "race", distance: "half", raceDate: "2026-10-25" });
    expect(zones.easyShareTarget).toBeNull();
    expect(zones.markdown).toContain(SHARE_LINE);
    expect(zones.markdown).not.toContain("Target for this block");
  });

  it("half in build, a two-quality-session week: still below the 80% target", async () => {
    const zones = await zonesFor(
      { kind: "race", distance: "half", raceDate: "2026-12-14" },
      SPEED_BLOCK_STATS,
    );
    expect(zones.easyShareVerdict).toBe(true);
    expect(zones.distribution.z1z2Pct).toBe(62);
    expect(zones.distribution.z1z2TargetMet).toBe(false);
    expect(zones.markdown).toContain("Target for this block: 80% or more.");
    expect(zones.markdown).toContain("This week is below the target.");
  });

  // #34: the speed column keeps 75% as a reference, with no verdict either way.
  const SPEED_GOALS: Array<[string, TrainingGoal]> = [
    ["5k", { kind: "race", distance: "5k" }],
    ["10k", { kind: "race", distance: "10k" }],
    ["speed kind", { kind: "speed" }],
  ];
  for (const [name, goal] of SPEED_GOALS) {
    it(`${name}: 75% as a reference, no verdict below it`, async () => {
      const zones = await zonesFor(goal, SPEED_BLOCK_STATS);
      expect(zones.easyShareTarget).toBe(75);
      expect(zones.easyShareVerdict).toBe(false);
      expect(zones.distribution.easyShareTarget).toBe(75);
      expect(zones.distribution.easyShareVerdict).toBe(false);
      expect(zones.distribution.z1z2Pct).toBe(62);
      expect(zones.distribution.z1z2TargetMet).toBeUndefined();
      expect(zones.markdown).toContain("Easy-running share: 62%");
      expect(zones.markdown).toContain("Reference for this block: about 75%");
      expect(zones.markdown).not.toMatch(/below|meets|Target for this block/i);
    });

    it(`${name}: 75% as a reference, no verdict above it either`, async () => {
      const zones = await zonesFor(goal);
      expect(zones.distribution.z1z2TargetMet).toBeUndefined();
      expect(zones.markdown).toContain(SHARE_LINE);
      expect(zones.markdown).toContain("Reference for this block: about 75%");
      expect(zones.markdown).not.toMatch(/below|meets|Target for this block/i);
      expect(zones.markdown).not.toMatch(/marathon/i);
    });
  }

  it("10k: the full report carries the share and the reference, never 'below the target'", async () => {
    const report = await reportFor({ kind: "race", distance: "10k" }, SPEED_BLOCK_STATS);
    expect(report.goal).toBe("10k");
    expect(report.goalContext.knobs.thresholds).toMatchObject({
      column: "speed",
      easyShareTarget: 75,
      easyShareVerdict: false,
    });
    expect(report.sections.zones).toContain("Easy-running share: 62%");
    expect(report.sections.zones).toContain("Reference for this block: about 75%");
    expect(report.reportMarkdown as string).not.toMatch(/below the target/i);
  });

  it("fitness: the share only, no target and no verdict, never marathon", async () => {
    const zones = await zonesFor({ kind: "fitness" });
    expect(zones.easyShareTarget).toBeNull();
    expect(zones.distribution.z1z2TargetMet ?? null).toBeNull();
    expect(zones.markdown).toContain(SHARE_LINE);
    expect(zones.markdown).not.toContain("Target");
    expect(zones.markdown).not.toMatch(/below|meets/i);

    await resetAppTables();
    await acceptAndReady();
    const report = await reportFor({ kind: "fitness" });
    expect(report.phase).toBe("base");
    expect(report.goal).toBe("general");
    expect(report.goalContext.knobs.thresholds.column).toBe("fitness");
    expect(report.reportMarkdown as string).not.toMatch(/marathon/i);
  });

  it("return: no target line", async () => {
    const zones = await zonesFor({ kind: "return" });
    expect(zones.easyShareTarget).toBeNull();
    expect(zones.markdown).toContain(SHARE_LINE);
    expect(zones.markdown).not.toContain("Target");

    await resetAppTables();
    await acceptAndReady();
    const report = await reportFor({ kind: "return" });
    expect(report.phase).toBe("recovery");
    expect(report.goalContext.knobs.thresholds.column).toBe("return");
  });

  it("no goal stored (legacy): the fitness column, numbers only", async () => {
    const zones = await zonesFor(null);
    expect(zones.easyShareTarget).toBeNull();
    expect(zones.markdown).toContain(SHARE_LINE);
    expect(zones.markdown).not.toContain("Target");

    await resetAppTables();
    await acceptAndReady();
    const report = await reportFor(null);
    expect(report.phase).toBe("base");
    expect(report.goal).toBe("general");
    expect(report.goalContext.knobs.thresholds.easyShareTarget).toBeNull();
    expect(report.reportMarkdown as string).not.toMatch(/marathon/i);
  });
});
