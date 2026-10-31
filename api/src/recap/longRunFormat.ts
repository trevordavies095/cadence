import type { TempoUnitPreference, TempoWorkoutSplit } from "../tempo/port.js";
import { formatDistanceM, formatDuration } from "./format.js";
import type { SectionDepth } from "./phase.js";
import {
  formatPaceFromSecondsPerKm,
  formatSplitPaceList,
} from "./runByRunFormat.js";
import type {
  LongRunDetail,
  LongRunFastFinish,
  LongRunHalfSplit,
} from "./longRunTypes.js";

const METERS_PER_MILE = 1609.344;
/** Negative split when back half avg pace is faster than front by ≥5s/mi. */
export const NEG_SPLIT_SEC_PER_MI = 5;

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

/** Fast-finish window: the last 5 km, or the last 3 mi for imperial athletes. */
export function fastFinishWindowM(unit: TempoUnitPreference): number {
  return unit === "imperial" ? 3 * METERS_PER_MILE : 5000;
}

/**
 * The last window counts as a fast finish when it is at least this much faster
 * than the rest of the run (6 s/km, about 10 s/mi; coaching convention for a
 * deliberate pickup rather than pacing noise).
 */
export const FAST_FINISH_MIN_PICKUP_SEC_PER_KM = 6;

type SplitSpan = { distanceM: number; timeS: number };

function splitSpans(
  splits: readonly TempoWorkoutSplit[],
  totalDistanceM: number,
): SplitSpan[] | undefined {
  const n = splits.length;
  if (n === 0) return undefined;
  const allHaveDistance = splits.every(
    (s) =>
      typeof s.distanceM === "number" &&
      Number.isFinite(s.distanceM) &&
      s.distanceM > 0,
  );
  const evenM =
    Number.isFinite(totalDistanceM) && totalDistanceM > 0
      ? totalDistanceM / n
      : undefined;
  const spans: SplitSpan[] = [];
  for (const s of splits) {
    const distanceM = allHaveDistance ? (s.distanceM as number) : evenM;
    if (distanceM === undefined) return undefined;
    let timeS: number | undefined;
    if (
      allHaveDistance &&
      typeof s.durationS === "number" &&
      Number.isFinite(s.durationS) &&
      s.durationS > 0
    ) {
      timeS = s.durationS;
    } else if (
      typeof s.paceS === "number" &&
      Number.isFinite(s.paceS) &&
      s.paceS > 0
    ) {
      timeS = (s.paceS * distanceM) / 1000;
    }
    if (timeS === undefined) return undefined;
    spans.push({ distanceM, timeS });
  }
  return spans;
}

/**
 * Compare the last 5 km (3 mi) with the rest of the run, by split pace.
 * Null when splits are missing or incomplete, or the run is no longer than the window.
 */
export function computeFastFinish(args: {
  splits: readonly TempoWorkoutSplit[];
  distanceM: number;
  unit: TempoUnitPreference;
}): LongRunFastFinish | null {
  const spans = splitSpans(args.splits, args.distanceM);
  if (!spans) return null;
  const windowM = fastFinishWindowM(args.unit);
  let lastM = 0;
  let lastS = 0;
  let i = spans.length - 1;
  for (; i >= 0 && lastM < windowM - 1; i--) {
    lastM += spans[i]!.distanceM;
    lastS += spans[i]!.timeS;
  }
  const rest = spans.slice(0, i + 1);
  const restM = rest.reduce((a, s) => a + s.distanceM, 0);
  const restS = rest.reduce((a, s) => a + s.timeS, 0);
  if (restM <= 0 || lastM <= 0) return null;
  const lastPaceSecPerKm = (lastS / lastM) * 1000;
  const restPaceSecPerKm = (restS / restM) * 1000;
  const fasterBySecPerKm = restPaceSecPerKm - lastPaceSecPerKm;
  return {
    windowM,
    lastPaceSecPerKm,
    restPaceSecPerKm,
    fasterBySecPerKm,
    fastFinish: fasterBySecPerKm >= FAST_FINISH_MIN_PICKUP_SEC_PER_KM,
  };
}

/** "Fast finish? Yes (last 5 km 12 s/km faster than the rest)", pace only. */
export function formatFastFinishLine(
  finish: LongRunFastFinish | null | undefined,
  unit: TempoUnitPreference,
): string {
  if (!finish) return "Fast finish? n/a (no split paces)";
  const windowLabel = unit === "imperial" ? "last 3 mi" : "last 5 km";
  const perUnit = unit === "imperial" ? "s/mi" : "s/km";
  const delta = Math.round(
    unit === "imperial"
      ? paceSecKmToSecMi(finish.fasterBySecPerKm)
      : finish.fasterBySecPerKm,
  );
  const answer = finish.fastFinish ? "Yes" : "No";
  const detail =
    delta === 0
      ? `${windowLabel} at the same pace as the rest`
      : `${windowLabel} ${Math.abs(delta)} ${perUnit} ${
          delta > 0 ? "faster" : "slower"
        } than the rest`;
  return `Fast finish? ${answer} (${detail})`;
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
  // The delta in the athlete's unit; the negative-split test stays in s/mi.
  const fasterBy = Math.round(
    unit === "imperial" ? half.deltaSecPerMi : secMiToSecKm(half.deltaSecPerMi),
  );
  const perUnit = unit === "imperial" ? "s/mi" : "s/km";
  const cmp =
    half.deltaSecPerMi >= NEG_SPLIT_SEC_PER_MI
      ? `(faster than front half by ${fasterBy}${perUnit}) ✓ negative split`
      : `(vs front half; Δ ${fasterBy >= 0 ? "+" : ""}${fasterBy}${perUnit})`;
  return `Back half avg pace: ${backStr} vs front ${frontStr} ${cmp}`;
}

/** Graceful markdown when no long run qualifies. */
export function buildMissingLongRunMarkdown(): string {
  return ["## Long run", "", "No qualifying long run this week.", ""].join(
    "\n",
  );
}

/** "Long run", or "Longest run" when the week's longest run stands in. */
function titleFor(detail: LongRunDetail): string {
  return detail.selectionReason === "longest_run_fallback"
    ? "Longest run"
    : "Long run";
}

const FALLBACK_NOTE = "No run was typed Long Run this week.";

/** The fast-finish line, only when the goal gets one (see goalKnobs fastFinish). */
function pushFastFinish(
  lines: string[],
  detail: LongRunDetail,
  unit: TempoUnitPreference,
): void {
  if (detail.fastFinish === undefined) return;
  lines.push(formatFastFinishLine(detail.fastFinish, unit), "");
}

/** tempo-cli §2.6 shape: no section heading, always full depth. */
function buildTempoLongRunMarkdown(
  detail: LongRunDetail,
  unit: TempoUnitPreference,
): string {
  const lines: string[] = [
    `### ${titleFor(detail)} — ${detail.titleDate} — ${formatDistanceM(detail.distanceM, unit)} / ${formatDuration(detail.durationS)}`,
    "",
  ];
  if (detail.selectionReason === "longest_run_fallback") {
    lines.push(FALLBACK_NOTE, "");
  }
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
  pushFastFinish(lines, detail, unit);
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
  const title = titleFor(detail);
  const lines: string[] = [
    `## ${title}`,
    "",
    `### ${title} — ${detail.titleDate} — ${distStr} / ${durStr}`,
    "",
  ];
  if (detail.selectionReason === "longest_run_fallback") {
    lines.push(FALLBACK_NOTE, "");
  }

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

  if (depth === "detailed") pushFastFinish(lines, detail, unit);

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
