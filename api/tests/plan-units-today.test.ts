import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { getCachedUnitPreference } from "../src/settings/unitPreferenceStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoPort, TempoUnitPreference } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/** Tempo reporting `unit`, or failing every settings read when null. */
function tempoWith(unit: TempoUnitPreference | null): TempoPort {
  const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
  return {
    ...base,
    getSettings: async () => {
      if (unit === null) throw new Error("Tempo is unreachable");
      return { ...(await base.getSettings()), unitPreference: unit };
    },
  };
}

describe("plan reads carry the athlete's units and today (#96)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function open(tempoPort: TempoPort, now = "2026-10-21T15:00:00.000Z") {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(now)),
      athleteTimezone: "America/New_York",
      tempoPort,
      llmPort: createStubLlmPort(),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, id: week.id as string };
  }

  const next = async (app: ReturnType<typeof createApp>, id: string) =>
    json(await app.request(`/weeks/${id}/prescribed/next`));

  it("reads the unit preference from Tempo and caches it", async () => {
    const { app, id } = await open(tempoWith("metric"));
    expect(await getCachedUnitPreference()).toBeNull();

    expect((await next(app, id)).unitPreference).toBe("metric");
    expect(await getCachedUnitPreference()).toBe("metric");
  });

  it("falls back to the last known unit when Tempo cannot be read", async () => {
    const first = await open(tempoWith("metric"));
    expect((await next(first.app, first.id)).unitPreference).toBe("metric");

    const down = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      athleteTimezone: "America/New_York",
      tempoPort: tempoWith(null),
      llmPort: createStubLlmPort(),
    });
    expect((await next(down, first.id)).unitPreference).toBe("metric");
  });

  it("defaults to miles when Tempo was never read", async () => {
    const { app, id } = await open(tempoWith(null));
    expect(await getCachedUnitPreference()).toBeNull();
    expect((await next(app, id)).unitPreference).toBe("imperial");
  });

  it("returns the unit and today on the current week's plan too", async () => {
    const { app, id } = await open(tempoWith("imperial"));
    // No plan yet: the read is still a 404, with nothing to carry units on.
    expect((await app.request(`/weeks/${id}/prescribed`)).status).toBe(404);

    const { savePrescribedWeek } = await import("../src/prescribed/store.js");
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: id,
      plan: { week: "2026-W43", days: [] },
      analysis: "Fixture.",
    });
    const body = await json(await app.request(`/weeks/${id}/prescribed`));
    expect(body.unitPreference).toBe("imperial");
    expect(body.todayYmd).toBe("2026-10-21");
  });

  it("todayYmd is the athlete's local date, not the UTC date", async () => {
    // 02:30 UTC on Monday Oct 26 is still Sunday evening in New York.
    const { app, id } = await open(tempoWith("imperial"), "2026-10-26T02:30:00.000Z");
    expect((await next(app, id)).todayYmd).toBe("2026-10-25");
  });
});
