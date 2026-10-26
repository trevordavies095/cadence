import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  buildStubDossierV1,
  createStubLlmPort,
  validateDossierV1Draft,
  type DossierV1Input,
  type LlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const SAMPLE_ANSWERS = {
  goal: "Half marathon in April",
  schedule: "Tue/Thu/Sat, ~5 hrs/week",
  injuries_constraints: "Left calf tight after hills",
  preferences: "Long run Saturday, prefer trails",
};

function sampleInput(overrides?: Partial<DossierV1Input>): DossierV1Input {
  return {
    answers: SAMPLE_ANSWERS,
    prefills: {
      available: true,
      unitPreference: "imperial",
      heartRateZones: {
        zones: [
          { zoneNumber: 1, minBpm: 120, maxBpm: 140 },
          { zoneNumber: 2, minBpm: 150, maxBpm: 160 },
        ],
      },
      shoes: [{ brand: "ASICS", model: "Nimbus 28" }],
      recentTraining: [
        { name: "Easy", distanceM: 8000, runType: "easy" },
      ],
    },
    ...overrides,
  };
}

describe("stub dossier v1 builder", () => {
  it("is deterministic and includes coach stance", () => {
    const input = sampleInput();
    const a = buildStubDossierV1(input);
    const b = buildStubDossierV1(input);
    expect(a).toEqual(b);

    const validated = validateDossierV1Draft(a);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.summaryBullets[0]).toContain("Half marathon");
    expect(validated.value.proposedBody).toMatch(/do not diagnose/i);
    expect(validated.value.proposedBody).toContain("Left calf");
    expect(validated.value.proposedBody).toMatch(/ASICS/);
  });

  it("createStubLlmPort.generateDossierV1 is deterministic", async () => {
    const port = createStubLlmPort();
    const input = sampleInput();
    const a = await port.generateDossierV1(input);
    const b = await port.generateDossierV1(input);
    expect(a).toEqual(b);
  });

  it("truncates long free-text answers in summary bullets (full text in body)", async () => {
    const longPreferences = [
      "Long runs on Saturdays are a must.",
      "I want this training block to be gentle enough to ease me back into training post marathon, while eventually getting challenging as we peak for the Half Marathon. The number one goal is to prevent injury and burnout.",
      "",
      "Easy runs: ASICS Nimbus 28",
    ].join("\n");
    expect(`Preferences: ${longPreferences}`.length).toBeGreaterThan(280);

    const port = createStubLlmPort();
    const draft = await port.generateDossierV1(
      sampleInput({
        answers: {
          ...SAMPLE_ANSWERS,
          goal: longPreferences,
          preferences: longPreferences,
        },
      }),
    );

    for (const bullet of draft.summaryBullets) {
      expect(bullet.length).toBeLessThanOrEqual(280);
    }
    expect(draft.proposedBody).toContain("ASICS Nimbus 28");
    expect(draft.proposedBody).toContain("prevent injury and burnout");
  });
});

describe("onboarding → stub LLM dossier v1 proposal + Accept", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("completing onboarding creates a pending dossier proposal", async () => {
    await acceptAndReady();
    const tempoPort = createExportTempoPort({ exportPath: FIXTURE_ZIP });
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort,
      llmPort: createStubLlmPort(),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const created = await app.request("/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: SAMPLE_ANSWERS,
        weekSessionId: week.id,
      }),
    });
    expect(created.status).toBe(201);
    const body = await json(created);

    expect(body.status).toBe("ready");
    const proposal = body.proposal as {
      id: number;
      status: string;
      summaryBullets: string[];
      proposedBody: string;
    };
    expect(proposal.status).toBe("pending");
    expect(proposal.summaryBullets.length).toBeGreaterThan(0);
    expect(proposal.summaryBullets[0]).toContain("Half marathon");
    expect(proposal.proposedBody).toMatch(/do not diagnose/i);

    const coachMessage = body.coachMessage as {
      role: string;
      body: string;
      weekSessionId: string | null;
    };
    expect(coachMessage.role).toBe("coach");
    expect(coachMessage.body).toContain("Summary:");
    expect(coachMessage.body).toContain("Half marathon");
    expect(coachMessage.weekSessionId).toBe(week.id);

    const llm = body.llm as {
      mode: string;
      anthropicConfigured: boolean;
      systemStance: string;
    };
    expect(llm.mode).toBe("stub");
    expect(llm.anthropicConfigured).toBe(false);
    expect(llm.systemStance).toBe("coach_running_no_diagnose");

    const pending = await json(await app.request("/dossier/proposals"));
    const proposals = pending.proposals as Array<{ id: number }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.id).toBe(proposal.id);

    // Coach summary is attached to the week (thread list may also surface artifacts).
    expect(coachMessage.body).toContain("Here is what I understood");
    expect(coachMessage.weekSessionId).toBe(week.id);
  });

  it("accept installs dossier v1; current dossier readable", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });

    const created = await json(
      await app.request("/onboarding/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(SAMPLE_ANSWERS),
      }),
    );
    const proposalId = (created.proposal as { id: number }).id;

    const acceptRes = await app.request(
      `/dossier/proposals/${proposalId}/accept`,
      { method: "POST" },
    );
    expect(acceptRes.status).toBe(200);
    const accepted = await json(acceptRes);
    expect((accepted.proposal as { status: string }).status).toBe("accepted");
    expect((accepted.version as { body: string }).body).toContain(
      "Half marathon",
    );

    const current = await json(await app.request("/dossier"));
    expect((current.current as { body: string }).body).toContain(
      "Half marathon",
    );
    expect((current.current as { body: string }).body).toMatch(
      /do not diagnose/i,
    );

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    const gate = await json(await app.request("/onboarding"));
    expect(gate.status).toBe("complete");
    expect(gate.dossierVersionId).toBeTruthy();
  });

  it("week-loop seam: onboard → accept → dossier current readable", async () => {
    await acceptAndReady();
    let dossierCalls = 0;
    const stub = createStubLlmPort();
    const llmPort: LlmPort = {
      generateWeeklyReply: (p) => stub.generateWeeklyReply(p),
      generateMidWeekChatReply: (p) => stub.generateMidWeekChatReply(p),
      generateDossierCorrection: (i) => stub.generateDossierCorrection(i),
      generateDossierAudit: (i) => stub.generateDossierAudit(i),
      async generateDossierV1(input) {
        dossierCalls += 1;
        return stub.generateDossierV1(input);
      },
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort,
    });

    const onboard = await json(
      await app.request("/onboarding/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: "10k PR",
          schedule: "MWF",
        }),
      }),
    );
    expect(dossierCalls).toBe(1);
    const proposalId = (onboard.proposal as { id: number }).id;

    await app.request(`/dossier/proposals/${proposalId}/accept`, {
      method: "POST",
    });

    const dossier = await json(await app.request("/dossier"));
    expect(dossier.current).not.toBeNull();
    expect((dossier.current as { body: string }).body).toContain("10k PR");
    expect((dossier.current as { body: string }).body).toContain("MWF");
  });
});
