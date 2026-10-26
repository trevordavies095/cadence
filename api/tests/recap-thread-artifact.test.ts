import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { getWeekRecapBySessionId } from "../src/recap/recapStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

describe("weekly recap thread artifact (#25)", () => {
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
    expect([200, 201]).toContain(weekRes.status);
    const week = await json(weekRes);
    return { app, weekSessionId: week.id as string };
  }

  it("successful generate posts weekly_recap artifact on the week thread", async () => {
    const { app, weekSessionId } = await openWeek();

    const before = await json(
      await app.request(
        `/thread?weekSessionId=${encodeURIComponent(weekSessionId)}`,
      ),
    );
    expect(before.artifacts).toEqual([]);

    const res = await app.request(
      `/weeks/${weekSessionId}/recap?skip_subjective=true`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("report");
    expect(body.threadArtifact).toMatchObject({
      kind: "weekly_recap",
      weekSessionId,
      subjective: "skipped",
    });
    expect(typeof (body.threadArtifact as { markdown: string }).markdown).toBe(
      "string",
    );
    expect(
      (body.threadArtifact as { markdown: string }).markdown,
    ).toMatch(/Weekly Recap/i);

    const threadRes = await app.request(
      `/thread?weekSessionId=${encodeURIComponent(weekSessionId)}`,
    );
    expect(threadRes.status).toBe(200);
    const threadBody = await json(threadRes);
    const artifacts = threadBody.artifacts as Array<{
      kind: string;
      weekSessionId: string;
      markdown: string;
      subjective: string;
    }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "weekly_recap",
      weekSessionId,
      subjective: "skipped",
    });
    expect(artifacts[0]!.markdown).toContain("Weekly Recap");
    expect(artifacts[0]!.markdown.length).toBeGreaterThan(40);
  });

  it("regenerating replaces the artifact (no unbounded duplicates)", async () => {
    const { app, weekSessionId } = await openWeek();

    const firstRes = await app.request(
      `/weeks/${weekSessionId}/recap?skip_subjective=true`,
    );
    expect(firstRes.status).toBe(200);
    const first = await json(firstRes);
    const firstArtifact = first.threadArtifact as {
      createdAt: string;
      updatedAt: string;
      markdown: string;
    };

    // Ensure updated_at can move forward on replace.
    await new Promise((r) => setTimeout(r, 20));

    const secondRes = await app.request(
      `/weeks/${weekSessionId}/recap?skip_subjective=true`,
    );
    expect(secondRes.status).toBe(200);
    const second = await json(secondRes);
    const secondArtifact = second.threadArtifact as {
      createdAt: string;
      updatedAt: string;
      markdown: string;
    };

    expect(secondArtifact.createdAt).toBe(firstArtifact.createdAt);
    expect(
      new Date(secondArtifact.updatedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(firstArtifact.updatedAt).getTime());
    expect(secondArtifact.markdown).toMatch(/Weekly Recap/i);

    const threadBody = await json(
      await app.request(
        `/thread?weekSessionId=${encodeURIComponent(weekSessionId)}`,
      ),
    );
    const artifacts = threadBody.artifacts as unknown[];
    expect(artifacts).toHaveLength(1);

    const stored = await getWeekRecapBySessionId(weekSessionId);
    expect(stored).not.toBeNull();
    expect(stored!.subjective).toBe("skipped");
  });

  it("subjective save → full report posts artifact with subjective present", async () => {
    const { app, weekSessionId } = await openWeek();

    const gate = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(gate.status).toBe("needs_subjective");
    expect(gate.threadArtifact).toBeUndefined();

    const saveRes = await app.request(
      `/weeks/${weekSessionId}/recap/subjective`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: [{ date: "2026-10-20", rpe: 4, felt: 8 }],
          weekly: { stress_level: "low", questions_for_coach: ["Volume?"] },
        }),
      },
    );
    expect(saveRes.status).toBe(201);
    const saved = await json(saveRes);
    expect(saved.threadArtifact).toMatchObject({
      kind: "weekly_recap",
      weekSessionId,
      subjective: "present",
    });
    expect(
      (saved.threadArtifact as { markdown: string }).markdown,
    ).toContain("## Subjective recap");

    const nested = saved.gate as {
      status: string;
      threadArtifact?: { kind: string };
    };
    expect(nested.status).toBe("report");
    expect(nested.threadArtifact?.kind).toBe("weekly_recap");

    const threadBody = await json(
      await app.request(
        `/thread?weekSessionId=${encodeURIComponent(weekSessionId)}`,
      ),
    );
    const artifacts = threadBody.artifacts as Array<{ kind: string }>;
    expect(artifacts.filter((a) => a.kind === "weekly_recap")).toHaveLength(1);
  });
});
