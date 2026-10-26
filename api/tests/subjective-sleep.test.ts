import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { migrate } from "../src/migrate.js";
import { buildSubjectiveRecapMarkdown } from "../src/recap/formatSubjective.js";
import {
  parseSleepAvgHrs,
  parseSleepRangeHrs,
} from "../src/recap/sleepParse.js";
import {
  parseSleepAvgHrs as feAvg,
  parseSleepRangeHrs as feRange,
} from "../../frontend/lib/sleepParse";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

describe("sleep free-text parsing (#85)", () => {
  const avgCases: Array<[string, number | undefined]> = [
    ["8.38", 8.38],
    ["8.38 hrs", 8.38],
    ["about 7 hours", 7],
    ["lots", undefined],
    ["", undefined],
    ["99 hrs", undefined],
  ];
  const rangeCases: Array<[string, [number, number] | undefined]> = [
    ["7.65–9.08 h", [7.65, 9.08]],
    ["7.65-9.08", [7.65, 9.08]],
    ["7.65 to 9.08", [7.65, 9.08]],
    ["9.08 - 7.65", [7.65, 9.08]],
    ["7.65", undefined],
    ["varies", undefined],
  ];

  it.each(avgCases)("avg %j", (text, want) => {
    expect(parseSleepAvgHrs(text)).toBe(want);
    expect(feAvg(text)).toBe(want);
  });

  it.each(rangeCases)("range %j", (text, want) => {
    expect(parseSleepRangeHrs(text)).toEqual(want);
    expect(feRange(text)).toEqual(want);
  });
});

describe("buildSubjectiveRecapMarkdown sleep + strength notes (#85)", () => {
  it("prints range without average", () => {
    const md = buildSubjectiveRecapMarkdown({ sleep_range_hrs: [7.65, 9.08] });
    expect(md).toContain("Sleep range this week: 7.65–9.08 hrs");
    expect(md).not.toContain("Sleep avg");
  });

  it("does not double-wrap parenthesised strength notes", () => {
    const md = buildSubjectiveRecapMarkdown({
      strength_sessions: { completed: 0, planned: 0, notes: "(None planned.)" },
    });
    expect(md).toContain("Strength sessions completed: 0 of 0 (None planned.)");
    expect(md).not.toContain("((");
  });
});

describe("POST /weeks/:id/recap/subjective sleep (#85)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function postWeekly(weekly: Record<string, unknown>) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const res = await app.request(`/weeks/${week.id}/recap/subjective`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runs: [{ date: "2026-10-20", rpe: 4 }], weekly }),
    });
    return { app, id: week.id as string, res };
  }

  async function storedMarkdown(
    app: ReturnType<typeof createApp>,
    id: string,
  ) {
    const gate = await json(await app.request(`/weeks/${id}/recap`));
    expect(gate.status).toBe("report");
    return gate.reportMarkdown as string;
  }

  it("numbers render avg with range", async () => {
    const { app, id, res } = await postWeekly({
      sleep_avg_hrs: 8.38,
      sleep_range_hrs: [7.65, 9.08],
    });
    expect(res.status).toBe(201);
    expect(await storedMarkdown(app, id)).toContain(
      "Sleep avg this week: 8.38 hrs (range 7.65–9.08)",
    );
  });

  it("free-text strings with units are parsed", async () => {
    const { app, id, res } = await postWeekly({
      sleep_avg_hrs: "8.38 hrs",
      sleep_range_hrs: "7.65–9.08 h",
    });
    expect(res.status).toBe(201);
    expect(await storedMarkdown(app, id)).toContain(
      "Sleep avg this week: 8.38 hrs (range 7.65–9.08)",
    );
  });

  it("range without average still renders", async () => {
    const { app, id, res } = await postWeekly({
      sleep_range_hrs: "7.65 to 9.08",
    });
    expect(res.status).toBe(201);
    expect(await storedMarkdown(app, id)).toContain(
      "Sleep range this week: 7.65–9.08 hrs",
    );
  });

  it("unparsable sleep text is rejected", async () => {
    const { res } = await postWeekly({ sleep_avg_hrs: "plenty" });
    expect(res.status).toBe(400);
  });

  it("parenthesised strength notes are not double-wrapped", async () => {
    const { app, id, res } = await postWeekly({
      strength_sessions: { completed: 0, planned: 0, notes: "(None planned.)" },
    });
    expect(res.status).toBe(201);
    const md = await storedMarkdown(app, id);
    expect(md).toContain("Strength sessions completed: 0 of 0 (None planned.)");
    expect(md).not.toContain("((");
  });
});
