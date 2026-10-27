import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { saveWeekRecap } from "../src/recap/recapStore.js";
import {
  ensureWeekSession,
  getOrCreateCurrentWeekSession,
  listWeekSessions,
} from "../src/week/store.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("week session model", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("get-or-create current week respects fixed clock", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    });

    const created = await app.request("/weeks/current", { method: "POST" });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.isoWeek).toBe("2026-W43");
    expect(body.timezone).toBe("UTC");
    expect(body.start).toBe("2026-10-19T00:00:00.000Z");
    expect(body.end).toBe("2026-10-25T23:59:59.999Z");
    expect(body.created).toBe(true);
    expect(body.archived).toBe(false);
    expect(body.archivedAt).toBeNull();
    expect(body.id).toBeTruthy();

    const again = await app.request("/weeks/current", { method: "POST" });
    expect(again.status).toBe(200);
    const againBody = await json(again);
    expect(againBody.id).toBe(body.id);
    expect(againBody.created).toBe(false);
    expect(againBody.archived).toBe(false);
  });

  it("list weeks returns sessions newest-first across week boundary", async () => {
    await acceptAndReady();

    const week43 = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-25T12:00:00.000Z")),
    });
    const a = await json(await week43.request("/weeks/current", { method: "POST" }));
    expect(a.isoWeek).toBe("2026-W43");
    expect(a.archived).toBe(false);

    const week44 = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-26T00:00:00.000Z")),
    });
    const b = await json(await week44.request("/weeks/current", { method: "POST" }));
    expect(b.isoWeek).toBe("2026-W44");
    expect(b.id).not.toBe(a.id);
    expect(b.archived).toBe(false);

    const listed = await json(await week44.request("/weeks"));
    const weeks = listed.weeks as Array<Record<string, unknown>>;
    expect(weeks).toHaveLength(2);
    expect(weeks[0]!.isoWeek).toBe("2026-W44");
    expect(weeks[0]!.archived).toBe(false);
    expect(weeks[1]!.isoWeek).toBe("2026-W43");
    expect(weeks[1]!.archived).toBe(true);
    expect(weeks[1]!.archivedAt).toBeTruthy();
  });

  it("starting week N+1 archives week N; history still lists/reads thread + artifacts", async () => {
    await acceptAndReady();

    const weekNApp = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    });
    const weekN = await json(
      await weekNApp.request("/weeks/current", { method: "POST" }),
    );
    expect(weekN.isoWeek).toBe("2026-W43");
    expect(weekN.archived).toBe(false);
    const weekNId = weekN.id as string;

    const posted = await weekNApp.request("/thread/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Notes from week N before handoff.",
        weekSessionId: weekNId,
      }),
    });
    expect(posted.status).toBe(201);

    await saveWeekRecap({
      at: new Date(),
      weekSessionId: weekNId,
      markdown: "# Weekly Recap — 2026-W43\n\nArchived-week fixture.",
      subjective: "skipped",
    });

    const weekNp1App = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-26T12:00:00.000Z")),
    });
    const weekNp1 = await json(
      await weekNp1App.request("/weeks/current", { method: "POST" }),
    );
    expect(weekNp1.isoWeek).toBe("2026-W44");
    expect(weekNp1.archived).toBe(false);
    expect(weekNp1.id).not.toBe(weekNId);

    const listed = await json(await weekNp1App.request("/weeks"));
    const weeks = listed.weeks as Array<Record<string, unknown>>;
    expect(weeks).toHaveLength(2);
    const live = weeks.find((w) => w.id === weekNp1.id);
    const archived = weeks.find((w) => w.id === weekNId);
    expect(live).toMatchObject({
      isoWeek: "2026-W44",
      archived: false,
      archivedAt: null,
    });
    expect(archived).toMatchObject({
      isoWeek: "2026-W43",
      archived: true,
    });
    expect(archived!.archivedAt).toBeTruthy();

    const history = await json(
      await weekNp1App.request(
        `/thread?weekSessionId=${encodeURIComponent(weekNId)}`,
      ),
    );
    const messages = history.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("Notes from week N before handoff.");
    expect(messages[0]!.weekSessionId).toBe(weekNId);

    const artifacts = history.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "weekly_recap",
      weekSessionId: weekNId,
      subjective: "skipped",
    });
    expect(String(artifacts[0]!.markdown)).toContain("2026-W43");

    const liveThread = await json(
      await weekNp1App.request(
        `/thread?weekSessionId=${encodeURIComponent(weekNp1.id as string)}`,
      ),
    );
    expect(liveThread.messages).toEqual([]);
    expect(liveThread.artifacts).toEqual([]);
  });

  it("new thread messages can attach to a week session", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    });

    const week = await json(await app.request("/weeks/current", { method: "POST" }));

    const posted = await app.request("/thread/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Mid-week note for this session.",
        weekSessionId: week.id,
      }),
    });
    expect(posted.status).toBe(201);
    const msg = await json(posted);
    expect(msg.weekSessionId).toBe(week.id);

    const filtered = await json(
      await app.request(`/thread?weekSessionId=${week.id as string}`),
    );
    const messages = filtered.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("Mid-week note for this session.");
    expect(messages[0]!.weekSessionId).toBe(week.id);
  });

  it("disclaimer gates week session endpoints", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/weeks")).status).toBe(403);
    expect(
      (await app.request("/weeks/current", { method: "POST" })).status,
    ).toBe(403);
  });

  it("ensureWeekSession creates a non-current week without archiving peers", async () => {
    const tz = "America/New_York";
    const current = await getOrCreateCurrentWeekSession(
      new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tz,
    );
    expect(current.created).toBe(true);
    expect(current.session.isoWeek).toBe("2026-W43");
    expect(current.session.archived).toBe(false);

    const future = await ensureWeekSession(new Date(), "2026-W44", tz);
    expect(future.created).toBe(true);
    expect(future.session.isoWeek).toBe("2026-W44");
    expect(future.session.timezone).toBe(tz);
    expect(future.session.archived).toBe(false);
    expect(future.session.start).toBe("2026-10-26T04:00:00.000Z");
    expect(future.session.end).toBe("2026-11-02T04:59:59.999Z");
    expect(future.session.id).not.toBe(current.session.id);

    const listed = await listWeekSessions();
    expect(listed).toHaveLength(2);
    const live = listed.find((w) => w.id === current.session.id);
    const rebuild = listed.find((w) => w.id === future.session.id);
    expect(live).toMatchObject({
      isoWeek: "2026-W43",
      archived: false,
      archivedAt: null,
    });
    expect(rebuild).toMatchObject({
      isoWeek: "2026-W44",
      archived: false,
      archivedAt: null,
    });
  });

  it("ensureWeekSession is idempotent for the same iso week + timezone", async () => {
    const first = await ensureWeekSession(new Date(), "2026-W44", "America/New_York");
    expect(first.created).toBe(true);

    const second = await ensureWeekSession(new Date(), "2026-W44", "America/New_York");
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.isoWeek).toBe(first.session.isoWeek);
    expect(second.session.start).toBe(first.session.start);
    expect(second.session.end).toBe(first.session.end);
    expect(second.session.archived).toBe(false);

    expect(await listWeekSessions()).toHaveLength(1);
  });
});
