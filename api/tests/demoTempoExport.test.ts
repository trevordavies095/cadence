import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { assertNoGpsFields } from "../src/tempo/sanitize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEMO_ZIP = path.join(REPO_ROOT, "demo", "tempo-export.zip");
const GENERATOR = path.join(REPO_ROOT, "demo", "generate-tempo-export.mjs");

const M_PER_MILE = 1609.344;
// Demo "now": Wed Oct 14 2026, 7:30 pm ET.
const DEMO_NOW_MS = Date.parse("2026-10-14T23:30:00Z");

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function allRuns() {
  const port = createExportTempoPort({ exportPath: DEMO_ZIP });
  const listed = await port.listWorkouts({
    page: 1,
    pageSize: 500,
    sortBy: "startedAt",
    sortOrder: "asc",
  });
  return { port, runs: listed.items };
}

function weeklyMiles(runs: { startedAt: string; distanceM?: number | null }[]) {
  const week1 = Date.UTC(2026, 7, 3);
  const miles = new Array<number>(11).fill(0);
  for (const r of runs) {
    // Runs start ~6-8 am ET, so the UTC date is the same local day.
    const idx = Math.floor((Date.parse(r.startedAt) - week1) / (7 * 86_400_000));
    miles[idx] = (miles[idx] ?? 0) + (r.distanceM ?? 0) / M_PER_MILE;
  }
  return miles;
}

describe("demo Tempo export (Johnny Morrissey)", () => {
  it("loads through the export TempoPort with runs, splits, HR and no GPS", async () => {
    const { port, runs } = await allRuns();
    expect(runs.length).toBeGreaterThan(40);

    const first = await port.getWorkout(runs[0]!.id);
    expect(first).not.toBeNull();
    expect(first!.distanceM).toBeGreaterThan(0);
    expect(first!.splits?.length).toBeGreaterThan(0);
    expect(first!.timeSeries?.length).toBeGreaterThan(0);
    expect(first!.avgHeartRateBpm).toBeGreaterThan(100);
    assertNoGpsFields(first);

    const settings = await port.getSettings();
    expect(settings.unitPreference).toBe("imperial");
  });

  it("covers Aug 3 to the morning of Oct 14 with nothing after demo now", async () => {
    const { runs } = await allRuns();
    const starts = runs.map((r) => Date.parse(r.startedAt));
    expect(new Date(Math.min(...starts)).toISOString()).toMatch(/^2026-08-04/);
    expect(Math.max(...starts)).toBeLessThan(DEMO_NOW_MS);
    expect(new Date(Math.max(...starts)).toISOString()).toMatch(/^2026-10-14T1[01]/);
  });

  it("follows the training arc: cutbacks, Achilles dip in weeks 6-7, recovery in week 8", async () => {
    const { runs } = await allRuns();
    const miles = weeklyMiles(runs);

    for (const w of [1, 2, 3, 4, 5, 8, 9, 10]) {
      expect(miles[w - 1]).toBeGreaterThanOrEqual(33);
      expect(miles[w - 1]).toBeLessThanOrEqual(46);
    }
    expect(miles[3]).toBeLessThan(miles[2]!); // week 4 cutback
    expect(miles[5]).toBeLessThan(miles[4]! - 8); // week 6 cut short
    expect(miles[6]).toBeLessThan(28); // week 7 reduced
    expect(miles[7]).toBeGreaterThan(32); // week 8 back to normal
    expect(miles[9]).toBeGreaterThanOrEqual(44); // week 10 peak
  });

  it("has the Achilles run cut short and a 20 mile long run, and no quality session in week 7", async () => {
    const { runs } = await allRuns();
    const stopped = runs.find((r) => r.name === "Tempo, stopped early");
    expect(stopped).toBeDefined();
    expect(stopped!.notes).toMatch(/Achilles/);
    expect(stopped!.startedAt).toMatch(/^2026-09-10/);

    const longest = Math.max(...runs.map((r) => (r.distanceM ?? 0) / M_PER_MILE));
    expect(longest).toBeGreaterThan(19.5);
    expect(longest).toBeLessThan(21);

    const week7 = runs.filter(
      (r) => r.startedAt >= "2026-09-14" && r.startedAt < "2026-09-21",
    );
    expect(week7).toHaveLength(5);
    expect(week7.every((r) => r.runType === "Easy Run" || r.runType === "Long Run")).toBe(true);
  });

  it("is deterministic: regenerating matches the committed zip byte for byte", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-tempo-test-"));
    try {
      const out = path.join(tmp, "tempo-export.zip");
      execFileSync("node", [GENERATOR, "--out", out], { stdio: "ignore" });
      expect(sha256(out)).toBe(sha256(DEMO_ZIP));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
