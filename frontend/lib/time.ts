const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(d: Date): string {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * A message time in words: "6:40 pm" today, "Yesterday 6:40 pm", "Tue 6:40 pm" within the
 * last week, and "Oct 12, 6:40 pm" after that. Uses the clock of whoever is reading.
 */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return clock(at);
  if (days === 1) return `Yesterday ${clock(at)}`;
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${clock(at)}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${clock(at)}`;
}
