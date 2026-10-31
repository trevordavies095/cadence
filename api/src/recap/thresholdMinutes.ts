/**
 * Threshold minutes (ticket 16): time spent near the athlete-set threshold,
 * summed across the week's runs from the per-second series.
 *
 * A run with pace in its series counts the time within 5% of threshold pace.
 * A run with no pace (treadmill, no GPS) falls back to the time within 3 bpm
 * of threshold heart rate. A run with neither contributes nothing.
 */
import type { TempoTimeSeriesPoint } from "../tempo/port.js";

/** Pace band: within this fraction of threshold pace (seconds per km). */
export const THRESHOLD_PACE_BAND = 0.05;
/** Heart-rate band: within this many bpm of threshold heart rate. */
export const THRESHOLD_HR_BAND_BPM = 3;

/** The athlete-set thresholds; null when not set. Paces are seconds per km. */
export type AthleteThresholds = {
  paceS: number | null;
  heartRateBpm: number | null;
};

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function usable(n: number | null): n is number {
  return finite(n) && n > 0;
}

/** True when at least one athlete-set threshold can be used. */
export function hasAthleteThreshold(t: AthleteThresholds | null | undefined): boolean {
  return !!t && (usable(t.paceS) || usable(t.heartRateBpm));
}

type Interval = { dt: number; paceS: number | null; hr: number | null };

/** Consecutive-sample intervals with the pace (distance over time) and the closing heart rate. */
function intervals(series: readonly TempoTimeSeriesPoint[]): Interval[] {
  const points = series
    .filter((p) => finite(p.elapsedSeconds))
    .slice()
    .sort((a, b) => a.elapsedSeconds! - b.elapsedSeconds!);
  const out: Interval[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dt = b.elapsedSeconds! - a.elapsedSeconds!;
    if (dt <= 0) continue;
    let paceS: number | null = null;
    if (finite(a.distanceM) && finite(b.distanceM)) {
      const dd = b.distanceM - a.distanceM;
      if (dd > 0) paceS = dt / (dd / 1000);
    } else if (finite(b.speedMps) && b.speedMps > 0) {
      paceS = 1000 / b.speedMps;
    }
    const hr = finite(b.heartRateBpm) && b.heartRateBpm > 0 ? b.heartRateBpm : null;
    out.push({ dt, paceS, hr });
  }
  return out;
}

export function withinPaceBand(paceS: number, thresholdPaceS: number): boolean {
  return Math.abs(paceS - thresholdPaceS) <= THRESHOLD_PACE_BAND * thresholdPaceS;
}

export function withinHeartRateBand(hr: number, thresholdHr: number): boolean {
  return Math.abs(hr - thresholdHr) <= THRESHOLD_HR_BAND_BPM;
}

/** Seconds of one run near threshold; 0 when the run has neither usable pace nor heart rate. */
export function thresholdSecondsForRun(
  series: readonly TempoTimeSeriesPoint[] | null | undefined,
  thresholds: AthleteThresholds,
): number {
  if (!series || series.length < 2) return 0;
  const iv = intervals(series);
  const hasPace = iv.some((x) => x.paceS !== null);
  if (hasPace && usable(thresholds.paceS)) {
    const t = thresholds.paceS;
    return iv.reduce(
      (s, x) => (x.paceS !== null && withinPaceBand(x.paceS, t) ? s + x.dt : s),
      0,
    );
  }
  // No pace in the series, or no threshold pace set: the heart-rate band.
  if (usable(thresholds.heartRateBpm)) {
    const t = thresholds.heartRateBpm;
    return iv.reduce(
      (s, x) => (x.hr !== null && withinHeartRateBand(x.hr, t) ? s + x.dt : s),
      0,
    );
  }
  return 0;
}

/** The week's threshold seconds across its runs' series. */
export function thresholdSecondsForWeek(
  seriesByRun: ReadonlyArray<readonly TempoTimeSeriesPoint[] | null | undefined>,
  thresholds: AthleteThresholds,
): number {
  return seriesByRun.reduce<number>(
    (sum, s) => sum + thresholdSecondsForRun(s, thresholds),
    0,
  );
}
