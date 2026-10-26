import type { Clock } from "../clock/clock.js";
import { nextIsoWeekBounds, resolveIsoWeek } from "../clock/isoWeek.js";
import { getCurrentDossier } from "../dossier/store.js";
import { listPendingDossierProposals } from "../dossier/proposals.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import {
  resolveCheckInStatus,
  type CheckInStatus,
} from "../recap/checkInStatus.js";
import { getLatestRun, type ReplyRun } from "../replyRun/store.js";
import { resolveTempoExportPath } from "../tempo/exportZip.js";
import { getAnthropicConnection } from "../settings/anthropicStore.js";
import { getTempoConnection } from "../settings/tempoStore.js";
import {
  findWeekSession,
  getOrCreateCurrentWeekSession,
  type WeekSession,
} from "../week/store.js";

/** Ordered weekly-loop phases — highest priority first (#46 / #44). */
export type LoopPhase =
  | "setup_incomplete"
  | "needs_onboarding"
  | "onboarding_review"
  | "needs_check_in"
  | "needs_plan"
  | "mid_week"
  | "week_ending";

export type LoopCta = {
  label: string;
  href: string;
};

export type LoopStatus = {
  phase: LoopPhase;
  headline: string;
  week: {
    weekSessionId: string | null;
    isoWeek: string | null;
    timezone: string;
    start: string | null;
    end: string | null;
  };
  flags: {
    setupComplete: boolean;
    tempoConfigured: boolean;
    anthropicConfigured: boolean;
    onboardingComplete: boolean;
    /** The coach tidied its notes; waiting on the athlete, but never in the way. */
    auditPending: boolean;
    /** Plan hard-gate (#49 / #52): needed | finished | skipped. */
    checkIn: CheckInStatus;
    /** Next week's (N+1) plan exists. */
    hasPlan: boolean;
    /** The current week's (N) own plan exists. */
    currentWeekHasPlan: boolean;
    weekEnding: boolean;
  };
  /** Null when the phase has nothing for the athlete to do (week_ending). */
  primaryCta: LoopCta | null;
  secondaryCta: LoopCta | null;
  /** Latest weekly reply run for the current week; null when none has started. */
  replyRun: {
    status: ReplyRun["status"];
    finishedAt: string | null;
    seenAt: string | null;
  } | null;
};

/** Sat/Sun in the session timezone (Mon=0 … Sun=6). */
export function isWeekEnding(session: WeekSession, clock: Clock): boolean {
  const bounds = resolveIsoWeek(clock, session.timezone);
  const dayMs = 24 * 60 * 60 * 1000;
  const daysFromMonday = Math.floor(
    (new Date(bounds.now).getTime() - new Date(bounds.start).getTime()) / dayMs,
  );
  return daysFromMonday >= 5;
}

function ctasForPhase(
  phase: LoopPhase,
  flags: LoopStatus["flags"],
): {
  headline: string;
  primaryCta: LoopCta | null;
  secondaryCta: LoopCta | null;
} {
  switch (phase) {
    case "setup_incomplete":
      return {
        headline: "Finish setup to start this week",
        primaryCta: { label: "Finish setup", href: "/settings" },
        secondaryCta: null,
      };
    case "needs_onboarding":
      return {
        headline: "Coach Cade needs a few answers to get started",
        primaryCta: { label: "Start", href: "/onboarding" },
        secondaryCta: null,
      };
    case "onboarding_review":
      return {
        headline: "Here’s what Coach Cade understood",
        primaryCta: { label: "Have a look", href: "/dossier" },
        secondaryCta: null,
      };
    case "needs_check_in":
      return {
        headline: "Start this week’s check-in",
        primaryCta: { label: "Start check-in", href: "/check-in" },
        // Skipping lives inside the check-in itself; a link here only reopened it.
        secondaryCta: null,
      };
    case "needs_plan":
      return {
        headline: "Plan next week",
        primaryCta: { label: "Plan next week", href: "/plan" },
        secondaryCta: null,
      };
    case "mid_week":
      return {
        headline: "How’s the week going?",
        primaryCta: { label: "Log how it went", href: "/chat" },
        secondaryCta: { label: "Ask Coach Cade", href: "/chat" },
      };
    case "week_ending":
      return {
        headline: "This week is wrapping up and next week’s plan is ready",
        // The week rolls over by itself; there is nothing to close out.
        primaryCta: null,
        secondaryCta: null,
      };
  }
}

/**
 * Resolve the week's loop state: one ordered phase plus flags and the latest
 * reply run. Home derives its banner from this. Composes settings, onboarding,
 * check-in and the prescribed plan, without Tempo recap assembly.
 */
export async function resolveLoopStatus(
  clock: Clock,
  timezone = "UTC",
): Promise<LoopStatus> {
  const [tempo, anthropic, dossier, pending] = await Promise.all([
    getTempoConnection(),
    getAnthropicConnection(),
    getCurrentDossier(),
    listPendingDossierProposals(),
  ]);

  // Demo instance: the offline Tempo export and the stub model stand in for the two
  // saved connections, so Home does not ask a demo visitor for keys they do not need.
  const demo = process.env.CADENCE_DEMO === "1";
  const stubModel =
    (process.env.LLM_PROVIDER ?? "stub").trim().toLowerCase() !== "anthropic";
  const tempoConfigured =
    tempo.configured || (demo && resolveTempoExportPath() != null);
  const anthropicConfigured = anthropic.configured || (demo && stubModel);
  const setupComplete = tempoConfigured && anthropicConfigured;
  const onboardingComplete = dossier != null;
  const onboardingReview = pending.some((p) => p.kind === "onboarding");
  const auditPending = pending.some((p) => p.kind === "audit");

  let session: WeekSession | null = null;
  if (setupComplete) {
    const created = await getOrCreateCurrentWeekSession(clock, timezone);
    session = created.session;
  }

  let checkIn: CheckInStatus = "needed";
  let hasPlan = false;
  let currentWeekHasPlan = false;
  let weekEnding = false;
  let replyRun: LoopStatus["replyRun"] = null;

  if (session) {
    const latestRun = await getLatestRun(session.id);
    replyRun = latestRun
      ? {
          status: latestRun.status,
          finishedAt: latestRun.finishedAt,
          seenAt: latestRun.seenAt,
        }
      : null;
    // Read-only: never create the N+1 session from loop status.
    const next = nextIsoWeekBounds(session.isoWeek, session.timezone);
    const [checkInStatus, currentPlan, nextSession] = await Promise.all([
      resolveCheckInStatus(session.id),
      getPrescribedWeekBySessionId(session.id),
      findWeekSession(next.isoWeek, session.timezone),
    ]);
    checkIn = checkInStatus;
    currentWeekHasPlan = currentPlan != null;
    hasPlan = nextSession
      ? (await getPrescribedWeekBySessionId(nextSession.id)) != null
      : false;
    weekEnding = isWeekEnding(session, clock);
  }

  const checkInDone = checkIn === "finished" || checkIn === "skipped";

  let phase: LoopPhase;
  if (!setupComplete) {
    phase = "setup_incomplete";
  } else if (!onboardingComplete) {
    // Answers are in and the coach has drafted what it understood: the athlete's turn.
    phase = onboardingReview ? "onboarding_review" : "needs_onboarding";
  } else if (weekEnding && !checkInDone) {
    phase = "needs_check_in";
  } else if (checkInDone && !hasPlan) {
    phase = "needs_plan";
  } else if (weekEnding) {
    phase = "week_ending";
  } else {
    phase = "mid_week";
  }

  const flags: LoopStatus["flags"] = {
    setupComplete,
    tempoConfigured,
    anthropicConfigured,
    onboardingComplete,
    auditPending,
    checkIn,
    hasPlan,
    currentWeekHasPlan,
    weekEnding,
  };

  const { headline, primaryCta, secondaryCta } = ctasForPhase(phase, flags);

  return {
    phase,
    headline,
    week: {
      weekSessionId: session?.id ?? null,
      isoWeek: session?.isoWeek ?? null,
      timezone: session?.timezone ?? timezone,
      start: session?.start ?? null,
      end: session?.end ?? null,
    },
    flags,
    primaryCta,
    secondaryCta,
    replyRun,
  };
}
