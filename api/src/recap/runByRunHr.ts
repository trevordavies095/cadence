/**
 * Per-run HR analytics for Run-by-run (drift + zone seconds).
 * Self-contained so week-level HR zone section (#20) can land in parallel.
 */

import type {
  TempoHeartRateZone,
  TempoTimeSeriesPoint,
} from "../tempo/port.js";
import { isEasyFamily, isLongRun } from "./runTypes.js";

export type RunByRunHrSample = {
  elapsedSeconds: number;
  heartRateBpm: number;
};

export type RunByRunHrDrift = {
  q1AvgHr: number;
  q4AvgHr: number;
  driftBpm: number;
};

export type RunByRunHrMetrics = {
  hasHrSeries: boolean;
  avgHrFromSeries?: number;
  drift?: RunByRunHrDrift;
  zoneSeconds?: number[];
  zonePct?: Record<string, number>;
  /** Mean one-foot cadence RPM from samples (when present). */
  avgCadenceRpm?: number;
};

export function extractHrSamples(
  points: readonly TempoTimeSeriesPoint[] | undefined,
): RunByRunHrSample[] {
  if (!points || points.length === 0) return [];
  const out: RunByRunHrSample[] = [];
  for (const p of points) {
    const es = p.elapsedSeconds;
    const hr = p.heartRateBpm;
    if (typeof es !== "number" || !Number.isFinite(es)) continue;
    if (typeof hr !== "number" || !Number.isFinite(hr) || hr <= 0) continue;
    out.push({
      elapsedSeconds: Math.max(0, Math.floor(es)),
      heartRateBpm: Math.round(hr),
    });
  }
  return out;
}

/**
 * One HR value per elapsed second [0 .. len−1], forward-filled from sorted samples.
 */
export function buildDenseHrPerSecond(
  samples: readonly RunByRunHrSample[],
  durationS: number | undefined,
): number[] | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
  const maxEl = sorted[sorted.length - 1]!.elapsedSeconds;
  let len =
    durationS !== undefined && durationS > 0 ? Math.floor(durationS) : maxEl + 1;
  len = Math.max(len, maxEl + 1);
  const out: number[] = [];
  let j = 0;
  let current = sorted[0]!.heartRateBpm;
  for (let sec = 0; sec < len; sec++) {
    while (j < sorted.length && sorted[j]!.elapsedSeconds <= sec) {
      current = sorted[j]!.heartRateBpm;
      j++;
    }
    out.push(current);
  }
  return out;
}

export function quarterAvgHrs(
  dense: readonly number[],
): RunByRunHrDrift | undefined {
  const n = dense.length;
  if (n < 4) return undefined;
  const q = Math.floor(n / 4);
  if (q < 1) return undefined;
  const q1Slice = dense.slice(0, q);
  const q4Slice = dense.slice(3 * q, n);
  const avg = (arr: readonly number[]) =>
    arr.reduce((a, b) => a + b, 0) / arr.length;
  const q1Avg = avg(q1Slice);
  const q4Avg = avg(q4Slice);
  return {
    q1AvgHr: Math.round(q1Avg * 10) / 10,
    q4AvgHr: Math.round(q4Avg * 10) / 10,
    driftBpm: Math.round((q4Avg - q1Avg) * 10) / 10,
  };
}

function zoneIndexForBpm(
  bpm: number,
  zonesSorted: readonly TempoHeartRateZone[],
): number {
  if (zonesSorted.length === 0) return 0;
  for (let i = 0; i < zonesSorted.length; i++) {
    const z = zonesSorted[i]!;
    if (bpm >= z.minBpm && bpm <= z.maxBpm) return i;
  }
  if (bpm < zonesSorted[0]!.minBpm) return 0;
  return zonesSorted.length - 1;
}

export function secondsPerZoneFromDense(
  dense: readonly number[],
  zonesSorted: readonly TempoHeartRateZone[],
): number[] {
  const counts = new Array(zonesSorted.length).fill(0) as number[];
  for (const bpm of dense) {
    const zi = zoneIndexForBpm(bpm, zonesSorted);
    counts[zi]! += 1;
  }
  return counts;
}

export function pctFromZoneSeconds(
  zoneSeconds: readonly number[],
): Record<string, number> {
  const total = zoneSeconds.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (let i = 0; i < zoneSeconds.length; i++) {
    const pct = (1000 * zoneSeconds[i]!) / total;
    out[`z${i + 1}`] = Math.round(pct) / 10;
  }
  return out;
}

function meanCadenceRpm(
  points: readonly TempoTimeSeriesPoint[] | undefined,
): number | undefined {
  if (!points || points.length === 0) return undefined;
  const vals: number[] = [];
  for (const p of points) {
    const c = p.cadenceRpm;
    if (typeof c === "number" && Number.isFinite(c) && c > 0) vals.push(c);
  }
  if (vals.length === 0) return undefined;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Compute drift / zones / cadence for one workout from time-series samples. */
export function computeRunHrMetrics(args: {
  timeSeries: readonly TempoTimeSeriesPoint[] | undefined;
  durationS: number;
  zones: readonly TempoHeartRateZone[];
}): RunByRunHrMetrics {
  const samples = extractHrSamples(args.timeSeries);
  const dense =
    samples.length > 0
      ? buildDenseHrPerSecond(samples, args.durationS)
      : undefined;
  const avgCadenceRpm = meanCadenceRpm(args.timeSeries);

  if (!dense || dense.length === 0) {
    const empty: RunByRunHrMetrics = { hasHrSeries: false };
    if (avgCadenceRpm !== undefined) empty.avgCadenceRpm = avgCadenceRpm;
    return empty;
  }

  const zonesSorted = [...args.zones].sort(
    (a, b) => a.zoneNumber - b.zoneNumber,
  );
  const zoneSeconds =
    zonesSorted.length > 0
      ? secondsPerZoneFromDense(dense, zonesSorted)
      : undefined;
  const zonePct =
    zoneSeconds !== undefined ? pctFromZoneSeconds(zoneSeconds) : undefined;
  const drift = dense.length >= 4 ? quarterAvgHrs(dense) : undefined;
  const avgHrFromSeries = Math.round(
    dense.reduce((a, b) => a + b, 0) / dense.length,
  );

  const out: RunByRunHrMetrics = {
    hasHrSeries: true,
    avgHrFromSeries,
  };
  if (drift) out.drift = drift;
  if (zoneSeconds) out.zoneSeconds = zoneSeconds;
  if (zonePct && Object.keys(zonePct).length > 0) out.zonePct = zonePct;
  if (avgCadenceRpm !== undefined) out.avgCadenceRpm = avgCadenceRpm;
  return out;
}

const DRIFT_WARN = "⚠ above target (target ≤10 bpm)";
const DRIFT_STRONG = "⚠⚠ well above target";

/** tempo-cli driftSeverityLabel: only meaningful for easy-family / Long runs. */
export function driftSeverityLabel(
  driftBpm: number,
  runType: string | null | undefined,
): string | undefined {
  if (!isEasyFamily(runType) && !isLongRun(runType)) return undefined;
  const d = Math.abs(driftBpm);
  if (d <= 10) return undefined;
  return d <= 20 ? DRIFT_WARN : DRIFT_STRONG;
}
