import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { createStubLlmPort, type PrescribedWeek } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

describe("prescribed week persist + thread artifact (#30)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("stub plan → persisted → thread artifact present", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Chronic left Achilles flare — keep easy volume capped.",
      }),
    });

    // A race goal keeps the week with a quality session and a Sunday long run.
    await app.request("/goal", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "race", distance: "marathon", raceName: "Lakeshore Marathon" }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(app, weekSessionId);

    const replyRes = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId,
        recapMarkdown:
          "## Summary\nExport-backed fixture week. Steady aerobic volume.",
      }),
    });
    expect(replyRes.status).toBe(200);
    const replyBody = await json(replyRes);
    expect(replyBody.prescribed).toBeTruthy();
    // The plan lives on next week's session; the coach message stays in N's thread.
    const planSessionId = (replyBody.prescribed as { weekSessionId: string })
      .weekSessionId;
    expect(planSessionId).not.toBe(weekSessionId);
    expect(replyBody.threadArtifact).toMatchObject({
      kind: "prescribed_week",
      weekSessionId: planSessionId,
    });
    expect(replyBody.coachMessage).toMatchObject({
      role: "coach",
      weekSessionId,
    });

    const getRes = await app.request(`/weeks/${planSessionId}/prescribed`);
    expect(getRes.status).toBe(200);
    const getBody = await json(getRes);
    const prescribed = getBody.prescribed as {
      plan: PrescribedWeek;
      analysis: string;
    };
    expect(prescribed.plan.days).toHaveLength(7);
    const quality = prescribed.plan.days.find((d) => d.dayType === "quality");
    expect(quality?.run?.shoes).toBeTruthy();
    expect(quality?.run?.structure).toBeTruthy();
    expect(quality?.run?.paceOrHr).toBeTruthy();
    expect(
      prescribed.plan.days.some((d) => Boolean(d.strength)),
    ).toBe(true);
    expect(prescribed.plan.days.some((d) => Boolean(d.notes))).toBe(true);

    const threadRes = await app.request(
      `/thread?weekSessionId=${encodeURIComponent(planSessionId)}`,
    );
    expect(threadRes.status).toBe(200);
    const threadBody = await json(threadRes);
    const messages = threadBody.messages as Array<Record<string, unknown>>;
    const artifacts = threadBody.artifacts as Array<{
      kind: string;
      plan: PrescribedWeek;
    }>;

    const reviewedThread = await json(
      await app.request(
        `/thread?weekSessionId=${encodeURIComponent(weekSessionId)}`,
      ),
    );
    expect(
      (reviewedThread.messages as Array<Record<string, unknown>>).some(
        (m) => m.role === "coach",
      ),
    ).toBe(true);
    expect(messages).toBeDefined();
    const prescribedArtifact = artifacts.find((a) => a.kind === "prescribed_week");
    expect(prescribedArtifact).toBeTruthy();
    expect(prescribedArtifact!.plan.days).toHaveLength(7);
    const artifactQuality = prescribedArtifact!.plan.days.find(
      (d) => d.dayType === "quality",
    );
    expect(artifactQuality?.run?.shoes).toBeTruthy();
    expect(artifactQuality?.run?.distanceM).toBeGreaterThan(0);
  });

  it("returns 404 when no prescribed week for session", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const res = await app.request(`/weeks/${week.id}/prescribed`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({
      error: "prescribed_week_not_found",
    });
  });
});
