import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import type { PrescribedWeek } from "../src/llm/types.js";
import {
  buildModelPacket,
  DEFAULT_RECENT_HISTORY_LIMIT,
  filterThreadToFocusWeek,
  resolveRecentHistoryLimit,
} from "../src/packet/index.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { saveWeekRecap } from "../src/recap/recapStore.js";
import { createAthleteMessage } from "../src/thread/store.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const COACHING_NOTE = "Keep easy volume capped after Achilles flare.";

function restPlan(isoWeek: string, monday: string): PrescribedWeek {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${monday}T12:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10);
    return { date: ymd, dayType: "rest" as const, run: null };
  });
  return { week: isoWeek, days };
}

describe("lean recent-history helpers (#34)", () => {
  it("defaults N to a sane window and accepts overrides / env", () => {
    expect(DEFAULT_RECENT_HISTORY_LIMIT).toBe(4);
    expect(resolveRecentHistoryLimit()).toBe(4);
    expect(resolveRecentHistoryLimit(2)).toBe(2);
    expect(resolveRecentHistoryLimit(0)).toBe(0);
    expect(resolveRecentHistoryLimit(-1)).toBe(4);
    expect(resolveRecentHistoryLimit(Number.NaN)).toBe(4);

    const prev = process.env.PACKET_RECENT_HISTORY_LIMIT;
    process.env.PACKET_RECENT_HISTORY_LIMIT = "3";
    expect(resolveRecentHistoryLimit()).toBe(3);
    process.env.PACKET_RECENT_HISTORY_LIMIT = "not-a-number";
    expect(resolveRecentHistoryLimit()).toBe(4);
    if (prev === undefined) delete process.env.PACKET_RECENT_HISTORY_LIMIT;
    else process.env.PACKET_RECENT_HISTORY_LIMIT = prev;
  });

  it("filterThreadToFocusWeek drops other-week mid-week chatter", () => {
    const focus = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const filtered = filterThreadToFocusWeek(
      [
        { weekSessionId: focus, body: "current" },
        { weekSessionId: other, body: "archived chatter" },
        { weekSessionId: null, body: "orphan" },
      ],
      focus,
    );
    expect(filtered).toEqual([{ weekSessionId: focus, body: "current" }]);
  });

  it("buildModelPacket includes redacted recentHistory and keeps dossier", () => {
    const packet = buildModelPacket({
      dossier: { versionId: 7, body: COACHING_NOTE },
      thread: [{ role: "athlete", body: "Current week only." }],
      recentHistory: [
        {
          isoWeek: "2026-W42",
          weekSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          recapMarkdown: "## Recap W42\nSolid.",
          analysis: "Held easy volume.",
        },
      ],
      recentHistoryLimit: 4,
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
        weekSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    });

    expect(packet.dossier).toMatchObject({
      versionId: 7,
      body: expect.stringContaining("Achilles"),
    });
    expect(packet.recentHistoryLimit).toBe(4);
    expect(packet.recentHistory).toHaveLength(1);
    expect(packet.recentHistory[0]!.isoWeek).toBe("2026-W42");
    expect(packet.recentHistory[0]!.recapMarkdown).toContain("W42");
    expect(packet.thread).toHaveLength(1);
    expect(packet.thread[0]!.body).toContain("Current week");
  });
});

describe("POST /packet lean live context (#34)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.PACKET_RECENT_HISTORY_LIMIT;
  });

  it("includes dossier + last N summaries/plans; excludes archived mid-week chatter", async () => {
    await acceptAndReady();

    // Seed four prior weeks with unique mid-week chatter + durable recap/plan.
    const prior: Array<{
      clock: string;
      isoWeek: string;
      monday: string;
      chatMarker: string;
      recapMarker: string;
    }> = [
      {
        clock: "2026-09-28T15:00:00.000Z",
        isoWeek: "2026-W40",
        monday: "2026-09-28",
        chatMarker: "SECRET_CHAT_W40",
        recapMarker: "RECAP_SUMMARY_W40",
      },
      {
        clock: "2026-10-05T15:00:00.000Z",
        isoWeek: "2026-W41",
        monday: "2026-10-05",
        chatMarker: "SECRET_CHAT_W41",
        recapMarker: "RECAP_SUMMARY_W41",
      },
      {
        clock: "2026-10-12T15:00:00.000Z",
        isoWeek: "2026-W42",
        monday: "2026-10-12",
        chatMarker: "SECRET_CHAT_W42",
        recapMarker: "RECAP_SUMMARY_W42",
      },
      {
        clock: "2026-10-19T15:00:00.000Z",
        isoWeek: "2026-W43",
        monday: "2026-10-19",
        chatMarker: "SECRET_CHAT_W43",
        recapMarker: "RECAP_SUMMARY_W43",
      },
    ];

    for (const week of prior) {
      const app = createApp({
        dataProtectionKey: TEST_DATA_PROTECTION_KEY,
        clock: new FixedClock(new Date(week.clock)),
      });
      const session = await json(
        await app.request("/weeks/current", { method: "POST" }),
      );
      expect(session.isoWeek).toBe(week.isoWeek);
      const id = session.id as string;

      await createAthleteMessage(
        `Mid-week chatter ${week.chatMarker} — should not enter live packet.`,
        id,
      );
      await saveWeekRecap({
        weekSessionId: id,
        markdown: `# Weekly Recap — ${week.isoWeek}\n\n${week.recapMarker}`,
        subjective: "skipped",
      });
      await savePrescribedWeek({
        weekSessionId: id,
        plan: restPlan(week.isoWeek, week.monday),
        analysis: `ANALYSIS_${week.isoWeek}`,
      });
    }

    // Start current week — archives all prior sessions.
    const liveApp = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-26T15:00:00.000Z")),
    });
    const live = await json(
      await liveApp.request("/weeks/current", { method: "POST" }),
    );
    expect(live.isoWeek).toBe("2026-W44");
    expect(live.archived).toBe(false);
    const liveId = live.id as string;

    await liveApp.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: COACHING_NOTE }),
    });
    await createAthleteMessage("Live week note CURRENT_WEEK_CHAT", liveId);

    const res = await liveApp.request("/packet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: liveId,
        recentHistoryLimit: 2,
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const packet = body.packet as Record<string, unknown>;

    const dossier = packet.dossier as Record<string, unknown>;
    expect(dossier).toBeTruthy();
    expect(dossier.versionId).toBeTruthy();
    expect(String(dossier.body)).toContain("Achilles");

    expect(packet.recentHistoryLimit).toBe(2);
    const recent = packet.recentHistory as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(2);
    expect(recent.map((w) => w.isoWeek)).toEqual(["2026-W43", "2026-W42"]);
    expect(String(recent[0]!.recapMarkdown)).toContain("RECAP_SUMMARY_W43");
    expect(String(recent[0]!.analysis)).toBe("ANALYSIS_2026-W43");
    expect(String(recent[1]!.recapMarkdown)).toContain("RECAP_SUMMARY_W42");
    expect(recent[0]!.prescribedWeek).toBeTruthy();

    const thread = packet.thread as Array<Record<string, unknown>>;
    expect(thread).toHaveLength(1);
    expect(String(thread[0]!.body)).toContain("CURRENT_WEEK_CHAT");

    const text = JSON.stringify(packet);
    // Archived mid-week chatter must not appear — even weeks inside the N window.
    expect(text).not.toContain("SECRET_CHAT_W40");
    expect(text).not.toContain("SECRET_CHAT_W41");
    expect(text).not.toContain("SECRET_CHAT_W42");
    expect(text).not.toContain("SECRET_CHAT_W43");
    // Weeks outside the N=2 window: no summaries either.
    expect(text).not.toContain("RECAP_SUMMARY_W40");
    expect(text).not.toContain("RECAP_SUMMARY_W41");
    expect(text).not.toContain("ANALYSIS_2026-W40");
    expect(text).not.toContain("ANALYSIS_2026-W41");
    // In-window summaries/plans remain.
    expect(text).toContain("RECAP_SUMMARY_W42");
    expect(text).toContain("RECAP_SUMMARY_W43");
    expect(text).toContain("CURRENT_WEEK_CHAT");
    expect(text).toContain(COACHING_NOTE);
  });

  it("respects PACKET_RECENT_HISTORY_LIMIT env default", async () => {
    await acceptAndReady();
    process.env.PACKET_RECENT_HISTORY_LIMIT = "1";

    for (const clock of [
      "2026-10-19T15:00:00.000Z",
      "2026-10-26T15:00:00.000Z",
    ]) {
      const app = createApp({
        dataProtectionKey: TEST_DATA_PROTECTION_KEY,
        clock: new FixedClock(new Date(clock)),
      });
      const session = await json(
        await app.request("/weeks/current", { method: "POST" }),
      );
      await saveWeekRecap({
        weekSessionId: session.id as string,
        markdown: `Recap for ${session.isoWeek as string}`,
        subjective: "skipped",
      });
    }

    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-11-02T15:00:00.000Z")),
    });
    const live = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request("/packet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: live.id }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const packet = body.packet as Record<string, unknown>;
    expect(packet.recentHistoryLimit).toBe(1);
    const recent = packet.recentHistory as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0]!.isoWeek).toBe("2026-W44");
  });
});
