import { formatIsoWeekRangeShort } from "../clock/weekRangeShort.js";
import {
  createDossierProposal,
  type DossierProposal,
} from "./proposals.js";
import { getCurrentDossier } from "./store.js";

/**
 * Build proposed dossier body from the current version + settings-proposal bullets.
 * Appends a dated coach-update section (training-log style) for soft-gate Accept.
 */
export function buildProposedBodyFromSettingsBullets(input: {
  currentBody: string | null | undefined;
  summaryBullets: string[];
  isoWeek?: string | null;
}): string {
  const bullets = input.summaryBullets.map((b) => b.trim()).filter(Boolean);
  const base = (input.currentBody ?? "").trimEnd();
  // The athlete reads these headings on About you: "Oct 12 – 18", never "2026-W42".
  const weekLabel = input.isoWeek?.trim()
    ? formatIsoWeekRangeShort(input.isoWeek)
    : "this week";
  const section = [
    `## Coach update (${weekLabel})`,
    "",
    ...bullets.map((b) => `- ${b}`),
  ].join("\n");

  if (!base) {
    return `# About you\n\n${section}\n`;
  }
  return `${base}\n\n${section}\n`;
}

/**
 * When a weekly reply includes settings-proposal bullets, create a pending
 * soft-gate dossier proposal (issue #31). No-op when bullets are empty.
 */
export async function createProposalFromWeeklyReply(input: {
  settingsProposalBullets?: string[] | null;
  isoWeek?: string | null;
  at: Date;
}): Promise<DossierProposal | null> {
  const bullets = (input.settingsProposalBullets ?? [])
    .map((b) => b.trim())
    .filter(Boolean);
  if (bullets.length === 0) return null;

  const current = await getCurrentDossier();
  const proposedBody = buildProposedBodyFromSettingsBullets({
    currentBody: current?.body,
    summaryBullets: bullets,
    isoWeek: input.isoWeek,
  });

  return createDossierProposal({
    summaryBullets: bullets,
    proposedBody,
    at: input.at,
  });
}
