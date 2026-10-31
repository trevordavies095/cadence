import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { RECAP_SKELETON_ORDER } from "../src/recap/phase.js";
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

describe("weekly recap long-run / trends / notable + phase knobs (#22)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function openWeek() {
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
    return { app, weekSessionId: week.id as string };
  }

  it("skeleton keeps long-run → trends → notable order for two phase knobs", async () => {
    const { app, weekSessionId } = await openWeek();

    const recoveryRes = await app.request(
      `/weeks/${weekSessionId}/recap/skeleton?format=json&phase=recovery&goal=general`,
    );
    expect(recoveryRes.status).toBe(200);
    const recovery = await json(recoveryRes);
    expect(recovery.sectionOrder).toEqual([...RECAP_SKELETON_ORDER]);
    expect(recovery.phase).toBe("recovery");
    expect(recovery.knobs).toMatchObject({
      phase: "recovery",
      sections: {
        longRun: "brief",
        trends: "brief",
        notable: "brief",
      },
      longestAsLongRun: false,
    });

    const recoveryMd = recovery.markdown as string;
    const iLongR = recoveryMd.indexOf("## Long run");
    const iTrendsR = recoveryMd.indexOf("## Trends");
    const iNotableR = recoveryMd.indexOf("## Notable");
    expect(iLongR).toBeGreaterThan(-1);
    expect(iTrendsR).toBeGreaterThan(iLongR);
    expect(iNotableR).toBeGreaterThan(iTrendsR);
    // Recovery does not invent a long run from easy miles.
    expect(recoveryMd).toContain("No qualifying long run this week.");
    expect(recoveryMd).not.toContain("Last 3 mi at goal effort");
    // Brief trends: long-run distance only (no easy pace / easy HR lines).
    expect(recoveryMd).toContain("**Long-run distance**");
    expect(recoveryMd).not.toContain("**Easy pace");
    assertNoGpsFields(recovery);

    const buildRes = await app.request(
      `/weeks/${weekSessionId}/recap/skeleton?format=json&phase=build&goal=half`,
    );
    expect(buildRes.status).toBe(200);
    const build = await json(buildRes);
    expect(build.sectionOrder).toEqual([...RECAP_SKELETON_ORDER]);
    expect(build.phase).toBe("build");
    expect(build.knobs).toMatchObject({
      phase: "build",
      goal: "half",
      sections: { longRun: "detailed", trends: "detailed" },
      longestAsLongRun: true,
    });

    const buildMd = build.markdown as string;
    const iLongB = buildMd.indexOf("## Long run");
    const iTrendsB = buildMd.indexOf("## Trends");
    const iNotableB = buildMd.indexOf("## Notable");
    expect(iLongB).toBeGreaterThan(-1);
    expect(iTrendsB).toBeGreaterThan(iLongB);
    expect(iNotableB).toBeGreaterThan(iTrendsB);
    // Same skeleton order as recovery (section headings positions relative).
    expect(iLongB).toBeLessThan(iTrendsB);
    expect(buildMd).toContain("### Long run —");
    expect(buildMd).toContain("Last 3 mi at goal effort");
    expect(buildMd).toContain("Weeks:");
    expect(buildMd).toContain("**Easy pace");
    // Depth changed; order did not.
    expect(build.sectionOrder).toEqual(recovery.sectionOrder);
  });

  it("long-run missing under recovery; longest-run fallback under build", async () => {
    const { app, weekSessionId } = await openWeek();

    const missing = await app.request(
      `/weeks/${weekSessionId}/recap/long-run?phase=recovery`,
    );
    expect(missing.status).toBe(200);
    const missingBody = await json(missing);
    expect(missingBody.included).toBe(false);
    expect(missingBody.reason).toBe("not_eligible");
    expect(missingBody.markdown).toContain("No qualifying long run this week.");

    const present = await app.request(
      `/weeks/${weekSessionId}/recap/long-run?phase=build&goal=half`,
    );
    expect(present.status).toBe(200);
    const presentBody = await json(present);
    expect(presentBody.included).toBe(true);
    expect(presentBody.reason).toBe("longest_run_fallback");
    expect(presentBody.longRun).toMatchObject({
      workoutId: "11111111-1111-4111-8111-111111111111",
      distanceM: 10000,
      selectionReason: "longest_run_fallback",
    });
    expect(presentBody.markdown).toContain("### Long run —");
    expect(presentBody.markdown).toContain("Splits:");
    assertNoGpsFields(presentBody);
  });

  it("trends + notable cover fixture week; empty notable / overload degrade gracefully", async () => {
    const { app, weekSessionId } = await openWeek();

    const trendsRes = await app.request(
      `/weeks/${weekSessionId}/recap/trends?format=json&phase=base`,
    );
    expect(trendsRes.status).toBe(200);
    const trendsBody = await json(trendsRes);
    expect(trendsBody.trends).toMatchObject({
      included: true,
      weekLabels: ["2026-W40", "2026-W41", "2026-W42", "2026-W43"],
    });
    const longSeries = (trendsBody.trends as { longRunDistanceM: (number | null)[] })
      .longRunDistanceM;
    expect(longSeries[3]).toBe(10000);
    expect(trendsBody.markdown).toContain("## Trends");
    expect(trendsBody.markdown).toContain("**Long-run distance**");

    const notableRes = await app.request(
      `/weeks/${weekSessionId}/recap/notable?format=json&phase=base`,
    );
    expect(notableRes.status).toBe(200);
    const notableBody = await json(notableRes);
    expect(notableBody.markdown).toContain("## Notable");
    // Empty best-efforts + shoe under threshold → still a section; RE overload may flag.
    const notable = notableBody.notable as {
      bullets: string[];
      overload: { flagged: boolean };
      bestEfforts: { newBests: unknown[] };
    };
    expect(notable.bestEfforts.newBests).toEqual([]);
    expect(notable.overload.flagged).toBe(true);
    expect(notable.bullets.some((b) => b.includes("possible overload"))).toBe(
      true,
    );
    expect(notableBody.markdown).not.toContain("routeGeoJson");
    assertNoGpsFields(notableBody);

    const mdRes = await app.request(
      `/weeks/${weekSessionId}/recap/notable?format=markdown&phase=recovery`,
    );
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toMatch(/text\/markdown/);
    const briefMd = await mdRes.text();
    expect(briefMd).toContain("## Notable");
    // Brief depth: at most one bullet.
    const bulletLines = briefMd
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBe(1);
  });

  it("requires disclaimer and rejects unknown week session", async () => {
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });

    const blocked = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/skeleton",
    );
    expect(blocked.status).toBe(403);

    await acceptAndReady();
    const missing = await app.request(
      "/weeks/11111111-1111-4111-8111-111111111111/recap/long-run",
    );
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({
      error: "week_session_not_found",
    });
  });

  it("phase and goal query parameters override the knobs, including the goal knobs table", async () => {
    const { app, weekSessionId } = await openWeek();

    const half = await json(
      await app.request(
        `/weeks/${weekSessionId}/recap/skeleton?format=json&phase=taper&goal=half`,
      ),
    );
    expect(half.knobs).toMatchObject({
      phase: "taper",
      goal: "half",
      thresholds: { column: "endurance", easyShareTarget: null, fastFinish: true },
    });

    const tenK = await json(
      await app.request(`/weeks/${weekSessionId}/recap/long-run?phase=build&goal=10k`),
    );
    expect(tenK.knobs).toMatchObject({
      phase: "build",
      goal: "10k",
      thresholds: { column: "speed", easyShareTarget: 75 },
    });

    const bad = await app.request(`/weeks/${weekSessionId}/recap/trends?goal=ultra`);
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("invalid_goal");
  });
});
