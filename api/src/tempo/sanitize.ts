import type {
  TempoSimilarRoute,
  TempoTimeSeriesPoint,
  TempoWorkoutDetail,
  TempoWorkoutSplit,
  TempoWorkoutSummary,
} from "./port.js";

/** Keys that must never leave TempoPort (GPS / identity-adjacent raw blobs). */
const STRIP_KEYS = new Set([
  "route",
  "rawGpxData",
  "rawFitData",
  "rawStravaData",
  "rawHealthKitData",
  "healthKitUuid",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") return v;
  return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function pickSummary(raw: Record<string, unknown>): TempoWorkoutSummary {
  const id = asString(raw.id);
  const startedAt = asString(raw.startedAt);
  if (!id || !startedAt) {
    throw new Error("tempo_workout_missing_id_or_startedAt");
  }
  const durationS = asNumber(raw.durationS);
  const distanceM = asNumber(raw.distanceM);
  const avgPaceS = asNumber(raw.avgPaceS);
  if (
    durationS === undefined ||
    durationS === null ||
    distanceM === undefined ||
    distanceM === null ||
    avgPaceS === undefined ||
    avgPaceS === null
  ) {
    throw new Error("tempo_workout_missing_metrics");
  }

  const summary: TempoWorkoutSummary = {
    id,
    startedAt,
    durationS,
    distanceM,
    avgPaceS,
  };

  const elevGainM = asNumber(raw.elevGainM);
  if (elevGainM !== undefined) summary.elevGainM = elevGainM;
  const elevLossM = asNumber(raw.elevLossM);
  if (elevLossM !== undefined) summary.elevLossM = elevLossM;
  const movingTimeS = asNumber(raw.movingTimeS);
  if (movingTimeS !== undefined) summary.movingTimeS = movingTimeS;
  const timerTimeS = asNumber(raw.timerTimeS);
  if (timerTimeS !== undefined) summary.timerTimeS = timerTimeS;
  const maxHeartRateBpm = asNumber(raw.maxHeartRateBpm);
  if (maxHeartRateBpm !== undefined) summary.maxHeartRateBpm = maxHeartRateBpm;
  const avgHeartRateBpm = asNumber(raw.avgHeartRateBpm);
  if (avgHeartRateBpm !== undefined) summary.avgHeartRateBpm = avgHeartRateBpm;
  const minHeartRateBpm = asNumber(raw.minHeartRateBpm);
  if (minHeartRateBpm !== undefined) summary.minHeartRateBpm = minHeartRateBpm;
  const avgCadenceRpm = asNumber(raw.avgCadenceRpm);
  if (avgCadenceRpm !== undefined) summary.avgCadenceRpm = avgCadenceRpm;
  const relativeEffort = asNumber(raw.relativeEffort);
  if (relativeEffort !== undefined) summary.relativeEffort = relativeEffort;
  const rpe = asNumber(raw.rpe);
  if (rpe !== undefined) summary.rpe = rpe;
  const runType = asString(raw.runType);
  if (runType !== undefined) summary.runType = runType;
  const name = asString(raw.name);
  if (name !== undefined) summary.name = name;
  const notes = asString(raw.notes);
  if (notes !== undefined) summary.notes = notes;
  const source = asString(raw.source);
  if (source !== undefined) summary.source = source;
  const device = asString(raw.device);
  if (device !== undefined) summary.device = device;
  const shoeId = asString(raw.shoeId);
  if (shoeId !== undefined) summary.shoeId = shoeId;
  const hasRoute = asBoolean(raw.hasRoute);
  if (hasRoute !== undefined) summary.hasRoute = hasRoute;
  else if ("route" in raw) summary.hasRoute = raw.route != null;
  const splitsCount = asNumber(raw.splitsCount);
  if (splitsCount !== undefined && splitsCount !== null) {
    summary.splitsCount = splitsCount;
  }

  return summary;
}

function mapSplit(raw: unknown): TempoWorkoutSplit {
  if (!isPlainObject(raw)) return {};
  const split: TempoWorkoutSplit = {};
  const idx = asNumber(raw.idx);
  if (idx !== undefined && idx !== null) split.idx = idx;
  const kind = asString(raw.kind);
  if (kind !== undefined) split.kind = kind;
  const distanceM = asNumber(raw.distanceM);
  if (distanceM !== undefined) split.distanceM = distanceM;
  const durationS = asNumber(raw.durationS);
  if (durationS !== undefined) split.durationS = durationS;
  const paceS = asNumber(raw.paceS);
  if (paceS !== undefined) split.paceS = paceS;
  const avgHeartRateBpm = asNumber(raw.avgHeartRateBpm);
  if (avgHeartRateBpm !== undefined) split.avgHeartRateBpm = avgHeartRateBpm;
  const startElapsedS = asNumber(raw.startElapsedS);
  if (startElapsedS !== undefined) split.startElapsedS = startElapsedS;
  const endElapsedS = asNumber(raw.endElapsedS);
  if (endElapsedS !== undefined) split.endElapsedS = endElapsedS;
  const startDistanceM = asNumber(raw.startDistanceM);
  if (startDistanceM !== undefined) split.startDistanceM = startDistanceM;
  const intensity = asString(raw.intensity);
  if (intensity !== undefined) split.intensity = intensity;
  const trigger = asString(raw.trigger);
  if (trigger !== undefined) split.trigger = trigger;
  const stepIndex = asNumber(raw.stepIndex);
  if (stepIndex !== undefined) split.stepIndex = stepIndex;
  return split;
}

export function mapTimeSeriesPoint(raw: unknown): TempoTimeSeriesPoint {
  if (!isPlainObject(raw)) return {};
  const point: TempoTimeSeriesPoint = {};
  const elapsedSeconds = asNumber(raw.elapsedSeconds);
  if (elapsedSeconds !== undefined) point.elapsedSeconds = elapsedSeconds;
  const heartRateBpm = asNumber(raw.heartRateBpm);
  if (heartRateBpm !== undefined) point.heartRateBpm = heartRateBpm;
  const distanceM = asNumber(raw.distanceM);
  if (distanceM !== undefined) point.distanceM = distanceM;
  const cadenceRpm = asNumber(raw.cadenceRpm);
  if (cadenceRpm !== undefined) point.cadenceRpm = cadenceRpm;
  const speedMps = asNumber(raw.speedMps);
  if (speedMps !== undefined) point.speedMps = speedMps;
  const elevationM = asNumber(raw.elevationM);
  if (elevationM !== undefined) point.elevationM = elevationM;
  const powerWatts = asNumber(raw.powerWatts);
  if (powerWatts !== undefined) point.powerWatts = powerWatts;
  return point;
}

/** Assert coach payloads never carry GPS strip keys (for tests / defense in depth). */
export function assertNoGpsFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoGpsFields(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (STRIP_KEYS.has(key)) {
      throw new Error(`gps_field_leaked:${key}`);
    }
    assertNoGpsFields(value[key]);
  }
}

export function sanitizeWorkoutSummary(raw: unknown): TempoWorkoutSummary {
  if (!isPlainObject(raw)) {
    throw new Error("tempo_workout_not_object");
  }
  const summary = pickSummary(raw);
  assertNoGpsFields(summary);
  return summary;
}

export function sanitizeWorkoutDetail(raw: unknown): TempoWorkoutDetail {
  if (!isPlainObject(raw)) {
    throw new Error("tempo_workout_not_object");
  }
  const summary = pickSummary(raw);
  const splitsRaw = Array.isArray(raw.splits) ? raw.splits : [];
  const detail: TempoWorkoutDetail = {
    ...summary,
    splits: splitsRaw.map(mapSplit),
  };
  if (Array.isArray(raw.timeSeries)) {
    detail.timeSeries = raw.timeSeries.map(mapTimeSeriesPoint);
  }
  if (raw.weather !== undefined) detail.weather = raw.weather;
  if (raw.heartRateZoneTimes !== undefined) {
    detail.heartRateZoneTimes = raw.heartRateZoneTimes;
  }
  if (raw.shoe !== undefined) detail.shoe = raw.shoe;
  if (detail.splitsCount === undefined) {
    detail.splitsCount = detail.splits.length;
  }
  assertNoGpsFields(detail);
  return detail;
}

function pickKey(
  obj: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Rows of a similar-routes body (array or wrapped), tempo-cli key set. */
export function similarRouteRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isPlainObject(body)) return [];
  const inner = pickKey(body, [
    "items",
    "Items",
    "similarRoutes",
    "SimilarRoutes",
    "routes",
    "Routes",
    "data",
    "Data",
  ]);
  return Array.isArray(inner) ? inner : [];
}

/** Whitelist mapper for one similar-routes row (wrapper + nested workout). */
export function mapSimilarRoute(raw: unknown): TempoSimilarRoute | undefined {
  if (!isPlainObject(raw)) return undefined;
  const nestedRaw = pickKey(raw, [
    "workout",
    "Workout",
    "pastWorkout",
    "PastWorkout",
  ]);
  const w = isPlainObject(nestedRaw) ? nestedRaw : raw;
  const out: TempoSimilarRoute = {};
  const startedAt = nonEmptyString(pickKey(w, ["startedAt", "StartedAt"]));
  if (startedAt !== undefined) out.startedAt = startedAt;
  const distanceM = finiteNumber(pickKey(w, ["distanceM", "Distance"]));
  if (distanceM !== undefined) out.distanceM = distanceM;
  const name = nonEmptyString(
    pickKey(w, ["name", "Name", "routeName", "RouteName", "title", "Title"]),
  );
  if (name !== undefined) out.name = name;
  const runType = nonEmptyString(pickKey(w, ["runType", "RunType"]));
  if (runType !== undefined) out.runType = runType;
  const avgPaceS = finiteNumber(pickKey(w, ["avgPaceS", "AvgPaceS"]));
  if (avgPaceS !== undefined) out.avgPaceS = avgPaceS;
  const avgHr = finiteNumber(
    pickKey(w, ["avgHeartRateBpm", "AvgHeartRateBpm"]),
  );
  if (avgHr !== undefined) out.avgHeartRateBpm = avgHr;
  const paceKeys = [
    "paceDifferenceSecondsPerKm",
    "PaceDifferenceSecondsPerKm",
    "paceDifferenceSeconds",
    "PaceDifferenceSeconds",
    "averagePaceDifferenceSeconds",
  ];
  const hrKeys = [
    "heartRateDifferenceBpm",
    "HeartRateDifferenceBpm",
    "avgHeartRateDifferenceBpm",
    "AvgHeartRateDifferenceBpm",
  ];
  // Wrapper first, then nested workout (tempo-cli order).
  const paceDelta =
    finiteNumber(pickKey(raw, paceKeys)) ?? finiteNumber(pickKey(w, paceKeys));
  if (paceDelta !== undefined) out.paceDifferenceSecondsPerKm = paceDelta;
  const hrDelta =
    finiteNumber(pickKey(raw, hrKeys)) ?? finiteNumber(pickKey(w, hrKeys));
  if (hrDelta !== undefined) out.heartRateDifferenceBpm = hrDelta;
  assertNoGpsFields(out);
  return out;
}
