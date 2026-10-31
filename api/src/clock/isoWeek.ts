import type { Clock } from "./clock.js";

export type IsoWeekBounds = {
  /** ISO week label, e.g. 2026-W42 */
  isoWeek: string;
  /** Monday 00:00:00.000 in the given IANA timezone (as UTC instant). */
  start: string;
  /** Sunday 23:59:59.999 in the given IANA timezone (as UTC instant). */
  end: string;
  /** Clock "now" as ISO string. */
  now: string;
  timezone: string;
};

/**
 * Mon–Sun ISO week containing `now` in `timeZone`.
 * Calendar math uses Intl zoned parts so a FixedClock + timezone is deterministic.
 */
/** Local calendar date YYYY-MM-DD for `clock.now()` in `timeZone`. */
export function localCalendarDateYmd(
  clock: Clock,
  timeZone = "UTC",
): string {
  const parts = zonedYmdWeekday(clock.now(), timeZone);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

export function resolveIsoWeek(
  clock: Clock,
  timeZone = "UTC",
): IsoWeekBounds {
  const now = clock.now();
  const parts = zonedYmdWeekday(now, timeZone);
  const daysFromMonday = parts.weekday - 1;

  const monday = addCalendarDays(parts.year, parts.month, parts.day, -daysFromMonday);
  const sunday = addCalendarDays(monday.year, monday.month, monday.day, 6);

  const start = localMidnightToUtc(monday.year, monday.month, monday.day, timeZone, "start");
  const end = localMidnightToUtc(sunday.year, sunday.month, sunday.day, timeZone, "end");

  const { isoYear, isoWeek } = isoWeekNumber(monday.year, monday.month, monday.day);

  return {
    isoWeek: `${isoYear}-W${String(isoWeek).padStart(2, "0")}`,
    start: start.toISOString(),
    end: end.toISOString(),
    now: now.toISOString(),
    timezone: timeZone,
  };
}

/**
 * Mon–Sun bounds for a known ISO week label in `timeZone`.
 * Same local-midnight math as {@link resolveIsoWeek}, without needing a clock "now".
 */
export function boundsForIsoWeek(
  isoWeek: string,
  timeZone = "UTC",
): Pick<IsoWeekBounds, "isoWeek" | "start" | "end" | "timezone"> {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) {
    throw new Error(`Invalid ISO week label: ${isoWeek}`);
  }
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) {
    throw new Error(`Invalid ISO week number: ${isoWeek}`);
  }

  const monday = mondayOfIsoWeek(isoYear, week);
  const sunday = addCalendarDays(monday.year, monday.month, monday.day, 6);
  const start = localMidnightToUtc(monday.year, monday.month, monday.day, timeZone, "start");
  const end = localMidnightToUtc(sunday.year, sunday.month, sunday.day, timeZone, "end");

  // Reject labels that are not real ISO weeks (e.g. 2026-W53 when year has 52).
  const verified = isoWeekNumber(monday.year, monday.month, monday.day);
  const normalized = `${verified.isoYear}-W${String(verified.isoWeek).padStart(2, "0")}`;
  if (normalized !== isoWeek) {
    throw new Error(`Invalid ISO week label: ${isoWeek}`);
  }

  return {
    isoWeek,
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: timeZone,
  };
}

/** Calendar Monday (Y-M-D) of ISO week `week` in `isoYear`. */
function mondayOfIsoWeek(isoYear: number, week: number): Ymd {
  // Jan 4 is always in ISO week 1 of isoYear.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4, 12, 0, 0));
  const utcDay = jan4.getUTCDay(); // 0=Sun … 6=Sat
  const weekday = utcDay === 0 ? 7 : utcDay; // Mon=1 … Sun=7
  const week1Monday = addCalendarDays(isoYear, 1, 4, -(weekday - 1));
  return addCalendarDays(
    week1Monday.year,
    week1Monday.month,
    week1Monday.day,
    (week - 1) * 7,
  );
}

type Ymd = { year: number; month: number; day: number };

function zonedYmdWeekday(
  instant: Date,
  timeZone: string,
): Ymd & { weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const map = Object.fromEntries(
    fmt.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const weekday = weekdayMap[map.weekday ?? ""];
  if (!weekday) {
    throw new Error(`Unable to resolve weekday in ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday,
  };
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): Ymd {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + delta);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function isoWeekNumber(
  year: number,
  month: number,
  day: number,
): { isoYear: number; isoWeek: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const isoYear = date.getUTCFullYear();
  const week1 = new Date(Date.UTC(isoYear, 0, 4));
  const isoWeek =
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getUTCDay() + 6) % 7)) /
        7,
    );
  return { isoYear, isoWeek };
}

/**
 * Map a local calendar day in `timeZone` to the UTC instant for week start/end.
 * For UTC this is exact; for other zones we probe offset candidates.
 */
function localMidnightToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
  edge: "start" | "end",
): Date {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") {
    if (edge === "start") {
      return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    }
    return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  }

  const hour = edge === "start" ? 0 : 23;
  const minute = edge === "start" ? 0 : 59;
  const second = edge === "start" ? 0 : 59;
  const ms = edge === "start" ? 0 : 999;

  // Probe UTC candidates by subtracting plausible offsets.
  const base = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  for (let offsetMin = -14 * 60; offsetMin <= 14 * 60; offsetMin += 15) {
    const candidate = new Date(base - offsetMin * 60_000);
    if (zonedMatches(candidate, year, month, day, hour, minute, second, timeZone)) {
      if (edge === "end") {
        candidate.setUTCMilliseconds(999);
      }
      return candidate;
    }
  }
  return new Date(base);
}

function zonedMatches(
  instant: Date,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(
    fmt.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return (
    Number(map.year) === year &&
    Number(map.month) === month &&
    Number(map.day) === day &&
    Number(map.hour) === hour &&
    Number(map.minute) === minute &&
    Number(map.second) === second
  );
}

export type PlanWeekBounds = {
  isoWeek: string;
  /** Monday 00:00 local, as UTC instant. */
  start: string;
  /** Sunday 23:59:59.999 local, as UTC instant. */
  end: string;
  /** Monday calendar date YYYY-MM-DD (timezone-independent). */
  startDate: string;
  /** Sunday calendar date YYYY-MM-DD. */
  endDate: string;
};

function ymdString(v: Ymd): string {
  return `${v.year}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}`;
}

/**
 * The ISO week after `isoWeek`, with calendar Mon/Sun dates and instants in
 * `timeZone`. Used to plan week N+1 from reviewed week N.
 */
export function nextIsoWeekBounds(
  isoWeek: string,
  timeZone = "UTC",
): PlanWeekBounds {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`Invalid ISO week label: ${isoWeek}`);
  const current = mondayOfIsoWeek(Number(match[1]), Number(match[2]));
  const monday = addCalendarDays(current.year, current.month, current.day, 7);
  const sunday = addCalendarDays(monday.year, monday.month, monday.day, 6);
  const wk = isoWeekNumber(monday.year, monday.month, monday.day);
  const label = `${wk.isoYear}-W${String(wk.isoWeek).padStart(2, "0")}`;
  const bounds = boundsForIsoWeek(label, timeZone);
  return {
    isoWeek: label,
    start: bounds.start,
    end: bounds.end,
    startDate: ymdString(monday),
    endDate: ymdString(sunday),
  };
}

/** Calendar Monday (YYYY-MM-DD) of an ISO week label such as 2026-W43. */
export function isoWeekMondayDate(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`Invalid ISO week label: ${isoWeek}`);
  return ymdString(mondayOfIsoWeek(Number(match[1]), Number(match[2])));
}
