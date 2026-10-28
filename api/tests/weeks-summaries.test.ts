import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { savePrescribedWeek } from "../src/prescribed/store.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoPort } from "../src/tempo/port.js";
import { headlineFromAnalysis } from "../src/week/summaries.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
// The fixture has runs on Tue Oct 20 and Thu Oct 22 (08:00 in New York), week 2026-W43.
const SUN = "2026-10-25T15:00:00.000Z";

type Summary = {
  id: string;
  isoWeek: string;
  localRange: string;
  actualDistanceM: number | null;
  runCount: number | null;
  coachHeadline: string | null;
};

const PLAN = {
  week: "2026-W44",
  days: [
    { date: "2026-10-26", dayType: "easy", run: { type: "easy", distanceM: 8000 } },
    { date: "2026-10-27", dayType: "rest", run: null },
    { date: "2026-10-28", dayType: "easy", run: { type: "easy", distanceM: 6000 } },
    { date: "2026-10-29", dayType: "rest", run: null },
    { date: "2026-10-30", dayType: "easy", run: { type: "easy", distanceM: 6000 } },
    { date: "2026-10-31", dayType: "rest", run: null },
    { date: "2026-11-01", dayType: "long", run: { type: "long", distanceM: 14000 } },
  ],
} as const;

describe("GET /weeks summaries (#109)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function setup(tempoPort?: TempoPort) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(SUN)),
      athleteTimezone: "America/New_York",
      tempoPort: tempoPort ?? createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    // Reading next week creates its session; it has no runs yet.
    const next = await json(await app.request(`/weeks/${week.id}/prescribed/next`));
    return { app, thisWeekId: week.id as string, nextWeekId: next.weekSession.id as string };
  }

  it("a week with runs carries its range, miles and runs; its plan supplies the headline", async () => {
    const { app, thisWeekId, nextWeekId } = await setup();
    // The coach's analysis is stored with the plan it came with, so 2026-W44's plan owns it.
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: nextWeekId,
      plan: PLAN as never,
      analysis: "## Headline\n\nSolid week. **Two good runs** and an easy finish.\n\n## Concerns\n\nNone.",
    });

    const body = await json(await app.request("/weeks"));
    const weeks = body.weeks as Summary[];
    const w43 = weeks.find((w) => w.id === thisWeekId)!;
    const w44 = weeks.find((w) => w.id === nextWeekId)!;
    expect(w43.localRange).toBe("Oct 19 – 25");
    expect(w43.runCount).toBe(2);
    expect(w43.actualDistanceM).toBeGreaterThan(0);
    // The headline sits on the week it describes. The week before, which has no plan of its
    // own here, does not borrow it.
    expect(w44.coachHeadline).toBe("Solid week. Two good runs and an easy finish.");
    expect(w43.coachHeadline).toBeNull();
    expect(body.tempoUnavailable).toBe(false);
  });

  it("a week that has its own plan shows that plan's headline, not the next week's", async () => {
    const { app, thisWeekId, nextWeekId } = await setup();
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: thisWeekId,
      plan: { ...PLAN, week: "2026-W43" } as never,
      analysis: "Easy week to settle in.\n\nMore detail.",
    });
    await savePrescribedWeek({
      at: new Date(),
      weekSessionId: nextWeekId,
      plan: PLAN as never,
      analysis: "Build begins.\n\nYour last week went well.",
    });
    const weeks = (await json(await app.request("/weeks"))).weeks as Summary[];
    expect(weeks.find((w) => w.id === thisWeekId)!.coachHeadline).toBe("Easy week to settle in.");
    expect(weeks.find((w) => w.id === nextWeekId)!.coachHeadline).toBe("Build begins.");
  });

  it("a week with neither runs nor a plan has zero runs and a null headline", async () => {
    const { app } = await setup();
    const body = await json(await app.request("/weeks"));
    const weeks = body.weeks as Summary[];
    // Newest first: the week after the fixture's runs comes before the week that has them.
    expect(weeks.map((w) => w.isoWeek)).toEqual(["2026-W44", "2026-W43"]);
    const w44 = weeks[0]!;
    expect(w44.localRange).toBe("Oct 26 – Nov 1");
    expect(w44.runCount).toBe(0);
    expect(w44.actualDistanceM).toBe(0);
    expect(w44.coachHeadline).toBeNull();
    // W43 has runs but no plan, so no headline either.
    expect(weeks[1]!.coachHeadline).toBeNull();
  });

  it("degrades to nulls and says so when Tempo cannot be read", async () => {
    const base = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const down: TempoPort = {
      ...base,
      listWorkouts: async () => {
        throw new Error("Tempo is unreachable");
      },
    };
    const { app } = await setup(down);
    const res = await app.request("/weeks");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.tempoUnavailable).toBe(true);
    for (const w of body.weeks as Summary[]) {
      expect(w.actualDistanceM).toBeNull();
      expect(w.runCount).toBeNull();
      expect(w.localRange).toMatch(/^[A-Z][a-z]{2} \d/);
    }
  });

  it("an empty list is fine", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(SUN)),
      athleteTimezone: "America/New_York",
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const body = await json(await app.request("/weeks"));
    expect(body).toEqual({ weeks: [], tempoUnavailable: false });
  });
});

describe("headlineFromAnalysis", () => {
  it("skips headings and takes the first paragraph as plain text", () => {
    expect(headlineFromAnalysis("# Read\n\n**Good** week, [see](http://x).\n\nMore.")).toBe(
      "Good week, see.",
    );
  });
  it("drops the stub's Headline label", () => {
    expect(headlineFromAnalysis("## Headline\nHeadline: Looks workable.\n\n## Concerns\nNone")).toBe(
      "Looks workable.",
    );
  });
  it("is null for empty or heading-only text", () => {
    expect(headlineFromAnalysis("")).toBeNull();
    expect(headlineFromAnalysis("## Only a heading")).toBeNull();
  });
});
