import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { createStubLlmPort, type LlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import type { ModelPacket } from "../src/packet/types.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { weeklyReadMessageBody } from "../src/thread/weeklyRead.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

type Message = {
  role: string;
  kind: string;
  body: string;
  readLink?: string;
  weekSessionId: string;
};

describe("weeklyReadMessageBody", () => {
  it("keeps the first paragraph and drops the headings", () => {
    const read =
      "## Headline\nBig week. Pull back a little.\n\nSo this week: 37 miles.\n\n## Flags\n- Sleep";
    expect(weeklyReadMessageBody(read)).toBe("Big week. Pull back a little.");
  });

  it("returns a read with no headings and no blank lines whole", () => {
    expect(weeklyReadMessageBody("One line only.")).toBe("One line only.");
  });
});

describe("the Sunday message in the conversation", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  function appAt(iso: string, llmPort: LlmPort = createStubLlmPort()) {
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(iso)),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort,
    });
  }

  async function readTheWeek(app: ReturnType<typeof appAt>) {
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(app, weekSessionId);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId,
        recapMarkdown: "## Summary\nExport-backed fixture week. Steady aerobic volume.",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const planSessionId = (body.prescribed as { weekSessionId: string }).weekSessionId;
    return { weekSessionId, planSessionId };
  }

  async function thread(app: ReturnType<typeof appAt>, weekSessionId: string) {
    const res = await app.request(`/thread?weekSessionId=${encodeURIComponent(weekSessionId)}`);
    return (await json(res)).messages as Message[];
  }

  it("posts one paragraph, not the full read, and links to the plan", async () => {
    const app = appAt("2026-10-21T15:00:00.000Z");
    const { weekSessionId, planSessionId } = await readTheWeek(app);

    const prescribed = await json(await app.request(`/weeks/${planSessionId}/prescribed`));
    const analysis = (prescribed.prescribed as { analysis: string }).analysis;

    const coach = (await thread(app, weekSessionId)).filter((m) => m.role === "coach");
    expect(coach).toHaveLength(1);
    expect(coach[0]!.kind).toBe("weekly_read");
    expect(coach[0]!.body).toBe(weeklyReadMessageBody(analysis));
    expect(coach[0]!.body).not.toMatch(/\n\s*\n/);
    expect(coach[0]!.body).not.toMatch(/^#/m);
    expect(coach[0]!.body.length).toBeLessThan(analysis.length);
    expect(coach[0]!.readLink).toBe("plan");
  });

  it("links to that week's Your week page once the planned week is over", async () => {
    const { weekSessionId } = await readTheWeek(appAt("2026-10-21T15:00:00.000Z"));
    const later = appAt("2026-11-10T15:00:00.000Z");
    const coach = (await thread(later, weekSessionId)).find((m) => m.kind === "weekly_read");
    expect(coach?.readLink).toBe("week");
  });

  it("leaves ordinary messages as chat with no link", async () => {
    const app = appAt("2026-10-21T15:00:00.000Z");
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await app.request("/thread/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Legs heavy today.", weekSessionId: week.id }),
    });
    const [message] = await thread(app, week.id as string);
    expect(message!.kind).toBe("chat");
    expect(message!.readLink).toBeUndefined();
  });

  it("hands Coach Cade the full read behind the Sunday message", async () => {
    const stub = createStubLlmPort();
    const packets: ModelPacket[] = [];
    const llmPort: LlmPort = {
      ...stub,
      generateMidWeekChatReply: (packet, options) => {
        packets.push(packet);
        return stub.generateMidWeekChatReply(packet, options);
      },
    };
    const app = appAt("2026-10-21T15:00:00.000Z", llmPort);
    const { weekSessionId, planSessionId } = await readTheWeek(app);
    const prescribed = await json(await app.request(`/weeks/${planSessionId}/prescribed`));
    const analysis = (prescribed.prescribed as { analysis: string }).analysis;

    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Why is Thursday shorter?" }),
    });
    expect(res.status).toBe(201);

    const coachTurns = packets[0]!.thread!.filter((m) => m.role === "coach");
    expect(coachTurns.map((m) => m.body)).toContain(analysis.trim());
  });
});
