import type { PrescribedRun } from "../../llm/types.js";
import type { TempoUnitPreference } from "../../tempo/port.js";
import { formatDistanceM, formatMinutesDuration } from "../format.js";

/** What was planned: "8.00 km", "40 min", or "8.00 km, 45 min". */
export function formatPrescribedAmount(
  run: PrescribedRun,
  unit: TempoUnitPreference,
): string {
  const parts: string[] = [];
  if (run.distanceM > 0) parts.push(formatDistanceM(run.distanceM, unit));
  if (run.durationS != null && run.durationS > 0) {
    parts.push(formatMinutesDuration(run.durationS));
  }
  return parts.length > 0 ? parts.join(", ") : formatDistanceM(run.distanceM, unit);
}
