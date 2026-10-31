/**
 * Shoe distance, read in the unit Tempo states and shown in the athlete's unit.
 *
 * Tempo's `GET /shoes` returns `totalMileage` in the athlete's preferred unit,
 * named by `unit` ("miles" or "km"); it already includes the shoe's starting
 * distance. `initialMileageM` is always metres. An export's shoes.json carries
 * only `initialMileageM`.
 */

import type { TempoUnitPreference } from "../tempo/port.js";

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;

/** The shoe warning fires above this distance, in metres (400 miles). */
export const SHOE_WARN_DISTANCE_M = 400 * METERS_PER_MILE;

/** Metres in one of Tempo's stated shoe units; undefined when the unit is unknown. */
function metersPerUnit(unit: unknown): number | undefined {
  if (typeof unit !== "string") return undefined;
  switch (unit.trim().toLowerCase()) {
    case "miles":
    case "mile":
    case "mi":
      return METERS_PER_MILE;
    case "km":
    case "kilometers":
    case "kilometres":
      return METERS_PER_KM;
    default:
      return undefined;
  }
}

function finiteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * A shoe's distance in metres: `totalMileage` in its stated `unit`, else the
 * starting distance. A total with no known unit is left out, not guessed.
 */
export function shoeDistanceM(shoe: {
  totalMileage?: unknown;
  unit?: unknown;
  initialMileageM?: unknown;
}): number | undefined {
  const perUnit = metersPerUnit(shoe.unit);
  if (perUnit !== undefined && finiteNonNegative(shoe.totalMileage)) {
    return shoe.totalMileage * perUnit;
  }
  if (finiteNonNegative(shoe.initialMileageM) && shoe.initialMileageM > 0) {
    return shoe.initialMileageM;
  }
  return undefined;
}

/** Whole-unit shoe distance in the athlete's unit, e.g. "412 mi" or "663 km". */
export function formatShoeDistance(
  meters: number,
  unit: TempoUnitPreference,
): string {
  return unit === "imperial"
    ? `${Math.round(meters / METERS_PER_MILE)} mi`
    : `${Math.round(meters / METERS_PER_KM)} km`;
}
