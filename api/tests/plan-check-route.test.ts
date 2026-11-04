/**
 * The plan check (issue #58) through the app on the offline stub: a Sunday
 * read whose plan is well above the athlete's recent distance gets a notice
 * in Coach Cade's voice on the plan record and on the Sunday message's card,
 * the plan is stored exactly as the reply had it, the notice survives "Add the
 * details", and the call-log row of the accepted reply records the rule. A
 * plan a fifth over shows nothing and records that nothing tripped.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  buildStubWeeklyForm,
  createStubLlmPort,
  expectedPlanDates,
  resolveWeeklyPlanWeek,
  validateWeeklyReply,
  weeklyReplyContext,
  type LlmPort,
  type PrescribedWeek,
  type WeeklyReply,
} from "../src/llm/index.js";
import { createPostgresLlmCallRecorder } from "../src/llmCallLog/recorder.js";
import { migrate } from "../src/migrate.js";
import type { PlanWarning } from "../src/prescribed/planCheck.js";
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

/** The reviewed week's report: 30 mi this week and 30 mi on average before it. */
const RECAP = [
  "## Summary",
  "",
  "| Metric | This week | Prev week | 3-wk avg | Δ |",
  "| --- | --- | --- | --- | --- |",
  "| Distance | 30.00 mi | 30.00 mi | 30.00 mi | +0.0 |",
  "| Runs | 5 | 5 | 5.0 | +0.0 |",
  "",
  "Steady aerobic week.",
].join("\n");

const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Seven easy lines with the given miles; 0 is a rest day; a line given as text is used as written. */
function linesOf(monday: string, miles: Array<number | string>): string {
  const dates = expectedPlanDates(monday);
  return miles
    .map((m, i) => {
      if (typeof m === "string") return `${NAMES[i]} ${dates[i]}: ${m}`;
      return m === 0 ? `${NAMES[i]} ${dates[i]}: rest.` : `${NAMES[i]} ${dates[i]}: easy, ${m} mi, relaxed.`;
    })
    .join("\n");
}

/** The stub, with its plan replaced by the given lines; everything else the stub's. */
function stubPlanning(miles: Array<number | string>): { port: LlmPort; replies: WeeklyReply[] } {
  // The stub writes its call-log rows as the app's own stub does, so the row can be read back.
  const stub = createStubLlmPort({ recorder: createPostgresLlmCallRecorder() });
  const replies: WeeklyReply[] = [];
  const port: LlmPort = {
    ...stub,
    async generateWeeklyReply(packet, options) {
      const monday = resolveWeeklyPlanWeek(packet).weekStartMonday;
      const form = { ...buildStubWeeklyForm(packet), plan: linesOf(monday, miles) };
      const checked = validateWeeklyReply(form, monday, weeklyReplyContext(packet));
      if (!checked.ok) throw new Error(checked.error);
      // The stub's own call keeps the call-log row; its reply is thrown away.
      await stub.generateWeeklyReply(packet, options);
      replies.push(checked.value);
      return checked.value;
    },
  };
  return { port, replies };
}

type Message = {
  role: string;
  kind: string;
  llmCallId: string | null;
  weekSessionId: string | null;
  safetyCallouts?: Array<{ title: string }>;
  planWarnings?: PlanWarning[];
};

describe("the plan check on a Sunday read", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function readTheWeek(miles: Array<number | string>, options: { recap?: string; said?: string } = {}) {
    const { port, replies } = stubPlanning(miles);
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: port,
    });
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;
    if (options.said) {
      await app.request("/thread/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: options.said, weekSessionId }),
      });
    }
    await unlockPlanCheckIn(app, weekSessionId);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, recapMarkdown: options.recap ?? RECAP }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const planSessionId = (body.prescribed as { weekSessionId: string }).weekSessionId;
    const messages = (await json(await app.request(`/thread?weekSessionId=${weekSessionId}`))).messages as Message[];
    const sunday = messages.find((m) => m.kind === "weekly_read")!;
    return { app, body, reply: replies[0]!, weekSessionId, planSessionId, sunday };
  }

  async function storedPlan(app: ReturnType<typeof createApp>, planSessionId: string) {
    const res = await json(await app.request(`/weeks/${planSessionId}/prescribed`));
    return res.prescribed as {
      plan: PrescribedWeek;
      safetyCallouts: Array<{ title: string }> | null;
      planWarnings: PlanWarning[] | null;
    };
  }

  it("a plan 1.4 times the recent distance gets the notice on the plan, the Sunday card and the call-log row, and the plan is stored as written", async () => {
    // 42 mi against 30 mi a week.
    const { app, body, reply, planSessionId, sunday } = await readTheWeek([0, 8, 8, 8, 0, 8, 10]);

    const expected: PlanWarning = {
      rule: "volume jump",
      title: "A big step up in distance",
      body: "This plan is 42 mi against your recent 30 mi a week. Ease into it, or ask me to adjust.",
      figures: { plannedM: 67593, recentM: 48280 },
    };
    expect(body.planWarnings).toEqual([expected]);

    const stored = await storedPlan(app, planSessionId);
    expect(stored.planWarnings).toEqual([expected]);
    // The plan is the validated reply's, day for day: the check added nothing to it and took nothing away.
    const validated = body.reply as WeeklyReply;
    expect(stored.plan).toEqual(validated.prescribedWeek);
    expect(stored.plan.days.map((d) => d.line)).toEqual(reply.prescribedWeek.days.map((d) => d.line));

    // The Sunday message carries the same notice, so the card says what the plan says.
    expect(sunday.planWarnings).toEqual([expected]);

    // No athlete-facing string names the rule.
    for (const w of stored.planWarnings!) {
      expect(`${w.title} ${w.body}`).not.toMatch(/volume jump|rule/i);
    }

    // The accepted reply's row records the rule.
    const row = await json(await app.request(`/llm-calls/${sunday.llmCallId}`));
    expect(row.operation).toBe("weekly_reply");
    expect(row.planRules).toEqual(["volume jump"]);
  });

  it("a plan 1.2 times the recent distance shows nothing and records that nothing tripped", async () => {
    // 36 mi against 30 mi a week.
    const { app, body, planSessionId, sunday } = await readTheWeek([0, 7, 7, 7, 0, 7, 8]);
    expect(body.planWarnings).toEqual([]);
    expect((await storedPlan(app, planSessionId)).planWarnings).toEqual([]);
    expect(sunday.planWarnings).toEqual([]);
    const row = await json(await app.request(`/llm-calls/${sunday.llmCallId}`));
    expect(row.planRules).toEqual([]);
  });

  it("each rule is its own notice beside Coach Cade's safety notice, on the plan and the Sunday card, in rule order", async () => {
    // A week with pain in a run note and in the athlete's last message, and a plan with a quality day at 1.4 times the recent distance:
    // the stub's own safety notice, then the volume notice, then the pain notice.
    const painRecap = RECAP.replace(
      "Steady aerobic week.",
      ["## Run-by-run", "", "### Thu Oct 15 — Tempo Run — 4.00 mi / 36m", "", 'Notes (from app): "Right Achilles tight from mile 2."', "", "RPE: 7/10  ·  Felt: 3/10"].join("\n"),
    );
    const { app, body, planSessionId, sunday, weekSessionId } = await readTheWeek(
      [0, 8, 8, "quality, 8 mi. Warm up, 4 x 1 mi at threshold, cool down.", 0, 8, 10],
      { recap: painRecap, said: "The Achilles is still sore today." },
    );
    const stored = await storedPlan(app, planSessionId);
    expect(stored.safetyCallouts?.map((c) => c.title)).toEqual(["See a professional."]);
    expect(stored.planWarnings?.map((w) => w.rule)).toEqual(["volume jump", "quality with pain"]);
    expect(stored.planWarnings?.[1]).toMatchObject({
      title: "Hard running after a week with pain",
      body: 'You reported pain on Thu Oct 15: "Right Achilles tight from mile 2". This plan still has hard running on Thu Oct 29. Keep it easy until it settles, or ask me to adjust.',
    });
    expect(body.planWarnings).toEqual(stored.planWarnings);

    // The Sunday message carries Coach Cade's notice and the plan's, apart.
    expect(sunday.safetyCallouts?.map((c) => c.title)).toEqual(["See a professional."]);
    expect(sunday.planWarnings).toEqual(stored.planWarnings);
    expect(sunday.weekSessionId).toBe(weekSessionId);

    const row = await json(await app.request(`/llm-calls/${sunday.llmCallId}`));
    expect(row.planRules).toEqual(["volume jump", "quality with pain"]);
  });

  it("the notice survives Add the details, and an unread day counts as nothing until it is filed", async () => {
    // Thursday is a bare number, so it does not count; the other days make 42 mi.
    const { app, planSessionId } = await readTheWeek([0, 8, 8, "easy 8, relaxed.", 0, 16, 10]);
    const before = await storedPlan(app, planSessionId);
    expect(before.plan.days[3]).toMatchObject({ parsed: false });
    expect(before.planWarnings?.map((w) => w.rule)).toEqual(["volume jump"]);

    const thursday = before.plan.days[3]!.date;
    const res = await app.request(`/weeks/${planSessionId}/prescribed/details`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: thursday }),
    });
    expect(res.status).toBe(200);

    const after = await storedPlan(app, planSessionId);
    expect(after.plan.days[3]).toMatchObject({ parsed: true, dayType: "easy" });
    expect(after.planWarnings).toEqual(before.planWarnings);
  });
});
