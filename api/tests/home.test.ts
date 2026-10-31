import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  createStubLlmPort,
  LlmTransportError,
  type LlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoPort } from "../src/tempo/port.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  settleReplyRun,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

// The fixture has runs on Tue Oct 20 and Thu Oct 22 (08:00 in New York).
const MON = "2026-10-19T15:00:00.000Z";
const SAT = "2026-10-24T15:00:00.000Z";
const SUN = "2026-10-25T15:00:00.000Z";

const THIS_WEEK_PLAN = {
  week: "2026-W43",
  days: [
    { date: "2026-10-19", dayType: "easy", run: { type: "easy", distanceM: 8000, shoes: "Trainer" } },
    { date: "2026-10-20", dayType: "easy", run: { type: "easy", distanceM: 6000 } },
    { date: "2026-10-21", dayType: "rest", run: null },
    { date: "2026-10-22", dayType: "quality", run: { type: "quality", distanceM: 10000 } },
    { date: "2026-10-23", dayType: "rest", run: null },
    { date: "2026-10-24", dayType: "easy", run: { type: "easy", distanceM: 7000, shoes: "Daily trainer" }, notes: "Keep it relaxed." },
    { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 16000 } },
  ],
} as const;

type App = ReturnType<typeof createApp>;

describe("GET /home (#100)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  function makeApp(
    now: string,
    options?: { tempoPort?: TempoPort; llmPort?: LlmPort },
  ) {
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(now)),
      athleteTimezone: "America/New_York",
      tempoPort:
        options?.tempoPort ?? createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: options?.llmPort ?? createStubLlmPort(),
    });
  }

  async function configure(app: App) {
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_home_test_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-home-test-key" }],
    ] as const) {
      const res = await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }
  }

  async function ready(now: string, options?: Parameters<typeof makeApp>[1]) {
    await acceptAndReady();
    const app = makeApp(now, options);
    await configure(app);
    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# About you\n\nEasy base building." }),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    return { app, id: week.id as string };
  }

  async function withPlan(id: string) {
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: id,
      plan: THIS_WEEK_PLAN as never,
      analysis: "Fixture plan.",
    });
  }

  const home = async (app: App) => json(await app.request("/home"));
  const states = (body: Record<string, unknown>) =>
    (body.week as Array<{ state: string }>).map((d) => d.state);

  const skipCheckIn = (app: App, id: string) =>
    app.request(`/weeks/${id}/recap?skip_subjective=true`);

  it("sits behind the disclaimer gate", async () => {
    const res = await makeApp(SAT).request("/home");
    expect(res.status).toBe(403);
  });

  describe("banner", () => {
    it("asks for setup first", async () => {
      await acceptAndReady();
      const body = await home(makeApp(SAT));
      expect(body.banner).toMatchObject({
        kind: "setup_incomplete",
        text: "Finish connecting your accounts",
        cta: { label: "Settings", href: "/settings" },
      });
      expect(body.week).toEqual([]);
      expect(body.today).toBeNull();
    });

    it("asks for the first answers, then for a look at what the coach understood", async () => {
      await acceptAndReady();
      const app = makeApp(SAT);
      await configure(app);
      expect((await home(app)).banner).toMatchObject({
        kind: "needs_onboarding",
        cta: { label: "Start", href: "/onboarding" },
      });

      const saved = await app.request("/onboarding/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: { schedule: "Tue Thu Sat" },
          goal: { kind: "race", distance: "half", raceName: "Half marathon in January" },
        }),
      });
      expect(saved.status).toBe(201);
      expect((await home(app)).banner).toMatchObject({
        kind: "onboarding_review",
        text: "Here’s what Coach Cade understood",
        cta: { label: "Have a look", href: "/dossier" },
      });
    });

    it("asks for the check-in from Saturday, not before", async () => {
      const mon = await ready(MON);
      expect((await home(mon.app)).banner).toBeNull();

      await resetAppTables();
      const sat = await ready(SAT);
      expect((await home(sat.app)).banner).toMatchObject({
        kind: "needs_check_in",
        text: "Time for your weekly check-in",
        cta: { label: "Start", href: "/check-in" },
      });
    });

    it("shows a pending reply with nothing to press", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const base = createStubLlmPort();
      const { app, id } = await ready(SAT, {
        llmPort: {
          ...base,
          generateWeeklyReply: async (packet, options) => {
            await gate;
            return base.generateWeeklyReply(packet, options);
          },
        },
      });
      expect((await skipCheckIn(app, id)).status).toBe(200);
      expect((await home(app)).banner).toEqual({
        kind: "reply_pending",
        text: "Coach Cade is reading your week",
        cta: null,
      });
      release();
      await waitForReplyRunsIdle();
    });

    it("offers a retry when the reply failed", async () => {
      const base = createStubLlmPort();
      const { app, id } = await ready(SAT, {
        llmPort: {
          ...base,
          generateWeeklyReply: async () => {
            throw new LlmTransportError("upstream went away");
          },
        },
      });
      await skipCheckIn(app, id);
      await settleReplyRun(app, id);
      expect((await home(app)).banner).toEqual({
        kind: "reply_failed",
        text: "Coach Cade couldn’t finish reading your week",
        cta: { label: "Retry", action: "retry_reply_run" },
      });
    });

    it("announces the new plan until the athlete has opened it", async () => {
      const { app, id } = await ready(SAT);
      await skipCheckIn(app, id);
      await settleReplyRun(app, id);
      // The reply's own notes apply on their own and never take the banner.
      expect((await home(app)).banner).toMatchObject({
        kind: "plan_ready",
        text: "Next week’s plan is ready",
        cta: { label: "See it", href: "/plan" },
      });

      const seen = await app.request(`/weeks/${id}/reply-run/seen`, { method: "POST" });
      expect(seen.status).toBe(200);
      expect(((await json(seen)).run as { seenAt: string }).seenAt).toBeTruthy();
      expect((await home(app)).banner).toBeNull();
    });

    it("mentions a tidy-up only when nothing more important is waiting", async () => {
      const mon = await ready(MON);
      const audit = await mon.app.request("/dossier/audits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(audit.status).toBe(201);
      expect((await home(mon.app)).banner).toMatchObject({
        kind: "audit_pending",
        text: "Coach Cade tidied what it knows about you",
        cta: { label: "Have a look", href: "/dossier" },
      });

      // From Saturday the check-in comes first.
      await resetAppTables();
      const sat = await ready(SAT);
      await sat.app.request("/dossier/audits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect((await home(sat.app)).banner).toMatchObject({ kind: "needs_check_in" });
    });

    it("an applied note is not a banner: the athlete can undo it later", async () => {
      const { app } = await ready(MON);
      const created = await app.request("/dossier/corrections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "I now run on Mondays too." }),
      });
      expect(created.status).toBe(201);
      expect((await home(app)).banner).toBeNull();
    });
  });

  describe("the week", () => {
    it("on Saturday: missed, done, rest, today and upcoming days, with totals", async () => {
      const { app, id } = await ready(SAT);
      await withPlan(id);
      const body = await home(app);

      expect(states(body)).toEqual([
        "missed", // Mon: a run was planned and Tempo has none
        "done", // Tue: Tempo has a run
        "rest", // Wed: planned rest, never missed
        "done", // Thu: Tempo has a run
        "rest", // Fri
        "today", // Sat
        "upcoming", // Sun
      ]);
      const week = body.week as Array<Record<string, unknown>>;
      expect(week.map((d) => d.date)).toEqual([
        "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22",
        "2026-10-23", "2026-10-24", "2026-10-25",
      ]);
      expect(week[0]).toMatchObject({ plannedDistanceM: 8000, actualDistanceM: 0, isToday: false });
      expect(week[1]!.actualDistanceM as number).toBeGreaterThan(0);
      expect(week[5]).toMatchObject({ isToday: true, plannedDistanceM: 7000 });

      const done = week.filter((d) => d.state === "done");
      const totals = body.totals as { actualDistanceM: number; plannedDistanceM: number };
      expect(totals.actualDistanceM).toBe(
        done.reduce((sum, d) => sum + (d.actualDistanceM as number), 0),
      );
      expect(totals.plannedDistanceM).toBe(8000 + 6000 + 10000 + 7000 + 16000);
      expect(body.units).toBe("imperial");
      expect(body.tempoUnavailable).toBe(false);

      expect(body.today).toMatchObject({
        date: "2026-10-24",
        dayType: "easy",
        notes: "Keep it relaxed.",
        run: { distanceM: 7000, shoes: "Daily trainer" },
      });
    });

    it("on Monday: today is today and rest days are rest", async () => {
      const { app, id } = await ready(MON);
      await withPlan(id);
      const body = await home(app);
      const s = states(body);
      expect(s[0]).toBe("today");
      expect(s[2]).toBe("rest");
      expect(s[5]).toBe("upcoming");
      expect(body.today).toMatchObject({ date: "2026-10-19" });
    });

    it("on Sunday: the unrun Saturday is missed and Sunday is today", async () => {
      const { app, id } = await ready(SUN);
      await withPlan(id);
      const s = states(await home(app));
      expect(s[5]).toBe("missed");
      expect(s[6]).toBe("today");
    });

    it("a rest day with a run in Tempo is done, not rest", async () => {
      const { app, id } = await ready(SAT);
      await savePrescribedWeek({
        at: new Date(),
        weekSessionId: id,
        plan: {
          ...THIS_WEEK_PLAN,
          days: THIS_WEEK_PLAN.days.map((d) =>
            d.date === "2026-10-20" ? { date: d.date, dayType: "rest", run: null } : d,
          ),
        } as never,
        analysis: "Fixture plan.",
      });
      expect(states(await home(app))[1]).toBe("done");
    });

    it("without a plan it still shows seven days and what was run", async () => {
      const { app } = await ready(SAT);
      const body = await home(app);
      expect(body.today).toBeNull();
      expect(states(body)).toEqual([
        "rest", "done", "rest", "done", "rest", "today", "upcoming",
      ]);
      expect((body.totals as { plannedDistanceM: number }).plannedDistanceM).toBe(0);
    });

    it("degrades to the plan alone when Tempo cannot be read", async () => {
      const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
      const down: TempoPort = {
        ...base,
        listWorkouts: async () => {
          throw new Error("Tempo is unreachable");
        },
      };
      const { app, id } = await ready(SAT, { tempoPort: down });
      await withPlan(id);

      const res = await app.request("/home");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.tempoUnavailable).toBe(true);
      const week = body.week as Array<{ actualDistanceM: number | null; state: string }>;
      expect(week.every((d) => d.actualDistanceM === null)).toBe(true);
      // Nothing is claimed done or missed when we cannot know.
      expect(week.map((d) => d.state)).toEqual([
        "unknown", "unknown", "rest", "unknown", "rest", "today", "upcoming",
      ]);
      expect(body.today).toMatchObject({ date: "2026-10-24" });
    });
  });
});
