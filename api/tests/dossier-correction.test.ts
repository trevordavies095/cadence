import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  anthropicCoachTarget,
  buildStubDossierCorrection,
  createAnthropicLlmPort,
  createStubLlmPort,
  LlmSchemaError,
  TESTED_COACH_MODEL,
  type LlmCallOptions,
  type LlmPort,
  validateDossierCorrectionDraft,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import {
  acceptAndReady,
  expectedErrorRetryTurns,
  fakeCoachServer,
  json,
  resetAppTables,
  retryTurns,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const BASE_DOSSIER = `# Athlete dossier

## Constraints
Chronic left Achilles flare — keep easy volume capped.
`;

const CORRECTION =
  "The dossier is wrong — Achilles is resolved. Add that I prefer morning runs.";

describe("athlete dossier correction → applied note (#18, #102)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("stub correction draft is deterministic and schema-valid", () => {
    const input = {
      athleteMessage: CORRECTION,
      currentDossier: { versionId: 1, body: BASE_DOSSIER },
      week: { isoWeek: "2026-W43" },
    };
    const a = buildStubDossierCorrection(input);
    const b = buildStubDossierCorrection(input);
    expect(a).toEqual(b);
    const checked = validateDossierCorrectionDraft(a);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.proposedBody).toContain("Achilles is resolved");
    expect(checked.value.proposedBody).toContain(BASE_DOSSIER.trim());
  });

  it("a correction applies straight away and comes back with its version ids", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });

    const put = await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: BASE_DOSSIER }),
    });
    expect(put.status).toBe(201);
    const versionId = ((await json(put)) as { id: number }).id;

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request("/dossier/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: CORRECTION,
        weekSessionId: week.id,
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);

    const proposal = body.dossierProposal as {
      id: number;
      kind: string;
      status: string;
      summaryBullets: string[];
      proposedBody: string;
      appliedVersionId: number;
      previousVersionId: number;
    };
    expect(proposal.kind).toBe("correction");
    expect(proposal.status).toBe("accepted");
    expect(proposal.summaryBullets.length).toBeGreaterThan(0);
    expect(proposal.proposedBody).toContain("Achilles is resolved");
    expect(proposal.proposedBody).toContain("morning runs");
    expect(proposal.previousVersionId).toBe(versionId);
    expect(proposal.appliedVersionId).toBeGreaterThan(versionId);
    expect(body.dossierVersionId).toBe(proposal.appliedVersionId);

    const athlete = body.athleteMessage as {
      role: string;
      body: string;
      weekSessionId: string | null;
    };
    expect(athlete.role).toBe("athlete");
    expect(athlete.body).toContain("Achilles is resolved");
    expect(athlete.weekSessionId).toBe(week.id);

    const coach = body.coachMessage as {
      role: string;
      body: string;
      weekSessionId: string | null;
    };
    expect(coach.role).toBe("coach");
    expect(coach.body).toContain("I've updated what I know about you");
    // The change is already made; the message must not ask for an approval.
    expect(coach.body).not.toContain("Accept");
    // The bullets are on the note card, not repeated in the message (#19).
    expect(coach.body).not.toContain("Summary:");
    expect(coach.weekSessionId).toBe(week.id);

    // Nothing waits, and the current version is the corrected one.
    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);
    const current = await json(await app.request("/dossier"));
    expect((current.current as { id: number }).id).toBe(
      proposal.appliedVersionId,
    );
    expect((current.current as { body: string }).body).toBe(
      proposal.proposedBody,
    );
  });

  it("undoing a correction puts the earlier text back as a new version", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });

    const put = await json(
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: BASE_DOSSIER }),
      }),
    );
    const prior = put as { id: number; body: string };

    const created = await json(
      await app.request("/dossier/corrections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: CORRECTION }),
      }),
    );
    const proposal = created.dossierProposal as {
      id: number;
      appliedVersionId: number;
    };

    const undoRes = await app.request(
      `/dossier/proposals/${proposal.id}/undo`,
      { method: "POST" },
    );
    expect(undoRes.status).toBe(200);
    const undone = await json(undoRes);
    expect((undone.proposal as { status: string }).status).toBe("undone");
    const version = undone.version as { id: number; body: string };
    expect(version.body).toBe(prior.body);
    expect(version.id).toBeGreaterThan(proposal.appliedVersionId);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { id: number }).id).toBe(version.id);
    expect((current.current as { body: string }).body).toBe(BASE_DOSSIER);
  });

  it("requires a current dossier and uses injected LlmPort", async () => {
    await acceptAndReady();
    let calls = 0;
    const stub = createStubLlmPort();
    const fake: LlmPort = {
      generateWeeklyReply: (p) => stub.generateWeeklyReply(p),
      generateMidWeekChatReply: (p) => stub.generateMidWeekChatReply(p),
      generateDossierV1: (i) => stub.generateDossierV1(i),
      generateDossierAudit: (i) => stub.generateDossierAudit(i),
      async generateDossierCorrection(input) {
        calls += 1;
        return stub.generateDossierCorrection(input);
      },
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      llmPort: fake,
    });

    const missing = await app.request("/dossier/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: CORRECTION }),
    });
    expect(missing.status).toBe(409);
    expect((await json(missing)).error).toBe("dossier_required");
    expect(calls).toBe(0);

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: BASE_DOSSIER }),
    });

    const ok = await app.request("/dossier/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: CORRECTION }),
    });
    expect(ok.status).toBe(201);
    expect(calls).toBe(1);
  });

  describe("through the live adapter, a draft refused for its shape is asked for once more", () => {
    const input = {
      athleteMessage: CORRECTION,
      currentDossier: { versionId: 1, body: BASE_DOSSIER },
      week: { isoWeek: "2026-W43" },
    };
    const refused = { summaryBullets: [], proposedBody: "" };

    function livePort(answers: unknown[]) {
      const server = fakeCoachServer("submit_about_you", answers);
      const port = createAnthropicLlmPort({
        fetchImpl: server.fetchImpl,
        recorder: server.recorder,
        resolveCoachTarget: async () => anthropicCoachTarget(TESTED_COACH_MODEL, "sk-ant-test"),
        apiUrl: "http://fake-anthropic.test/v1/messages",
      });
      return { port, ...server };
    }

    it("applies the second draft of a correction, sent with the validator's message, both attempts logged and linked", async () => {
      await acceptAndReady();
      await putAnthropicConnection("sk-ant-test", new SecretProtector(TEST_DATA_PROTECTION_KEY));
      const server = fakeCoachServer("submit_about_you", [refused, buildStubDossierCorrection(input)]);
      const app = createApp({
        dataProtectionKey: TEST_DATA_PROTECTION_KEY,
        clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
        llmPort: createAnthropicLlmPort({
          fetchImpl: server.fetchImpl,
          recorder: server.recorder,
          dataProtectionKey: TEST_DATA_PROTECTION_KEY,
          apiUrl: "http://fake-anthropic.test/v1/messages",
        }),
      });
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: BASE_DOSSIER }),
      });
      const res = await app.request("/dossier/corrections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: CORRECTION }),
      });
      expect(res.status).toBe(201);
      expect(((await json(res)).dossierProposal as { status: string }).status).toBe("accepted");
      expect(server.bodies).toHaveLength(2);
      expect(server.rows.map((r) => r.outcome)).toEqual(["schema_invalid", "ok"]);
      expect(retryTurns(server.bodies[0]!, server.bodies[1]!)).toEqual(
        expectedErrorRetryTurns("submit_about_you", refused, server.rows[0]!.errorMessage!),
      );
      expect(server.rows[1]!.parentCallId).toBe(server.rows[0]!.id);
    });

    it.each([
      ["first draft", (port: LlmPort, o: LlmCallOptions) => port.generateDossierV1({ answers: { goal: "Run a strong 10K.", schedule: "Four days a week." }, prefills: { available: false } }, o)],
      ["correction", (port: LlmPort, o: LlmCallOptions) => port.generateDossierCorrection(input, o)],
      ["tidy-up", (port: LlmPort, o: LlmCallOptions) =>
        port.generateDossierAudit({ currentDossier: input.currentDossier, week: null, nowIso: "2026-10-21T15:00:00.000Z", intervalWeeks: 4 }, o)],
    ] as const)("the %s is sent twice at most, the second carrying the validator's message", async (_label, call) => {
      const { port, bodies, rows } = livePort([refused]);
      await expect(call(port, { callId: "about-you-1" })).rejects.toBeInstanceOf(LlmSchemaError);
      expect(bodies).toHaveLength(2);
      expect(retryTurns(bodies[0]!, bodies[1]!)).toEqual(
        expectedErrorRetryTurns("submit_about_you", refused, rows[0]!.errorMessage!),
      );
      expect(rows.map((r) => r.outcome)).toEqual(["schema_invalid", "schema_invalid"]);
      // The caller's id names the attempt it was handed; the first links nowhere.
      expect(rows[1]).toMatchObject({ id: "about-you-1", parentCallId: rows[0]!.id });
      expect(rows[0]!.parentCallId).toBeNull();
    });
  });

  it("disclaimer gates dossier corrections", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect(
      (
        await app.request("/dossier/corrections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: CORRECTION }),
        })
      ).status,
    ).toBe(403);
  });
});
