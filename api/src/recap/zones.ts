import type {
  TempoHeartRateZone,
  TempoTimeSeriesPoint,
  TempoWorkoutDetail,
} from "../tempo/port.js";

export type HrSamplePoint = {
  elapsedSeconds: number;
  heartRateBpm: number;
};

export type ZoneWeekDistribution = {
  totalHrSeconds: number;
  /** Seconds in Z1..Zn (aligned with sorted zones). */
  zoneSeconds: number[];
  zonePct?: Record<string, number>;
  z1z2Pct?: number;
  /** Set only when there is a target and a verdict: z1z2Pct at or above easyShareTarget. */
  z1z2TargetMet?: boolean;
  /** The goal's easy-share target in percent; null shows the share with no target. */
  easyShareTarget: number | null;
  /** False: the target is a reference only, with no verdict (the speed column). */
  easyShareVerdict: boolean;
  noHrTimeSeriesInWeek: boolean;
  note?: string;
};

/** Extract HR samples from port time-series points (skips missing/invalid). */
export function samplesFromTimeSeries(
  points: readonly TempoTimeSeriesPoint[] | undefined,
): HrSamplePoint[] {
  if (!points || points.length === 0) return [];
  const out: HrSamplePoint[] = [];
  for (const p of points) {
    const es = p.elapsedSeconds;
    const hr = p.heartRateBpm;
    if (typeof es !== "number" || !Number.isFinite(es)) continue;
    if (typeof hr !== "number" || !Number.isFinite(hr)) continue;
    const rounded = Math.round(hr);
    if (rounded <= 0) continue;
    out.push({
      elapsedSeconds: Math.max(0, Math.floor(es)),
      heartRateBpm: rounded,
    });
  }
  return out;
}

/**
 * One HR value per elapsed second [0 .. len−1], forward-filled from sorted samples.
 */
export function buildDenseHrPerSecond(
  samples: readonly HrSamplePoint[],
  durationS: number | undefined,
): number[] | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort(
    (a, b) => a.elapsedSeconds - b.elapsedSeconds,
  );
  const maxEl = sorted[sorted.length - 1]!.elapsedSeconds;
  let len =
    durationS !== undefined && durationS > 0 ? durationS : maxEl + 1;
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

/** Zone index 0..n-1 for sorted zones Z1..Zn (clamp below/above). */
export function zoneIndexForBpm(
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

function sortZones(
  zones: readonly TempoHeartRateZone[],
): TempoHeartRateZone[] {
  return [...zones].sort((a, b) => a.zoneNumber - b.zoneNumber);
}

/**
 * Aggregate week-total Z1–Z5 seconds/% from workout details + settings zones.
 * Graceful when zones or HR samples are missing.
 */
export function computeWeekZoneDistribution(args: {
  zones: readonly TempoHeartRateZone[];
  workouts: readonly TempoWorkoutDetail[];
  /** The goal's easy-share target; null or omitted: no met flag. */
  easyShareTarget?: number | null;
  /** The goal judges the share against its target; omitted: true. */
  easyShareVerdict?: boolean;
}): ZoneWeekDistribution {
  const zonesSorted = sortZones(args.zones);
  const easyShareTarget = args.easyShareTarget ?? null;
  const easyShareVerdict = args.easyShareVerdict ?? true;

  if (zonesSorted.length === 0) {
    return {
      totalHrSeconds: 0,
      zoneSeconds: [],
      easyShareTarget,
      easyShareVerdict,
      noHrTimeSeriesInWeek: true,
      note: "No HR zones configured in Tempo settings.",
    };
  }

  const weekSeconds = new Array(zonesSorted.length).fill(0) as number[];

  if (args.workouts.length === 0) {
    return {
      totalHrSeconds: 0,
      zoneSeconds: weekSeconds,
      easyShareTarget,
      easyShareVerdict,
      noHrTimeSeriesInWeek: true,
      note: "No workouts in recap window.",
    };
  }

  for (const w of args.workouts) {
    const samples = samplesFromTimeSeries(w.timeSeries);
    const durationS =
      typeof w.durationS === "number" &&
      Number.isFinite(w.durationS) &&
      w.durationS > 0
        ? Math.floor(w.durationS)
        : undefined;
    const dense =
      samples.length > 0
        ? buildDenseHrPerSecond(samples, durationS)
        : undefined;
    if (!dense || dense.length === 0) continue;
    const zoneSec = secondsPerZoneFromDense(dense, zonesSorted);
    for (let i = 0; i < zonesSorted.length; i++) {
      weekSeconds[i]! += zoneSec[i]!;
    }
  }

  return zoneDistributionFromSeconds(
    weekSeconds,
    easyShareTarget,
    easyShareVerdict,
  );
}

/**
 * Week distribution from seconds per zone (Z1..Zn order): the per-second
 * sums above, or the log's stored zone seconds from the weekly recap.
 */
export function zoneDistributionFromSeconds(
  weekSeconds: readonly number[],
  /** The goal's easy-share target; null or omitted: no met flag. */
  easyShareTarget: number | null = null,
  /** The goal judges the share against its target; false: reference only. */
  easyShareVerdict = true,
): ZoneWeekDistribution {
  const totalHrSeconds = weekSeconds.reduce((a, b) => a + b, 0);
  if (totalHrSeconds === 0) {
    return {
      totalHrSeconds: 0,
      zoneSeconds: [...weekSeconds],
      easyShareTarget,
      easyShareVerdict,
      noHrTimeSeriesInWeek: true,
      note: "No usable HR samples for workouts this week. Zone totals need time-series heart rate.",
    };
  }

  const zonePct = pctFromZoneSeconds(weekSeconds);
  const z1 = weekSeconds[0] ?? 0;
  const z2 = weekSeconds[1] ?? 0;
  const z1z2Pct = Math.round((10000 * (z1 + z2)) / totalHrSeconds) / 100;

  return {
    totalHrSeconds,
    zoneSeconds: [...weekSeconds],
    zonePct,
    z1z2Pct,
    ...(easyShareTarget !== null && easyShareVerdict
      ? { z1z2TargetMet: z1z2Pct >= easyShareTarget }
      : {}),
    easyShareTarget,
    easyShareVerdict,
    noHrTimeSeriesInWeek: false,
  };
}
