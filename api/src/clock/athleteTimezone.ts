import { FixedClock } from "./clock.js";
import { resolveIsoWeek } from "./isoWeek.js";

export const DEFAULT_ATHLETE_TIMEZONE = "UTC";

/**
 * Resolve the single server-side athlete timezone from `ATHLETE_TIMEZONE`
 * (IANA name). Unset/blank returns `fallback`. An invalid name throws a clear
 * error so the API fails at startup rather than serving the wrong week.
 */
export function resolveAthleteTimezone(
  env: Record<string, string | undefined> = process.env,
  fallback: string = DEFAULT_ATHLETE_TIMEZONE,
): string {
  const name = env.ATHLETE_TIMEZONE?.trim() || fallback;
  try {
    // Same Intl machinery the ISO-week math uses.
    resolveIsoWeek(new FixedClock(new Date("2026-01-01T00:00:00Z")), name);
  } catch {
    throw new Error(
      `Invalid ATHLETE_TIMEZONE "${name}": expected an IANA timezone name such as "America/New_York" or "UTC".`,
    );
  }
  return name;
}
