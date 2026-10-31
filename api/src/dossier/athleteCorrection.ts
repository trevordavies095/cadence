import { randomUUID } from "node:crypto";
import type { Clock } from "../clock/clock.js";
import {
  formatDossierCorrectionThreadBody,
  type LlmPort,
} from "../llm/index.js";
import {
  createAthleteMessage,
  createCoachMessage,
  type ThreadMessage,
} from "../thread/store.js";
import { createProposalFromCorrection } from "./fromCorrection.js";
import {
  listPendingDossierProposals,
  rejectWaitingDossierProposals,
  type DossierProposal,
} from "./proposals.js";
import { getCurrentDossier } from "./store.js";

/** The About you text a correction rewrites. */
export type CorrectionBase = { id: number; body: string };

/**
 * What an athlete correction rewrites: the installed About you, or with none yet the
 * first draft still waiting for Looks right. Null when there is nothing to correct.
 */
export async function loadCorrectionBase(): Promise<CorrectionBase | null> {
  const installed = await getCurrentDossier();
  if (installed) return { id: installed.id, body: installed.body };
  const waitingDraft =
    (await listPendingDossierProposals())
      .filter((p) => p.kind === "onboarding")
      .at(-1) ?? null;
  return waitingDraft ? { id: 0, body: waitingDraft.proposedBody } : null;
}

export type AthleteCorrectionResult = {
  athleteMessage: ThreadMessage;
  coachMessage: ThreadMessage;
  dossierProposal: DossierProposal;
  /** The correction applies straight away; this is the version it installed. */
  dossierVersionId: number | null;
};

/**
 * Fix something: post the athlete's sentence, have the model rewrite About you, apply the
 * rewrite as a correction note and post the coach's note message. Throws LlmSchemaError
 * when the model's draft is unusable; the athlete message is already posted then.
 */
export async function applyAthleteCorrection(input: {
  text: string;
  base: CorrectionBase;
  weekSessionId: string | null;
  isoWeek: string | null;
  llmPort: LlmPort;
  clock: Clock;
}): Promise<AthleteCorrectionResult> {
  const { text, base, weekSessionId, isoWeek, llmPort, clock } = input;
  const athleteMessage = await createAthleteMessage(clock.now(), text, weekSessionId);

  const callId = randomUUID();
  const draft = await llmPort.generateDossierCorrection(
    {
      athleteMessage: text,
      currentDossier: { versionId: base.id, body: base.body },
      week: isoWeek ? { isoWeek } : null,
    },
    { callId, weekSessionId },
  );

  const dossierProposal = await createProposalFromCorrection({
    summaryBullets: draft.summaryBullets,
    proposedBody: draft.proposedBody,
    at: clock.now(),
  });

  // Anything still waiting for a yes was drafted from older text.
  await rejectWaitingDossierProposals(clock.now());

  const coachMessage = await createCoachMessage(
    clock.now(),
    formatDossierCorrectionThreadBody(draft),
    weekSessionId,
    callId,
    null,
    dossierProposal.id,
  );

  return {
    athleteMessage,
    coachMessage,
    dossierProposal,
    dossierVersionId: dossierProposal.appliedVersionId,
  };
}
