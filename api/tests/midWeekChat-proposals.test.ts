import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { createStubLlmPort, type MidWeekChatReply } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const COACHING_NOTE =
  "Baseline easy volume capped after prior Achilles flare.";

describe("mid-week chat → coach notes applied straight away (#39, #102)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("applies a note straight away when the athlete shares something significant", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: `# Dossier\n\n${COACHING_NOTE}` }),
    });
    const before = await json(await app.request("/dossier"));
    const beforeId = (before.current as { id: number }).id;
    const beforeBody = (before.current as { body: string }).body;

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "My Achilles flared again after yesterday's easy run — keep volume capped.",
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);

    const proposal = body.dossierProposal as {
      id: number;
      status: string;
      summaryBullets: string[];
      proposedBody: string;
    };
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe("accepted");
    expect(proposal.summaryBullets.length).toBeGreaterThan(0);
    expect(proposal.summaryBullets[0]).toMatch(/Achilles|flared/i);
    expect(proposal.proposedBody).toContain(COACHING_NOTE);
    expect(proposal.proposedBody).toContain("Coach update");

    // Applied on the spot as a new version, and nothing is left waiting.
    const after = await json(await app.request("/dossier"));
    expect((after.current as { id: number }).id).toBeGreaterThan(beforeId);
    expect((after.current as { body: string }).body).toBe(proposal.proposedBody);
    expect((after.current as { body: string }).body).not.toBe(beforeBody);
    expect((after.current as { body: string }).body).toContain(beforeBody.trimEnd());

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    // The athlete can take it back.
    const undo = await app.request(`/dossier/proposals/${proposal.id}/undo`, {
      method: "POST",
    });
    expect(undo.status).toBe(200);
    const restored = await json(await app.request("/dossier"));
    expect((restored.current as { body: string }).body).toBe(beforeBody);
  });

  it("casual mid-week note does not create a proposal", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: `# Dossier\n\n${COACHING_NOTE}` }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Felt a bit heavy today — all good otherwise." }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.dossierProposal).toBeNull();

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);
  });

  it("a mid-week note never stands in the way of the next plan request", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: `# Dossier\n\n${COACHING_NOTE}` }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await unlockPlanCheckIn(app, week.id as string);
    const chat = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Skipping Thursday — sore calf niggle after the long run.",
      }),
    });
    expect(chat.status).toBe(201);
    expect((await json(chat)).dossierProposal).toBeTruthy();

    const plan = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: week.id,
        recapMarkdown: "## Summary\nPlanning right after the note.",
      }),
    });
    expect(plan.status).toBe(200);
  });

  it("injected stub mid-week reply with bullets applies a note", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: {
        ...createStubLlmPort(),
        async generateMidWeekChatReply(): Promise<MidWeekChatReply> {
          return {
            body: "Got it — I'll remember that.",
            settingsProposalBullets: [
              "Mid-week: athlete is traveling Fri–Sun; protect easy volume.",
            ],
          };
        },
      },
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: `# Dossier\n\n${COACHING_NOTE}` }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Heads up on travel." }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    const proposal = body.dossierProposal as {
      summaryBullets: string[];
      status: string;
    };
    expect(proposal.status).toBe("accepted");
    expect(proposal.summaryBullets).toEqual([
      "Mid-week: athlete is traveling Fri–Sun; protect easy volume.",
    ]);
  });
});
