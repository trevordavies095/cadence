/**
 * Threshold minutes (ticket 16): time spent near the athlete-set threshold,
 * summed across the week's runs from the per-second series.
 *
 * A run with pace in its series counts the time within 5% of threshold pace.
 * A run with no pace (treadmill, no GPS) falls back to the time within 3 bpm
 * of threshold heart rate. A run with neither contributes nothing.
 *
 * GPS pace between two samples is too noisy for a 5% band, so each step is
 * judged by a trailing 30-second window: pace is the distance gained over the
 * last 30 s of elapsed time, heart rate the 30-second mean (shorter windows
 * at the run's start).
 */
import type { TempoTimeSeriesPoint } from "../tempo/port.js";

/** Pace band: within this fraction of threshold pace (seconds per km). */
export const THRESHOLD_PACE_BAND = 0.05;
/** Heart-rate band: within this many bpm of threshold heart rate. */
export const THRESHOLD_HR_BAND_BPM = 3;
/** Trailing window each step is judged over. */
export const THRESHOLD_WINDOW_S = 30;

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

/** One step between consecutive samples: [start, end], its speed and closing heart rate. */
type Step = { start: number; end: number; speedMps: number | null; hr: number | null };

function steps(series: readonly TempoTimeSeriesPoint[]): Step[] {
  const points = series
    .filter((p) => finite(p.elapsedSeconds))
    .slice()
    .sort((a, b) => a.elapsedSeconds! - b.elapsedSeconds!);
  const out: Step[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const start = a.elapsedSeconds!;
    const end = b.elapsedSeconds!;
    const dt = end - start;
    if (dt <= 0) continue;
    let speedMps: number | null = null;
    if (finite(a.distanceM) && finite(b.distanceM)) {
      const dd = b.distanceM - a.distanceM;
      if (dd >= 0) speedMps = dd / dt;
    } else if (finite(b.speedMps) && b.speedMps >= 0) {
      speedMps = b.speedMps;
    }
    const hr = finite(b.heartRateBpm) && b.heartRateBpm > 0 ? b.heartRateBpm : null;
    out.push({ start, end, speedMps, hr });
  }
  return out;
}

/**
 * Time-weighted mean of a step value over the trailing window ending at
 * steps[i].end; null when no step in the window has the value.
 */
function trailingMean(
  all: readonly Step[],
  i: number,
  value: (s: Step) => number | null,
): number | null {
  const windowStart = all[i]!.end - THRESHOLD_WINDOW_S;
  let weighted = 0;
  let time = 0;
  for (let j = i; j >= 0; j--) {
    const s = all[j]!;
    if (s.end <= windowStart) break;
    const v = value(s);
    if (v === null) continue;
    const overlap = s.end - Math.max(s.start, windowStart);
    weighted += v * overlap;
    time += overlap;
  }
  return time > 0 ? weighted / time : null;
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
  const all = steps(series);
  const hasPace = all.some((s) => s.speedMps !== null && s.speedMps > 0);
  let inBand: (i: number) => boolean;
  if (hasPace && usable(thresholds.paceS)) {
    const t = thresholds.paceS;
    inBand = (i) => {
      const speed = trailingMean(all, i, (s) => s.speedMps);
      return speed !== null && speed > 0 && withinPaceBand(1000 / speed, t);
    };
  } else if (usable(thresholds.heartRateBpm)) {
    // No pace in the series, or no threshold pace set: the heart-rate band.
    const t = thresholds.heartRateBpm;
    inBand = (i) => {
      const hr = trailingMean(all, i, (s) => s.hr);
      return hr !== null && withinHeartRateBand(hr, t);
    };
  } else {
    return 0;
  }
  return all.reduce((sum, s, i) => (inBand(i) ? sum + (s.end - s.start) : sum), 0);
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
