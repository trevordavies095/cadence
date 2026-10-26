import { listAllWorkoutsInWindow } from "./listWindow.js";
import type {
  TempoHeartRateZone,
  TempoPort,
  TempoWorkoutDetail,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import { buildZonesMarkdown } from "./formatZones.js";
import { loadRecapWorkoutDetails } from "./workoutDetails.js";
import type { WeekWindow } from "./weekWindows.js";
import {
  computeWeekZoneDistribution,
  type ZoneWeekDistribution,
} from "./zones.js";

export type RecapZonesResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  zones: TempoHeartRateZone[];
  distribution: ZoneWeekDistribution;
  markdown: string;
};

async function loadWorkoutDetails(
  port: TempoPort,
  summaries: readonly TempoWorkoutSummary[],
): Promise<TempoWorkoutDetail[]> {
  const details = await loadRecapWorkoutDetails(port, summaries);
  return details.map((d, i) => d ?? { ...summaries[i]!, splits: [] });
}

/** Build HR zone distribution section for a persisted week session via TempoPort. */
export async function buildRecapZones(args: {
  session: WeekSession;
  tempoPort: TempoPort;
}): Promise<RecapZonesResult> {
  const { session, tempoPort } = args;
  const window: WeekWindow = { start: session.start, end: session.end };

  const [settings, summaries] = await Promise.all([
    tempoPort.getSettings(),
    listAllWorkoutsInWindow(tempoPort, window),
  ]);

  const zones = settings.heartRateZones.zones ?? [];
  const workouts = await loadWorkoutDetails(tempoPort, summaries);
  const distribution = computeWeekZoneDistribution({ zones, workouts });
  const failed = workouts.filter((w) => w.timeSeriesUnavailableReason);
  if (distribution.noHrTimeSeriesInWeek && failed.length > 0) {
    const reasons = [
      ...new Set(failed.map((w) => w.timeSeriesUnavailableReason!)),
    ].join(", ");
    distribution.note = `Zone distribution unavailable (time-series unavailable: ${reasons}).`;
  }
  const markdown = buildZonesMarkdown(distribution);

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    zones: [...zones].sort((a, b) => a.zoneNumber - b.zoneNumber),
    distribution,
    markdown,
  };
}
