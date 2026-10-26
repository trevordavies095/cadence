import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { createStubLlmPort, type WeeklyReply } from "../src/llm/index.js";
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

const COACHING_NOTE =
  "Chronic left Achilles flare after long downhill — keep easy volume capped.";

describe("weekly reply → coach notes applied straight away (#31, #102)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function replyWithNotes() {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });

    const before = await json(
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: `# Dossier\n\n${COACHING_NOTE}` }),
      }),
    );

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    await unlockPlanCheckIn(app, week.id as string);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: week.id,
        recapMarkdown: "## Summary\nSteady aerobic week.",
      }),
    });
    expect(res.status).toBe(200);
    return { app, week, before: before as { id: number; body: string }, body: await json(res) };
  }

  it("the coach's notes from the reply are applied, not left waiting", async () => {
    const { app, before, body } = await replyWithNotes();
    const reply = body.reply as WeeklyReply;
    expect(reply.settingsProposalBullets?.length).toBeGreaterThan(0);

    const proposal = body.dossierProposal as {
      id: number;
      kind: string;
      status: string;
      summaryBullets: string[];
      proposedBody: string;
      appliedVersionId: number;
      previousVersionId: number;
    };
    expect(proposal.kind).toBe("settings");
    expect(proposal.status).toBe("accepted");
    expect(proposal.summaryBullets).toEqual(reply.settingsProposalBullets);
    expect(proposal.proposedBody).toContain(COACHING_NOTE);
    expect(proposal.proposedBody).toContain(proposal.summaryBullets[0]!);
    expect(proposal.previousVersionId).toBe(before.id);

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { id: number }).id).toBe(proposal.appliedVersionId);
    expect((current.current as { body: string }).body).toBe(proposal.proposedBody);
    expect((current.current as { body: string }).body).toContain("Coach update");
  });

  it("undoing the reply's notes restores the earlier text", async () => {
    const { app, before, body } = await replyWithNotes();
    const proposal = body.dossierProposal as { id: number };

    const undo = await app.request(`/dossier/proposals/${proposal.id}/undo`, {
      method: "POST",
    });
    expect(undo.status).toBe(200);
    const current = await json(await app.request("/dossier"));
    expect((current.current as { body: string }).body).toBe(before.body);
  });

  it("the reply's notes never stand in the way of the next plan request", async () => {
    const { app, week } = await replyWithNotes();

    const again = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId: week.id,
        recapMarkdown: "## Summary\nSecond look.",
      }),
    });
    expect(again.status).toBe(200);
  });
});
