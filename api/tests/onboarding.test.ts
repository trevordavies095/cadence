import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { getOnboardingAnswers } from "../src/onboarding/store.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

describe("onboarding interview questionnaire gate", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("new athlete hits needs_onboarding instead of empty void", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
    });

    const res = await app.request("/onboarding");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("needs_onboarding");
    expect(body.questionnaire).toBeTruthy();
    const q = body.questionnaire as {
      order: string[];
      fields: Record<string, string>;
      required: string[];
      all_fields_optional: boolean;
    };
    expect(q.order).toEqual([
      "goal",
      "schedule",
      "injuries_constraints",
      "preferences",
    ]);
    expect(q.fields.goal).toMatch(/training for/i);
    expect(q.required).toEqual(["goal", "schedule"]);
    expect(q.all_fields_optional).toBe(false);
    expect(typeof body.note).toBe("string");
  });

  it("Tempo prefills appear as hints where available", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
    });

    const body = await json(await app.request("/onboarding"));
    expect(body.status).toBe("needs_onboarding");
    const prefills = body.prefills as {
      available: boolean;
      unitPreference: string;
      heartRateZones: { zones: Array<{ zoneNumber: number; minBpm: number }> };
      shoes: Array<{ brand: string; model: string }>;
      recentTraining: Array<{ id: string; distanceM: number }>;
      defaultShoeId: string | null;
    };
    expect(prefills.available).toBe(true);
    expect(prefills.unitPreference).toBe("imperial");
    expect(prefills.heartRateZones.zones.length).toBeGreaterThanOrEqual(5);
    expect(prefills.heartRateZones.zones[1]).toMatchObject({
      zoneNumber: 2,
      minBpm: 150,
    });
    expect(prefills.shoes[0]).toMatchObject({
      brand: "ASICS",
      model: "Nimbus 28",
    });
    expect(prefills.defaultShoeId).toBe(
      "4ca636b8-b06a-43aa-9252-c5ef643a2e0e",
    );
    expect(prefills.recentTraining.length).toBeGreaterThan(0);
    expect(prefills.recentTraining[0]!.distanceM).toBeGreaterThan(0);
  });

  it("answers persist and are visible for subsequent dossier generation", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
    });

    const created = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Half marathon in April",
        schedule: "Tue/Thu/Sat, ~5 hrs/week",
        injuries_constraints: "Left calf tight after hills",
        preferences: "Long run Saturday, prefer trails",
      }),
    });
    expect(created.status).toBe(201);
    const saved = await json(created);
    expect(saved.status).toBe("ready");
    expect(saved.answers).toMatchObject({
      goal: "Half marathon in April",
      schedule: "Tue/Thu/Sat, ~5 hrs/week",
      injuries_constraints: "Left calf tight after hills",
      preferences: "Long run Saturday, prefer trails",
    });
    // #17: answers complete → pending dossier proposal (stub LlmPort)
    expect((saved.proposal as { status: string }).status).toBe("pending");
    expect(
      ((saved.proposal as { summaryBullets: string[] }).summaryBullets ?? [])
        .length,
    ).toBeGreaterThan(0);

    const gate = await json(await app.request("/onboarding"));
    expect(gate.status).toBe("ready");
    expect(gate.answers).toMatchObject({
      goal: "Half marathon in April",
      schedule: "Tue/Thu/Sat, ~5 hrs/week",
    });

    // Store seam used by later dossier generation (#17)
    const fromStore = await getOnboardingAnswers();
    expect(fromStore).not.toBeNull();
    expect(fromStore!.answers.goal).toBe("Half marathon in April");
    expect(fromStore!.answers.injuries_constraints).toContain("calf");
  });

  it("accepts nested { answers } body shape", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
    });

    const res = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: {
          goal: "5k PR",
          schedule: "MWF",
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect((body.answers as { goal: string }).goal).toBe("5k PR");
  });

  it("requires goal and schedule", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });

    const missingGoal = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schedule: "MWF" }),
    });
    expect(missingGoal.status).toBe(400);
    expect((await json(missingGoal)).error).toBe("goal_required");

    const missingSchedule = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "10k" }),
    });
    expect(missingSchedule.status).toBe(400);
    expect((await json(missingSchedule)).error).toBe("schedule_required");
  });

  it("dossier present → complete; answers locked", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
    });

    await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Marathon",
        schedule: "5 days",
      }),
    });
    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# Dossier\n\nGoal: marathon." }),
    });

    const gate = await json(await app.request("/onboarding"));
    expect(gate.status).toBe("complete");
    expect(gate.dossierVersionId).toBeTruthy();
    expect((gate.answers as { goal: string }).goal).toBe("Marathon");

    const locked = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Other", schedule: "Other" }),
    });
    expect(locked.status).toBe(409);
    expect((await json(locked)).error).toBe("onboarding_complete");
  });

  it("disclaimer gates onboarding", async () => {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });
    expect((await app.request("/onboarding")).status).toBe(403);
    expect(
      (
        await app.request("/onboarding/answers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "x", schedule: "y" }),
        })
      ).status,
    ).toBe(403);
  });
});
