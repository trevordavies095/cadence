/**
 * The plan the week was meant to follow goes into the Sunday packet
 * (coaching-quality 01, #59): the reviewed week's stored plan beside a per-day
 * outcome list from the helper Home uses, the prompt line that names them,
 * the Privacy summary, and the stub's reply unchanged by any of it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { weeklyUserPromptFor } from "../src/llm/anthropic.js";
import { createStubLlmPort, type LlmPort } from "../src/llm/index.js";
import type { PrescribedWeek } from "../src/llm/types.js";
import { migrate } from "../src/migrate.js";
import type { ModelPacket } from "../src/packet/types.js";
import { planDayOutcomes } from "../src/prescribed/dayOutcomes.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoPort } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

// The fixture has runs on Tue Oct 20 and Thu Oct 22 (08:00 in New York).
const SUN = "2026-10-25T23:00:00.000Z";
const DATES = [
  "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22",
  "2026-10-23", "2026-10-24", "2026-10-25",
];

/** The reviewed week's plan: a run on Mon, Tue, Thu, Sat and Sun; Sat's line could not be read. */
const WEEK_PLAN: PrescribedWeek = {
  week: "2026-W43",
  days: [
    { date: "2026-10-19", dayType: "easy", run: { type: "easy", distanceM: 8000 } },
    { date: "2026-10-20", dayType: "easy", run: { type: "easy", distanceM: 6000 } },
    { date: "2026-10-21", dayType: "rest", run: null },
    { date: "2026-10-22", dayType: "quality", run: { type: "quality", distanceM: 10000 } },
    { date: "2026-10-23", dayType: "rest", run: null },
    { date: "2026-10-24", dayType: "other", run: null, line: "Sat 2026-10-24: whatever you fancy", parsed: false },
    { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 16000 }, notes: "Flat." },
  ],
};

describe("the per-day outcome helper", () => {
  it("grades a finished week: done where something was run, missed where a run was planned, rest otherwise", () => {
    const actual = new Map([["2026-10-20", 9700], ["2026-10-22", 11200]]);
    const outcomes = planDayOutcomes({
      dates: DATES,
      days: WEEK_PLAN.days,
      actualDistanceByDate: actual,
      todayYmd: "2026-10-26",
    });
    expect(outcomes.map((d) => d.state)).toEqual([
      "missed", "done", "rest", "done", "rest", "not_filed", "missed",
    ]);
    expect(outcomes[1]).toMatchObject({ actualDistanceM: 9700, plannedDistanceM: 6000, parsed: true });
    expect(outcomes[5]).toMatchObject({ parsed: false, plannedDistanceM: null, actualDistanceM: 0 });
    expect(outcomes.every((d) => !d.isToday)).toBe(true);
  });

  it("with the running log unreadable, a planned run is unknown and no distance is claimed", () => {
    const outcomes = planDayOutcomes({
      dates: DATES,
      days: WEEK_PLAN.days,
      actualDistanceByDate: null,
      todayYmd: "2026-10-26",
    });
    expect(outcomes.map((d) => d.state)).toEqual([
      "unknown", "unknown", "rest", "unknown", "rest", "not_filed", "unknown",
    ]);
    expect(outcomes.every((d) => d.actualDistanceM === null)).toBe(true);
  });

  it("with no plan, a past day with a run is done and the rest are rest", () => {
    const outcomes = planDayOutcomes({
      dates: DATES,
      days: null,
      actualDistanceByDate: new Map([["2026-10-22", 5000]]),
      todayYmd: "2026-10-26",
    });
    expect(outcomes.map((d) => d.state)).toEqual([
      "rest", "rest", "rest", "done", "rest", "rest", "rest",
    ]);
    expect(outcomes.every((d) => d.planned === null)).toBe(true);
  });
});

describe("the plan in the Sunday packet (#59)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  /** The stub, keeping every packet the weekly read and the conversation send. */
  function capturing(sent: { weekly: ModelPacket[]; midWeek: ModelPacket[] }): LlmPort {
    const stub = createStubLlmPort();
    return {
      ...stub,
      generateWeeklyReply: (packet, options) => {
        sent.weekly.push(structuredClone(packet));
        return stub.generateWeeklyReply(packet, options);
      },
      generateMidWeekChatReply: (packet, options) => {
        sent.midWeek.push(structuredClone(packet));
        return stub.generateMidWeekChatReply(packet, options);
      },
    };
  }

  async function ready(options: { plan?: boolean; tempoPort?: TempoPort } = {}) {
    await acceptAndReady();
    const sent = { weekly: [] as ModelPacket[], midWeek: [] as ModelPacket[] };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(SUN)),
      athleteTimezone: "America/New_York",
      tempoPort: options.tempoPort ?? createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: capturing(sent),
    });
    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# About you\n\nEasy base building." }),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    if (options.plan !== false) {
      await savePrescribedWeek({
        at: new Date(SUN),
        weekSessionId,
        plan: WEEK_PLAN,
        analysis: "The plan the week was meant to follow.",
      });
    }
    await unlockPlanCheckIn(app, weekSessionId);
    return { app, weekSessionId, sent };
  }

  async function read(app: ReturnType<typeof createApp>, weekSessionId: string) {
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId,
        recapMarkdown: "## Summary\nExport-backed fixture week. Steady aerobic volume.",
      }),
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  it("carries the reviewed week's stored plan and what happened on each of its days", async () => {
    const { app, weekSessionId, sent } = await ready();
    await read(app, weekSessionId);

    expect(sent.weekly).toHaveLength(1);
    const packet = sent.weekly[0]!;
    expect(packet.week?.isoWeek).toBe("2026-W43");
    expect(packet.planWeek?.isoWeek).toBe("2026-W44");
    // The plan as stored, byte for byte: it is the coach's own.
    expect(packet.prescribedWeek).toEqual(WEEK_PLAN);

    const outcomes = packet.prescribedWeekOutcomes!;
    expect(outcomes.map((d) => d.date)).toEqual(DATES);
    expect(outcomes.map((d) => d.state)).toEqual([
      "missed", "done", "rest", "done", "rest", "not_filed", "missed",
    ]);
    expect(outcomes[1]!.actualDistanceM).toBeGreaterThan(0);
    expect(outcomes[3]!.actualDistanceM).toBeGreaterThan(0);
    expect(outcomes[0]!.actualDistanceM).toBe(0);
    // Beside the plan, never inside it.
    for (const day of packet.prescribedWeek!.days) expect(day).not.toHaveProperty("state");
  });

  it("carries null for both when the week had no stored plan", async () => {
    const { app, weekSessionId, sent } = await ready({ plan: false });
    await read(app, weekSessionId);
    const packet = sent.weekly[0]!;
    expect(packet).toHaveProperty("prescribedWeek", null);
    expect(packet).toHaveProperty("prescribedWeekOutcomes", null);
  });

  it("marks planned days unknown when the running log cannot be read, and still reads the week", async () => {
    const port = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const failing: TempoPort = {
      ...port,
      listWorkouts: async () => {
        throw new Error("running log down");
      },
    };
    const { app, weekSessionId, sent } = await ready({ tempoPort: failing });
    await read(app, weekSessionId);
    const outcomes = sent.weekly[0]!.prescribedWeekOutcomes!;
    expect(outcomes.map((d) => d.state)).toEqual([
      "unknown", "unknown", "rest", "unknown", "rest", "not_filed", "unknown",
    ]);
    expect(outcomes.every((d) => d.actualDistanceM === null)).toBe(true);
  });

  it("the weekly prompt names the field and asks for the week against it, before the packet", async () => {
    const { app, weekSessionId, sent } = await ready();
    await read(app, weekSessionId);
    const prompt = weeklyUserPromptFor(sent.weekly[0]!);
    const lines = prompt.split("\n");
    const at = lines.findIndex((l) => l.includes("the plan the reviewed week was meant to follow"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at]).toContain("prescribedWeekOutcomes");
    expect(lines[at]).toMatch(/followed.*skipped.*overrun/);
    expect(lines[at + 1]).toBe("Model packet (redacted; no identity PII or GPS):");
  });

  it("the weekly prompt says nothing about a plan when none was stored", async () => {
    const { app, weekSessionId, sent } = await ready({ plan: false });
    await read(app, weekSessionId);
    expect(weeklyUserPromptFor(sent.weekly[0]!)).not.toContain("meant to follow");
  });

  it("the stub's reply to a Sunday read is unchanged by the plan and its outcomes", async () => {
    const { app, weekSessionId, sent } = await ready();
    await read(app, weekSessionId);
    const stub = createStubLlmPort();
    const withPlan = sent.weekly[0]!;
    const { prescribedWeek: _plan, prescribedWeekOutcomes: _outcomes, ...withoutPlan } = withPlan;
    expect(withPlan.prescribedWeek).not.toBeNull();
    const a = await stub.generateWeeklyReply(withPlan);
    const b = await stub.generateWeeklyReply(withoutPlan as ModelPacket);
    expect(a).toEqual(b);
  });

  it("the Privacy summary says the plan went along", async () => {
    const { app, weekSessionId } = await ready();
    await read(app, weekSessionId);
    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket.summary.hasPlan).toBe(true);
    expect(lastPacket.packet.prescribedWeek).toEqual(WEEK_PLAN);
    expect(lastPacket.packet.prescribedWeekOutcomes).toHaveLength(7);
  });

  it("the Privacy summary says nothing of a plan when none was stored", async () => {
    const { app, weekSessionId } = await ready({ plan: false });
    await read(app, weekSessionId);
    const { lastPacket } = await json(await app.request("/settings/last-packet"));
    expect(lastPacket.summary.hasPlan).toBe(false);
  });

  it("the mid-week packet keeps the plan alone, with no outcomes", async () => {
    const { app, weekSessionId, sent } = await ready();
    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Legs heavy today." }),
    });
    expect(res.status).toBe(201);
    expect(sent.midWeek).toHaveLength(1);
    const packet = sent.midWeek[0]!;
    expect(packet.prescribedWeek).toEqual(WEEK_PLAN);
    expect(packet).not.toHaveProperty("prescribedWeekOutcomes");
  });
});
