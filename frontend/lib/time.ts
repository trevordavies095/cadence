const DAY_MS = 86_400_000;

type Stamp = { ymd: string; weekday: string; month: string; day: string; clock: string };

/** The parts of a moment as a clock in `timeZone` shows them. */
function stamp(at: Date, timeZone: string | undefined): Stamp {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return {
    ymd,
    weekday: get("weekday"),
    month: get("month"),
    day: get("day"),
    clock: `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`,
  };
}

/**
 * When a message was sent, as a conversation says it: "Today 6:40 pm", "Yesterday 6:40 pm",
 * "Tue 6:40 pm" within the last week, and "Tue Oct 20, 6:40 pm" after that. Read on the
 * clock of `timeZone` (the athlete's week), or of whoever is reading when none is given.
 */
export function messageWhen(iso: string, timeZone?: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  let sent: Stamp;
  let today: Stamp;
  try {
    sent = stamp(at, timeZone);
    today = stamp(now, timeZone);
  } catch {
    // A time zone this browser doesn't know: use the reader's own clock.
    sent = stamp(at, undefined);
    today = stamp(now, undefined);
  }
  const days = Math.round((Date.parse(today.ymd) - Date.parse(sent.ymd)) / DAY_MS);
  if (days <= 0) return `Today ${sent.clock}`;
  if (days === 1) return `Yesterday ${sent.clock}`;
  if (days < 7) return `${sent.weekday} ${sent.clock}`;
  return `${sent.weekday} ${sent.month} ${sent.day}, ${sent.clock}`;
}
