import { listAllWorkoutsInWindow } from "./listWindow.js";
import type { WeekSession } from "../week/store.js";
import type {
  TempoPort,
  TempoShoe,
  TempoUnitPreference,
  TempoWorkoutDetail,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import { resolveRecapUnit } from "./buildSummary.js";
import { shoeDistanceM } from "./shoeDistance.js";
import {
  buildRunByRunMarkdown,
  cadenceRpmToSpm,
  formatSplitPaceList,
  formatTitleDate,
} from "./runByRunFormat.js";
import { percentMaxHr, resolveConfiguredMaxHr } from "./maxHr.js";
import { resolveRecapDepthKnobs, type RecapDepthKnobs } from "./phase.js";
import {
  computeRunHrMetrics,
  driftCapForRun,
  driftSeverityLabel,
  type DriftCaps,
} from "./runByRunHr.js";
import {
  formatSimilarRouteText,
  formatWeather,
} from "./similarRouteLine.js";
import { formatRepSummary, summarizeReps } from "./repSummary.js";
import { isQualityFamily, isRace } from "./runTypes.js";
import { loadRecapWorkoutDetails } from "./workoutDetails.js";
import type {
  RecapRunByRunResult,
  RunByRunEntry,
  RunByRunShoe,
  RunByRunSplit,
} from "./runByRunTypes.js";
import type { WeekWindow } from "./weekWindows.js";

type ShoeLookup = Map<string, RunByRunShoe>;

function shoeFromPort(shoe: TempoShoe): RunByRunShoe {
  const label = `${shoe.brand} ${shoe.model}`.trim() || shoe.id.slice(0, 8);
  const out: RunByRunShoe = { id: shoe.id, label };
  const distanceM = shoeDistanceM(shoe);
  if (distanceM !== undefined) out.distanceM = distanceM;
  return out;
}

function shoeFromNested(raw: unknown): RunByRunShoe | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : undefined;
  if (!id) return undefined;
  const brand = typeof o.brand === "string" ? o.brand.trim() : "";
  const model = typeof o.model === "string" ? o.model.trim() : "";
  const label = `${brand} ${model}`.trim() || id.slice(0, 8);
  const out: RunByRunShoe = { id, label };
  const distanceM = shoeDistanceM(o);
  if (distanceM !== undefined) out.distanceM = distanceM;
  return out;
}

function buildShoeLookup(shoes: readonly TempoShoe[]): ShoeLookup {
  const map: ShoeLookup = new Map();
  for (const s of shoes) {
    map.set(s.id.toLowerCase(), shoeFromPort(s));
  }
  return map;
}

function mapSplits(detail: TempoWorkoutDetail): RunByRunSplit[] {
  return detail.splits.map((s) => {
    const split: RunByRunSplit = {};
    if (s.idx !== undefined) split.idx = s.idx;
    if (s.kind !== undefined) split.kind = s.kind;
    if (s.paceS !== undefined) split.paceS = s.paceS;
    if (s.distanceM !== undefined) split.distanceM = s.distanceM;
    if (s.durationS !== undefined) split.durationS = s.durationS;
    if (s.avgHeartRateBpm !== undefined) split.avgHeartRateBpm = s.avgHeartRateBpm;
    if (s.intensity !== undefined) split.intensity = s.intensity;
    if (s.trigger !== undefined) split.trigger = s.trigger;
    if (s.stepIndex !== undefined) split.stepIndex = s.stepIndex;
    return split;
  });
}

function buildEntry(args: {
  detail: TempoWorkoutDetail;
  unit: TempoUnitPreference;
  timeZone: string;
  zones: readonly { zoneNumber: number; minBpm: number; maxBpm: number }[];
  shoes: ShoeLookup;
  maxHr?: number;
  driftCaps: DriftCaps;
}): RunByRunEntry {
  const { detail, unit, timeZone, zones, shoes, maxHr } = args;
  const hr = computeRunHrMetrics({
    timeSeries: detail.timeSeries,
    durationS: detail.durationS,
    zones,
  });

  const splits = mapSplits(detail);
  const paceValues = splits
    .map((s) => s.paceS)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);
  const splitPacesFormatted = formatSplitPaceList(paceValues, unit);

  const runType =
    typeof detail.runType === "string" && detail.runType.trim()
      ? detail.runType.trim()
      : "Run";

  const entry: RunByRunEntry = {
    workoutId: detail.id,
    startedAt: detail.startedAt,
    titleDate: formatTitleDate(detail.startedAt, timeZone),
    runType,
    distanceM: detail.distanceM,
    durationS: detail.durationS,
    avgPaceS: detail.avgPaceS,
    splits,
    driftCapBpm: driftCapForRun(detail.runType, args.driftCaps),
  };

  if (detail.name !== undefined) entry.name = detail.name;
  if (detail.avgHeartRateBpm !== undefined) {
    entry.avgHeartRateBpm = detail.avgHeartRateBpm;
  } else if (hr.avgHrFromSeries !== undefined) {
    entry.avgHeartRateBpm = hr.avgHrFromSeries;
  }
  if (detail.maxHeartRateBpm !== undefined) {
    entry.maxHeartRateBpm = detail.maxHeartRateBpm;
  }
  // tempo-cli: summary avgCadenceRpm; fall back to the series mean.
  const cadenceRpm =
    typeof detail.avgCadenceRpm === "number" &&
    Number.isFinite(detail.avgCadenceRpm)
      ? detail.avgCadenceRpm
      : hr.avgCadenceRpm;
  if (cadenceRpm !== undefined) {
    entry.cadenceSpm = cadenceRpmToSpm(cadenceRpm);
  }
  // tempo-cli: % max uses the series-derived average when present, else summary.
  const pctAvg =
    hr.avgHrFromSeries ??
    (typeof detail.avgHeartRateBpm === "number" && detail.avgHeartRateBpm > 0
      ? Math.round(detail.avgHeartRateBpm)
      : undefined);
  const pct = percentMaxHr(pctAvg, maxHr);
  if (pct !== undefined) entry.pctMaxHr = pct;
  if (detail.timeSeriesUnavailableReason) {
    entry.timeSeriesUnavailableReason = detail.timeSeriesUnavailableReason;
  }
  if (detail.elevGainM !== undefined) entry.elevGainM = detail.elevGainM;
  if (detail.elevLossM !== undefined) entry.elevLossM = detail.elevLossM;
  if (detail.relativeEffort !== undefined) {
    entry.relativeEffort = detail.relativeEffort;
  }
  const weather = formatWeather(detail.weather, unit);
  if (weather) entry.weather = weather;
  entry.similarRouteText = formatSimilarRouteText({
    current: {
      startedAt: detail.startedAt,
      avgPaceS: detail.avgPaceS,
      avgHeartRateBpm: detail.avgHeartRateBpm,
    },
    similar: detail.similarRoute,
    unavailableReason: detail.similarRouteUnavailableReason,
    unit,
  });
  if (detail.notes !== undefined) entry.notes = detail.notes;
  if (detail.shoeId !== undefined) entry.shoeId = detail.shoeId;
  if (splitPacesFormatted) entry.splitPacesFormatted = splitPacesFormatted;
  if (isQualityFamily(runType) || isRace(runType)) {
    const reps = summarizeReps(splits, detail.avgPaceS);
    if (reps) entry.repSummary = formatRepSummary(reps, unit);
  }
  if (hr.drift) {
    entry.drift = hr.drift;
    const severity = driftSeverityLabel(hr.drift.driftBpm, entry.driftCapBpm);
    if (severity) entry.driftSeverity = severity;
  }
  if (hr.zonePct) entry.zonePct = hr.zonePct;
  if (hr.zoneSeconds) entry.zoneSeconds = hr.zoneSeconds;

  const shoeId =
    typeof detail.shoeId === "string" && detail.shoeId.trim()
      ? detail.shoeId.trim()
      : undefined;
  if (shoeId) {
    const fromList = shoes.get(shoeId.toLowerCase());
    entry.shoe = fromList ?? shoeFromNested(detail.shoe);
  } else {
    const nested = shoeFromNested(detail.shoe);
    if (nested) entry.shoe = nested;
  }

  return entry;
}

/** Build Run-by-run section for a persisted week session via TempoPort. */
export async function buildRecapRunByRun(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
  /** The week's resolved knobs; the drift caps come from its thresholds. No knobs: the no-goal column. */
  knobs?: RecapDepthKnobs;
}): Promise<RecapRunByRunResult> {
  const { session, tempoPort } = args;
  const driftCaps = (args.knobs ?? resolveRecapDepthKnobs()).thresholds
    .driftCapBpm;
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const window: WeekWindow = { start: session.start, end: session.end };

  const [summaries, settings, shoes] = await Promise.all([
    listAllWorkoutsInWindow(tempoPort, window),
    tempoPort.getSettings(),
    tempoPort.listShoes({ status: "all" }),
  ]);

  const details = await loadRecapWorkoutDetails(tempoPort, summaries, {
    includeSimilarRoutes: true,
  });

  const shoeLookup = buildShoeLookup(shoes);
  const zones = settings.heartRateZones.zones;
  const maxHr = resolveConfiguredMaxHr(settings.heartRateZones);
  const runs: RunByRunEntry[] = [];

  for (let i = 0; i < summaries.length; i++) {
    const detail = details[i];
    if (!detail) continue;
    runs.push(
      buildEntry({
        detail,
        unit,
        timeZone: session.timezone,
        zones,
        shoes: shoeLookup,
        maxHr,
        driftCaps,
      }),
    );
  }

  runs.sort((a, b) => {
    const ta = new Date(a.startedAt).getTime();
    const tb = new Date(b.startedAt).getTime();
    if (ta !== tb) return ta - tb;
    return a.workoutId.localeCompare(b.workoutId);
  });

  const markdown = buildRunByRunMarkdown(runs, unit);

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    runs,
    markdown,
  };
}
