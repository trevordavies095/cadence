import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { isDossierAuditRequest } from "../src/dossier/auditMeta.js";
import {
  buildStubDossierAudit,
  createStubLlmPort,
  type LlmPort,
  validateDossierAuditDraft,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const BLOATED_DOSSIER = `# Athlete dossier

## Current Status
Post-marathon recovery week 2. Feet sore.

## Coach update (2026-W40)
- Achilles flared after Tuesday strides.
- Cap easy volume this week.

## Coach update (2026-W41)
- Achilles settling; keep quality light.
- Prefer morning runs.

## Constraints
Chronic left Achilles — monitor load.
`;

const CLOCK = new FixedClock(new Date("2026-10-21T15:00:00.000Z"));

describe("dossier audit/trim proposals (#40)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("detects ask-in-chat audit phrases", () => {
    expect(isDossierAuditRequest("Please audit my settings")).toBe(true);
    expect(isDossierAuditRequest("Can we run a settings audit?")).toBe(true);
    expect(isDossierAuditRequest("Trim my dossier — it's getting long")).toBe(
      true,
    );
    expect(isDossierAuditRequest("How is my Achilles today?")).toBe(false);
  });

  it("stub audit draft is deterministic, schema-valid, and trims coach updates", () => {
    const input = {
      currentDossier: { versionId: 1, body: BLOATED_DOSSIER },
      week: { isoWeek: "2026-W43" },
      nowIso: "2026-10-21T15:00:00.000Z",
      intervalWeeks: 5,
    };
    const a = buildStubDossierAudit(input);
    const b = buildStubDossierAudit(input);
    expect(a).toEqual(b);
    const checked = validateDossierAuditDraft(a);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.proposedBody).toMatch(/^## Current Status$/m);
    expect(checked.value.proposedBody).toContain("Tidied Wed Oct 21 (Oct 19 – 25).");
    expect(checked.value.proposedBody).toContain("Achilles flared");
    expect(checked.value.proposedBody).not.toMatch(/^## Coach update/m);
    expect(checked.value.proposedBody).toContain("- Last tidy-up: Wed Oct 21");
    expect(checked.value.proposedBody).toContain(
      "- Next one around Wed Nov 25 (every 5 weeks)",
    );
    expect(checked.value.proposedBody).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(buildStubDossierAudit({ ...input, currentDossier: { versionId: 2, body: a.proposedBody } })
      .proposedBody.match(/^## Tidy-ups$/gm)).toHaveLength(1);
    expect(checked.value.summaryBullets.length).toBeGreaterThan(0);
  });

  it("coach cadence path creates a pending audit proposal (stub)", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: CLOCK,
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: BLOATED_DOSSIER }),
    });

    const meta = await json(await app.request("/dossier/audit"));
    expect((meta.audit as { due: boolean }).due).toBe(true);

    const res = await app.request("/dossier/audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    const proposal = body.dossierProposal as {
      id: number;
      kind: string;
      status: string;
      summaryBullets: string[];
      proposedBody: string;
    };
    expect(proposal.status).toBe("pending");
    expect(proposal.kind).toBe("audit");
    expect(proposal.summaryBullets.length).toBeGreaterThan(0);
    expect(proposal.proposedBody).not.toMatch(/^## Coach update/m);
    expect(body.triggeredBy).toBe("cadence");

    const coach = body.coachMessage as { role: string; body: string };
    expect(coach.role).toBe("coach");
    expect(coach.body).toContain("Accept");

    const pending = await json(await app.request("/dossier/proposals"));
    expect((pending.proposals as unknown[]).length).toBe(1);
  });

  it("ask → proposal → accept applies trim and stamps lastAuditAt/next due", async () => {
    await acceptAndReady();
    let auditCalls = 0;
    const stub = createStubLlmPort();
    const fake: LlmPort = {
      generateWeeklyReply: (p) => stub.generateWeeklyReply(p),
      generateMidWeekChatReply: (p) => stub.generateMidWeekChatReply(p),
      generateDossierV1: (i) => stub.generateDossierV1(i),
      generateDossierCorrection: (i) => stub.generateDossierCorrection(i),
      async generateDossierAudit(input) {
        auditCalls += 1;
        return stub.generateDossierAudit(input);
      },
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: CLOCK,
      llmPort: fake,
    });

    const put = await json(
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: BLOATED_DOSSIER }),
      }),
    );
    const priorId = (put as { id: number }).id;

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const chat = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Please audit my settings" }),
    });
    expect(chat.status).toBe(201);
    expect(auditCalls).toBe(1);
    const chatBody = await json(chat);
    expect(chatBody.triggeredBy).toBe("ask_in_chat");

    const proposal = chatBody.dossierProposal as {
      id: number;
      kind: string;
      status: string;
      proposedBody: string;
    };
    expect(proposal.status).toBe("pending");
    expect(proposal.kind).toBe("audit");
    expect(proposal.proposedBody).toContain("Tidied Wed Oct 21");
    expect(proposal.proposedBody).not.toMatch(/^## Coach update/m);

    // No silent mutation until Accept.
    const before = await json(await app.request("/dossier"));
    expect((before.current as { id: number }).id).toBe(priorId);
    expect((before.audit as { lastAuditAt: string | null }).lastAuditAt).toBe(
      null,
    );
    expect((before.audit as { due: boolean }).due).toBe(true);

    const acceptRes = await app.request(
      `/dossier/proposals/${proposal.id}/accept`,
      { method: "POST" },
    );
    expect(acceptRes.status).toBe(200);
    const accepted = await json(acceptRes);
    expect((accepted.proposal as { status: string }).status).toBe("accepted");
    const version = accepted.version as { id: number; body: string };
    expect(version.id).toBeGreaterThan(priorId);
    expect(version.body).toBe(proposal.proposedBody);

    const audit = accepted.audit as {
      lastAuditAt: string;
      nextAuditDueAt: string;
      due: boolean;
      intervalWeeks: number;
    };
    expect(audit.lastAuditAt).toBe("2026-10-21T15:00:00.000Z");
    expect(audit.nextAuditDueAt).toBe("2026-11-25T15:00:00.000Z");
    expect(audit.due).toBe(false);
    expect(audit.intervalWeeks).toBe(5);

    const after = await json(await app.request("/dossier"));
    expect((after.current as { id: number }).id).toBe(version.id);
    expect((after.current as { body: string }).body).not.toMatch(
      /^## Coach update/m,
    );
    expect((after.audit as { due: boolean }).due).toBe(false);
    expect((after.audit as { lastAuditAt: string }).lastAuditAt).toBe(
      "2026-10-21T15:00:00.000Z",
    );

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    // Cadence gate: not due until next window (unless force).
    const blocked = await app.request("/dossier/audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe("audit_not_due");

    const forced = await app.request("/dossier/audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(201);
    expect((await json(forced)).triggeredBy).toBe("force");
  });

  it("requires a current dossier for cadence audits", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: CLOCK,
      llmPort: createStubLlmPort(),
    });
    const res = await app.request("/dossier/audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("dossier_required");
  });

  it("disclaimer gates dossier audits", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/dossier/audit")).status).toBe(403);
    expect(
      (
        await app.request("/dossier/audits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);
  });
});
