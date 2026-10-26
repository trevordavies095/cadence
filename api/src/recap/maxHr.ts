import type { TempoHeartRateZones } from "../tempo/port.js";

/**
 * Athlete max HR as tempo-cli resolves it: AgeBased -> 220 - age; otherwise the
 * explicit maxHeartRateBpm; otherwise the top zone ceiling.
 */
export function resolveConfiguredMaxHr(
  hz: TempoHeartRateZones | undefined,
): number | undefined {
  if (!hz) return undefined;
  const method = (hz.calculationMethod ?? "").toLowerCase();
  if (method === "agebased") {
    const age = hz.age;
    if (typeof age === "number" && age > 0 && age < 120) {
      return Math.round(220 - age);
    }
  }
  const max = hz.maxHeartRateBpm;
  if (typeof max === "number" && max > 0 && max < 250) return Math.round(max);
  if (hz.zones.length === 0) return undefined;
  const top = [...hz.zones].sort((a, b) => a.zoneNumber - b.zoneNumber).at(-1)!;
  return top.maxBpm > 0 ? top.maxBpm : undefined;
}

/** Percent of max HR, one decimal (tempo-cli percentMaxHr). */
export function percentMaxHr(
  avgHr: number | undefined,
  maxHr: number | undefined,
): number | undefined {
  if (avgHr === undefined || maxHr === undefined || maxHr <= 0) return undefined;
  return Math.round((1000 * avgHr) / maxHr) / 10;
}
