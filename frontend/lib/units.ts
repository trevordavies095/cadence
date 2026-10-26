import type { UnitPreference } from "./api";

const MI = 1609.344;

export function distanceLabel(meters: number, unit: UnitPreference): string {
  if (unit === "metric") return `${(meters / 1000).toFixed(1)} km`;
  return `${(meters / MI).toFixed(1)} mi`;
}

/** Pace from seconds per kilometre, as "11:32/mi" or "7:10/km". */
export function paceLabel(secPerKm: number, unit: UnitPreference): string {
  const sec = unit === "metric" ? secPerKm : secPerKm * (MI / 1000);
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  const [mm, ss] = s === 60 ? [m + 1, 0] : [m, s];
  return `${mm}:${String(ss).padStart(2, "0")}/${unit === "metric" ? "km" : "mi"}`;
}

export function durationLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m} min`;
}

/** The local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localYmd(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}
