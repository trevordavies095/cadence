/**
 * Outbound model context packet (issue #27).
 * This is the structured payload LlmPort receives — identity PII and GPS omitted.
 */

import type { TrainingGoal } from "../goal/types.js";
import type { PrescribedWeek } from "../llm/types.js";
import type { RecapPhase } from "../recap/phase.js";

export type ModelPacketRole = "athlete" | "coach" | "system";

export type ModelPacketThreadMessage = {
  role: ModelPacketRole;
  body: string;
  createdAt?: string;
};

/** Compact coaching attachment — metrics/splits only; never route geometry. */
export type ModelPacketAttachment = {
  workoutId: string;
  startedAt: string;
  durationS: number;
  distanceM: number;
  avgPaceS: number;
  elevGainM?: number | null;
  avgHeartRateBpm?: number | null;
  maxHeartRateBpm?: number | null;
  relativeEffort?: number | null;
  rpe?: number | null;
  runType?: string | null;
  /** Activity title (not athlete legal name). */
  activityName?: string | null;
  notes?: string | null;
  /** Whether Tempo has a route; geometry is never included. */
  hasRoute?: boolean;
  splitsCount?: number;
  splits?: Array<{
    idx?: number;
    kind?: string | null;
    distanceM?: number | null;
    durationS?: number | null;
    paceS?: number | null;
    avgHeartRateBpm?: number | null;
    /** Device-lap intensity (active, rest, interval, …); null when not sent. */
    intensity?: string | null;
    trigger?: string | null;
    stepIndex?: number | null;
  }>;
};

export type ModelPacketWeek = {
  isoWeek: string;
  start: string;
  end: string;
  weekSessionId?: string;
};

/**
 * The week being planned (N+1) when the reviewed week is `week` (N).
 * `startDate`/`endDate` are the Mon/Sun calendar dates plans must use.
 */
export type ModelPacketPlanWeek = {
  isoWeek: string;
  start: string;
  end: string;
  startDate: string;
  endDate: string;
};

/**
 * One prior week in the lean recent-history window (#34).
 * Summaries/plans only — never mid-week thread chatter.
 */
export type ModelPacketRecentWeek = {
  isoWeek: string;
  weekSessionId: string;
  /** Weekly recap markdown when persisted. */
  recapMarkdown?: string | null;
  /** Coach analysis from the weekly reply when persisted. */
  analysis?: string | null;
  /** Structured prescribed plan when persisted. */
  prescribedWeek?: PrescribedWeek | null;
};

/**
 * Where the athlete is in training, resolved from the goal for the focus week's
 * Monday. Optional fields are absent when they do not apply or are not known yet.
 */
export type ModelPacketCoaching = {
  phase: RecapPhase;
  /** Whole weeks from the focus week's Monday to the race; absent with no date or after the race. */
  weeksToRace?: number;
  /** Present (true) only once the race date is before the focus week's Monday. */
  racePassed?: boolean;
  /** Threshold pace, seconds per km. */
  thresholdPaceS?: number;
  thresholdHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  observedMaxHeartRateBpm?: number;
};

/**
 * Structured context for the LLM.
 * Athlete-volunteered coaching constraints in `dossier.body` remain available
 * after identity/GPS scrubbing.
 *
 * Lean live shape (#34): dossier + recentHistory (last N summaries/plans) +
 * current-week thread only. Archived mid-week chatter is excluded.
 */
export type ModelPacket = {
  dossier: { versionId: number | null; body: string } | null;
  recapMarkdown: string | null;
  thread: ModelPacketThreadMessage[];
  attachments: ModelPacketAttachment[];
  week: ModelPacketWeek | null;
  /**
   * Week the weekly reply plans (N+1, the ISO week after `week`).
   * Absent for mid-week packets, which plan against `week`.
   */
  planWeek?: ModelPacketPlanWeek | null;
  /** Current prescribed week when available (mid-week plan patches — #38). */
  prescribedWeek?: PrescribedWeek | null;
  /**
   * Last N prior weeks' recap/plan summaries (newest first).
   * Empty when none or limit is 0.
   */
  recentHistory: ModelPacketRecentWeek[];
  /** Resolved N for this packet (see PACKET_RECENT_HISTORY_LIMIT). */
  recentHistoryLimit: number;
  /**
   * The current training goal as stored, or null with none. Not identity: it
   * passes through redaction untouched (a race name is the athlete's own goal).
   */
  goal: TrainingGoal | null;
  /** Coaching context for the focus week; null when no goal is stored. */
  coaching: ModelPacketCoaching | null;
};

/** Known identity strings used to scrub free text (optional). */
export type IdentityHints = {
  names?: string[];
  emails?: string[];
};

export type BuildModelPacketInput = {
  dossier?: { versionId?: number | null; body: string } | null;
  recapMarkdown?: string | null;
  thread?: Array<{
    role: string;
    body: string;
    createdAt?: string;
    weekSessionId?: string | null;
  }>;
  /**
   * Raw workout-like objects (Tempo detail/summary or fixtures).
   * May contain GPS / identity fields — builder redacts before emit.
   */
  attachments?: unknown[];
  week?: ModelPacketWeek | null;
  /** Week being planned by the weekly reply (N+1). */
  planWeek?: ModelPacketPlanWeek | null;
  /** Current prescribed week for mid-week patch context (#38). */
  prescribedWeek?: PrescribedWeek | null;
  /** Prior week summaries/plans for lean recent history (#34). */
  recentHistory?: ModelPacketRecentWeek[];
  /** Window size N; defaults applied by lean assembly when omitted. */
  recentHistoryLimit?: number;
  identityHints?: IdentityHints;
  /** Current training goal; null or omitted when none. */
  goal?: TrainingGoal | null;
  /** Coaching context for the focus week; null or omitted when no goal. */
  coaching?: ModelPacketCoaching | null;
};
