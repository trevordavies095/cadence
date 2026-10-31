import type {
  TempoAthleteSettings,
  TempoBestEffort,
  TempoBestEfforts,
  TempoHeartRateZone,
  TempoHeartRateZones,
  TempoShoe,
  TempoUnitPreference,
} from "./port.js";

const CALC_METHOD_NAMES = ["AgeBased", "Karvonen", "Custom"] as const;

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

export function parseUnitPreference(raw: unknown): TempoUnitPreference {
  if (isPlainObject(raw)) {
    const v = asString(raw.unitPreference);
    if (v === "imperial" || v === "metric") return v;
  }
  if (raw === "imperial" || raw === "metric") return raw;
  return "metric";
}

function calculationMethodLabel(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 3) {
    return CALC_METHOD_NAMES[raw]!;
  }
  return "AgeBased";
}

function zonesFromFlatExport(settings: Record<string, unknown>): TempoHeartRateZone[] {
  const zones: TempoHeartRateZone[] = [];
  for (let n = 1; n <= 5; n++) {
    const minBpm = asNumber(settings[`zone${n}MinBpm`]);
    const maxBpm = asNumber(settings[`zone${n}MaxBpm`]);
    if (
      minBpm === undefined ||
      minBpm === null ||
      maxBpm === undefined ||
      maxBpm === null
    ) {
      continue;
    }
    zones.push({ zoneNumber: n, minBpm, maxBpm });
  }
  return zones;
}

function zonesFromLiveDoc(raw: unknown): TempoHeartRateZone[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.zones)) return [];
  const out: TempoHeartRateZone[] = [];
  for (const item of raw.zones) {
    if (!isPlainObject(item)) continue;
    const zoneNumber = asNumber(item.zoneNumber);
    const minBpm = asNumber(item.minBpm);
    const maxBpm = asNumber(item.maxBpm);
    if (
      zoneNumber === undefined ||
      zoneNumber === null ||
      minBpm === undefined ||
      minBpm === null ||
      maxBpm === undefined ||
      maxBpm === null
    ) {
      continue;
    }
    out.push({ zoneNumber, minBpm, maxBpm });
  }
  return out;
}

/** Map Tempo GET /settings/heart-rate-zones JSON. */
export function parseHeartRateZonesLive(raw: unknown): TempoHeartRateZones {
  if (!isPlainObject(raw)) {
    return { calculationMethod: "AgeBased", zones: [] };
  }
  const zones: TempoHeartRateZones = {
    calculationMethod: calculationMethodLabel(raw.calculationMethod),
    zones: zonesFromLiveDoc(raw),
  };
  const age = asNumber(raw.age);
  if (age !== undefined) zones.age = age;
  const resting = asNumber(raw.restingHeartRateBpm);
  if (resting !== undefined) zones.restingHeartRateBpm = resting;
  const maxHr = asNumber(raw.maxHeartRateBpm);
  if (maxHr !== undefined) zones.maxHeartRateBpm = maxHr;
  return zones;
}

/** Map export `data/settings.json` (flat zoneNMinBpm fields) to coach settings. */
export function parseAthleteSettingsFromExport(
  raw: unknown,
): TempoAthleteSettings {
  const rec = isPlainObject(raw) ? raw : {};
  const heartRateZones: TempoHeartRateZones = {
    calculationMethod: calculationMethodLabel(rec.calculationMethod),
    zones: zonesFromFlatExport(rec),
  };
  const age = asNumber(rec.age);
  if (age !== undefined) heartRateZones.age = age;
  const resting = asNumber(rec.restingHeartRateBpm);
  if (resting !== undefined) heartRateZones.restingHeartRateBpm = resting;
  const maxHr = asNumber(rec.maxHeartRateBpm);
  if (maxHr !== undefined) heartRateZones.maxHeartRateBpm = maxHr;

  const defaultShoeId = asString(rec.defaultShoeId);

  return {
    unitPreference: parseUnitPreference(rec),
    ...(defaultShoeId !== undefined ? { defaultShoeId } : {}),
    heartRateZones,
  };
}

export function parseShoe(raw: unknown): TempoShoe | null {
  if (!isPlainObject(raw)) return null;
  const id = asString(raw.id);
  const brand = asString(raw.brand);
  const model = asString(raw.model);
  const isRetired = asBoolean(raw.isRetired);
  if (!id || !brand || !model || isRetired === undefined) return null;

  const shoe: TempoShoe = { id, brand, model, isRetired };
  const initialMileageM = asNumber(raw.initialMileageM);
  if (initialMileageM !== undefined) shoe.initialMileageM = initialMileageM;
  const totalMileage = asNumber(raw.totalMileage);
  if (totalMileage !== undefined) shoe.totalMileage = totalMileage;
  const unit = asString(raw.unit);
  if (unit !== undefined) shoe.unit = unit;
  const createdAt = asString(raw.createdAt);
  if (createdAt !== undefined) shoe.createdAt = createdAt;
  const updatedAt = asString(raw.updatedAt);
  if (updatedAt !== undefined) shoe.updatedAt = updatedAt;
  return shoe;
}

export function parseShoesList(raw: unknown): TempoShoe[] {
  if (!Array.isArray(raw)) return [];
  const out: TempoShoe[] = [];
  for (const item of raw) {
    const shoe = parseShoe(item);
    if (shoe) out.push(shoe);
  }
  return out;
}

function parseBestEffort(raw: unknown): TempoBestEffort | null {
  if (!isPlainObject(raw)) return null;
  const distance = asString(raw.distance);
  const distanceM = asNumber(raw.distanceM);
  const timeS = asNumber(raw.timeS);
  const workoutIdRaw = raw.workoutId;
  const workoutId =
    typeof workoutIdRaw === "string"
      ? workoutIdRaw
      : workoutIdRaw != null
        ? String(workoutIdRaw)
        : undefined;
  const workoutDate = asString(raw.workoutDate);
  const previousTimeS = asNumber(raw.previousTimeS);
  if (
    !distance ||
    distanceM === undefined ||
    distanceM === null ||
    timeS === undefined ||
    timeS === null ||
    !workoutId ||
    !workoutDate
  ) {
    return null;
  }
  return {
    distance,
    distanceM,
    timeS: Math.trunc(timeS),
    workoutId,
    workoutDate,
    previousTimeS:
      typeof previousTimeS === "number" ? Math.trunc(previousTimeS) : null,
  };
}

/**
 * Normalize live `{ distances }` or export `BestEffort[]` to coach shape.
 */
export function parseBestEfforts(raw: unknown): TempoBestEfforts {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isPlainObject(raw) && Array.isArray(raw.distances)) {
    items = raw.distances;
  }
  const distances: TempoBestEffort[] = [];
  for (const item of items) {
    const effort = parseBestEffort(item);
    if (effort) distances.push(effort);
  }
  return { distances };
}
