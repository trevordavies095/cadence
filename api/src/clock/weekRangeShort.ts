const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

type Ymd = { y: number; m: number; d: number };

function parseYmd(ymd: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/**
 * Athlete-facing week range from two calendar dates: "Oct 19 – 25",
 * "Oct 26 – Nov 1", or "Dec 28 – Jan 3, 2027" when the year changes.
 * Pure calendar text, no time zones involved.
 */
export function formatWeekRangeShort(startYmd: string, endYmd: string): string {
  const a = parseYmd(startYmd);
  const b = parseYmd(endYmd);
  if (!a || !b) return "this week";
  const start = `${MONTHS[a.m - 1]} ${a.d}`;
  if (a.y !== b.y) return `${start}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
  if (a.m === b.m) return `${start} – ${b.d}`;
  return `${start} – ${MONTHS[b.m - 1]} ${b.d}`;
}

/** Range for an ISO week id such as "2026-W43"; "this week" when unparsable. */
export function formatIsoWeekRangeShort(isoWeek: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek.trim());
  if (!m) return "this week";
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Week 1 is the week that holds Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon = 0
  const monday = new Date(jan4.getTime());
  monday.setUTCDate(jan4.getUTCDate() - jan4Dow + (week - 1) * 7);
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const ymd = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return formatWeekRangeShort(ymd(monday), ymd(sunday));
}
