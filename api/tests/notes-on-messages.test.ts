import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { createStubLlmPort } from "../src/llm/index.js";
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

type App = ReturnType<typeof createApp>;
type Note = {
  id: number;
  kind: string;
  status: string;
  summaryBullets: string[];
  appliedVersionId: number | null;
  previousVersionId: number | null;
};
type Message = {
  id: string;
  role: string;
  llmCallId: string | null;
  dossierProposal: Note | null;
};

describe("a reply carries the note it produced (#103)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function open() {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    return { app, id: week.id as string };
  }

  const putProfile = (app: App, body = "# About you\n\nEasy base building.") =>
    app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });

  const post = (app: App, path: string, data: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });

  const messages = async (app: App, id: string) =>
    (await json(await app.request(`/thread?weekSessionId=${id}`))).messages as Message[];

  it("a mid-week reply that noted something points at its note, and the note follows undo", async () => {
    const { app, id } = await open();
    await putProfile(app);

    const res = await post(app, `/weeks/${id}/chat`, {
      body: "Skipping Thursday, sore calf niggle after the long run.",
    });
    expect(res.status).toBe(201);
    const sent = await json(res);
    const proposal = sent.dossierProposal as Note;
    const reply = sent.coachMessage as Message;
    expect(reply.dossierProposal).toMatchObject({
      id: proposal.id,
      kind: "settings",
      status: "accepted",
    });
    expect(reply.dossierProposal!.summaryBullets.length).toBeGreaterThan(0);

    const thread = await messages(app, id);
    const coach = thread.find((m) => m.role === "coach")!;
    expect(coach.dossierProposal).toMatchObject({ id: proposal.id, status: "accepted" });
    // What the athlete wrote is not a note.
    expect(thread.find((m) => m.role === "athlete")!.dossierProposal).toBeNull();

    await app.request(`/dossier/proposals/${proposal.id}/undo`, { method: "POST" });
    const after = (await messages(app, id)).find((m) => m.role === "coach")!;
    expect(after.dossierProposal).toMatchObject({ id: proposal.id, status: "undone" });
  });

  it("a reply that noted nothing carries no note", async () => {
    const { app, id } = await open();
    await putProfile(app);
    const res = await post(app, `/weeks/${id}/chat`, { body: "Felt good today." });
    expect(res.status).toBe(201);
    expect(((await json(res)).coachMessage as Message).dossierProposal).toBeNull();
    expect((await messages(app, id)).every((m) => m.dossierProposal === null)).toBe(true);
  });

  it("the weekly reply's message points at its note, found by the run's call", async () => {
    const { app, id } = await open();
    await putProfile(app);
    await unlockPlanCheckIn(app, id);

    const res = await post(app, "/week/reply", { weekSessionId: id });
    expect(res.status).toBe(200);
    const body = await json(res);
    const proposal = body.dossierProposal as Note;
    expect(proposal.status).toBe("accepted");

    const coach = (await messages(app, id)).find((m) => m.role === "coach")!;
    expect(coach.dossierProposal).toMatchObject({ id: proposal.id, kind: "settings" });
    expect(coach.llmCallId).toBeTruthy();
  });

  it("the onboarding draft and the tidy-up show as notes still waiting", async () => {
    const { app, id } = await open();
    const saved = await post(app, "/onboarding/answers", {
      answers: { schedule: "Tue Thu Sat" },
      goal: { kind: "race", distance: "half", raceName: "Half marathon in January" },
      weekSessionId: id,
    });
    expect(saved.status).toBe(201);
    const draft = (await messages(app, id)).find((m) => m.role === "coach")!;
    expect(draft.dossierProposal).toMatchObject({ kind: "onboarding", status: "pending" });

    // Install the profile, then ask for a tidy-up.
    await app.request(`/dossier/proposals/${draft.dossierProposal!.id}/accept`, {
      method: "POST",
    });
    const audit = await post(app, "/dossier/audits", { force: true, weekSessionId: id });
    expect(audit.status).toBe(201);
    const tidy = (await messages(app, id)).filter((m) => m.dossierProposal?.kind === "audit");
    expect(tidy).toHaveLength(1);
    expect(tidy[0]!.dossierProposal!.status).toBe("pending");
  });
});

describe("fixing something replaces what was waiting (#103)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  async function open() {
    await acceptAndReady();
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });
  }

  const post = (app: App, path: string, data: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });

  it("a correction to the first draft installs the corrected draft as the profile", async () => {
    const app = await open();
    await post(app, "/onboarding/answers", {
      answers: { schedule: "Tue Thu Sat" },
      goal: { kind: "race", distance: "half", raceName: "Half marathon in January" },
    });
    expect(
      ((await json(await app.request("/dossier"))).current as unknown),
    ).toBeNull();

    const res = await post(app, "/dossier/corrections", {
      body: "I can only run Mon Wed Fri.",
    });
    expect(res.status).toBe(201);
    const note = (await json(res)).dossierProposal as Note;
    expect(note).toMatchObject({ kind: "correction", status: "accepted", previousVersionId: null });

    const current = (await json(await app.request("/dossier"))).current as { body: string };
    expect(current.body).toContain("Half marathon in January");
    expect(current.body).toContain("I can only run Mon Wed Fri.");

    // The draft that was waiting is superseded, so a later yes cannot undo the fix.
    expect((await json(await app.request("/dossier/proposals"))).proposals).toEqual([]);
    const gate = await json(await app.request("/onboarding"));
    expect(gate.status).toBe("complete");
  });

  it("a correction replaces a tidy-up that was waiting", async () => {
    const app = await open();
    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# About you\n\nEasy base building." }),
    });
    const audit = await post(app, "/dossier/audits", { force: true });
    expect(audit.status).toBe(201);
    const waiting = (await json(audit)).dossierProposal as Note;
    expect(waiting.status).toBe("pending");

    expect((await post(app, "/dossier/corrections", { body: "I now run Mondays." })).status).toBe(
      201,
    );
    expect((await json(await app.request("/dossier/proposals"))).proposals).toEqual([]);
    // It is listed neither as applied nor waiting: it was set aside.
    const changes = (await json(await app.request("/dossier/changes"))).changes as Note[];
    expect(changes.map((c) => c.id)).not.toContain(waiting.id);
  });

  it("with no profile and no draft there is nothing to correct", async () => {
    const app = await open();
    const res = await post(app, "/dossier/corrections", { body: "Anything." });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("dossier_required");
  });
});
