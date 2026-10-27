import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  buildStubMidWeekChatReply,
  buildStubPrescribedDayPatches,
  createStubLlmPort,
  expectedPlanDates,
  type LlmPort,
  type MidWeekChatReply,
  type PrescribedDay,
  type PrescribedWeek,
  validateMidWeekChatReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
import {
  applyPrescribedDayPatches,
  isPrescribedDayPatchable,
} from "../src/prescribed/patch.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
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

const WEEK_START = "2026-10-19";
const DATES = expectedPlanDates(WEEK_START);

function samplePlan(): PrescribedWeek {
  return {
    week: "2026-W43",
    days: DATES.map((date, i) => {
      if (i === 1 || i === 4) {
        return { date, dayType: "rest" as const, run: null };
      }
      if (i === 3) {
        return {
          date,
          dayType: "quality" as const,
          run: {
            type: "quality" as const,
            distanceM: 12000,
            structure: "threshold reps",
            paceOrHr: "threshold",
            shoes: "race flat",
          },
        };
      }
      if (i === 6) {
        return {
          date,
          dayType: "long" as const,
          run: {
            type: "long" as const,
            distanceM: 18000,
            paceOrHr: "easy–steady",
            shoes: "cushioned",
          },
        };
      }
      return {
        date,
        dayType: "easy" as const,
        run: {
          type: "easy" as const,
          distanceM: 8000,
          paceOrHr: "easy",
          shoes: "trainer",
        },
      };
    }),
  };
}

describe("prescribed day patch rule (#38)", () => {
  it("marks only today and future as patchable by default", () => {
    expect(isPrescribedDayPatchable("2026-10-20", "2026-10-21")).toBe(false);
    expect(isPrescribedDayPatchable("2026-10-21", "2026-10-21")).toBe(true);
    expect(isPrescribedDayPatchable("2026-10-22", "2026-10-21")).toBe(true);
    expect(
      isPrescribedDayPatchable("2026-10-20", "2026-10-21", true),
    ).toBe(true);
  });

  it("applies future patches and keeps past days stable", () => {
    const plan = samplePlan();
    const monday = plan.days[0]!;
    const thursday = plan.days[3]!;
    const patches: PrescribedDay[] = [
      {
        date: monday.date,
        dayType: "rest",
        run: null,
        notes: "should not apply",
      },
      {
        date: thursday.date,
        dayType: "rest",
        run: null,
        notes: "cut quality",
      },
    ];
    const result = applyPrescribedDayPatches(plan, patches, {
      todayYmd: "2026-10-21",
    });
    expect(result.skippedPastDates).toEqual([monday.date]);
    expect(result.appliedDates).toEqual([thursday.date]);
    expect(result.plan.days[0]).toEqual(monday);
    expect(result.plan.days[3]!.dayType).toBe("rest");
    expect(result.plan.days[3]!.notes).toBe("cut quality");
    expect(result.plan.days[6]!.dayType).toBe("long");
  });

  it("applies past patches only when allowPastDayPatches is true", () => {
    const plan = samplePlan();
    const monday = plan.days[0]!;
    const result = applyPrescribedDayPatches(
      plan,
      [
        {
          date: monday.date,
          dayType: "rest",
          run: null,
          notes: "explicit past rewrite",
        },
      ],
      { todayYmd: "2026-10-21", allowPastDayPatches: true },
    );
    expect(result.appliedDates).toEqual([monday.date]);
    expect(result.plan.days[0]!.notes).toBe("explicit past rewrite");
  });
});

describe("stub prescribed day patches (#38)", () => {
  it("returns a remaining-day patch when athlete asks to cut the plan", () => {
    const plan = samplePlan();
    const packet = buildModelPacket({
      dossier: null,
      recapMarkdown: null,
      thread: [
        {
          role: "athlete",
          body: "Felt heavy — please cut Thursday quality.",
        },
      ],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
      },
      prescribedWeek: plan,
    });
    const patches = buildStubPrescribedDayPatches(packet);
    expect(patches).toHaveLength(1);
    expect(patches![0]!.date).toBe(DATES[3]);
    expect(patches![0]!.dayType).toBe("rest");

    const reply = buildStubMidWeekChatReply(packet);
    expect(reply.prescribedDayPatches).toEqual(patches);
    expect(reply.body).toContain("Updated the plan");
    const validated = validateMidWeekChatReply(reply, WEEK_START);
    expect(validated.ok).toBe(true);
  });

  it("omits patches when there is no plan-change intent", () => {
    const packet = buildModelPacket({
      dossier: null,
      recapMarkdown: null,
      thread: [{ role: "athlete", body: "Feeling fine today." }],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
      },
      prescribedWeek: samplePlan(),
    });
    expect(buildStubPrescribedDayPatches(packet)).toBeUndefined();
  });
});

// The weekly reply now plans NEXT week, so mid-week tests seed the current
// week's plan directly.
async function seedCurrentWeekPlan(weekSessionId: string): Promise<void> {
  await savePrescribedWeek({
    at: new Date(),
    weekSessionId,
    plan: samplePlan(),
    analysis: "Seeded current-week plan.",
    settingsProposalBullets: null,
    safetyCallouts: null,
  });
}

describe("mid-week chat prescribed patch API (#38)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    delete process.env.LLM_PROVIDER;
  });

  it("stub returns patch → remaining days updated; past days stable", async () => {
    await acceptAndReady();
    const clock = new FixedClock(new Date("2026-10-21T15:00:00.000Z"));
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(app, weekSessionId);

    await seedCurrentWeekPlan(weekSessionId);
    const before = await json(
      await app.request(`/weeks/${weekSessionId}/prescribed`),
    );
    const beforePlan = (before.prescribed as { plan: PrescribedWeek }).plan;
    const mondayBefore = beforePlan.days[0]!;
    const thursdayBefore = beforePlan.days[3]!;
    expect(thursdayBefore.dayType).toBe("quality");

    const chatRes = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Felt heavy — please cut Thursday quality.",
      }),
    });
    expect(chatRes.status).toBe(201);
    const chatBody = await json(chatRes);
    expect(String((chatBody.coachMessage as { body: string }).body)).toContain(
      "Updated the plan",
    );
    const patched = chatBody.prescribed as { plan: PrescribedWeek };
    expect(patched).toBeTruthy();
    expect(patched.plan.days[3]!.dayType).toBe("rest");
    expect(patched.plan.days[3]!.notes).toMatch(/Changed this week/i);
    expect(patched.plan.days[0]).toEqual(mondayBefore);
    expect(chatBody.threadArtifact).toMatchObject({
      kind: "prescribed_week",
      weekSessionId,
    });

    const after = await json(
      await app.request(`/weeks/${weekSessionId}/prescribed`),
    );
    const afterPlan = (after.prescribed as { plan: PrescribedWeek }).plan;
    expect(afterPlan.days[3]!.dayType).toBe("rest");
    expect(afterPlan.days[0]).toEqual(mondayBefore);

    const thread = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    const artifacts = thread.artifacts as Array<{
      kind: string;
      plan: PrescribedWeek;
    }>;
    const planArtifact = artifacts.find((a) => a.kind === "prescribed_week");
    expect(planArtifact?.plan.days[3]!.dayType).toBe("rest");
    expect(planArtifact?.plan.days[0]).toEqual(mondayBefore);
  });

  it("past-day patches from LLM stay stable unless allowPastDayPatches", async () => {
    await acceptAndReady();
    const clock = new FixedClock(new Date("2026-10-21T15:00:00.000Z"));
    let allowPast = false;
    const fake: LlmPort = {
      async generateWeeklyReply(packet) {
        return createStubLlmPort().generateWeeklyReply(packet);
      },
      async generateMidWeekChatReply(packet) {
        const monday = resolveMonday(packet.week?.start);
        const reply: MidWeekChatReply = {
          body: "Tried to rewrite Monday.",
          prescribedDayPatches: [
            {
              date: monday,
              dayType: "rest",
              run: null,
              notes: "past rewrite",
            },
          ],
          allowPastDayPatches: allowPast,
        };
        return reply;
      },
      async generateDossierV1(input) {
        return createStubLlmPort().generateDossierV1(input);
      },
      async generateDossierCorrection(input) {
        return createStubLlmPort().generateDossierCorrection(input);
      },
      async generateDossierAudit(input) {
        return createStubLlmPort().generateDossierAudit(input);
      },
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: fake,
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(app, weekSessionId);
    await seedCurrentWeekPlan(weekSessionId);
    const before = await json(
      await app.request(`/weeks/${weekSessionId}/prescribed`),
    );
    const mondayBefore = (
      before.prescribed as { plan: PrescribedWeek }
    ).plan.days[0]!;

    const blocked = await json(
      await app.request(`/weeks/${weekSessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Rewrite Monday please." }),
      }),
    );
    const blockedPlan = (blocked.prescribed as { plan: PrescribedWeek }).plan;
    expect(blockedPlan.days[0]).toEqual(mondayBefore);

    allowPast = true;
    const allowed = await json(
      await app.request(`/weeks/${weekSessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Rewrite Monday with allow flag." }),
      }),
    );
    const allowedPlan = (allowed.prescribed as { plan: PrescribedWeek }).plan;
    expect(allowedPlan.days[0]!.notes).toBe("past rewrite");
  });
});

function resolveMonday(start: string | undefined): string {
  if (start && /^\d{4}-\d{2}-\d{2}/.test(start)) return start.slice(0, 10);
  return WEEK_START;
}
