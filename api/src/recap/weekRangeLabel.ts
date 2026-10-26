const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function localParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * Recap title label, as tempo-cli writes it:
 * `2026-W43 (Mon Oct 19 – Sun Oct 25, 2026)`; the Monday carries its year only
 * when the week crosses a year boundary.
 */
export function formatRecapWeekRangeLabel(
  isoWeek: string,
  startIso: string,
  endIso: string,
  timeZone: string,
): string {
  const a = localParts(startIso, timeZone);
  const b = localParts(endIso, timeZone);
  const md = (p: { month: number; day: number }) =>
    `${MONTHS[p.month - 1]} ${p.day}`;
  const startFmt = a.year === b.year ? md(a) : `${md(a)}, ${a.year}`;
  return `${isoWeek} (Mon ${startFmt} – Sun ${md(b)}, ${b.year})`;
}
