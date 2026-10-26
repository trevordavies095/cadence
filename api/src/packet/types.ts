/**
 * Outbound model context packet (issue #27).
 * This is the structured payload LlmPort receives — identity PII and GPS omitted.
 */

import type { PrescribedWeek } from "../llm/types.js";

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
};
