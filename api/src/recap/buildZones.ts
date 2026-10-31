import { listAllWorkoutsInWindow } from "./listWindow.js";
import type {
  TempoHeartRateZone,
  TempoPort,
  TempoWeeklyRecapStats,
  TempoWorkoutDetail,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import {
  fetchWeeklyRecapStats,
  type SharedWeeklyRecapStats,
} from "./fetchWeeklyRecapStats.js";
import { buildZonesMarkdown } from "./formatZones.js";
import { loadRecapWorkoutDetails } from "./workoutDetails.js";
import type { WeekWindow } from "./weekWindows.js";
import {
  computeWeekZoneDistribution,
  zoneDistributionFromSeconds,
  type ZoneWeekDistribution,
} from "./zones.js";

export type RecapZonesResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  zones: TempoHeartRateZone[];
  /**
   * Where the week totals came from: the log's stored per-run zone seconds
   * (weekly recap) or Cadence's per-second sum over each run's HR series.
   */
  zoneSource: "weekly-recap" | "time-series";
  /** The goal's easy-share target in percent; null: the share with no target. */
  easyShareTarget: number | null;
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

/**
 * Current-week Z1..Z5 seconds from the weekly recap, or undefined unless all
 * five are present, the athlete has five zones set, and some time is logged.
 */
function aggregateZoneSeconds(
  stats: TempoWeeklyRecapStats | null,
  zoneCount: number,
): number[] | undefined {
  if (!stats || zoneCount !== 5) return undefined;
  const seconds = [
    stats.zoneSecondsZ1?.current,
    stats.zoneSecondsZ2?.current,
    stats.zoneSecondsZ3?.current,
    stats.zoneSecondsZ4?.current,
    stats.zoneSecondsZ5?.current,
  ];
  if (seconds.some((s) => s === undefined || s < 0)) return undefined;
  const out = seconds as number[];
  return out.some((s) => s > 0) ? out : undefined;
}

async function perSecondDistribution(
  tempoPort: TempoPort,
  window: WeekWindow,
  zones: readonly TempoHeartRateZone[],
  easyShareTarget: number | null,
): Promise<ZoneWeekDistribution> {
  const summaries = await listAllWorkoutsInWindow(tempoPort, window);
  const workouts = await loadWorkoutDetails(tempoPort, summaries);
  const distribution = computeWeekZoneDistribution({
    zones,
    workouts,
    easyShareTarget,
  });
  const failed = workouts.filter((w) => w.timeSeriesUnavailableReason);
  if (distribution.noHrTimeSeriesInWeek && failed.length > 0) {
    const reasons = [
      ...new Set(failed.map((w) => w.timeSeriesUnavailableReason!)),
    ].join(", ");
    distribution.note = `Zone distribution unavailable (time-series unavailable: ${reasons}).`;
  }
  return distribution;
}

/**
 * Build HR zone distribution section for a persisted week session via TempoPort.
 * Prefers the log's weekly zone aggregate (no per-run calls); falls back to
 * per-second HR series when a bucket is null, the call fails, or in export mode.
 */
export async function buildRecapZones(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  /** The report's one weekly-recap fetch; fetched here when omitted. */
  weeklyStats?: SharedWeeklyRecapStats;
  /** From the goal's knobs (thresholds.easyShareTarget); null: no target, no verdict. */
  easyShareTarget: number | null;
}): Promise<RecapZonesResult> {
  const { session, tempoPort, easyShareTarget } = args;
  const window: WeekWindow = { start: session.start, end: session.end };

  const [settings, stats] = await Promise.all([
    tempoPort.getSettings(),
    args.weeklyStats ?? fetchWeeklyRecapStats(tempoPort, session),
  ]);
  const zones = settings.heartRateZones.zones ?? [];

  const fromLog = aggregateZoneSeconds(stats, zones.length);
  const zoneSource = fromLog ? "weekly-recap" : "time-series";
  const distribution = fromLog
    ? zoneDistributionFromSeconds(fromLog, easyShareTarget)
    : await perSecondDistribution(tempoPort, window, zones, easyShareTarget);
  const markdown = buildZonesMarkdown(distribution);

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    zones: [...zones].sort((a, b) => a.zoneNumber - b.zoneNumber),
    zoneSource,
    easyShareTarget,
    distribution,
    markdown,
  };
}
