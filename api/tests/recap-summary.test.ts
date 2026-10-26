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

describe("weekly recap Summary (#19)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("generates summary JSON/markdown for fixture ISO week via TempoPort + fixed clock", async () => {
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
      `/weeks/${weekSessionId}/recap/summary?format=json`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.isoWeek).toBe("2026-W43");
    expect(body.range).toEqual({
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    });
    expect(body.unit).toBe("imperial");

    const thisWeek = body.thisWeek as Record<string, unknown>;
    expect(thisWeek.runCount).toBe(2);
    expect(thisWeek.distanceM).toBe(15000);
    expect(thisWeek.durationS).toBe(5400);
    expect(thisWeek.elevGainM).toBe(40);
    expect(thisWeek.relativeEffort).toBe(80);
    expect(thisWeek.easyRunAvgHr).toBe(143);

    // Prior week (W42) empty (a real zero week, as tempo-cli); W41 has one
    // easy run → 3-wk avg is the mean of the three trailing weeks incl. empty ones.
    const comparison = body.comparison as {
      mileage: Record<string, number | undefined>;
      runs: Record<string, number | undefined>;
      easyRunHr?: Record<string, number | undefined>;
    };
    expect(comparison.mileage.prevDistanceM).toBe(0);
    expect(comparison.runs.prev).toBe(0);
    expect(comparison.mileage.threeWkAvgDistanceM).toBeCloseTo(8000 / 3, 6);
    expect(comparison.mileage.deltaVsThreeWkM).toBeCloseTo(15000 - 8000 / 3, 6);
    expect(comparison.runs.threeWkAvg).toBeCloseTo(1 / 3, 6);
    expect(comparison.runs.deltaVsThreeWk).toBeCloseTo(2 - 1 / 3, 6);
    expect(comparison.easyRunHr?.threeWkAvg).toBe(138);
    expect(comparison.easyRunHr?.deltaVsThreeWk).toBe(5);

    const rows = body.rows as Array<Record<string, string>>;
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.metric)).toEqual([
      "Mileage",
      "Runs",
      "Total time",
      "Total elevation",
      "Relative effort",
      "Avg easy-run HR",
    ]);
    expect(rows[0]!.thisWeek).toBe("9.32 mi");
    expect(rows[0]!.prevWeek).toBe("0.00 mi");
    expect(rows[0]!.threeWkAvg).toBe("1.66 mi");
    expect(rows[0]!.delta).toBe("+7.7");
    expect(rows[1]!.thisWeek).toBe("2");
    expect(rows[1]!.threeWkAvg).toBe("0.3");
    expect(rows[5]!.thisWeek).toBe("143");
    expect(rows[5]!.threeWkAvg).toBe("138");
    expect(rows[5]!.delta).toBe("+5");

    const markdown = body.markdown as string;
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain(
      "| Metric | This week | Prev week | 3-wk avg | Δ |",
    );
    expect(markdown).not.toContain("LineString");
    expect(markdown).not.toContain("SHOULD_NOT_LEAK");
    expect(markdown).not.toContain("routeGeoJson");
    assertNoGpsFields(body);

    const mdRes = await app.request(
      `/weeks/${weekSessionId}/recap/summary?format=markdown`,
    );
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toMatch(/text\/markdown/);
    const mdBody = await mdRes.text();
    expect(mdBody).toBe(markdown);
  });

  it("requires disclaimer and rejects unknown week session", async () => {
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });

    const blocked = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/summary",
    );
    expect(blocked.status).toBe(403);

    await acceptAndReady();
    const missing = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/summary",
    );
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({
      error: "week_session_not_found",
    });
  });
});
