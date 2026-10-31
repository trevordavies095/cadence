import type { PrescribedRun } from "../../llm/types.js";
import type { TempoUnitPreference } from "../../tempo/port.js";
import { formatDistanceM } from "../format.js";

/** A planned duration as "40 min" or "1 h 05 min", the same as the plan shows it. */
export function formatPlannedDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m} min`;
}

/** What was planned: "8.00 km", "40 min", or "8.00 km, 45 min". */
export function formatPrescribedAmount(
  run: PrescribedRun,
  unit: TempoUnitPreference,
): string {
  const parts: string[] = [];
  if (run.distanceM > 0) parts.push(formatDistanceM(run.distanceM, unit));
  if (run.durationS != null && run.durationS > 0) {
    parts.push(formatPlannedDuration(run.durationS));
  }
  return parts.length > 0 ? parts.join(", ") : formatDistanceM(run.distanceM, unit);
}
