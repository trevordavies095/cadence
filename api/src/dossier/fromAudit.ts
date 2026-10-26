import {
  createDossierProposal,
  type DossierProposal,
  type DossierProposalKind,
} from "./proposals.js";

/**
 * Persist a soft-gate dossier audit/trim proposal (#40).
 * Accept installs the trimmed body and updates lastAuditAt / next due.
 */
export async function createProposalFromAudit(input: {
  summaryBullets: string[];
  proposedBody: string;
}): Promise<DossierProposal> {
  const kind: DossierProposalKind = "audit";
  return createDossierProposal({
    summaryBullets: input.summaryBullets,
    proposedBody: input.proposedBody,
    kind,
  });
}
