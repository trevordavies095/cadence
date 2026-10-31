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
 * The fixture week (2026-W43, Mon Oct 19): Tue Oct 20 10 km and Thu Oct 22
 * 5 km, retyped here as Threshold and Race so the week holds two quality
 * sessions. The log reports 22 hard minutes (14 the week before), 4 h 12 min
 * of moving time and a longest run of 32 min.
 */
const STATS: TempoWeeklyRecapStats = {
  runs: { current: 2, previous: 0, trailingAvg: 0 },
  distanceM: { current: 15000, previous: 0, trailingAvg: 0 },
  durationS: { current: 5400, previous: 0, trailingAvg: 0 },
  movingTimeS: { current: 4 * 3600 + 12 * 60, previous: 0, trailingAvg: 0 },
  longestRunDurationS: { current: 32 * 60, previous: 0, trailingAvg: 0 },
  zoneSecondsZ1: { current: 3000, previous: 3000 },
  zoneSecondsZ2: { current: 600, previous: 600 },
  zoneSecondsZ3: { current: 480, previous: 480 },
  zoneSecondsZ4: { current: 900, previous: 600 },
  zoneSecondsZ5: { current: 420, previous: 240 },
};

const RETYPE: Record<string, string> = {
  "11111111-1111-4111-8111-111111111111": "Threshold",
  "22222222-2222-4222-8222-222222222222": "Race",
};

function port(stats: TempoWeeklyRecapStats | null): TempoPort {
  const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
  return {
    ...base,
    async listWorkouts(q) {
      const res = await base.listWorkouts(q);
      return {
        ...res,
        items: res.items.map((w) => ({ ...w, runType: RETYPE[w.id] ?? w.runType })),
      };
    },
    getWeeklyRecapStats: async () => stats,
  };
}

type GoalLine = {
  id: string;
  label: string;
  value: string | null;
  headline: boolean;
  flag: boolean;
};
type Summary = { goalLines: GoalLine[]; markdown: string };

async function summaryFor(
  goal: TrainingGoal | null,
  stats: TempoWeeklyRecapStats | null = STATS,
): Promise<Summary> {
  if (goal) await appendGoal(new Date("2026-10-01T12:00:00Z"), goal, "settings");
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    tempoPort: port(stats),
  });
  const week = await json(await app.request("/weeks/current", { method: "POST" }));
  expect(week.isoWeek).toBe("2026-W43");
  const res = await app.request(`/weeks/${week.id}/recap/summary?unit=metric`);
  expect(res.status).toBe(200);
  return (await json(res)) as unknown as Summary;
}

function texts(s: Summary): string[] {
  return s.goalLines.map((l) => (l.value === null ? l.label : `${l.label}: ${l.value}`));
}

const HARD = "Hard minutes (zones 4 and 5): 22 min, up 8";

describe("summary goal lines (#13)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    await acceptAndReady();
  });

  it("half: hard minutes with the delta, no quality count, distance leads", async () => {
    const s = await summaryFor({ kind: "race", distance: "half", raceDate: "2026-12-14" });
    expect(texts(s)).toEqual([HARD]);
    expect(s.goalLines[0]!.headline).toBe(false);
    expect(s.markdown).toContain(`- ${HARD}`);
    expect(s.markdown).not.toContain("Quality sessions");
    expect(s.markdown).not.toContain("Run time");
  });

  it("10k: hard minutes lead, then two quality sessions (Race counts)", async () => {
    const s = await summaryFor({ kind: "race", distance: "10k", raceDate: "2026-12-14" });
    expect(texts(s)).toEqual([HARD, "Quality sessions: 2"]);
    expect(s.goalLines[0]!.headline).toBe(true);
  });

  it("speed kind: quality sessions too", async () => {
    const s = await summaryFor({ kind: "speed", distance: "5k" });
    expect(texts(s)).toContain("Quality sessions: 2");
  });

  it("fitness: run time leads, hard minutes, longest run with the day", async () => {
    const s = await summaryFor({ kind: "fitness" });
    expect(texts(s)).toEqual([
      "Run time: 4 h 12 min moving",
      HARD,
      "Longest run: 10.0 km (Tue)",
    ]);
    expect(s.goalLines[0]!.headline).toBe(true);
    expect(s.markdown).not.toContain("Quality sessions");
  });

  it("fitness with no hard minutes: says so", async () => {
    const s = await summaryFor(
      { kind: "fitness" },
      {
        ...STATS,
        zoneSecondsZ4: { current: 0, previous: 0 },
        zoneSecondsZ5: { current: 0, previous: 0 },
      },
    );
    expect(texts(s)).toContain("Hard minutes (zones 4 and 5): 0 min, same as last week");
    expect(texts(s)).toContain("No hard minutes this week");
  });

  it("return: run time, longest run duration, hard minutes and the flag", async () => {
    const s = await summaryFor({ kind: "return" });
    expect(texts(s)).toEqual([
      "Run time: 4 h 12 min moving",
      "Longest run: 32 min",
      HARD,
      "Hard minutes above zero this week",
    ]);
    expect(s.goalLines.map((l) => l.headline)).toEqual([true, true, false, false]);
    expect(s.goalLines[3]!.flag).toBe(true);
  });

  it("null zone buckets: not available", async () => {
    const { zoneSecondsZ4: _z4, zoneSecondsZ5: _z5, ...noHr } = STATS;
    const s = await summaryFor({ kind: "return" }, noHr);
    expect(texts(s)).toContain(
      "Hard minutes (zones 4 and 5): not available (no heart-rate data)",
    );
    expect(texts(s)).not.toContain("Hard minutes above zero this week");
  });

  it("no previous week buckets: no delta", async () => {
    const s = await summaryFor(
      { kind: "race", distance: "half", raceDate: "2026-12-14" },
      { ...STATS, zoneSecondsZ4: { current: 900 }, zoneSecondsZ5: { current: 420 } },
    );
    expect(texts(s)).toEqual(["Hard minutes (zones 4 and 5): 22 min"]);
  });

  it("without the weekly recap: run time and longest run from the runs", async () => {
    const s = await summaryFor({ kind: "return" }, null);
    expect(texts(s)).toEqual([
      "Run time: 1 h 30 min moving",
      "Longest run: 1 h",
      "Hard minutes (zones 4 and 5): not available (no heart-rate data)",
    ]);
  });

  it("the report's summary carries the lines above the table", async () => {
    await appendGoal(
      new Date("2026-10-01T12:00:00Z"),
      { kind: "race", distance: "10k", raceDate: "2026-12-14" },
      "settings",
    );
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: port(STATS),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const res = await app.request(`/weeks/${week.id}/recap?skip_subjective=true`);
    expect(res.status).toBe(200);
    const body = await json(res);
    const summary = (body.sections as { summary: string }).summary;
    expect(summary).toContain(`## Summary\n\n- ${HARD}\n- Quality sessions: 2\n\n| Metric`);
    expect(body.reportMarkdown as string).toContain(`- ${HARD}`);
  });
});
