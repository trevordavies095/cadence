import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  buildStubWeeklyReply,
  expectedPlanDates,
  type WeeklyReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  anthropicStreamResponse,
  anthropicToolMessage,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const API_KEY = "sk-ant-test-key-fixture-xyz";
const NY = "America/New_York";
// Sunday 2026-10-25 11:00 in New York (2026-W43). Reviewed week N = W43,
// plan week N+1 = W44 (Mon Oct 26 - Sun Nov 1).
const SUNDAY = new Date("2026-10-25T15:00:00.000Z");
const PLAN_DATES = expectedPlanDates("2026-10-26");

function packetFor(reviewedIsoWeek: string) {
  return buildModelPacket({
    // No dossier: the stub would add settings-proposal bullets, which trip the
    // dirty-dossier gate on a second run.
    dossier: null,
    recapMarkdown: "## Summary\nSteady aerobic week.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: reviewedIsoWeek,
      start: "2026-10-19T04:00:00.000Z",
      end: "2026-10-26T03:59:59.999Z",
    },
  });
}

/** Plan for 2026-W44 (the correct next week). */
function nextWeekReply(analysis?: string): WeeklyReply {
  const reply = buildStubWeeklyReply(packetFor("2026-W43"));
  return analysis ? { ...reply, analysis } : reply;
}

/** Plan dated for the reviewed week itself (wrong). */
function reviewedWeekReply(): WeeklyReply {
  return buildStubWeeklyReply(packetFor("2026-W42"));
}

function anthropicResponse(input: unknown): Response {
  return anthropicStreamResponse(
    anthropicToolMessage("submit_weekly_reply", input, {
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
}

type Weeks = { weeks: Array<{ id: string; isoWeek: string; archived: boolean }> };

describe("weekly reply plans next week (#78)", () => {
  let prevProvider: string | undefined;
  let nextReply: WeeklyReply;
  let requests: Array<{ messages: Array<{ content: string }> }>;

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    prevProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "anthropic";
    nextReply = nextWeekReply();
    requests = [];
    return () => {
      if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevProvider;
    };
  });

  async function liveApp() {
    await acceptAndReady();
    await putAnthropicConnection(
      API_KEY,
      new SecretProtector(TEST_DATA_PROTECTION_KEY),
    );
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return anthropicResponse(nextReply);
    }) as unknown as typeof globalThis.fetch;
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(SUNDAY),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmFetch: fetchImpl,
      athleteTimezone: NY,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await unlockPlanCheckIn(app, week.id as string);
    return { app, weekSessionId: week.id as string };
  }

  function reply(app: ReturnType<typeof createApp>, weekSessionId: string) {
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId }),
    });
  }

  async function weeks(app: ReturnType<typeof createApp>) {
    return ((await json(await app.request("/weeks"))) as unknown as Weeks).weeks;
  }

  it("sends planWeek and the N+1 dates to the model", async () => {
    const { app, weekSessionId } = await liveApp();
    const res = await reply(app, weekSessionId);
    expect(res.status).toBe(200);

    expect(requests).toHaveLength(1);
    const content = requests[0]!.messages[0]!.content;
    expect(content).toContain("Plan week ISO label: 2026-W44");
    expect(content).toContain(PLAN_DATES.join(", "));
    expect(PLAN_DATES[0]).toBe("2026-10-26");
    expect(PLAN_DATES[6]).toBe("2026-11-01");
    const packetLine = content.split("\n").pop()!;
    const packet = JSON.parse(packetLine) as {
      week: { isoWeek: string };
      planWeek: { isoWeek: string; startDate: string; endDate: string };
    };
    expect(packet.week.isoWeek).toBe("2026-W43");
    expect(packet.planWeek).toMatchObject({
      isoWeek: "2026-W44",
      startDate: "2026-10-26",
      endDate: "2026-11-01",
    });
  });

  it("stores the plan on N+1 (not N) without archiving N; coach message stays in N", async () => {
    const { app, weekSessionId } = await liveApp();
    const res = await reply(app, weekSessionId);
    expect(res.status).toBe(200);
    const body = await json(res);

    const prescribed = body.prescribed as {
      weekSessionId: string;
      plan: { week: string; days: Array<{ date: string }> };
    };
    expect(prescribed.weekSessionId).not.toBe(weekSessionId);
    expect(prescribed.plan.week).toBe("2026-W44");
    expect(prescribed.plan.days.map((d) => d.date)).toEqual(PLAN_DATES);
    expect(body.threadArtifact).toMatchObject({
      kind: "prescribed_week",
      weekSessionId: prescribed.weekSessionId,
    });

    // Not on N.
    const onN = await app.request(`/weeks/${weekSessionId}/prescribed`);
    expect(onN.status).toBe(404);

    // Readable via next-week endpoint.
    const next = await json(
      await app.request(`/weeks/${weekSessionId}/prescribed/next`),
    );
    expect(next.weekSession).toMatchObject({
      id: prescribed.weekSessionId,
      isoWeek: "2026-W44",
      timezone: NY,
    });
    expect(
      (next.prescribed as { weekSessionId: string }).weekSessionId,
    ).toBe(prescribed.weekSessionId);

    // N+1 exists, N is not archived.
    const all = await weeks(app);
    expect(all.map((w) => w.isoWeek).sort()).toEqual(["2026-W43", "2026-W44"]);
    expect(all.every((w) => !w.archived)).toBe(true);

    // Coach message is in N's thread, linked to the LLM call.
    const thread = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    const coach = (thread.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role === "coach",
    );
    expect(coach).toHaveLength(1);
    expect(coach[0]!.llmCallId).toMatch(/^[0-9a-f-]{36}$/);
    const nextThread = await json(
      await app.request(
        `/thread?weekSessionId=${prescribed.weekSessionId}`,
      ),
    );
    expect(
      (nextThread.messages as Array<Record<string, unknown>>).filter(
        (m) => m.role === "coach",
      ),
    ).toHaveLength(0);
  });

  it("rejects a plan dated for the reviewed week and saves nothing", async () => {
    const { app, weekSessionId } = await liveApp();
    nextReply = reviewedWeekReply();
    const res = await reply(app, weekSessionId);
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ error: "llm_schema_invalid" });

    expect(await weeks(app)).toHaveLength(1);
    const onN = await app.request(`/weeks/${weekSessionId}/prescribed`);
    expect(onN.status).toBe(404);
    const thread = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    expect(
      (thread.messages as Array<Record<string, unknown>>).filter(
        (m) => m.role === "coach",
      ),
    ).toHaveLength(0);
  });

  it("re-running replaces N+1's existing plan", async () => {
    const { app, weekSessionId } = await liveApp();
    nextReply = nextWeekReply("## Headline\nFirst plan.");
    const first = await json(await reply(app, weekSessionId));
    nextReply = nextWeekReply("## Headline\nSecond plan.");
    const second = await json(await reply(app, weekSessionId));

    const firstId = (first.prescribed as { weekSessionId: string })
      .weekSessionId;
    expect((second.prescribed as { weekSessionId: string }).weekSessionId).toBe(
      firstId,
    );
    expect(await weeks(app)).toHaveLength(2);

    const next = await json(
      await app.request(`/weeks/${weekSessionId}/prescribed/next`),
    );
    expect((next.prescribed as { analysis: string }).analysis).toContain(
      "Second plan.",
    );
  });

  it("uses an existing N+1 session (pre-seeded) without duplicating it", async () => {
    const { app, weekSessionId } = await liveApp();
    const seeded = await json(
      await app.request(`/weeks/${weekSessionId}/prescribed/next`),
    );
    const seededId = (seeded.weekSession as { id: string }).id;
    const res = await json(await reply(app, weekSessionId));
    expect((res.prescribed as { weekSessionId: string }).weekSessionId).toBe(
      seededId,
    );
    expect(await weeks(app)).toHaveLength(2);
  });

  it("packet-only callers still plan the week after packet.week", async () => {
    const { app, weekSessionId } = await liveApp();
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId, packet: packetFor("2026-W43") }),
    });
    expect(res.status).toBe(200);
    expect(requests[0]!.messages[0]!.content).toContain(
      PLAN_DATES.join(", "),
    );
  });

  describe("GET /weeks/:id/prescribed/next", () => {
    it("returns prescribed null and creates N+1 without archiving N", async () => {
      const { app, weekSessionId } = await liveApp();
      const res = await app.request(`/weeks/${weekSessionId}/prescribed/next`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.prescribed).toBeNull();
      expect(body.weekSession).toMatchObject({
        isoWeek: "2026-W44",
        timezone: NY,
        archived: false,
      });
      const all = await weeks(app);
      expect(all).toHaveLength(2);
      expect(all.every((w) => !w.archived)).toBe(true);
    });

    it("404s for an unknown week", async () => {
      const { app } = await liveApp();
      const res = await app.request(
        "/weeks/00000000-0000-4000-8000-000000000099/prescribed/next",
      );
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ error: "week_session_not_found" });
    });

    it("403s before the disclaimer is accepted", async () => {
      const app = createApp({
        dataProtectionKey: TEST_DATA_PROTECTION_KEY,
        clock: new FixedClock(SUNDAY),
        athleteTimezone: NY,
      });
      const res = await app.request(
        "/weeks/00000000-0000-4000-8000-000000000099/prescribed/next",
      );
      expect(res.status).toBe(403);
    });
  });
});
