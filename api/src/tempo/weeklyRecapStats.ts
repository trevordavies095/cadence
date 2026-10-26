import type { TempoWeeklyRecapMetric, TempoWeeklyRecapStats } from "./port.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pickFirst(
  o: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(o, k)) return o[k];
  }
  return undefined;
}

function finite(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseBlock(raw: unknown): TempoWeeklyRecapMetric | undefined {
  if (!isPlainObject(raw)) return undefined;
  const block: TempoWeeklyRecapMetric = {};
  const current = finite(pickFirst(raw, ["current", "Current", "CurrentWeek"]));
  const previous = finite(
    pickFirst(raw, ["previous", "Previous", "PreviousWeek"]),
  );
  const trailingAvg = finite(
    pickFirst(raw, [
      "trailingAvg",
      "TrailingAvg",
      "threeWeekAverage",
      "ThreeWeekAverage",
    ]),
  );
  if (current !== undefined) block.current = current;
  if (previous !== undefined) block.previous = previous;
  if (trailingAvg !== undefined) block.trailingAvg = trailingAvg;
  return Object.keys(block).length > 0 ? block : undefined;
}

function metricsObject(
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const direct = pickFirst(root, ["metrics", "Metrics"]);
  if (isPlainObject(direct)) return direct;
  for (const wk of ["data", "Data", "result", "Result", "value", "Value"]) {
    const w = root[wk];
    if (!isPlainObject(w)) continue;
    const nested = pickFirst(w, ["metrics", "Metrics"]);
    if (isPlainObject(nested)) return nested;
    if (
      pickFirst(w, ["runs", "Runs", "distanceM", "DistanceM"]) !== undefined
    ) {
      return w;
    }
  }
  return undefined;
}

/**
 * Parse GET /stats/weekly-recap (tempo-cli `parseWeeklyRecapResponse` shapes).
 * Returns undefined when the body has no usable metric blocks.
 */
export function parseWeeklyRecapStats(
  parsed: unknown,
): TempoWeeklyRecapStats | undefined {
  if (!isPlainObject(parsed)) return undefined;
  const metrics = metricsObject(parsed);
  if (!metrics) return undefined;
  const out: TempoWeeklyRecapStats = {};
  const set = (key: keyof TempoWeeklyRecapStats, names: readonly string[]) => {
    const b = parseBlock(pickFirst(metrics, names));
    if (b) out[key] = b;
  };
  set("runs", ["runs", "Runs", "runCount", "RunCount"]);
  set("distanceM", [
    "distanceM",
    "DistanceM",
    "totalDistanceM",
    "TotalDistanceM",
  ]);
  set("durationS", [
    "durationS",
    "DurationS",
    "durationSeconds",
    "DurationSeconds",
    "totalDurationS",
    "TotalDurationS",
  ]);
  set("elevationGainM", [
    "elevationGainM",
    "ElevationGainM",
    "elevGainM",
    "ElevGainM",
    "totalElevationGainM",
    "TotalElevationGainM",
  ]);
  set("relativeEffortSum", [
    "relativeEffortSum",
    "RelativeEffortSum",
    "relativeEffort",
    "RelativeEffort",
  ]);
  set("easyRunAvgHeartRateBpm", [
    "easyRunAvgHeartRateBpm",
    "EasyRunAvgHeartRateBpm",
    "easyRunHeartRateBpm",
    "EasyRunHeartRateBpm",
  ]);
  return Object.keys(out).length > 0 ? out : undefined;
}
