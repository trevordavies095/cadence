/**
 * "Similar route:" and "Weather:" run-block lines — ports of tempo-cli's
 * weekly-recap/similar-route-line.ts and formatWeatherLine (markdown-report.ts).
 */
import type {
  TempoSimilarRoute,
  TempoUnitPreference,
} from "../tempo/port.js";
import { formatPaceFromSecondsPerKm } from "./runByRunFormat.js";

const METERS_PER_MILE = 1609.344;
const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

function weeksAgoLabel(
  currentStarted: string,
  similarStarted: string,
): string | undefined {
  const a = Date.parse(currentStarted.trim());
  const b = Date.parse(similarStarted.trim());
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  const diffWeeks = (a - b) / MS_PER_WEEK;
  if (diffWeeks < 0) return undefined;
  const w = Math.max(0, Math.round(diffWeeks));
  if (w === 0) return "this period";
  if (w === 1) return "1 week ago";
  return `${w} weeks ago`;
}

function distanceShort(meters: number, unit: TempoUnitPreference): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (unit === "imperial") return `${(meters / METERS_PER_MILE).toFixed(1)} mi`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function secPerKmToUnit(secPerKm: number, unit: TempoUnitPreference): number {
  return unit === "imperial" ? secPerKm * (METERS_PER_MILE / 1000) : secPerKm;
}

export type SimilarRouteCurrent = {
  startedAt: string;
  avgPaceS?: number | null;
  avgHeartRateBpm?: number | null;
};

/** Narrative after `Similar route: ` — `n/a` when there is nothing to show. */
export function formatSimilarRouteNarrative(args: {
  current: SimilarRouteCurrent;
  similar: TempoSimilarRoute | undefined;
  unit: TempoUnitPreference;
}): string {
  const { current, similar, unit } = args;
  if (!similar || typeof similar.startedAt !== "string") return "n/a";
  const wk = weeksAgoLabel(current.startedAt, similar.startedAt);
  if (!wk) return "n/a";

  const distPart =
    similar.distanceM !== undefined ? distanceShort(similar.distanceM, unit) : "";
  const label = similar.name?.trim() || similar.runType?.trim() || "run";
  const lead = distPart ? `${distPart} ${label}` : label;

  const simPace = similar.avgPaceS;
  const simHr = similar.avgHeartRateBpm;
  if (simPace === undefined && simHr === undefined) return "n/a";

  const atParts: string[] = [];
  if (simPace !== undefined) {
    atParts.push(formatPaceFromSecondsPerKm(simPace, unit));
  }
  if (simHr !== undefined) atParts.push(`avg HR ${Math.round(simHr)}`);
  const mid = `${lead} ${wk} at ${atParts.join(" · ")}`;

  const curPace =
    typeof current.avgPaceS === "number" && Number.isFinite(current.avgPaceS)
      ? current.avgPaceS
      : undefined;
  const curHr =
    typeof current.avgHeartRateBpm === "number" &&
    Number.isFinite(current.avgHeartRateBpm)
      ? current.avgHeartRateBpm
      : undefined;

  let paceDelta: number | undefined;
  let hrDelta: number | undefined;
  if (similar.paceDifferenceSecondsPerKm !== undefined) {
    paceDelta = secPerKmToUnit(similar.paceDifferenceSecondsPerKm, unit);
  } else if (curPace !== undefined && simPace !== undefined) {
    // Positive = current faster (lower sec/km).
    paceDelta = secPerKmToUnit(simPace - curPace, unit);
  }
  if (similar.heartRateDifferenceBpm !== undefined) {
    hrDelta = similar.heartRateDifferenceBpm;
  } else if (curHr !== undefined && simHr !== undefined) {
    hrDelta = curHr - simHr;
  }
  if (paceDelta === undefined && hrDelta === undefined) return mid;

  const bits: string[] = [];
  if (paceDelta !== undefined) {
    const unitLabel = unit === "imperial" ? "mi" : "km";
    bits.push(
      `${Math.abs(Math.round(paceDelta))}s/${unitLabel} ${paceDelta > 0 ? "faster" : "slower"}`,
    );
  }
  if (hrDelta !== undefined) {
    bits.push(`${hrDelta >= 0 ? "+" : ""}${Math.round(hrDelta)} bpm avg HR`);
  }
  let tail = ` → ${bits.join(" at ")}`;
  if (
    paceDelta !== undefined &&
    hrDelta !== undefined &&
    paceDelta > 0 &&
    hrDelta < 0
  ) {
    tail += " ✓";
  }
  return `${mid}${tail}`;
}

/** Text after `Similar route: ` (always present, as in tempo-cli). */
export function formatSimilarRouteText(args: {
  current: SimilarRouteCurrent;
  similar: TempoSimilarRoute | undefined;
  unavailableReason?: string;
  unit: TempoUnitPreference;
}): string {
  if (args.unavailableReason) return `n/a (${args.unavailableReason})`;
  return formatSimilarRouteNarrative(args);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pickFirst(
  o: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/**
 * Text after `Weather: ` (tempo-cli formatWeatherLine), or undefined to omit.
 * Temperature is °C, wind m/s (string wind is passed through verbatim).
 */
export function formatWeather(
  weather: unknown,
  unit: TempoUnitPreference,
): string | undefined {
  if (!isPlainObject(weather)) return undefined;
  const bits: string[] = [];
  const temp = pickFirst(weather, [
    "temperature",
    "Temperature",
    "temp",
    "Temp",
  ]);
  if (typeof temp === "number" && Number.isFinite(temp)) {
    bits.push(
      unit === "imperial"
        ? `${Math.round((temp * 9) / 5 + 32)}°F`
        : `${Math.round(temp)}°C`,
    );
  }
  const hum = pickFirst(weather, ["humidity", "Humidity", "relativeHumidity"]);
  if (typeof hum === "number" && Number.isFinite(hum)) {
    bits.push(`${Math.round(hum)}% RH`);
  }
  const wind = pickFirst(weather, ["wind", "Wind", "windSpeed"]);
  if (typeof wind === "string" && wind.trim()) bits.push(wind.trim());
  else if (typeof wind === "number" && Number.isFinite(wind)) {
    bits.push(
      unit === "imperial"
        ? `${(wind * 2.23694).toFixed(1)} mph`
        : `${(wind * 3.6).toFixed(1)} km/h`,
    );
  }
  return bits.length > 0 ? bits.join(", ") : undefined;
}
