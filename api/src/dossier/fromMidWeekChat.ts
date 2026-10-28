import {
  createProposalFromWeeklyReply,
} from "./fromWeeklyReply.js";
import type { DossierProposal } from "./proposals.js";

/**
 * When a mid-week chat reply includes significant memory-update bullets,
 * create a pending soft-gate dossier proposal (issue #39). No-op when empty.
 * Reuses the weekly settings-bullet body builder — never silent-applies.
 */
export async function createProposalFromMidWeekChat(input: {
  settingsProposalBullets?: string[] | null;
  isoWeek?: string | null;
  at: Date;
}): Promise<DossierProposal | null> {
  return createProposalFromWeeklyReply({
    settingsProposalBullets: input.settingsProposalBullets,
    isoWeek: input.isoWeek,
    at: input.at,
  });
}
