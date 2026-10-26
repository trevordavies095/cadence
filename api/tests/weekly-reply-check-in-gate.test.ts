import path from "node:path";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
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

describe("POST /week/reply check-in plan hard-gate (#52)", () => {
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
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, weekSessionId: week.id as string };
  }

  async function requestPlan(
    app: ReturnType<typeof createApp>,
    weekSessionId: string,
  ) {
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId,
        recapMarkdown: "## Summary\nGate fixture week.",
      }),
    });
  }

  it("blocks plan while check-in is still needed", async () => {
    const { app, weekSessionId } = await openWeek();

    const open = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(open.status).toBe("needs_subjective");
    expect(open.checkInStatus).toBe("needed");

    const blocked = await requestPlan(app, weekSessionId);
    expect(blocked.status).toBe(409);
    const body = await json(blocked);
    expect(body.error).toBe("check_in_required");
    expect(body.checkInStatus).toBe("needed");
    expect(body.weekSessionId).toBe(weekSessionId);
    expect(typeof body.message).toBe("string");
    expect(body.message as string).toMatch(/Finish or skip this week/i);
  });

  it("blocked → finish check-in → plan allowed", async () => {
    const { app, weekSessionId } = await openWeek();

    const blocked = await requestPlan(app, weekSessionId);
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe("check_in_required");

    const saveRes = await app.request(
      `/weeks/${weekSessionId}/recap/subjective`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: [{ date: "2026-10-20", rpe: 5, felt: 7 }],
          weekly: { stress_level: "ok" },
        }),
      },
    );
    expect(saveRes.status).toBe(201);
    const again = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(again.checkInStatus).toBe("finished");
    // Finishing starts the reply on its own; let it settle before asking again.
    await waitForReplyRunsIdle();

    const allowed = await requestPlan(app, weekSessionId);
    expect(allowed.status).toBe(200);
    const body = await json(allowed);
    expect(body.reply).toBeTruthy();
  });

  it("blocked → explicit skip → plan allowed", async () => {
    const { app, weekSessionId } = await openWeek();

    const blocked = await requestPlan(app, weekSessionId);
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe("check_in_required");

    const skipRes = await app.request(
      `/weeks/${weekSessionId}/recap?skip_subjective=true`,
    );
    expect(skipRes.status).toBe(200);
    const again = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(again.checkInStatus).toBe("skipped");
    await waitForReplyRunsIdle();

    const allowed = await requestPlan(app, weekSessionId);
    expect(allowed.status).toBe(200);
    const body = await json(allowed);
    expect(body.reply).toBeTruthy();
  });

  it("in-progress subjective (needs_subjective) still blocks plan", async () => {
    const { app, weekSessionId } = await openWeek();

    // Open interview without finishing — no answers, no durable Skip.
    const gate = await json(await app.request(`/weeks/${weekSessionId}/recap`));
    expect(gate.status).toBe("needs_subjective");
    expect(gate.checkInStatus).toBe("needed");

    const blocked = await requestPlan(app, weekSessionId);
    expect(blocked.status).toBe(409);
    const body = await json(blocked);
    expect(body.error).toBe("check_in_required");
    expect(body.checkInStatus).toBe("needed");
  });
});
