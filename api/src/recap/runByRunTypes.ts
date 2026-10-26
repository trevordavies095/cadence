import type { TempoUnitPreference } from "../tempo/port.js";
import type { RunByRunHrDrift } from "./runByRunHr.js";

export type RunByRunShoe = {
  id: string;
  label: string;
  mileageMi?: number;
};

export type RunByRunSplit = {
  idx?: number;
  paceS?: number | null;
  distanceM?: number | null;
  durationS?: number | null;
  avgHeartRateBpm?: number | null;
};

/** One workout under Run-by-run — Tempo data only (no subjective RPE/feel). */
export type RunByRunEntry = {
  workoutId: string;
  startedAt: string;
  titleDate: string;
  runType: string;
  name?: string | null;
  distanceM: number;
  durationS: number;
  avgPaceS: number;
  avgHeartRateBpm?: number | null;
  maxHeartRateBpm?: number | null;
  /** Steps per minute (both feet) when cadence samples exist. */
  cadenceSpm?: number;
  elevGainM?: number | null;
  elevLossM?: number | null;
  relativeEffort?: number | null;
  /** Text after "Weather: " (unit-converted), when Tempo has weather. */
  weather?: string;
  /** Text after "Similar route: " (narrative, or n/a with reason). */
  similarRouteText?: string;
  notes?: string | null;
  shoeId?: string | null;
  shoe?: RunByRunShoe;
  splits: RunByRunSplit[];
  /** Formatted split paces joined with " / ", when any paceS present. */
  splitPacesFormatted?: string;
  drift?: RunByRunHrDrift;
  /** tempo-cli severity suffix (Easy/Long runs only), e.g. "⚠ above target (target ≤10 bpm)". */
  driftSeverity?: string;
  /** % of athlete max HR for the run's average HR, one decimal. */
  pctMaxHr?: number;
  /** Why HR series analytics are n/a (e.g. "HTTP 500"); set only on failure. */
  timeSeriesUnavailableReason?: string;
  zonePct?: Record<string, number>;
  zoneSeconds?: number[];
};

export type RecapRunByRunResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  runs: RunByRunEntry[];
  markdown: string;
};
