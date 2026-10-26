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
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const SUN = "2026-10-25T15:00:00.000Z";

describe("what was last sent to the coach (#114)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });
  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function ready() {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(SUN)),
      athleteTimezone: "America/New_York",
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_last_sent_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-last-sent-key" }],
    ] as const) {
      await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# About you\n\nEasy base building." }),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    return { app, id: week.id as string };
  }

  it("is empty before the coach has been sent anything", async () => {
    const { app } = await ready();
    expect(await json(await app.request("/settings/last-packet"))).toEqual({ lastPacket: null });
  });

  it("remembers the message behind a chat reply", async () => {
    const { app, id } = await ready();
    const res = await app.request(`/weeks/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Easy week ahead, nothing to report." }),
    });
    expect(res.status).toBe(201);

    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket.summary).toMatchObject({
      isoWeek: "2026-W43",
      weekSessionId: id,
      threadMessageCount: 1,
    });
    expect(lastPacket.summary.dossierVersionId).not.toBeNull();
    expect(lastPacket.packet.thread[0].body).toContain("nothing to report");
  });

  it("a later message replaces the earlier one", async () => {
    const { app, id } = await ready();
    for (const body of ["First message.", "Second message."]) {
      await app.request(`/weeks/${id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
    }
    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket.summary.threadMessageCount).toBeGreaterThanOrEqual(3);
    const bodies = (lastPacket.packet.thread as Array<{ body: string }>).map((m) => m.body);
    expect(bodies.some((b) => b.includes("Second message."))).toBe(true);
  });

  it("remembers the message behind the coach's read of a week", async () => {
    const { app, id } = await ready();
    const res = await app.request(`/weeks/${id}/recap?skip_subjective=true`);
    expect(res.status).toBe(200);
    // The read runs in the background after the check-in is skipped.
    await waitForReplyRunsIdle();

    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket).not.toBeNull();
    expect(lastPacket.summary.weekSessionId).toBe(id);
    expect(lastPacket.summary.hasRecap).toBe(true);
  });
});
