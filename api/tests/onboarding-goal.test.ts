import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import {
  getOnboardingAnswers,
  saveOnboardingAnswers,
} from "../src/onboarding/store.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const SCHEDULE = "Free to run on Tue, Thu, Sat.";

function app() {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
  });
}

async function postAnswers(body: unknown) {
  return app().request("/onboarding/answers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function goalRows() {
  const result = await pool.query(
    "SELECT kind, distance, race_name, to_char(race_date, 'YYYY-MM-DD') AS race_date, source FROM training_goals ORDER BY id",
  );
  return result.rows;
}

describe("onboarding stores the structured goal", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    await acceptAndReady();
  });

  // The sentences the page wrote before the API took over, byte for byte.
  const cases = [
    {
      name: "a race with a date",
      goal: {
        kind: "race",
        distance: "other",
        raceName: "Half marathon",
        raceDate: "2027-01-16",
      },
      sentence: "Race: Half marathon on Sat Jan 16 2027.",
      row: {
        kind: "race",
        distance: "other",
        race_name: "Half marathon",
        race_date: "2027-01-16",
      },
    },
    {
      name: "another race with a date",
      goal: {
        kind: "race",
        distance: "marathon",
        raceName: "  Lakeshore Marathon ",
        raceDate: "2026-11-15",
      },
      sentence: "Race: Lakeshore Marathon on Sun Nov 15 2026.",
      row: {
        kind: "race",
        distance: "marathon",
        race_name: "Lakeshore Marathon",
        race_date: "2026-11-15",
      },
    },
    {
      name: "a race without a date",
      goal: { kind: "race", distance: "other", raceName: "X", raceDate: "" },
      sentence: "Race: X, date not set yet.",
      row: { kind: "race", distance: "other", race_name: "X", race_date: null },
    },
    {
      name: "a race with a target in the athlete's words",
      goal: {
        kind: "race",
        distance: "half",
        raceName: "Lakeshore Half",
        raceDate: "2027-03-07",
        target: " under 2 hours ",
      },
      sentence: "Race: Lakeshore Half on Sun Mar 7 2027, target under 2 hours.",
      row: {
        kind: "race",
        distance: "half",
        race_name: "Lakeshore Half",
        race_date: "2027-03-07",
      },
    },
    {
      name: "a race with a target and no date",
      goal: { kind: "race", distance: "10k", raceName: "Turkey Trot", target: "sub 50." },
      sentence: "Race: Turkey Trot, date not set yet, target sub 50.",
      row: { kind: "race", distance: "10k", race_name: "Turkey Trot", race_date: null },
    },
    {
      name: "speed with a target",
      goal: { kind: "speed", distance: "10k", target: "under 45 minutes" },
      sentence: "Working on 10k speed, target under 45 minutes.",
      row: { kind: "speed", distance: "10k", race_name: null, race_date: null },
    },
    {
      name: "speed with the distance alone",
      goal: { kind: "speed", distance: "5k", target: "", raceDate: "" },
      sentence: "Working on 5k speed.",
      row: { kind: "speed", distance: "5k", race_name: null, race_date: null },
    },
    {
      name: "speed with a target and a next race date",
      goal: { kind: "speed", distance: "5k", target: "a 5k under 20 minutes", raceDate: "2027-01-16" },
      sentence: "Working on 5k speed, target a 5k under 20 minutes, next race on Sat Jan 16 2027.",
      row: { kind: "speed", distance: "5k", race_name: null, race_date: "2027-01-16" },
    },
    {
      name: "speed with a next race date and no target",
      goal: { kind: "speed", distance: "10k", raceDate: "2027-01-16" },
      sentence: "Working on 10k speed, next race on Sat Jan 16 2027.",
      row: { kind: "speed", distance: "10k", race_name: null, race_date: "2027-01-16" },
    },
    {
      name: "getting back to running, the choice alone",
      goal: { kind: "return" },
      sentence: "Getting back to running.",
      row: { kind: "return", distance: null, race_name: null, race_date: null },
    },
    {
      name: "getting back to running, with where they are now and since when",
      goal: {
        kind: "return",
        startingPoint: " off for six weeks, cleared by my physio ",
        since: "2026-09-28",
      },
      sentence:
        "Getting back to running since Mon Sep 28 2026: off for six weeks, cleared by my physio.",
      row: { kind: "return", distance: null, race_name: null, race_date: null },
    },
    {
      name: "getting back to running, in their own words with no date",
      goal: { kind: "return", startingPoint: "Running 15 minutes three times a week!", since: "" },
      sentence: "Getting back to running: Running 15 minutes three times a week!",
      row: { kind: "return", distance: null, race_name: null, race_date: null },
    },
    {
      name: "getting back to running, a date and no words",
      goal: { kind: "return", since: "2026-09-28" },
      sentence: "Getting back to running since Mon Sep 28 2026.",
      row: { kind: "return", distance: null, race_name: null, race_date: null },
    },
    {
      name: "general fitness",
      goal: { kind: "fitness" },
      sentence: "General fitness, no race planned.",
      row: { kind: "fitness", distance: null, race_name: null, race_date: null },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: stores the sentence and a goal row from onboarding`, async () => {
      const res = await postAnswers({
        answers: { schedule: SCHEDULE, preferences: "Trails" },
        goal: c.goal,
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      const answers = body.answers as Record<string, string>;
      expect(answers.goal).toBe(c.sentence);
      expect(answers).toEqual({
        goal: c.sentence,
        schedule: SCHEDULE,
        preferences: "Trails",
      });

      // The gate hands the same stored answers to the first About you draft.
      const gate = await json(await app().request("/onboarding"));
      expect((gate.answers as { goal: string }).goal).toBe(c.sentence);

      expect(await goalRows()).toEqual([{ ...c.row, source: "onboarding" }]);
      const current = await json(await app().request("/goal"));
      expect(current.source).toBe("onboarding");
      expect((current.goal as { kind: string }).kind).toBe(c.goal.kind);
    });
  }

  it("keeps the return answer on the goal record", async () => {
    const res = await postAnswers({
      answers: { schedule: SCHEDULE },
      goal: { kind: "return", startingPoint: "off for six weeks", since: "2026-09-28" },
    });
    expect(res.status).toBe(201);
    const current = await json(await app().request("/goal"));
    expect(current.goal).toEqual({
      kind: "return",
      startingPoint: "off for six weeks",
      since: "2026-09-28",
    });
  });

  it("ignores a text goal in the answers: the sentence comes from the record", async () => {
    const res = await postAnswers({
      answers: { goal: "Something I typed", schedule: SCHEDULE },
      goal: { kind: "fitness" },
    });
    expect(res.status).toBe(201);
    expect(((await json(res)).answers as { goal: string }).goal).toBe(
      "General fitness, no race planned.",
    );
  });

  it("accepts the goal among the answers when the body is the answers", async () => {
    const res = await postAnswers({ goal: { kind: "fitness" }, schedule: SCHEDULE });
    expect(res.status).toBe(201);
    expect(await goalRows()).toHaveLength(1);
  });

  const refused: Array<[string, unknown, string]> = [
    ["no goal", { answers: { schedule: SCHEDULE } }, "goal_required"],
    ["a null goal", { answers: { schedule: SCHEDULE }, goal: null }, "goal_required"],
    [
      "a text goal",
      { answers: { schedule: SCHEDULE }, goal: "Half marathon in April" },
      "goal_object_required",
    ],
    [
      "an unknown kind",
      { answers: { schedule: SCHEDULE }, goal: { kind: "ultra" } },
      "invalid_goal_kind",
    ],
    [
      "a race without a distance",
      { answers: { schedule: SCHEDULE }, goal: { kind: "race", raceName: "X" } },
      "goal_distance_required",
    ],
    [
      "a race without a name",
      { answers: { schedule: SCHEDULE }, goal: { kind: "race", distance: "10k" } },
      "race_name_required",
    ],
    [
      "a malformed race date",
      {
        answers: { schedule: SCHEDULE },
        goal: { kind: "race", distance: "10k", raceName: "X", raceDate: "Jan 16" },
      },
      "invalid_race_date",
    ],
  ];

  for (const [name, body, error] of refused) {
    it(`refuses ${name} and writes nothing`, async () => {
      const res = await postAnswers(body);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe(error);
      expect(await goalRows()).toEqual([]);
      expect((await json(await app().request("/onboarding"))).status).toBe(
        "needs_onboarding",
      );
    });
  }

  it("a missing schedule is still refused after a valid goal", async () => {
    const res = await postAnswers({ answers: {}, goal: { kind: "fitness" } });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("schedule_required");
    expect(await goalRows()).toEqual([]);
  });

  it("the answers and the goal row are written together or not at all", async () => {
    // A race with no distance gets past no parser, but the table refuses it: the answers
    // written just before must roll back with it.
    await expect(
      saveOnboardingAnswers(
        new Date("2026-10-30T12:00:00Z"),
        { goal: "Race: X, date not set yet.", schedule: SCHEDULE },
        { kind: "race", raceName: "X" },
      ),
    ).rejects.toThrow();
    expect(await getOnboardingAnswers()).toBeNull();
    expect(await goalRows()).toEqual([]);
  });
});
