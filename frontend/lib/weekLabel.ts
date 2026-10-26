const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "Oct 19 – 25", "Oct 26 – Nov 1", or with years when the week crosses New Year. */
export function weekRangeLabel(startYmd: string, endYmd: string): string {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(startYmd);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(endYmd);
  if (!a || !b) return "this week";
  const [ay, am, ad] = [Number(a[1]), Number(a[2]), Number(a[3])];
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const start = `${MONTHS[am - 1]} ${ad}`;
  if (ay !== by) return `${start}, ${ay} – ${MONTHS[bm - 1]} ${bd}, ${by}`;
  if (am === bm) return `${start} – ${bd}`;
  return `${start} – ${MONTHS[bm - 1]} ${bd}`;
}

/**
 * Athlete-facing range for an ISO week id such as "2026-W43". Pure calendar
 * arithmetic, so it never depends on the browser's time zone. The id comes from
 * the API, which resolves weeks in the athlete's time zone.
 */
export function isoWeekRangeLabel(isoWeek: string | null | undefined): string {
  const m = /^(\d{4})-W(\d{2})$/.exec((isoWeek ?? "").trim());
  if (!m) return "this week";
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4.getTime());
  monday.setUTCDate(jan4.getUTCDate() - jan4Dow + (Number(m[2]) - 1) * 7);
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return weekRangeLabel(ymd(monday), ymd(sunday));
}
