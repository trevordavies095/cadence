import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
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

/** Known Monday run in the scrubbed export mini pack. */
const W1 = "11111111-1111-4111-8111-111111111111";

describe("mid-week chat workout attach (#36)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("attaches a known export workout id (coaching fields, no GPS)", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
      llmPort: createStubLlmPort(),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    expect(week.isoWeek).toBe("2026-W43");

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "How did Monday's 10k look?",
        attachmentWorkoutId: W1,
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);

    const athlete = body.athleteMessage as Record<string, unknown>;
    expect(athlete.role).toBe("athlete");
    const attachment = athlete.attachment as Record<string, unknown>;
    expect(attachment).toBeTruthy();
    expect(attachment.workoutId).toBe(W1);
    expect(attachment.distanceM).toBe(10000);
    expect(attachment.startedAt).toBeTruthy();
    expect(attachment.durationS).toBeTruthy();
    expect(attachment.avgPaceS).toBeTruthy();
    expect(attachment).not.toHaveProperty("route");
    expect(attachment).not.toHaveProperty("routeGeoJson");
    expect(attachment).not.toHaveProperty("rawGpxData");
    expect(attachment).not.toHaveProperty("rawFitData");
    expect(attachment).not.toHaveProperty("coordinates");
    expect(JSON.stringify(attachment)).not.toMatch(/LineString/i);

    const coach = body.coachMessage as Record<string, unknown>;
    // Stub attach feedback (#37): deterministic metrics from the attachment.
    expect(String(coach.body)).toContain("Attached run feedback");
    expect(String(coach.body)).toContain("10.0 km");
    expect(String(coach.body)).toContain("avg pace");
    expect(String(coach.body)).toMatch(/do not diagnose/i);

    const listed = await json(
      await app.request(`/thread?weekSessionId=${week.id as string}`),
    );
    const messages = listed.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    const stored = messages[0]!.attachment as Record<string, unknown>;
    expect(stored.workoutId).toBe(W1);
    expect(stored.distanceM).toBe(10000);
    expect(stored).not.toHaveProperty("routeGeoJson");
    // Coach feedback is visible in the thread listing (UI reads this).
    expect(String(messages[1]!.body)).toContain("Attached run feedback");
    expect(String(messages[1]!.body)).toContain("10.0 km");
  });

  it("rejects unknown workout id from export port", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Attach missing run",
        attachmentWorkoutId: "00000000-0000-4000-8000-000000000099",
      }),
    });
    expect(res.status).toBe(404);
    const err = await json(res);
    expect(err.error).toBe("workout_not_found");
  });

  it("rejects invalid attachment workout id", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "bad id",
        attachmentWorkoutId: "not-a-uuid",
      }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_workout_id");
  });
});
