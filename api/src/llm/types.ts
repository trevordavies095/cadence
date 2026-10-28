/**
 * Structured weekly coach reply (issue #28).
 * Day-by-day prescribed week for later grading (#30 / #41).
 *
 * Dossier v1 draft (issue #17) and athlete correction rewrite (#18) are
 * separate LlmPort calls (soft-gated via dossier proposals).
 */

export type DayType = "rest" | "easy" | "quality" | "long" | "race" | "other";

/** Onboarding answers + Tempo hints for dossier v1 generation. */
export type DossierV1Input = {
  answers: {
    goal: string;
    schedule: string;
    injuries_constraints?: string;
    preferences?: string;
  };
  prefills: {
    available: boolean;
    unitPreference?: "metric" | "imperial";
    heartRateZones?: {
      zones: Array<{ zoneNumber: number; minBpm: number; maxBpm: number }>;
    };
    defaultShoeId?: string | null;
    shoes?: Array<{ brand: string; model: string; isRetired?: boolean }>;
    recentTraining?: Array<{
      name: string | null;
      distanceM: number;
      runType: string | null;
    }>;
  };
};

/** Soft-gate dossier proposal payload from LlmPort. */
export type DossierV1Draft = {
  summaryBullets: string[];
  proposedBody: string;
};

/**
 * Athlete fix/add request → rewritten dossier soft-gate draft (issue #18).
 * Same shape as v1; Accept installs a new version.
 */
export type DossierCorrectionDraft = DossierV1Draft;

/** Input for LLM-owned dossier rewrite from an athlete correction. */
export type DossierCorrectionInput = {
  athleteMessage: string;
  currentDossier: { versionId: number; body: string };
  week?: { isoWeek?: string | null } | null;
};

/**
 * Coach or athlete-triggered dossier audit/trim soft-gate draft (issue #40).
 * Same shape as v1; Accept installs a trimmed version + stamps lastAuditAt.
 */
export type DossierAuditDraft = DossierV1Draft;

/** Input for LLM-owned dossier trim/consolidate (Current Status style). */
export type DossierAuditInput = {
  currentDossier: { versionId: number; body: string };
  week?: { isoWeek?: string | null } | null;
  /** ISO instant used for "updated" labels and next-due copy (injectable). */
  nowIso?: string | null;
  /** Cadence weeks for next-due note in the proposed body. */
  intervalWeeks?: number;
};

export type RunType = "easy" | "quality" | "long" | "race" | "other";

export type PrescribedRun = {
  type: RunType;
  /** Planned distance in meters. */
  distanceM: number;
  /** Workout recipe (intervals, etc.); null on unstructured easy/rest. */
  structure?: string | null;
  /** Athlete-facing pace or HR guidance. */
  paceOrHr?: string | null;
  /** Shoe recommendation (name or local id string). */
  shoes?: string | null;
};

export type PrescribedDay = {
  /** Local calendar date YYYY-MM-DD (Mon–Sun of the plan week). */
  date: string;
  dayType: DayType;
  run?: PrescribedRun | null;
  /** Optional strength block description. */
  strength?: string | null;
  /** Day-level coaching notes. */
  notes?: string | null;
};

export type PrescribedWeek = {
  /** ISO week id, e.g. 2026-W43. */
  week: string;
  /** Exactly seven Mon–Sun days. */
  days: PrescribedDay[];
};

/** Severity for visible safety callouts (issue #32). */
export type SafetyCalloutSeverity = "info" | "caution" | "urgent";

/**
 * Structured safety callout when the model flags a concern.
 * Product stance: do not diagnose; escalate to professionals.
 */
export type SafetyCallout = {
  title: string;
  body: string;
  severity?: SafetyCalloutSeverity;
};

/**
 * Full weekly LLM reply: analysis prose + structured plan + optional
 * settings-proposal bullets (soft-gated via dossier proposals — #31)
 * + optional safety callouts (#32).
 */
/** Something Coach Cade is watching: a short title and one line of detail. */
export type ReadFlag = { title: string; detail: string };

/** An answer to the athlete's own question, quoted as they wrote it. */
export type ReadAnswer = { question: string; answer: string };

/** The parts of Coach Cade's read the pages lay out on their own, stored beside the full read. */
export type ReadSections = {
  /** The one or two sentences Coach Cade would say if it could say only one thing. */
  headline: string;
  /** Shown as "Watching"; empty when there is nothing to watch. */
  flags: ReadFlag[];
  /** Shown as "Your questions"; empty when the athlete asked nothing. */
  answers: ReadAnswer[];
};

export type WeeklyReply = {
  /** The one or two sentences that matter most; opens the read on Plan. */
  headline: string;
  /** Up to five things Coach Cade is watching. */
  flags?: ReadFlag[];
  /** Answers to the athlete's questions, up to eight. */
  answers?: ReadAnswer[];
  /** The full read: markdown, up to 4,000 characters. */
  analysis: string;
  prescribedWeek: PrescribedWeek;
  settingsProposalBullets?: string[];
  /** Visible escalate-not-diagnose callouts when red flags appear. */
  safetyCallouts?: SafetyCallout[];
};

/**
 * Free-form mid-week coach chat reply (issue #35 / #37 / #38 / #39).
 * When the packet includes workout attachments, `body` should include
 * concrete run feedback (metrics/splits). Optional day patches update the
 * persisted prescribed week for remaining days (#38). Significant memory
 * updates emit settingsProposalBullets for soft-gate Accept (#39).
 */
export type MidWeekChatReply = {
  /** Athlete-facing coach prose for the thread (incl. attach feedback when present). */
  body: string;
  /**
   * Optional soft-gate dossier/settings proposal bullets when mid-week chat
   * surfaces a significant memory update (#39). Never silent-apply.
   */
  settingsProposalBullets?: string[];
  /** Visible escalate-not-diagnose callouts when red flags appear. */
  safetyCallouts?: SafetyCallout[];
  /**
   * Structured day replacements for the current prescribed week (#38).
   * Applied only for remaining days (date >= local today) unless
   * `allowPastDayPatches` is true.
   */
  prescribedDayPatches?: PrescribedDay[];
  /**
   * When true, past-day patches may be applied. Default false — past days
   * remain stable.
   */
  allowPastDayPatches?: boolean;
};
