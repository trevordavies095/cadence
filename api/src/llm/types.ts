/**
 * Structured weekly coach reply (issue #28).
 * Day-by-day prescribed week for later grading (#30 / #41).
 *
 * Dossier v1 draft (issue #17) and athlete correction rewrite (#18) are
 * separate LlmPort calls (soft-gated via dossier proposals).
 */

import type { TrainingGoal } from "../goal/types.js";

export type DayType = "rest" | "easy" | "quality" | "long" | "race" | "other";

/** Onboarding answers + Tempo hints for dossier v1 generation. */
export type DossierV1Input = {
  /** The goal record the answers' goal sentence was written from. */
  goal?: TrainingGoal;
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
  /** Planned distance in meters; 0 when the run is prescribed by duration only. */
  distanceM: number;
  /** Planned duration in seconds, when the run is prescribed by time. */
  durationS?: number | null;
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
  /**
   * The plan line Coach Cade wrote for this day, as written; null when the
   * plan gave no line for the date. Absent on rows stored before plans were
   * text.
   */
  line?: string | null;
  /**
   * Whether Cadence derived this day's structure from its line. False means
   * the day carries only the line (or no line). Absent reads as parsed.
   */
  parsed?: boolean;
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

/**
 * An answer to the athlete's own question. `question` is the athlete's
 * question as Cadence holds it, or empty when Cadence cannot tell which
 * question the answer is for: Coach Cade sends the answers only.
 */
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

/**
 * The weekly reply as Coach Cade sends it: every box plain text or a list of
 * lines (.scratch/plan-as-text/spec.md, "The forms"). Cadence turns it into a
 * {@link WeeklyReply}, deriving the plan's structure from its lines.
 */
export type WeeklyReplyForm = {
  headline: string;
  /** "Title: detail", one per line; a line with no colon is all title. At most five kept. */
  flags?: string;
  /** The answer to the athlete's questions, markdown; stored as one answer. */
  answers?: string;
  /** The full read, markdown. */
  analysis: string;
  /** Seven lines, one per day, in the plan grammar. */
  plan: string;
  /** One suggestion per line; a leading "- " or "* " is stripped. */
  settingsProposalBullets?: string;
  /** One notice per line, with an optional leading "Urgent:", "Caution:" or "Info:". */
  safetyCallouts?: string;
};

/** The weekly reply as Cadence stores it. */
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
 * The mid-week reply as Coach Cade sends it: every box plain text, a list of
 * lines or a boolean (.scratch/plan-as-text/spec.md, "The forms"). Cadence
 * turns it into a {@link MidWeekChatReply}, reading the changed days from the
 * `changes` lines.
 */
export type MidWeekChatReplyForm = {
  /** Coach prose for the thread, markdown. */
  body: string;
  /**
   * Zero or more lines in the plan grammar, one per changed day. Empty or
   * absent: the plan does not change. A date with no line is not changed.
   */
  changes?: string;
  allowPastDayPatches?: boolean;
  /** One suggestion per line; a leading "- " or "* " is stripped. */
  settingsProposalBullets?: string;
  /** One notice per line, with an optional leading "Urgent:", "Caution:" or "Info:". */
  safetyCallouts?: string;
};

/**
 * Free-form mid-week coach chat reply as Cadence stores it (issue #35 / #37 /
 * #38 / #39). When the packet includes workout attachments, `body` should
 * include concrete run feedback (metrics/splits). Changed days update the
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
   * The days as Coach Cade's `changes` lines read them, one per changed date
   * of the plan week, each with `line` and `parsed` (an unparsed line is a
   * day with `parsed: false`). Each replaces its date whole, for remaining
   * days only (date >= local today) unless `allowPastDayPatches` is true.
   */
  prescribedDayPatches?: PrescribedDay[];
  /**
   * When true, past-day patches may be applied. Default false — past days
   * remain stable.
   */
  allowPastDayPatches?: boolean;
};

/**
 * One unread plan day sent back to Coach Cade to fill in ("Add the details",
 * plan-as-text ticket 09): the plan week, the unit, the date, its line as
 * stored and why Cadence could not read it. No packet.
 */
export type PlanDayFixInput = {
  /** Monday of the plan week, YYYY-MM-DD. */
  weekStartMonday: string;
  unit: "metric" | "imperial";
  /** The day to fill in, YYYY-MM-DD, inside the plan week. */
  date: string;
  /** The day's line as stored; null when the plan gave no line for the date. */
  line: string | null;
  /** Why the line could not be read, re-read now; null when it cannot be told. */
  reason: string | null;
};

/** Coach Cade's new line for the date, read into a stored day (`parsed: true`). */
export type PlanDayFix = {
  day: PrescribedDay;
};
