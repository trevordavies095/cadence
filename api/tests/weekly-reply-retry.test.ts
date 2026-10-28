import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  createStubLlmPort,
  expectedPlanDates,
  LlmSchemaError,
  validateWeeklyReply,
  type LlmPort,
  type WeeklyReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
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
const WEEK_START = "2026-10-26";

function plan() {
  return {
    week: "2026-W44",
    days: expectedPlanDates(WEEK_START).map((date) => ({ date, dayType: "rest", run: null })),
  };
}

describe("a plan sent as a string", () => {
  const reply = (prescribedWeek: unknown) => ({
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek,
  });

  it("is parsed and accepted when the string is well-formed, with the repair noted", () => {
    const checked = validateWeeklyReply(reply(JSON.stringify(plan())), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.prescribedWeek.days).toHaveLength(7);
    expect(checked.repairs).toContain("prescribedWeek arrived as a string of JSON and was parsed");
  });

  it("is refused when the string is malformed", () => {
    const broken = JSON.stringify(plan()).replace('"rest","run":null}', '"rest","run":null}}');
    expect(validateWeeklyReply(reply(broken), WEEK_START).ok).toBe(false);
  });
});

describe("a refused weekly reply is asked for once more", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  /** A stub whose first replies fail in the given ways, then answer normally. */
  function flakyPort(failures: Array<"throws" | "invalid">) {
    const stub = createStubLlmPort();
    let calls = 0;
    const port: LlmPort = {
      ...stub,
      async generateWeeklyReply(packet, options) {
        const failure = failures[calls];
        calls += 1;
        if (failure === "throws") throw new LlmSchemaError("prescribedWeek must be an object");
        const reply = await stub.generateWeeklyReply(packet, options);
        if (failure === "invalid") return { ...reply, headline: "" } as WeeklyReply;
        return reply;
      },
    };
    return { port, calls: () => calls };
  }

  async function askForReply(port: LlmPort) {
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: port,
    });
    await acceptAndReady();
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    return app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: week.id, recapMarkdown: "## Summary\nSteady week." }),
    });
  }

  it("answers on the first try without asking again", async () => {
    const { port, calls } = flakyPort([]);
    expect((await askForReply(port)).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("recovers when the model's reply is refused the first time", async () => {
    const { port, calls } = flakyPort(["throws"]);
    const res = await askForReply(port);
    expect(res.status).toBe(200);
    expect((await json(res)).prescribed).toBeTruthy();
    expect(calls()).toBe(2);
  });

  it("recovers when the route's own check refuses the first reply", async () => {
    const { port, calls } = flakyPort(["invalid"]);
    expect((await askForReply(port)).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("asks only once more, then reports the failure", async () => {
    const { port, calls } = flakyPort(["throws", "throws", "throws"]);
    const res = await askForReply(port);
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("llm_schema_invalid");
    expect(calls()).toBe(2);
  });
});
