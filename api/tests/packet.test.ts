import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  assertPacketHasNoPiiOrGps,
  buildModelPacket,
  packetToJson,
} from "../src/packet/index.js";
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

describe("buildModelPacket redaction", () => {
  it("produces structured LLM context and keeps coaching notes", () => {
    const packet = buildModelPacket({
      dossier: {
        versionId: 3,
        body: `${COACHING_NOTE}\nContact: ${ATHLETE_NAME} <${ATHLETE_EMAIL}>`,
      },
      recapMarkdown: `# Week summary\nAthlete ${ATHLETE_NAME} ran 42 mi.`,
      thread: [
        {
          role: "athlete",
          body: `Felt good. Email me at ${ATHLETE_EMAIL} if needed.`,
          createdAt: "2026-10-20T12:00:00.000Z",
        },
      ],
      attachments: [
        {
          id: W1,
          startedAt: "2026-10-19T14:00:00.000Z",
          durationS: 3600,
          distanceM: 10000,
          avgPaceS: 360,
          name: "Easy 10k",
          notes: "Steady effort",
          avgHeartRateBpm: 140,
          hasRoute: true,
          email: ATHLETE_EMAIL,
          athleteName: ATHLETE_NAME,
          route: {
            type: "LineString",
            coordinates: [
              [-77.6, 43.1],
              [-77.61, 43.11],
            ],
          },
          rawGpxData: { should: "never leak" },
          polyline: "ENCODED_POLYLINE_LEAK",
          splits: [
            {
              idx: 0,
              distanceM: 1609,
              durationS: 540,
              paceS: 335,
              avgHeartRateBpm: 138,
            },
          ],
        },
      ],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
        weekSessionId: "00000000-0000-4000-8000-000000000001",
      },
      identityHints: {
        names: [ATHLETE_NAME],
        emails: [ATHLETE_EMAIL],
      },
    });

    expect(packet.dossier).not.toBeNull();
    expect(packet.dossier!.versionId).toBe(3);
    expect(packet.dossier!.body).toContain(COACHING_NOTE);
    expect(packet.dossier!.body).not.toContain(ATHLETE_NAME);
    expect(packet.dossier!.body).not.toContain(ATHLETE_EMAIL);
    expect(packet.dossier!.body).toContain("[redacted]");

    expect(packet.recapMarkdown).toContain("Week summary");
    expect(packet.recapMarkdown).not.toContain(ATHLETE_NAME);

    expect(packet.thread).toHaveLength(1);
    expect(packet.thread[0]!.body).toContain("Felt good");
    expect(packet.thread[0]!.body).not.toContain(ATHLETE_EMAIL);

    expect(packet.attachments).toHaveLength(1);
    const att = packet.attachments[0]!;
    expect(att.workoutId).toBe(W1);
    expect(att.activityName).toBe("Easy 10k");
    expect(att.avgHeartRateBpm).toBe(140);
    expect(att.hasRoute).toBe(true);
    expect(att.splits).toHaveLength(1);
    expect(att).not.toHaveProperty("route");
    expect(att).not.toHaveProperty("email");
    expect(att).not.toHaveProperty("athleteName");
    expect(att).not.toHaveProperty("polyline");
    expect(att).not.toHaveProperty("rawGpxData");
    expect(att).not.toHaveProperty("name");

    expect(packet.week?.isoWeek).toBe("2026-W43");
    expect(packet.recentHistory).toEqual([]);
    expect(packet.recentHistoryLimit).toBe(4);

    const jsonText = packetToJson(packet);
    expect(jsonText).not.toContain(ATHLETE_NAME);
    expect(jsonText).not.toContain(ATHLETE_EMAIL);
    expect(jsonText).not.toContain("LineString");
    expect(jsonText).not.toContain("ENCODED_POLYLINE_LEAK");
    expect(jsonText).not.toContain("never leak");
    expect(jsonText).not.toContain("-77.6");
    expect(jsonText).toContain(COACHING_NOTE);

    expect(() =>
      assertPacketHasNoPiiOrGps(packet, {
        identityHints: {
          names: [ATHLETE_NAME],
          emails: [ATHLETE_EMAIL],
        },
        forbiddenSubstrings: [
          ATHLETE_NAME,
          ATHLETE_EMAIL,
          "LineString",
          "ENCODED_POLYLINE_LEAK",
          "rawGpxData",
        ],
      }),
    ).not.toThrow();
  });

  it("assert fails when PII or GPS leak into packet JSON", () => {
    const leaky = {
      dossier: { versionId: 1, body: COACHING_NOTE },
      recapMarkdown: null,
      thread: [],
      attachments: [
        {
          workoutId: W1,
          startedAt: "2026-10-19T14:00:00.000Z",
          durationS: 3600,
          distanceM: 10000,
          avgPaceS: 360,
          email: ATHLETE_EMAIL,
          route: { type: "LineString", coordinates: [[-77.6, 43.1]] },
        },
      ],
      week: null,
    };

    expect(() =>
      assertPacketHasNoPiiOrGps(leaky, {
        forbiddenSubstrings: [ATHLETE_EMAIL],
      }),
    ).toThrow(/pii_key_leaked:email|gps_key_leaked:route/);

    const withEmailInText = {
      dossier: {
        versionId: 1,
        body: `Reach me at ${ATHLETE_EMAIL}`,
      },
      recapMarkdown: null,
      thread: [],
      attachments: [],
      week: null,
    };
    expect(() => assertPacketHasNoPiiOrGps(withEmailInText)).toThrow(
      /pii_leaked:email_pattern/,
    );

    const withGpsText = {
      dossier: { versionId: 1, body: COACHING_NOTE },
      recapMarkdown: 'coords [[-77.6, 43.1]]',
      thread: [],
      attachments: [],
      week: null,
    };
    expect(() => assertPacketHasNoPiiOrGps(withGpsText)).toThrow(
      /gps_leaked:residual_coordinates/,
    );
  });
});

describe("POST /packet week-loop seam (export TempoPort)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("assembles redacted packet from dossier + thread + export attachment", async () => {
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

    const res = await app.request("/packet", {
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
    expect(res.status).toBe(200);
    const body = await json(res);
    const packet = body.packet as Record<string, unknown>;

    expect(packet).toBeTruthy();
    const dossier = packet.dossier as Record<string, unknown>;
    expect(String(dossier.body)).toContain(COACHING_NOTE);
    expect(String(dossier.body)).not.toContain(ATHLETE_NAME);
    expect(String(dossier.body)).not.toContain(ATHLETE_EMAIL);

    const thread = packet.thread as Array<Record<string, unknown>>;
    expect(thread).toHaveLength(1);
    expect(String(thread[0]!.body)).toContain("Achilles");
    expect(String(thread[0]!.body)).not.toContain(ATHLETE_EMAIL);

    const attachments = packet.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.workoutId).toBe(W1);
    expect(attachments[0]!.distanceM).toBe(10000);
    expect(attachments[0]!.hasRoute).toBe(true);
    expect(attachments[0]).not.toHaveProperty("route");
    expect(attachments[0]).not.toHaveProperty("rawGpxData");
    expect(packet.recentHistory).toEqual([]);
    expect(packet.recentHistoryLimit).toBe(4);

    const text = JSON.stringify(body);
    expect(text).not.toContain(ATHLETE_NAME);
    expect(text).not.toContain(ATHLETE_EMAIL);
    expect(text).not.toContain("LineString");
    expect(text).not.toContain("SHOULD_NOT_LEAK");
    expect(text).toContain(COACHING_NOTE);

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

  it("disclaimer gates packet assembly", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/packet", { method: "POST" })).status).toBe(
      403,
    );
  });
});
