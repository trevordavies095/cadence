import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
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

type App = ReturnType<typeof createApp>;

/** Notes used to block the recap, the check-in and the plan. They no longer do (#102). */
describe("coach notes never stand in the way of the week (#102)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function openApp() {
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
      body: JSON.stringify({ body: "# About you\n\nEasy base building." }),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, id: week.id as string };
  }

  /** The two kinds that still wait for a yes. */
  async function leaveWaiting(app: App) {
    for (const kind of ["onboarding", "audit"]) {
      const res = await app.request("/dossier/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          summaryBullets: ["Waiting"],
          proposedBody: `# About you\n\n${kind}`,
        }),
      });
      expect(res.status).toBe(201);
    }
    const pending = (await json(await app.request("/dossier/proposals")))
      .proposals as unknown[];
    expect(pending).toHaveLength(2);
  }

  it("reading the recap is not blocked while a proposal waits", async () => {
    const { app, id } = await openApp();
    await leaveWaiting(app);

    const res = await app.request(`/weeks/${id}/recap`);
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("needs_subjective");
  });

  it("finishing the check-in is not blocked, and starts the coach's reply", async () => {
    const { app, id } = await openApp();
    await leaveWaiting(app);

    const res = await app.request(`/weeks/${id}/recap/subjective`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runs: [{ date: "2026-10-20", rpe: 5 }], weekly: {} }),
    });
    expect(res.status).toBe(201);
    await waitForReplyRunsIdle();
    const run = (await json(await app.request(`/weeks/${id}/reply-run`))).run as {
      status: string;
    };
    expect(run.status).toBe("ok");
  });

  it("skipping the check-in is not blocked", async () => {
    const { app, id } = await openApp();
    await leaveWaiting(app);

    const res = await app.request(`/weeks/${id}/recap?skip_subjective=true`);
    expect(res.status).toBe(200);
    await waitForReplyRunsIdle();
  });

  it("asking for a plan is not blocked, and a note from one reply does not block the next", async () => {
    const { app, id } = await openApp();
    await leaveWaiting(app);
    await unlockPlanCheckIn(app, id);

    for (const summary of ["First.", "Second."]) {
      const res = await app.request("/week/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekSessionId: id,
          recapMarkdown: `## Summary\n${summary}`,
        }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).error).toBeUndefined();
    }
  });

  it("mid-week chat is not blocked while a proposal waits", async () => {
    const { app, id } = await openApp();
    await leaveWaiting(app);

    const res = await app.request(`/weeks/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Felt good today." }),
    });
    expect(res.status).toBe(201);
  });
});
