import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { ensureWeekSession } from "../src/week/store.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

function appAt(iso: string) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date(iso)),
    llmPort: createStubLlmPort(),
  });
}

async function listed(app: ReturnType<typeof appAt>) {
  const body = await json(await app.request("/weeks"));
  return body.weeks as Array<Record<string, unknown>>;
}

async function seedArchivedFutureWeek() {
  const early = appAt("2026-10-21T15:00:00.000Z");
  await early.request("/weeks/current", { method: "POST" });
  const future = await ensureWeekSession("2026-W44", "UTC");
  await pool.query(
    `UPDATE week_sessions SET archived_at = NOW() WHERE id = $1`,
    [future.session.id],
  );
  return future.session;
}

describe("week archiving (#77)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    await acceptAndReady();
  });

  it("starting the current week does not archive a future session", async () => {
    const app = appAt("2026-10-21T15:00:00.000Z");
    const current = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const future = await ensureWeekSession("2026-W44", "UTC");

    await app.request("/weeks/current", { method: "POST" });

    const weeks = await listed(app);
    expect(weeks.find((w) => w.id === future.session.id)).toMatchObject({
      archived: false,
      archivedAt: null,
    });
    expect(weeks.find((w) => w.id === current.id)).toMatchObject({
      archived: false,
    });
  });

  it("a formerly archived future week is live once it becomes current", async () => {
    const future = await seedArchivedFutureWeek();

    const later = appAt("2026-10-26T12:00:00.000Z");
    const res = await later.request("/weeks/current", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe(future.id);
    expect(body.archived).toBe(false);
    expect(body.archivedAt).toBeNull();

    const weeks = await listed(later);
    expect(weeks.find((w) => w.id === future.id)).toMatchObject({
      archived: false,
    });
  });

  it("earlier weeks are still archived", async () => {
    const early = appAt("2026-10-21T15:00:00.000Z");
    const prior = await json(
      await early.request("/weeks/current", { method: "POST" }),
    );
    const later = appAt("2026-10-26T12:00:00.000Z");
    await later.request("/weeks/current", { method: "POST" });

    const weeks = await listed(later);
    expect(weeks.find((w) => w.id === prior.id)).toMatchObject({
      archived: true,
    });
  });

  it("mid-week chat works on a formerly archived, now-current week", async () => {
    await seedArchivedFutureWeek();

    const later = appAt("2026-10-26T12:00:00.000Z");
    const week = await json(
      await later.request("/weeks/current", { method: "POST" }),
    );
    const res = await later.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Legs feel fresh this Monday." }),
    });
    expect(res.status).toBe(201);
  });
});
