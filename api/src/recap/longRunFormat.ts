import type { TempoUnitPreference, TempoWorkoutSplit } from "../tempo/port.js";
import { formatDistanceM, formatDuration } from "./format.js";
import type { SectionDepth } from "./phase.js";
import {
  formatPaceFromSecondsPerKm,
  formatSplitPaceList,
} from "./runByRunFormat.js";
import type { LongRunDetail, LongRunHalfSplit } from "./longRunTypes.js";

const METERS_PER_MILE = 1609.344;
/** Negative split when back half avg pace is faster than front by ≥5s/mi. */
export const NEG_SPLIT_SEC_PER_MI = 5;
/** Pace pickup vs overall avg on last ~3 mi window (sec/mi). */
const GOAL_PACE_PICKUP_SEC_PER_MI = 10;

export function isLongRunType(runType: unknown): boolean {
  return typeof runType === "string" && runType.toLowerCase().includes("long");
}

function paceSecKmToSecMi(paceS: number): number {
  return paceS * (METERS_PER_MILE / 1000);
}

function secMiToSecKm(secPerMi: number): number {
  return secPerMi / (METERS_PER_MILE / 1000);
}

function avgSecPerMiFromSplits(
  splits: readonly TempoWorkoutSplit[],
): number | undefined {
  const secs: number[] = [];
  for (const s of splits) {
    if (typeof s.paceS === "number" && Number.isFinite(s.paceS) && s.paceS > 0) {
      secs.push(paceSecKmToSecMi(s.paceS));
    }
  }
  if (secs.length === 0) return undefined;
  return secs.reduce((a, b) => a + b, 0) / secs.length;
}

export function computeHalfSplit(
  splits: readonly TempoWorkoutSplit[],
): LongRunHalfSplit | undefined {
  const n = splits.length;
  if (n < 2) return undefined;
  const frontN = Math.floor(n / 2);
  const front = avgSecPerMiFromSplits(splits.slice(0, frontN));
  const back = avgSecPerMiFromSplits(splits.slice(frontN));
  if (front === undefined || back === undefined) return undefined;
  const deltaSecPerMi = front - back;
  return {
    frontHalfSecPerMi: front,
    backHalfSecPerMi: back,
    deltaSecPerMi,
    negativeSplit: deltaSecPerMi >= NEG_SPLIT_SEC_PER_MI,
  };
}

const THREE_MI_M = 3 * METERS_PER_MILE;

function lastThreeMiSplits(
  splits: readonly TempoWorkoutSplit[],
  totalDistanceM: number,
): TempoWorkoutSplit[] {
  if (splits.length === 0) return [];
  let cum = 0;
  const suffix: TempoWorkoutSplit[] = [];
  for (let i = splits.length - 1; i >= 0; i--) {
    const row = splits[i]!;
    suffix.unshift(row);
    if (typeof row.distanceM === "number" && Number.isFinite(row.distanceM)) {
      cum += row.distanceM;
    }
    if (cum >= THREE_MI_M) break;
  }
  if (cum > 0) return suffix;
  const totalMi =
    totalDistanceM > 0 ? totalDistanceM / METERS_PER_MILE : undefined;
  const perSplitMi =
    totalMi !== undefined && splits.length > 0 ? totalMi / splits.length : 0.5;
  const k = Math.max(1, Math.min(splits.length, Math.ceil(3 / perSplitMi)));
  return splits.slice(-k);
}

/** True when last ~3 mi window paced up vs overall avg (≥10s/mi). */
export function finishAtGoalEffortLikely(args: {
  splits: readonly TempoWorkoutSplit[];
  distanceM: number;
  avgPaceS: number | undefined;
}): boolean | null {
  const { splits, distanceM, avgPaceS } = args;
  if (
    avgPaceS === undefined ||
    !Number.isFinite(avgPaceS) ||
    avgPaceS <= 0 ||
    splits.length === 0
  ) {
    return null;
  }
  const window = lastThreeMiSplits(splits, distanceM);
  const lastWin = avgSecPerMiFromSplits(window);
  const overall = paceSecKmToSecMi(avgPaceS);
  if (lastWin === undefined) return null;
  return overall - lastWin >= GOAL_PACE_PICKUP_SEC_PER_MI;
}

function formatHalfLine(
  half: LongRunHalfSplit,
  unit: TempoUnitPreference,
): string {
  const frontStr = formatPaceFromSecondsPerKm(
    secMiToSecKm(half.frontHalfSecPerMi),
    unit,
  );
  const backStr = formatPaceFromSecondsPerKm(
    secMiToSecKm(half.backHalfSecPerMi),
    unit,
  );
  const fasterBy = Math.round(half.deltaSecPerMi);
  const cmp =
    half.deltaSecPerMi >= NEG_SPLIT_SEC_PER_MI
      ? `(faster than front half by ${fasterBy}s/mi) ✓ negative split`
      : `(vs front half; Δ ${fasterBy >= 0 ? "+" : ""}${fasterBy}s/mi)`;
  return `Back half avg pace: ${backStr} vs front ${frontStr} ${cmp}`;
}

/** Graceful markdown when no long run qualifies. */
export function buildMissingLongRunMarkdown(): string {
  return ["## Long run", "", "No qualifying long run this week.", ""].join(
    "\n",
  );
}

/**
 * tempo-cli §2.6 text: no section heading, always full depth, marathon-pace
 * wording for the last-window line.
 */
function buildTempoLongRunMarkdown(
  detail: LongRunDetail,
  unit: TempoUnitPreference,
): string {
  const lines: string[] = [
    `### Long run — ${detail.titleDate} — ${formatDistanceM(detail.distanceM, unit)} / ${formatDuration(detail.durationS)}`,
    "",
  ];
  const paceStr =
    detail.avgPaceS !== undefined
      ? formatPaceFromSecondsPerKm(detail.avgPaceS, unit)
      : "n/a";
  const avgHrStr =
    detail.avgHeartRateBpm !== undefined
      ? String(Math.round(detail.avgHeartRateBpm))
      : "n/a";
  const bits = [`Avg pace: ${paceStr}`, `Avg HR ${avgHrStr}`];
  if (detail.drift) {
    const sign = detail.drift.driftBpm >= 0 ? "+" : "";
    bits.push(
      `Drift: ${detail.drift.q1AvgHr} → ${detail.drift.q4AvgHr} (${sign}${detail.drift.driftBpm} bpm)`,
    );
  } else {
    bits.push("Drift: n/a");
  }
  lines.push(bits.join("  ·  "), "");
  lines.push(`Splits: ${detail.splitPacesFormatted ?? "n/a"}`, "");
  if (detail.half) {
    lines.push(formatHalfLine(detail.half, unit), "");
  }
  const windowLabel = unit === "imperial" ? "Last 3 mi" : "Last ~5 km window";
  const runType = detail.runType.toLowerCase();
  const assignedEasy = runType.includes("easy") || runType.includes("recovery");
  if (
    detail.finishAtGoalEffort === null ||
    detail.finishAtGoalEffort === undefined
  ) {
    lines.push(
      `${windowLabel} at marathon-pace effort? n/a (pace data incomplete)`,
    );
  } else if (detail.finishAtGoalEffort) {
    lines.push(
      `${windowLabel} at marathon-pace effort? Yes (paced up or HR above easy cap)`,
    );
  } else if (assignedEasy) {
    lines.push(`${windowLabel} at marathon-pace effort? No (assigned: easy)`);
  } else {
    lines.push(`${windowLabel} at marathon-pace effort? No`);
  }
  lines.push("");
  return lines.join("\n").trimEnd() + "\n";
}

export function buildLongRunMarkdown(
  detail: LongRunDetail | undefined,
  unit: TempoUnitPreference,
  depth: SectionDepth,
  opts?: { tempoParity?: boolean },
): string {
  if (!detail) {
    // tempo-cli emits nothing when no long run qualifies.
    return opts?.tempoParity ? "" : buildMissingLongRunMarkdown();
  }
  if (opts?.tempoParity) return buildTempoLongRunMarkdown(detail, unit);

  const distStr = formatDistanceM(detail.distanceM, unit);
  const durStr = formatDuration(detail.durationS);
  const lines: string[] = [
    `## Long run`,
    "",
    `### Long run — ${detail.titleDate} — ${distStr} / ${durStr}`,
    "",
  ];

  const paceStr =
    detail.avgPaceS !== undefined
      ? formatPaceFromSecondsPerKm(detail.avgPaceS, unit)
      : "n/a";
  const avgHrStr =
    detail.avgHeartRateBpm !== undefined
      ? String(Math.round(detail.avgHeartRateBpm))
      : "n/a";
  const summaryBits = [`Avg pace: ${paceStr}`, `Avg HR ${avgHrStr}`];
  if (detail.drift) {
    const sign = detail.drift.driftBpm >= 0 ? "+" : "";
    summaryBits.push(
      `Drift: ${detail.drift.q1AvgHr} → ${detail.drift.q4AvgHr} (${sign}${detail.drift.driftBpm} bpm)`,
    );
  } else if (depth !== "brief") {
    summaryBits.push("Drift: n/a");
  }
  lines.push(summaryBits.join("  ·  "));
  lines.push("");

  if (depth === "brief") {
    lines.push("");
    return lines.join("\n").trimEnd() + "\n";
  }

  lines.push(`Splits: ${detail.splitPacesFormatted ?? "n/a"}`);
  lines.push("");

  if (detail.half) {
    lines.push(formatHalfLine(detail.half, unit));
    lines.push("");
  }

  if (depth === "detailed") {
    const windowLabel =
      unit === "imperial" ? "Last 3 mi" : "Last ~5 km window";
    if (detail.finishAtGoalEffort === null || detail.finishAtGoalEffort === undefined) {
      lines.push(
        `${windowLabel} at goal effort? n/a (pace data incomplete)`,
      );
    } else if (detail.finishAtGoalEffort) {
      lines.push(`${windowLabel} at goal effort? Yes (paced up)`);
    } else {
      lines.push(`${windowLabel} at goal effort? No`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function formatSplitPacesFromDetail(
  splits: readonly TempoWorkoutSplit[],
  unit: TempoUnitPreference,
): string | undefined {
  const paces = splits
    .map((s) => s.paceS)
    .filter(
      (p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0,
    );
  return formatSplitPaceList(paces, unit);
}
