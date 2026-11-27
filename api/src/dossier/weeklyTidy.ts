/**
 * The weekly tidy of About you (GitHub issue #86): when a reply run starts
 * and About you has dated "Coach update" sections to fold in, Coach Cade
 * tidies it first, so the weekly read is written from the tidy text and the
 * read's own note is the only update left on the page.
 *
 * The tidy is the audit Coach Cade already had (the same prompt and tool); what
 * is new is that the weekly report asks for it. It is applied at once, with
 * Undo, like Coach Cade's weekly notes: in the proof of concept it was accepted
 * as written about 99 times in 100. For the other one there is a guard. A tidy
 * that drops a section about the athlete, or cuts the text sharply, is not
 * applied: it waits for Looks right, as the ask-in-chat tidy does.
 *
 * It is never in the way. Any failure leaves About you as it was and the read
 * goes ahead on that text; the tidy is tried again the next week.
 */
import { randomUUID } from "node:crypto";
import type { Clock } from "../clock/clock.js";
import { pool } from "../db.js";
import type { LlmPort } from "../llm/port.js";
import { createCoachMessage } from "../thread/store.js";
import type { WeekSession } from "../week/store.js";
import { createProposalFromAudit } from "./fromAudit.js";
import {
  acceptDossierProposal,
  listPendingDossierProposals,
  rejectDossierProposal,
  type DossierProposal,
} from "./proposals.js";
import { getCurrentDossier } from "./store.js";

/** On unless ABOUT_YOU_WEEKLY_TIDY is off (or 0, false, no). */
export function weeklyTidyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test(env.ABOUT_YOU_WEEKLY_TIDY?.trim() ?? "");
}

/** The tidied text may be no shorter than this share of the sections about the athlete. */
export const TIDY_MIN_KEPT_SHARE = 0.7;

type Section = { title: string; body: string };

const COACH_UPDATE = /^coach update\b/i;
/** The tidy's own bookkeeping section; it may come and go. */
const TIDY_META = /^(settings audit|tidy-ups)\b/i;

function sectionsOf(body: string): Section[] {
  return body
    .split(/^## +/m)
    .slice(1)
    .map((part) => {
      const newline = part.indexOf("\n");
      return {
        title: (newline === -1 ? part : part.slice(0, newline)).trim(),
        body: newline === -1 ? "" : part.slice(newline + 1).trim(),
      };
    });
}

/** True when About you has a dated "Coach update" section for a tidy to fold in. */
export function hasCoachUpdates(body: string): boolean {
  return sectionsOf(body).some((s) => COACH_UPDATE.test(s.title));
}

/**
 * Why a tidy must wait for Looks right, or null when it can be applied. Pure.
 * The sections about the athlete (everything but the coach updates and the
 * tidy's own bookkeeping) must all still be there by title, and the tidied
 * text must keep at least {@link TIDY_MIN_KEPT_SHARE} of their length: the
 * coach updates are meant to shrink, the rest is not.
 */
export function tidyHoldReason(currentBody: string, proposedBody: string): string | null {
  if (!proposedBody.trim()) return "the tidied text is empty";
  const about = sectionsOf(currentBody).filter(
    (s) => !COACH_UPDATE.test(s.title) && !TIDY_META.test(s.title),
  );
  const proposedTitles = new Set(sectionsOf(proposedBody).map((s) => s.title.toLowerCase()));
  const dropped = about.filter((s) => !proposedTitles.has(s.title.toLowerCase()));
  if (dropped.length > 0) {
    return `the tidied text drops ${dropped.map((s) => `"${s.title}"`).join(", ")}`;
  }
  const aboutLength = about.reduce((n, s) => n + s.title.length + s.body.length, 0);
  if (proposedBody.trim().length < aboutLength * TIDY_MIN_KEPT_SHARE) {
    return "the tidied text is much shorter than the sections about the athlete";
  }
  return null;
}

/** What the conversation says when the weekly tidy was applied; the card under it lists what changed. */
export const WEEKLY_TIDY_APPLIED_MESSAGE =
  "I tidied what I know about you before reading your week. If something's off, undo it or tell me what to fix. The full text is under About you.";
/** And when it was held back for the athlete to check. */
export const WEEKLY_TIDY_HELD_MESSAGE =
  "I've drafted a tidy-up of what I know about you, and it changes more than usual. Nothing changes until you say it looks right. The full text is under About you.";

export type WeeklyTidyResult =
  | { status: "skipped"; reason: "off" | "nothing to tidy" | "first answers waiting" | "changed meanwhile" }
  | { status: "applied"; proposal: DossierProposal; callId: string }
  | { status: "held"; proposal: DossierProposal; callId: string; reason: string }
  | { status: "failed"; message: string };

/** A tidy still waiting from an earlier week was drafted from older text; a fresh one replaces it. */
async function setAsideWaitingTidies(at: Date): Promise<void> {
  await pool.query(
    `UPDATE dossier_proposals
     SET status = 'rejected', resolved_at = $1
     WHERE status = 'pending' AND kind = 'audit'`,
    [at],
  );
}

/**
 * Tidy About you ahead of the weekly read of `session`. Never throws: the read
 * must go ahead whatever happens here.
 */
export async function runWeeklyTidy(options: {
  llmPort: LlmPort;
  clock: Clock;
  session: WeekSession;
  env?: NodeJS.ProcessEnv;
}): Promise<WeeklyTidyResult> {
  const { llmPort, clock, session } = options;
  try {
    if (!weeklyTidyFromEnv(options.env)) return { status: "skipped", reason: "off" };
    const current = await getCurrentDossier();
    if (!current || !hasCoachUpdates(current.body)) {
      return { status: "skipped", reason: "nothing to tidy" };
    }
    const waiting = await listPendingDossierProposals();
    if (waiting.some((p) => p.kind === "onboarding")) {
      return { status: "skipped", reason: "first answers waiting" };
    }

    const callId = randomUUID();
    const now = clock.now();
    const draft = await llmPort.generateDossierAudit(
      {
        currentDossier: { versionId: current.id, body: current.body },
        week: { isoWeek: session.isoWeek },
        nowIso: now.toISOString(),
        intervalWeeks: 1,
      },
      { callId, weekSessionId: session.id },
    );

    // A correction or a note that landed while Coach Cade was tidying wins.
    const latest = await getCurrentDossier();
    if (!latest || latest.id !== current.id) {
      return { status: "skipped", reason: "changed meanwhile" };
    }

    await setAsideWaitingTidies(clock.now());
    const drafted = await createProposalFromAudit({
      summaryBullets: draft.summaryBullets,
      proposedBody: draft.proposedBody,
      at: clock.now(),
    });

    const hold = tidyHoldReason(current.body, draft.proposedBody);
    if (hold) {
      await createCoachMessage(clock.now(), WEEKLY_TIDY_HELD_MESSAGE, session.id, callId, null, drafted.id);
      return { status: "held", proposal: drafted, callId, reason: hold };
    }

    const accepted = await acceptDossierProposal(drafted.id, { acceptedAt: clock.now() });
    if (!accepted.ok) {
      await rejectDossierProposal(clock.now(), drafted.id);
      return { status: "failed", message: `tidy could not be applied: ${accepted.reason}` };
    }
    await createCoachMessage(clock.now(), WEEKLY_TIDY_APPLIED_MESSAGE, session.id, callId, null, accepted.proposal.id);
    return { status: "applied", proposal: accepted.proposal, callId };
  } catch (err) {
    return { status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}
