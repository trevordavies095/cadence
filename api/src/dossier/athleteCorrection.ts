import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Clock } from "../clock/clock.js";
import { pool } from "../db.js";
import {
  formatDossierCorrectionThreadBody,
  type DossierCorrectionDraft,
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

/** The model's rewrite of About you, and the call log id that produced it. */
export type AthleteCorrectionDraft = {
  callId: string;
  draft: DossierCorrectionDraft;
};

/**
 * Have the model rewrite About you for the athlete's sentence. Writes nothing, so no
 * caller needs a transaction open while the model answers. Throws LlmSchemaError when
 * the model's draft is unusable.
 */
export async function draftAthleteCorrection(input: {
  text: string;
  base: CorrectionBase;
  weekSessionId: string | null;
  isoWeek: string | null;
  llmPort: LlmPort;
}): Promise<AthleteCorrectionDraft> {
  const { text, base, weekSessionId, isoWeek, llmPort } = input;
  const callId = randomUUID();
  const draft = await llmPort.generateDossierCorrection(
    {
      athleteMessage: text,
      currentDossier: { versionId: base.id, body: base.body },
      week: isoWeek ? { isoWeek } : null,
    },
    { callId, weekSessionId },
  );
  return { callId, draft };
}

/**
 * Write a drafted correction on the caller's `client`: the athlete's sentence (unless
 * `athleteMessage` says it is already posted), the applied note, the rejection of the
 * drafts it replaces and the coach's note message. They commit or fail with the caller's
 * transaction.
 */
export async function writeAthleteCorrection(
  input: {
    text: string;
    drafted: AthleteCorrectionDraft;
    weekSessionId: string | null;
    clock: Clock;
    athleteMessage?: ThreadMessage;
  },
  client: Pick<PoolClient, "query">,
): Promise<AthleteCorrectionResult> {
  const { text, drafted, weekSessionId, clock } = input;
  const athleteMessage =
    input.athleteMessage ??
    (await createAthleteMessage(clock.now(), text, weekSessionId, null, client));

  const dossierProposal = await createProposalFromCorrection(
    {
      summaryBullets: drafted.draft.summaryBullets,
      proposedBody: drafted.draft.proposedBody,
      at: clock.now(),
    },
    client,
  );

  // Anything still waiting for a yes was drafted from older text.
  await rejectWaitingDossierProposals(clock.now(), client);

  const coachMessage = await createCoachMessage(
    clock.now(),
    formatDossierCorrectionThreadBody(drafted.draft),
    weekSessionId,
    drafted.callId,
    null,
    dossierProposal.id,
    "chat",
    null,
    client,
  );

  return {
    athleteMessage,
    coachMessage,
    dossierProposal,
    dossierVersionId: dossierProposal.appliedVersionId,
  };
}

/**
 * Fix something: post the athlete's sentence, have the model rewrite About you, then
 * apply the rewrite as a correction note and post the coach's note message in one
 * transaction. Throws LlmSchemaError when the model's draft is unusable. The athlete
 * message is posted first and stays when the draft or its writes fail.
 */
export async function applyAthleteCorrection(input: {
  text: string;
  base: CorrectionBase;
  weekSessionId: string | null;
  isoWeek: string | null;
  llmPort: LlmPort;
  clock: Clock;
}): Promise<AthleteCorrectionResult> {
  const { text, weekSessionId, clock } = input;
  const athleteMessage = await createAthleteMessage(clock.now(), text, weekSessionId);
  const drafted = await draftAthleteCorrection(input);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await writeAthleteCorrection(
      { text, drafted, weekSessionId, clock, athleteMessage },
      client,
    );
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
