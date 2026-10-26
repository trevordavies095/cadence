import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { assertPacketHasNoPiiOrGps } from "../src/packet/index.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const W1 = "11111111-1111-4111-8111-111111111111";
const ATHLETE_NAME = "Jordan Athlete";
const ATHLETE_EMAIL = "jordan.athlete@example.com";
const COACHING_NOTE =
  "Chronic left Achilles flare after long downhill — keep easy volume capped.";

describe("last outbound packet transparency (#42)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("GET /settings/last-packet is null before any stub call", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const res = await app.request("/settings/last-packet");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.lastPacket).toBeNull();
  });

  it("stub POST /packet persists summary visible via GET /settings/last-packet", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: `${COACHING_NOTE}\nAthlete identity: ${ATHLETE_NAME} / ${ATHLETE_EMAIL}`,
      }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    await app.request("/thread/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: `Left Achilles still tender. Ping ${ATHLETE_EMAIL}.`,
        weekSessionId: week.id,
      }),
    });

    const assemble = await app.request("/packet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: week.id,
        recapMarkdown: `## Summary\nSolid week for ${ATHLETE_NAME}.`,
        attachmentWorkoutIds: [W1],
        identityHints: {
          names: [ATHLETE_NAME],
          emails: [ATHLETE_EMAIL],
        },
      }),
    });
    expect(assemble.status).toBe(200);
    const assembled = await json(assemble);
    expect(assembled.lastPacket).toBeTruthy();

    const get = await app.request("/settings/last-packet");
    expect(get.status).toBe(200);
    const body = await json(get);
    const last = body.lastPacket as Record<string, unknown>;
    expect(last).toBeTruthy();
    expect(typeof last.savedAt).toBe("string");

    const summary = last.summary as Record<string, unknown>;
    expect(summary.isoWeek).toBeTruthy();
    expect(summary.threadMessageCount).toBe(1);
    expect(summary.attachmentCount).toBe(1);
    expect(summary.hasRecap).toBe(true);
    expect(summary.attachmentWorkoutIds).toEqual([W1]);
    expect(summary.dossierVersionId).toBeTruthy();

    const packet = last.packet as Record<string, unknown>;
    const dossier = packet.dossier as Record<string, unknown>;
    expect(String(dossier.body)).toContain(COACHING_NOTE);
    expect(String(dossier.body)).not.toContain(ATHLETE_NAME);
    expect(String(dossier.body)).not.toContain(ATHLETE_EMAIL);

    const text = JSON.stringify(body);
    expect(text).not.toContain(ATHLETE_NAME);
    expect(text).not.toContain(ATHLETE_EMAIL);
    expect(text).not.toContain("LineString");
    expect(text).not.toContain("SHOULD_NOT_LEAK");
    expect(text).not.toContain("tmp_");
    expect(text).not.toContain("sk-ant-");

    assertPacketHasNoPiiOrGps(packet, {
      identityHints: {
        names: [ATHLETE_NAME],
        emails: [ATHLETE_EMAIL],
      },
      forbiddenSubstrings: [
        ATHLETE_NAME,
        ATHLETE_EMAIL,
        "LineString",
        "SHOULD_NOT_LEAK",
        "rawGpxData",
        "rawFitData",
      ],
    });
  });

  it("disclaimer gates last-packet read", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/settings/last-packet")).status).toBe(403);
  });
});
