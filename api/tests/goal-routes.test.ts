import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

function makeApp(at = "2026-10-21T15:00:00.000Z") {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date(at)),
  });
}

function put(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.request("/goal", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("training goal routes", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("disclaimer gates both routes", async () => {
    const app = makeApp();
    expect((await app.request("/goal")).status).toBe(403);
    expect((await put(app, { kind: "fitness" })).status).toBe(403);
  });

  it("GET /goal is 404 before any goal is stored", async () => {
    await acceptAndReady();
    const res = await makeApp().request("/goal");
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe("goal_not_found");
  });

  it("PUT /goal stores a race goal with source settings and GET reads it back", async () => {
    await acceptAndReady();
    const app = makeApp();
    const goal = {
      kind: "race",
      distance: "marathon",
      raceName: "Lakeshore Marathon",
      raceDate: "2026-11-15",
      target: "sub 3:30",
    };
    const res = await put(app, goal);
    expect(res.status).toBe(201);
    const saved = await json(res);
    expect(saved.goal).toEqual(goal);
    expect(saved.source).toBe("settings");
    expect(saved.createdAt).toBe("2026-10-21T15:00:00.000Z");

    const read = await app.request("/goal");
    expect(read.status).toBe(200);
    expect(await json(read)).toEqual(saved);
  });

  it("PUT accepts the goal wrapped in { goal }", async () => {
    await acceptAndReady();
    const res = await put(makeApp(), {
      goal: { kind: "return", startingPoint: "walk-run 1:1", since: "2026-10-01" },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).goal).toEqual({
      kind: "return",
      startingPoint: "walk-run 1:1",
      since: "2026-10-01",
    });
  });

  it("replacing appends a row; the latest is current and earlier rows are kept", async () => {
    await acceptAndReady();
    const first = makeApp("2026-10-21T15:00:00.000Z");
    expect(
      (await put(first, { kind: "race", distance: "half", raceDate: "2027-03-14" }))
        .status,
    ).toBe(201);
    const second = makeApp("2026-10-22T15:00:00.000Z");
    expect((await put(second, { kind: "fitness" })).status).toBe(201);

    const current = await json(await second.request("/goal"));
    expect(current.goal).toEqual({ kind: "fitness" });
    expect(current.createdAt).toBe("2026-10-22T15:00:00.000Z");

    const { rows } = await pool.query(
      "SELECT kind, source FROM training_goals ORDER BY id",
    );
    expect(rows).toEqual([
      { kind: "race", source: "settings" },
      { kind: "fitness", source: "settings" },
    ]);
  });

  it("rejects an unknown kind, a race without a distance, and malformed dates", async () => {
    await acceptAndReady();
    const app = makeApp();
    const cases: Array<[unknown, string]> = [
      ["not json", "invalid_json"],
      [[], "goal_object_required"],
      [{}, "invalid_goal_kind"],
      [{ kind: "ultra" }, "invalid_goal_kind"],
      [{ kind: "race" }, "goal_distance_required"],
      [{ kind: "race", distance: "15k" }, "invalid_goal_distance"],
      [{ kind: "race", distance: "half", raceDate: "15/03/2027" }, "invalid_race_date"],
      [{ kind: "race", distance: "half", raceDate: "2027-02-30" }, "invalid_race_date"],
      [{ kind: "return", since: "last spring" }, "invalid_since_date"],
      [{ kind: "fitness", target: 42 }, "invalid_target"],
      [{ kind: "race", distance: "5k", raceName: 7 }, "invalid_race_name"],
      [{ kind: "return", startingPoint: [] }, "invalid_starting_point"],
    ];
    for (const [body, error] of cases) {
      const res = await put(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).error, JSON.stringify(body)).toBe(error);
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM training_goals",
    );
    expect(rows[0].n).toBe(0);
  });

  it("accepts a race date in the past", async () => {
    await acceptAndReady();
    const res = await put(makeApp(), {
      kind: "race",
      distance: "10k",
      raceDate: "2026-09-01",
    });
    expect(res.status).toBe(201);
  });
});
