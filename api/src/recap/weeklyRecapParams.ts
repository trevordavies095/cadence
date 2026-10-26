import type { WeeklyRecapStatsQuery } from "../tempo/port.js";

/**
 * GET /stats/weekly-recap params the way tempo-cli sends them:
 * referenceDate = local Monday (yyyy-MM-dd) and timezoneOffsetMinutes = the
 * zone's offset (east of UTC, negative behind) at Monday 00:00 local.
 * `weekStartIso` is the week session's start instant (Monday 00:00 local).
 */
export function weeklyRecapQueryForWeek(
  weekStartIso: string,
  timeZone: string,
): WeeklyRecapStatsQuery {
  const instant = new Date(weekStartIso);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const get = (type: string): number =>
    Number(dtf.formatToParts(instant).find((p) => p.type === type)?.value);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const localAsUtc = Date.UTC(
    y,
    mo - 1,
    d,
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMin = Math.round(
    (localAsUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000,
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    referenceDate: `${y}-${pad(mo)}-${pad(d)}`,
    timezoneOffsetMinutes: offsetMin,
  };
}
