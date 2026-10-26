import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { resolveAppVersion } from "../src/llmCallLog/appVersion.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket } from "../src/packet/index.js";
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

const DOSSIER = `# Athlete dossier

## Current Status
Post-marathon recovery week 2.

## Coach update (2026-W41)
- Achilles settling; keep quality light.

## Constraints
Chronic left Achilles flare.
`;

type Msg = Record<string, unknown>;
type App = ReturnType<typeof createApp>;

describe("LLM call log: stub port rows (#71)", () => {
  let prevProvider: string | undefined;

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    prevProvider = process.env.LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    return () => {
      if (prevProvider !== undefined) process.env.LLM_PROVIDER = prevProvider;
    };
  });

  async function setup(options?: { dossier?: boolean }) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    });
    if (options?.dossier !== false) {
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: DOSSIER }),
      });
    }
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, weekSessionId: week.id as string };
  }

  function post(app: App, url: string, body: unknown) {
    return app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function thread(app: App): Promise<Msg[]> {
    const listed = await json(await app.request("/thread"));
    return listed.messages as Msg[];
  }

  async function onlyCoachRow(app: App) {
    const coach = (await thread(app)).filter((m) => m.role === "coach");
    expect(coach).toHaveLength(1);
    const callId = coach[0]!.llmCallId as string;
    expect(callId).toMatch(/^[0-9a-f-]{36}$/);
    const res = await app.request(`/llm-calls/${callId}`);
    expect(res.status).toBe(200);
    return { callId, row: await json(res) };
  }

  function expectStubShape(row: Record<string, unknown>, callId: string) {
    expect(row).toMatchObject({
      id: callId,
      provider: "stub",
      appVersion: resolveAppVersion(),
      model: null,
      httpStatus: null,
      stopReason: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      outcome: "ok",
      errorMessage: null,
      parentCallId: null,
    });
    expect(typeof row.responseRaw).toBe("string");
    expect(() => JSON.parse(row.responseRaw as string)).not.toThrow();
  }

  it("records the weekly reply", async () => {
    const { app, weekSessionId } = await setup();
    await unlockPlanCheckIn(app, weekSessionId);
    const packet = buildModelPacket({
      dossier: { versionId: 1, body: DOSSIER },
      recapMarkdown: "## Summary\nSteady aerobic week.",
      thread: [],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
        weekSessionId,
      },
    });
    const res = await post(app, "/week/reply", { weekSessionId, packet });
    expect(res.status).toBe(200);

    const { callId, row } = await onlyCoachRow(app);
    expectStubShape(row, callId);
    expect(row.operation).toBe("weekly_reply");
    expect(row.weekSessionId).toBe(weekSessionId);
    expect(row.request).toBeTruthy();
  });

  it("records mid-week chat and leaves the athlete message unlinked", async () => {
    const { app, weekSessionId } = await setup();
    const res = await post(app, `/weeks/${weekSessionId}/chat`, {
      body: "Felt heavy today - should I cut Thursday?",
    });
    expect(res.status).toBe(201);

    const { callId, row } = await onlyCoachRow(app);
    expectStubShape(row, callId);
    expect(row.operation).toBe("mid_week_chat");
    expect(row.weekSessionId).toBe(weekSessionId);

    const athlete = (await thread(app)).filter((m) => m.role === "athlete");
    expect(athlete).toHaveLength(1);
    expect(athlete[0]!.llmCallId).toBeNull();
  });

  it("records onboarding dossier v1", async () => {
    // Onboarding only runs before a dossier is installed.
    const { app, weekSessionId } = await setup({ dossier: false });
    const answers = {
      goal: "Half marathon in April",
      schedule: "Tue/Thu/Sat",
      injuries_constraints: "Left calf tight",
      preferences: "Long run Saturday",
    };
    const res = await post(app, "/onboarding/answers", {
      answers,
      weekSessionId,
    });
    expect(res.status).toBe(201);

    const { callId, row } = await onlyCoachRow(app);
    expectStubShape(row, callId);
    expect(row.operation).toBe("dossier_v1");
    expect(row.weekSessionId).toBe(weekSessionId);
    expect((row.request as { answers: unknown }).answers).toEqual(answers);
    expect(JSON.parse(row.responseRaw as string)).toHaveProperty(
      "proposedBody",
    );
  });

  it("records dossier correction without a week session", async () => {
    const { app } = await setup();
    const text = "The dossier is wrong; add that I prefer morning runs.";
    const res = await post(app, "/dossier/corrections", { body: text });
    expect(res.status).toBe(201);

    const { callId, row } = await onlyCoachRow(app);
    expectStubShape(row, callId);
    expect(row.operation).toBe("dossier_correction");
    expect(row.weekSessionId).toBeNull();
    expect((row.request as { athleteMessage: string }).athleteMessage).toBe(
      text,
    );

    const athlete = (await thread(app)).filter((m) => m.role === "athlete");
    expect(athlete).toHaveLength(1);
    expect(athlete[0]!.llmCallId).toBeNull();
  });

  it("records dossier audit with a week session", async () => {
    const { app, weekSessionId } = await setup();
    const res = await post(app, "/dossier/audits", { weekSessionId });
    expect(res.status).toBe(201);

    const { callId, row } = await onlyCoachRow(app);
    expectStubShape(row, callId);
    expect(row.operation).toBe("dossier_audit");
    expect(row.weekSessionId).toBe(weekSessionId);
    expect(JSON.parse(row.responseRaw as string)).toHaveProperty(
      "proposedBody",
    );
  });

  it("records dossier audit without a week session", async () => {
    const { app } = await setup();
    const res = await post(app, "/dossier/audits", {});
    expect(res.status).toBe(201);

    const { callId, row } = await onlyCoachRow(app);
    expectStubShape(row, callId);
    expect(row.operation).toBe("dossier_audit");
    expect(row.weekSessionId).toBeNull();
  });
});
