import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  createStubLlmPort,
  expectedPlanDates,
  validatePrescribedWeek,
  validateWeeklyReply,
  type LlmPort,
  type WeeklyReply,
} from "../src/llm/index.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { migrate } from "../src/migrate.js";
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
const ISO_WEEK = "2026-W43";
// The weekly reply plans the week AFTER the reviewed week (N+1).
const PLAN_WEEK_START = "2026-10-26";
const PLAN_ISO_WEEK = "2026-W44";
const COACHING_NOTE =
  "Chronic left Achilles flare after long downhill — keep easy volume capped.";

function samplePacket(overrides?: Partial<ModelPacket>): ModelPacket {
  return buildModelPacket({
    dossier: {
      versionId: 1,
      body: COACHING_NOTE,
    },
    recapMarkdown:
      "## Summary\n42 mi, solid aerobic week. Long run felt controlled.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: ISO_WEEK,
      start: `${WEEK_START}T00:00:00.000Z`,
      end: "2026-10-25T23:59:59.999Z",
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
    ...overrides,
  });
}

describe("prescribed-week schema validation", () => {
  it("accepts a valid 7-day plan", () => {
    const dates = expectedPlanDates(WEEK_START);
    const raw = {
      week: ISO_WEEK,
      days: dates.map((date, i) =>
        i === 1 || i === 4
          ? { date, dayType: "rest", run: null, strength: null, notes: "Rest" }
          : {
              date,
              dayType: i === 6 ? "long" : i === 3 ? "quality" : "easy",
              run: {
                type: i === 6 ? "long" : i === 3 ? "quality" : "easy",
                distanceM: i === 6 ? 18000 : 8000,
                structure: null,
                paceOrHr: "easy",
                shoes: "trainer",
              },
              strength: null,
              notes: null,
            },
      ),
    };
    const result = validatePrescribedWeek(raw, WEEK_START);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.days).toHaveLength(7);
      expect(result.value.days[3]!.run?.shoes).toBe("trainer");
    }
  });

  it("rejects invalid stub shapes", () => {
    expect(validatePrescribedWeek(null, WEEK_START).ok).toBe(false);
    expect(
      validatePrescribedWeek({ week: ISO_WEEK, days: [] }, WEEK_START).ok,
    ).toBe(false);

    const dates = expectedPlanDates(WEEK_START);
    const wrongDate = {
      week: ISO_WEEK,
      days: dates.map((date, i) => ({
        date: i === 0 ? "2026-10-12" : date,
        dayType: "easy",
        run: { type: "easy", distanceM: 5000 },
      })),
    };
    const wrong = validatePrescribedWeek(wrongDate, WEEK_START);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/days\[0\]\.date/);

    const missingRun = {
      week: ISO_WEEK,
      days: dates.map((date) => ({
        date,
        dayType: "easy",
        run: null,
      })),
    };
    const noRun = validatePrescribedWeek(missingRun, WEEK_START);
    expect(noRun.ok).toBe(false);
    if (!noRun.ok) expect(noRun.error).toMatch(/requires a run/);

    const badReply = validateWeeklyReply(
      {
        analysis: "",
        prescribedWeek: {
          week: ISO_WEEK,
          days: dates.map((date) => ({
            date,
            dayType: "rest",
            run: null,
          })),
        },
      },
      WEEK_START,
    );
    expect(badReply.ok).toBe(false);
    if (!badReply.ok) expect(badReply.error).toMatch(/analysis/);
  });
});

describe("createStubLlmPort", () => {
  it("returns a valid prescribed-week schema for tests", async () => {
    const port = createStubLlmPort();
    const reply = await port.generateWeeklyReply(samplePacket());

    expect(reply.analysis.length).toBeGreaterThan(0);
    expect(reply.analysis).toContain("Headline");
    // Each section heading appears once, not again as a label on the next line (#20).
    expect(reply.analysis).not.toMatch(/^(Headline|Answers):/m);
    expect(reply.analysis).toMatch(/Achilles|soft-tissue/i);

    const checked = validateWeeklyReply(reply, PLAN_WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    expect(checked.value.prescribedWeek.week).toBe(PLAN_ISO_WEEK);
    expect(checked.value.prescribedWeek.days).toHaveLength(7);
    expect(checked.value.prescribedWeek.days[0]!.date).toBe(PLAN_WEEK_START);
    expect(checked.value.prescribedWeek.days[6]!.dayType).toBe("long");
    expect(checked.value.prescribedWeek.days[3]!.run?.structure).toBeTruthy();
    expect(checked.value.prescribedWeek.days[3]!.run?.paceOrHr).toBeTruthy();
    expect(checked.value.prescribedWeek.days[3]!.run?.shoes).toBeTruthy();
    expect(checked.value.settingsProposalBullets?.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same packet", async () => {
    const port = createStubLlmPort();
    const packet = samplePacket();
    const a = await port.generateWeeklyReply(packet);
    const b = await port.generateWeeklyReply(packet);
    expect(a).toEqual(b);
  });
});

describe("POST /week/reply week-loop (export TempoPort + LlmPort stub)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("generates a plan from fixture recap + dossier without network", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const llmPort = createStubLlmPort();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort,
      llmPort,
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: COACHING_NOTE }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await unlockPlanCheckIn(app, week.id as string);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: week.id,
        recapMarkdown:
          "## Summary\nExport-backed fixture week. Steady aerobic volume.",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const reply = body.reply as WeeklyReply;

    expect(reply.analysis).toContain("Headline");
    // Reviewed week is 2026-W43 (Mon 2026-10-19); the plan is for 2026-W44.
    const weekStart = "2026-10-26";
    const validated = validateWeeklyReply(reply, weekStart);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.prescribedWeek.days).toHaveLength(7);
    expect(validated.value.prescribedWeek.days[0]!.date).toBe(weekStart);
    const quality = validated.value.prescribedWeek.days.find(
      (d) => d.dayType === "quality",
    );
    expect(quality?.run?.distanceM).toBeGreaterThan(0);
    expect(quality?.run?.shoes).toBeTruthy();
  });

  it("uses injected LlmPort (weekly reply flow seam)", async () => {
    await acceptAndReady();
    let calls = 0;
    const fake: LlmPort = {
      async generateWeeklyReply(packet) {
        calls += 1;
        const stub = createStubLlmPort();
        return stub.generateWeeklyReply(packet);
      },
      async generateMidWeekChatReply(packet) {
        return createStubLlmPort().generateMidWeekChatReply(packet);
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
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: fake,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await unlockPlanCheckIn(app, week.id as string);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: week.id,
        packet: samplePacket(),
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("disclaimer gates weekly reply", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/week/reply", { method: "POST" })).status).toBe(
      403,
    );
  });
});
