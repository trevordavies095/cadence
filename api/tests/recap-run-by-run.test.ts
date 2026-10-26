import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
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

describe("weekly recap Run-by-run (#21)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("lists each fixture run with core metrics via TempoPort + FixedClock", async () => {
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
      `/weeks/${weekSessionId}/recap/run-by-run?format=json`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.isoWeek).toBe("2026-W43");
    expect(body.unit).toBe("imperial");
    expect(body.range).toEqual({
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    });

    const runs = body.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(2);

    const monday = runs[0]!;
    expect(monday.workoutId).toBe("11111111-1111-4111-8111-111111111111");
    expect(monday.runType).toBe("Easy Run");
    expect(monday.distanceM).toBe(10000);
    expect(monday.durationS).toBe(3600);
    expect(monday.avgPaceS).toBe(360);
    expect(monday.avgHeartRateBpm).toBe(140);
    expect(monday.maxHeartRateBpm).toBe(155);
    expect(monday.elevGainM).toBe(20);
    expect(monday.relativeEffort).toBe(40);
    expect(monday.notes).toBe("fixture note");
    expect(monday.cadenceSpm).toBe(320);
    expect(monday.splitPacesFormatted).toMatch(/\/mi/);
    expect(Array.isArray(monday.splits)).toBe(true);
    expect((monday.splits as unknown[]).length).toBe(2);
    expect(monday.drift).toMatchObject({
      q1AvgHr: expect.any(Number),
      q4AvgHr: expect.any(Number),
      driftBpm: expect.any(Number),
    });
    expect(monday.zonePct).toBeTypeOf("object");
    expect(monday.shoe).toMatchObject({
      id: "4ca636b8-b06a-43aa-9252-c5ef643a2e0e",
      label: "ASICS Nimbus 28",
    });
    // No subjective fields in this slice.
    expect(monday).not.toHaveProperty("rpe");
    expect(monday).not.toHaveProperty("feel");
    expect(monday).not.toHaveProperty("subjective");

    const wednesday = runs[1]!;
    expect(wednesday.workoutId).toBe("22222222-2222-4222-8222-222222222222");
    expect(wednesday.distanceM).toBe(5000);
    expect(wednesday.durationS).toBe(1800);
    expect(wednesday.avgHeartRateBpm).toBe(145);
    expect((wednesday.splits as unknown[]).length).toBe(1);
    expect(wednesday.cadenceSpm).toBe(316);
    expect(wednesday.shoe).toMatchObject({ label: "ASICS Nimbus 28" });

    const markdown = body.markdown as string;
    expect(markdown).toContain("## Run-by-run");
    expect(markdown).toContain("Easy Run");
    expect(markdown).toContain("Pace:");
    expect(markdown).toContain("Splits:");
    expect(markdown).toContain("HR drift:");
    expect(markdown).toContain("Time in zones:");
    expect(markdown).toContain("Shoe: ASICS Nimbus 28");
    expect(markdown).toContain('Notes (from app): "fixture note"');
    expect(markdown).not.toContain("RPE");
    expect(markdown).not.toContain("SHOULD_NOT_LEAK");
    expect(markdown).not.toContain("routeGeoJson");
    assertNoGpsFields(body);

    const mdRes = await app.request(
      `/weeks/${weekSessionId}/recap/run-by-run?format=markdown`,
    );
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await mdRes.text()).toBe(markdown);
  });

  it("requires disclaimer and rejects unknown week session", async () => {
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });

    const blocked = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/run-by-run",
    );
    expect(blocked.status).toBe(403);

    await acceptAndReady();
    const missing = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/run-by-run",
    );
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({
      error: "week_session_not_found",
    });
  });
});
