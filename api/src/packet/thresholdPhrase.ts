import type { TempoUnitPreference } from "../tempo/port.js";
import type { ModelPacketCoaching } from "./types.js";

const METERS_PER_MILE = 1609.344;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function formatPace(secPerKm: number, unit: TempoUnitPreference): string {
  const perUnit =
    unit === "imperial" ? secPerKm * (METERS_PER_MILE / 1000) : secPerKm;
  // Round the whole pace first so 4:59.6 prints 5:00, not 4:60.
  const total = Math.round(perUnit);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}${unit === "imperial" ? "/mi" : "/km"}`;
}

/** "Mar 2" from a yyyy-MM-dd (or ISO timestamp) date; null when unreadable. */
function formatDay(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return null;
  return `${month} ${day}`;
}

function usable(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * The threshold clause for the prompt's phase line, in the athlete's unit:
 * the athlete-set pace, else the running log's suggestion with its source,
 * else null.
 *
 *   "Threshold pace 4:10/km (set in your running log)"
 *   "Threshold pace 4:14/km (suggested by your running log from your 5K on Mar 2)"
 */
export function thresholdPhrase(
  coaching: ModelPacketCoaching | null | undefined,
  unit: TempoUnitPreference,
): string | null {
  if (!coaching) return null;
  if (usable(coaching.thresholdPaceS)) {
    return `Threshold pace ${formatPace(coaching.thresholdPaceS, unit)} (set in your running log)`;
  }
  if (usable(coaching.suggestedThresholdPaceS)) {
    const pace = formatPace(coaching.suggestedThresholdPaceS, unit);
    const from = coaching.suggestedThresholdFrom;
    const day = from ? formatDay(from.workoutDate) : null;
    const distance = from?.distance.trim();
    const source = distance && day ? ` from your ${distance} on ${day}` : "";
    return `Threshold pace ${pace} (suggested by your running log${source})`;
  }
  return null;
}
