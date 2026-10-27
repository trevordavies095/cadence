import {
  createDossierProposal,
  type DossierProposal,
} from "./proposals.js";

/**
 * Persist a soft-gate dossier proposal from an athlete correction rewrite (#18).
 */
export async function createProposalFromCorrection(input: {
  summaryBullets: string[];
  proposedBody: string;
  at: Date;
}): Promise<DossierProposal> {
  return createDossierProposal({
    summaryBullets: input.summaryBullets,
    proposedBody: input.proposedBody,
    kind: "correction",
    at: input.at,
  });
}
