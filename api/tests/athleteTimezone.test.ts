import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resolveAthleteTimezone } from "../src/clock/athleteTimezone.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/**
 * Sun 2026-10-25 22:30 in New York (EDT, UTC-4) == Mon 2026-10-26 02:30Z.
 * New York: 2026-W43. UTC: 2026-W44.
 */
const INSTANT = new FixedClock(new Date("2026-10-26T02:30:00.000Z"));
const NY = "America/New_York";

describe("resolveAthleteTimezone", () => {
  it("returns a valid IANA name", () => {
    expect(resolveAthleteTimezone({ ATHLETE_TIMEZONE: NY })).toBe(NY);
  });

  it("defaults to UTC when unset or blank", () => {
    expect(resolveAthleteTimezone({})).toBe("UTC");
    expect(resolveAthleteTimezone({ ATHLETE_TIMEZONE: "  " })).toBe("UTC");
  });

  it("uses the supplied fallback only when unset", () => {
    expect(resolveAthleteTimezone({}, NY)).toBe(NY);
    expect(
      resolveAthleteTimezone({ ATHLETE_TIMEZONE: "Europe/Paris" }, NY),
    ).toBe("Europe/Paris");
  });

  it("throws a clear message for an invalid name", () => {
    expect(() =>
      resolveAthleteTimezone({ ATHLETE_TIMEZONE: "Mars/Olympus" }),
    ).toThrow(/Invalid ATHLETE_TIMEZONE "Mars\/Olympus"/);
  });
});

describe("athlete timezone through HTTP (#76)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  function makeApp(athleteTimezone: string) {
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: INSTANT,
      athleteTimezone,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
  }

  async function configureSetup(app: ReturnType<typeof createApp>) {
    for (const [route, body] of [
      ["tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_tz_test_key" }],
      ["anthropic", { apiKey: "sk-ant-tz-test-key" }],
    ] as const) {
      const res = await app.request(`/settings/${route}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }
  }

  it("GET /week uses the athlete timezone; ?timezone overrides", async () => {
    const app = makeApp(NY);
    const ny = await json(await app.request("/week"));
    expect(ny).toMatchObject({ isoWeek: "2026-W43", timezone: NY });
    const utc = await json(await app.request("/week?timezone=UTC"));
    expect(utc).toMatchObject({ isoWeek: "2026-W44", timezone: "UTC" });
  });

  it("POST /weeks/current resolves the New York session; query overrides", async () => {
    await acceptAndReady();
    const app = makeApp(NY);
    const ny = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    expect(ny).toMatchObject({ isoWeek: "2026-W43", timezone: NY });
    const utc = await json(
      await app.request("/weeks/current?timezone=UTC", { method: "POST" }),
    );
    expect(utc).toMatchObject({ isoWeek: "2026-W44", timezone: "UTC" });
  });

  it("loop status resolves the New York session; query overrides", async () => {
    await acceptAndReady();
    const app = makeApp(NY);
    await configureSetup(app);
    const ny = await json(await app.request("/loop-status"));
    expect(ny.week).toMatchObject({ isoWeek: "2026-W43", timezone: NY });
    const utc = await json(await app.request("/loop-status?timezone=UTC"));
    expect(utc.week).toMatchObject({ isoWeek: "2026-W44", timezone: "UTC" });
  });

  it("POST /week/reply focuses the New York session (observed via the check-in gate)", async () => {
    await acceptAndReady();
    const app = makeApp(NY);
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const reply = (a: ReturnType<typeof createApp>) =>
      a.request("/week/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recapMarkdown: "## Summary\nTz fixture." }),
      });

    const res = await reply(app);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe("check_in_required");
    expect(body.weekSessionId).toBe(week.id);

    // Same instant with a UTC athlete resolves a different (W44) session.
    const utcBody = await json(await reply(makeApp("UTC")));
    expect(utcBody.weekSessionId).not.toBe(week.id);
  });
});
