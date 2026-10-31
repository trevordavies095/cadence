/**
 * Rep summaries for quality runs: which device laps were the reps, and one
 * line that sums them up ("6 reps, avg 3:05 at 4:02/km, fade 4%, rests 90 s").
 *
 * Pure: takes a run's splits and average pace, returns numbers or a string.
 *
 * - Only device laps count. Distance splits (km/mile) are never reps.
 * - When any device lap carries a structured intensity (rest, recovery,
 *   warmup, cooldown, interval), reps are the laps marked `active` or
 *   `interval`. Laps that are all `active` are plain auto-laps, not a
 *   structured session, so they fall through to the pace rule.
 * - Otherwise (auto-laps, HealthKit, Strava CSV, GPX), reps are laps at
 *   least 20 s/km faster than the run's average pace, and the summary says
 *   "(by pace)".
 * - Fewer than two reps is no summary.
 */
import type { TempoUnitPreference } from "../tempo/port.js";
import { formatPaceFromSecondsPerKm } from "./runByRunFormat.js";

export type RepLap = {
  idx?: number;
  kind?: string | null;
  distanceM?: number | null;
  durationS?: number | null;
  paceS?: number | null;
  intensity?: string | null;
};

export type RepMethod = "intensity" | "pace";

export type RepSummary = {
  method: RepMethod;
  count: number;
  /** Mean rep duration, whole seconds. */
  avgDurationS: number;
  /** Seconds per kilometre over all reps (total time over total distance). */
  avgPaceS: number;
  /** Last rep's pace against the first's, % slower; negative when faster. */
  fadePct?: number;
  /** Mean time spent between consecutive reps, whole seconds. */
  avgRestS?: number;
};

/** A lap must be this much faster than the run average to count by pace. */
export const PACE_REP_MARGIN_S_PER_KM = 20;

const REP_INTENSITIES = new Set(["active", "interval"]);
/** Intensities that only a structured workout writes. */
const STRUCTURED_INTENSITIES = new Set([
  "rest",
  "recovery",
  "warmup",
  "cooldown",
  "interval",
]);
/** Tempo's device-lap kind; "lap" is the older export spelling. */
const DEVICE_LAP_KINDS = new Set(["device_lap", "lap"]);

function positive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function lapPace(lap: RepLap): number | undefined {
  if (positive(lap.paceS)) return lap.paceS;
  if (positive(lap.durationS) && positive(lap.distanceM)) {
    return (lap.durationS / lap.distanceM) * 1000;
  }
  return undefined;
}

function intensityOf(lap: RepLap): string | undefined {
  if (typeof lap.intensity !== "string") return undefined;
  const v = lap.intensity.trim().toLowerCase();
  return v === "" ? undefined : v;
}

function hasStructuredIntensity(lap: RepLap): boolean {
  const v = intensityOf(lap);
  return v !== undefined && STRUCTURED_INTENSITIES.has(v);
}

function isDeviceLap(lap: RepLap): boolean {
  return typeof lap.kind === "string" && DEVICE_LAP_KINDS.has(lap.kind);
}

/** Device laps in lap order. */
function deviceLaps(splits: readonly RepLap[]): RepLap[] {
  const laps = splits.filter(isDeviceLap);
  if (laps.every((l) => typeof l.idx === "number")) {
    laps.sort((a, b) => (a.idx as number) - (b.idx as number));
  }
  return laps;
}

/** Positions (in device-lap order) of the laps that are reps, and how. */
export function detectReps(
  splits: readonly RepLap[],
  runAvgPaceS: number,
): { laps: RepLap[]; repIndexes: number[]; method: RepMethod } {
  const laps = deviceLaps(splits);
  if (laps.some(hasStructuredIntensity)) {
    const repIndexes = laps.flatMap((l, i) => {
      const v = intensityOf(l);
      return v !== undefined && REP_INTENSITIES.has(v) ? [i] : [];
    });
    return { laps, repIndexes, method: "intensity" };
  }
  if (!positive(runAvgPaceS)) return { laps, repIndexes: [], method: "pace" };
  const cutoff = runAvgPaceS - PACE_REP_MARGIN_S_PER_KM;
  const repIndexes = laps.flatMap((l, i) => {
    const pace = lapPace(l);
    return pace !== undefined && pace <= cutoff ? [i] : [];
  });
  return { laps, repIndexes, method: "pace" };
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Summarize a run's reps; null when fewer than two reps. */
export function summarizeReps(
  splits: readonly RepLap[],
  runAvgPaceS: number,
): RepSummary | null {
  const { laps, repIndexes, method } = detectReps(splits, runAvgPaceS);
  if (repIndexes.length < 2) return null;
  const reps = repIndexes.map((i) => laps[i]!);

  const durations = reps.map((r) => r.durationS).filter(positive);
  const avgDuration = mean(durations);
  if (avgDuration === undefined) return null;

  const timed = reps.filter((r) => positive(r.durationS) && positive(r.distanceM));
  let avgPaceS: number | undefined;
  if (timed.length > 0) {
    const t = timed.reduce((a, r) => a + (r.durationS as number), 0);
    const d = timed.reduce((a, r) => a + (r.distanceM as number), 0);
    avgPaceS = (t / d) * 1000;
  } else {
    avgPaceS = mean(reps.map(lapPace).filter((p): p is number => p !== undefined));
  }
  if (avgPaceS === undefined) return null;

  const summary: RepSummary = {
    method,
    count: reps.length,
    avgDurationS: Math.round(avgDuration),
    avgPaceS,
  };

  const firstPace = lapPace(reps[0]!);
  const lastPace = lapPace(reps[reps.length - 1]!);
  if (firstPace !== undefined && lastPace !== undefined) {
    // Round, then clear -0 so a flat session reads "fade 0%".
    summary.fadePct = Math.round(((lastPace - firstPace) / firstPace) * 100) || 0;
  }

  const gaps: number[] = [];
  for (let k = 1; k < repIndexes.length; k++) {
    const between = laps.slice(repIndexes[k - 1]! + 1, repIndexes[k]!);
    if (between.length === 0) continue;
    gaps.push(between.reduce((a, l) => a + (positive(l.durationS) ? l.durationS : 0), 0));
  }
  const avgRest = mean(gaps.filter((g) => g > 0));
  if (avgRest !== undefined) summary.avgRestS = Math.round(avgRest);

  return summary;
}

/** "3:05", or "1:02:05" past an hour. */
function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Rests read as seconds up to two minutes, then as m:ss. */
function restLabel(sec: number): string {
  return sec < 120 ? `${sec} s` : clock(sec);
}

/** "6 reps, avg 3:05 at 4:02/km, fade 4%, rests 90 s" (+ " (by pace)"). */
export function formatRepSummary(
  summary: RepSummary,
  unit: TempoUnitPreference,
): string {
  const bits = [
    `${summary.count} reps`,
    `avg ${clock(summary.avgDurationS)} at ${formatPaceFromSecondsPerKm(summary.avgPaceS, unit)}`,
  ];
  if (summary.fadePct !== undefined) bits.push(`fade ${summary.fadePct}%`);
  if (summary.avgRestS !== undefined) bits.push(`rests ${restLabel(summary.avgRestS)}`);
  const line = bits.join(", ");
  return summary.method === "pace" ? `${line} (by pace)` : line;
}
