import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  createStubLlmPort,
  expectedPlanDates,
  MIDWEEK_SYSTEM_PROMPT,
  type PrescribedDay,
  type PrescribedWeek,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/** Week of Oct 19 – 25 with quality on Thursday Oct 22. */
function plan(): PrescribedWeek {
  return {
    week: "2026-W43",
    days: expectedPlanDates("2026-10-19").map((date, i) =>
      i === 3
        ? {
            date,
            dayType: "quality" as const,
            run: { type: "quality" as const, distanceM: 12000, structure: "threshold reps" },
          }
        : { date, dayType: "easy" as const, run: { type: "easy" as const, distanceM: 8000 } },
    ),
  };
}

type Message = { role: string; planChanges: PrescribedDay[] | null };

describe("a reply that changes days carries them as a card", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function setup(nowIso: string) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(nowIso)),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    await savePrescribedWeek({ at: new Date(nowIso), weekSessionId, plan: plan(), analysis: "Seeded." });
    const send = async (body: string) => {
      const res = await app.request(`/weeks/${weekSessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(201);
      return (await json(res)).coachMessage as Message;
    };
    const coachMessages = async () =>
      ((await json(await app.request(`/thread?weekSessionId=${weekSessionId}`))).messages as Message[]).filter(
        (m) => m.role === "coach",
      );
    return { weekSessionId, send, coachMessages };
  }

  it("stores the days it changed, as they were changed", async () => {
    const { send, coachMessages } = await setup("2026-10-21T15:00:00.000Z");
    const reply = await send("Legs are heavy, can we cut Thursday?");
    expect(reply.planChanges).toHaveLength(1);
    expect(reply.planChanges![0]).toMatchObject({ date: "2026-10-22", dayType: "rest" });
    const [listed] = await coachMessages();
    expect(listed!.planChanges).toEqual(reply.planChanges);
  });

  it("stores nothing for a reply that changes no days", async () => {
    const { send } = await setup("2026-10-21T15:00:00.000Z");
    expect((await send("How is my week going?")).planChanges).toBeNull();
  });

  it("leaves out a day it asked to change but could not, because it was past", async () => {
    // Friday: Thursday is past, so the stub's patch is skipped.
    const { send } = await setup("2026-10-23T15:00:00.000Z");
    expect((await send("Can we cut Thursday?")).planChanges).toBeNull();
  });

  it("keeps an old card as it was when the plan changes again", async () => {
    const { weekSessionId, send, coachMessages } = await setup("2026-10-21T15:00:00.000Z");
    const first = await send("Can we cut Thursday?");
    const later = plan();
    later.days[3] = { date: "2026-10-22", dayType: "easy", run: { type: "easy", distanceM: 5000 }, notes: "Changed again." };
    await savePrescribedWeek({ at: new Date(), weekSessionId, plan: later, analysis: "Seeded." });
    const [listed] = await coachMessages();
    expect(listed!.planChanges).toEqual(first.planChanges);
  });

  it("tells Coach Cade the cards carry the details, so the reply gives only the reason", () => {
    expect(MIDWEEK_SYSTEM_PROMPT).toMatch(/sees each changed day as a card/);
    expect(MIDWEEK_SYSTEM_PROMPT).toMatch(/say only why you changed the week/);
  });
});
