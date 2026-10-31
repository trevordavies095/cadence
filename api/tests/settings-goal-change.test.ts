import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { pool } from "../src/db.js";
import {
  createStubLlmPort,
  LlmSchemaError,
  type LlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const ABOUT_YOU = `# Athlete dossier

## Goal
Race: Lakeshore Marathon on Sun Nov 15 2026, target sub 3:30.
`;

function countingPort(failWith?: Error): {
  port: LlmPort;
  calls: () => number;
  texts: string[];
} {
  const stub = createStubLlmPort();
  let calls = 0;
  const texts: string[] = [];
  const port: LlmPort = {
    generateWeeklyReply: (p) => stub.generateWeeklyReply(p),
    generateMidWeekChatReply: (p) => stub.generateMidWeekChatReply(p),
    generateDossierV1: (i) => stub.generateDossierV1(i),
    generateDossierAudit: (i) => stub.generateDossierAudit(i),
    async generateDossierCorrection(input, ctx) {
      calls += 1;
      texts.push(input.athleteMessage);
      if (failWith) throw failWith;
      return stub.generateDossierCorrection(input, ctx);
    },
  };
  return { port, calls: () => calls, texts };
}

function makeApp(llmPort: LlmPort) {
  return createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    llmPort,
  });
}

function putGoal(app: ReturnType<typeof makeApp>, goal: unknown) {
  return app.request("/goal", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
}

async function installAboutYou(app: ReturnType<typeof makeApp>) {
  const res = await app.request("/dossier", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: ABOUT_YOU }),
  });
  expect(res.status).toBe(201);
}

async function counts() {
  const goals = await pool.query<{ source: string }>(
    "SELECT source FROM training_goals ORDER BY id",
  );
  const proposals = await pool.query<{ kind: string; status: string }>(
    "SELECT kind, status FROM dossier_proposals ORDER BY id",
  );
  return { goals: goals.rows, proposals: proposals.rows };
}

describe("changing the goal from Settings", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    await acceptAndReady();
  });

  it("PUT /goal creates one goal row and one correction that says the new goal", async () => {
    const { port, calls, texts } = countingPort();
    const app = makeApp(port);
    await installAboutYou(app);

    const res = await putGoal(app, { kind: "fitness" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.goal).toEqual({ kind: "fitness" });
    expect(body.source).toBe("settings");
    expect(body.sentence).toBe("General fitness, no race planned.");

    expect(calls()).toBe(1);
    expect(texts).toEqual(["My goal is now general fitness, no race planned."]);

    expect(await counts()).toEqual({
      goals: [{ source: "settings" }],
      proposals: [{ kind: "correction", status: "accepted" }],
    });

    const correction = body.correction as {
      athleteMessage: { role: string; body: string };
      coachMessage: { role: string };
      dossierProposal: { id: number; kind: string; proposedBody: string };
      dossierVersionId: number;
    };
    expect(correction.athleteMessage.role).toBe("athlete");
    expect(correction.athleteMessage.body).toBe(
      "My goal is now general fitness, no race planned.",
    );
    expect(correction.coachMessage.role).toBe("coach");
    expect(correction.dossierProposal.kind).toBe("correction");
    expect(correction.dossierProposal.proposedBody).toContain(
      "general fitness, no race planned",
    );

    // About you lists the note card for the change.
    const changes = await json(await app.request("/dossier/changes"));
    const ids = (changes.changes as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(correction.dossierProposal.id);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { id: number }).id).toBe(
      correction.dossierVersionId,
    );
  });

  it("accepts a race date in the past and says it in the correction", async () => {
    const { port, texts } = countingPort();
    const app = makeApp(port);
    await installAboutYou(app);

    const res = await putGoal(app, {
      kind: "race",
      distance: "10k",
      raceName: "Harbour 10k",
      raceDate: "2026-09-06",
    });
    expect(res.status).toBe(201);
    expect(texts).toEqual([
      "My goal is now race: Harbour 10k on Sun Sep 6 2026.",
    ]);
  });

  it("refuses a race without a name before anything is stored or sent", async () => {
    const { port, calls } = countingPort();
    const app = makeApp(port);
    await installAboutYou(app);

    const res = await putGoal(app, { kind: "race", distance: "half" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("race_name_required");
    expect(calls()).toBe(0);
    expect(await counts()).toEqual({ goals: [], proposals: [] });
  });

  it("stores no goal when the correction fails, so goal and About you never disagree", async () => {
    const { port } = countingPort(new LlmSchemaError("bad draft"));
    const app = makeApp(port);
    await installAboutYou(app);

    const res = await putGoal(app, { kind: "fitness" });
    expect(res.status).toBe(502);
    expect(await counts()).toEqual({ goals: [], proposals: [] });
  });

  it("with no About you yet, only the goal is stored", async () => {
    const { port, calls } = countingPort();
    const app = makeApp(port);

    const res = await putGoal(app, { kind: "fitness" });
    expect(res.status).toBe(201);
    expect((await json(res)).correction).toBeNull();
    expect(calls()).toBe(0);
    expect(await counts()).toEqual({
      goals: [{ source: "settings" }],
      proposals: [],
    });
  });

  it("GET /goal carries the sentence Settings shows", async () => {
    const { port } = countingPort();
    const app = makeApp(port);
    await putGoal(app, {
      kind: "race",
      distance: "marathon",
      raceName: "Lakeshore Marathon",
      raceDate: "2026-11-15",
    });
    const read = await json(await app.request("/goal"));
    expect(read.sentence).toBe("Race: Lakeshore Marathon on Sun Nov 15 2026.");
  });
});
