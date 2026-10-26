/**
 * Rolling trends (W−3…W0): easy pace, easy HR, long-run distance.
 * Shape follows tempo-cli weekly-recap §2.7; phase knobs control depth.
 */

import type {
  TempoHeartRateZone,
  TempoUnitPreference,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import { formatDistanceM } from "./format.js";
import type { SectionDepth } from "./phase.js";
import { formatPaceFromSecondsPerKm } from "./runByRunFormat.js";
import { isLongRunType } from "./longRunFormat.js";
import type { WeekWindow } from "./weekWindows.js";
import { priorWeekWindows, shiftWeekWindow } from "./weekWindows.js";

const EM_DASH = "—";
const SPARK_CHARS = ["▁", "▃", "▅", "█"] as const;

export type RecapTrendsSnapshot = {
  included: boolean;
  weekLabels: [string, string, string, string];
  /** Seconds per km; null = no qualifying data that week. */
  easyPaceSecPerKm: (number | null)[];
  avgEasyHr: (number | null)[];
  longRunDistanceM: (number | null)[];
  sparklines?: {
    easyPace: string;
    avgEasyHr: string;
    longRunDistance: string;
  };
  verdicts?: {
    easyPace?: string;
    avgEasyHr?: string;
    longRunDistance?: string;
  };
};

function isEasyOrUntypedNonLong(runType: unknown): boolean {
  if (runType === undefined || runType === null) return true;
  const s = String(runType).trim();
  if (s === "") return true;
  const t = s.toLowerCase();
  if (t.includes("long")) return false;
  return t.includes("easy") || t.includes("recovery");
}

function z2MaxBpm(zones: readonly TempoHeartRateZone[]): number | undefined {
  const z2 = [...zones]
    .sort((a, b) => a.zoneNumber - b.zoneNumber)
    .find((z) => z.zoneNumber === 2);
  return z2 !== undefined && z2.maxBpm > 0 ? z2.maxBpm : undefined;
}

function qualifiesEasyAvgHr(
  runType: string | null | undefined,
  avgHr: number | null | undefined,
  z2Max: number | undefined,
): boolean {
  if (avgHr === undefined || avgHr === null || !Number.isFinite(avgHr)) {
    return false;
  }
  const blank =
    runType === undefined ||
    runType === null ||
    (typeof runType === "string" && runType.trim() === "");
  if (blank) {
    return z2Max !== undefined && avgHr <= z2Max;
  }
  const t = String(runType).trim().toLowerCase();
  if (t.includes("long")) return false;
  return t.includes("easy") || t.includes("recovery");
}

type WeekAgg = {
  paceWeightedSum: number;
  paceWeight: number;
  easyHrSum: number;
  easyHrCount: number;
  longDistances: number[];
  maxDistanceM: number;
};

function emptyAgg(): WeekAgg {
  return {
    paceWeightedSum: 0,
    paceWeight: 0,
    easyHrSum: 0,
    easyHrCount: 0,
    longDistances: [],
    maxDistanceM: 0,
  };
}

function finalizeWeekAgg(a: WeekAgg): {
  paceSecPerKm: number | null;
  avgEasyHr: number | null;
  longRunM: number | null;
} {
  const paceSecPerKm =
    a.paceWeight > 0 && Number.isFinite(a.paceWeightedSum)
      ? a.paceWeightedSum / a.paceWeight
      : null;
  const avgEasyHr =
    a.easyHrCount > 0 ? Math.round(a.easyHrSum / a.easyHrCount) : null;
  let longRunM: number | null = null;
  if (a.longDistances.length > 0) {
    longRunM = Math.max(...a.longDistances);
  } else if (a.maxDistanceM > 0) {
    longRunM = a.maxDistanceM;
  }
  return { paceSecPerKm, avgEasyHr, longRunM };
}

function accumulate(
  agg: WeekAgg,
  w: TempoWorkoutSummary,
  z2Max: number | undefined,
): void {
  const dist = w.distanceM;
  if (Number.isFinite(dist) && dist > agg.maxDistanceM) agg.maxDistanceM = dist;

  if (isLongRunType(w.runType) && Number.isFinite(dist) && dist > 0) {
    agg.longDistances.push(dist);
  }

  if (!isEasyOrUntypedNonLong(w.runType)) return;

  const hr = w.avgHeartRateBpm;
  if (qualifiesEasyAvgHr(w.runType, hr, z2Max) && typeof hr === "number") {
    agg.easyHrSum += hr;
    agg.easyHrCount += 1;
  }

  if (
    z2Max !== undefined &&
    typeof hr === "number" &&
    Number.isFinite(hr) &&
    hr <= z2Max &&
    Number.isFinite(w.avgPaceS) &&
    w.avgPaceS > 0 &&
    Number.isFinite(w.durationS) &&
    w.durationS > 0 &&
    isEasyOrUntypedNonLong(w.runType)
  ) {
    agg.paceWeightedSum += w.avgPaceS * w.durationS;
    agg.paceWeight += w.durationS;
  }
}

/** Four week windows oldest → newest (W−3…W0). */
export function trendWeekWindows(thisWeek: WeekWindow): WeekWindow[] {
  const { trailing } = priorWeekWindows(thisWeek);
  return [...trailing, thisWeek];
}

/** Shift ISO week label by whole weeks (negative = earlier). */
export function shiftIsoWeekLabel(isoWeek: string, deltaWeeks: number): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek.trim());
  if (!m) return isoWeek;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (day - 1));
  const monday = new Date(mondayWeek1);
  monday.setUTCDate(mondayWeek1.getUTCDate() + (week - 1 + deltaWeeks) * 7);
  // ISO week: Thursday determines week year
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const y = thursday.getUTCFullYear();
  const yJan4 = new Date(Date.UTC(y, 0, 4));
  const yDay = yJan4.getUTCDay() || 7;
  const yMon = new Date(yJan4);
  yMon.setUTCDate(yJan4.getUTCDate() - (yDay - 1));
  const weekNum =
    1 + Math.round((monday.getTime() - yMon.getTime()) / (7 * 86400000));
  return `${y}-W${String(weekNum).padStart(2, "0")}`;
}

export function buildTrendWeekLabels(
  isoWeek: string,
): [string, string, string, string] {
  return [
    shiftIsoWeekLabel(isoWeek, -3),
    shiftIsoWeekLabel(isoWeek, -2),
    shiftIsoWeekLabel(isoWeek, -1),
    isoWeek,
  ];
}

function finiteValues(series: (number | null)[]): number[] {
  return series.filter((x): x is number => x !== null && Number.isFinite(x));
}

function sparklineForSeries(
  series: (number | null)[],
  lowerIsBetter: boolean,
): string {
  const vals = finiteValues(series);
  if (vals.length === 0) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return series
    .map((v) => {
      if (v === null || !Number.isFinite(v)) return SPARK_CHARS[0];
      if (max === min) return SPARK_CHARS[2];
      const desirability = lowerIsBetter
        ? (max - v) / (max - min)
        : (v - min) / (max - min);
      const idx = Math.min(3, Math.max(0, Math.round(desirability * 3)));
      return SPARK_CHARS[idx]!;
    })
    .join("");
}

function strictlyMonotonicVerdict(
  series: (number | null)[],
  lowerIsBetter: boolean,
): string | undefined {
  const nums = finiteValues(series);
  if (nums.length < 2) return undefined;
  let inc = true;
  let dec = true;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! <= nums[i - 1]!) inc = false;
    if (nums[i]! >= nums[i - 1]!) dec = false;
  }
  if (lowerIsBetter && dec) return "improving";
  if (!lowerIsBetter && inc) return "improving";
  if (!lowerIsBetter && dec) return "declining";
  if (lowerIsBetter && inc) return "declining";
  return undefined;
}

function workoutsInWindow(
  items: readonly TempoWorkoutSummary[],
  window: WeekWindow,
): TempoWorkoutSummary[] {
  const startMs = new Date(window.start).getTime();
  const endMs = new Date(window.end).getTime();
  return items.filter((w) => {
    const t = new Date(w.startedAt).getTime();
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
}

export function computeRecapTrendsSnapshot(args: {
  isoWeek: string;
  thisWeek: WeekWindow;
  zones: readonly TempoHeartRateZone[];
  /** Workouts spanning W−3…W0. */
  workouts: readonly TempoWorkoutSummary[];
}): RecapTrendsSnapshot {
  const weekLabels = buildTrendWeekLabels(args.isoWeek);
  const windows = trendWeekWindows(args.thisWeek);
  const z2Max = z2MaxBpm(args.zones);
  const paceSeries: (number | null)[] = [];
  const hrSeries: (number | null)[] = [];
  const longSeries: (number | null)[] = [];

  for (const win of windows) {
    const agg = emptyAgg();
    for (const w of workoutsInWindow(args.workouts, win)) {
      accumulate(agg, w, z2Max);
    }
    const f = finalizeWeekAgg(agg);
    paceSeries.push(f.paceSecPerKm);
    hrSeries.push(f.avgEasyHr);
    longSeries.push(f.longRunM);
  }

  const hasAny =
    paceSeries.some((x) => x !== null) ||
    hrSeries.some((x) => x !== null) ||
    longSeries.some((x) => x !== null);

  if (!hasAny) {
    return {
      included: true,
      weekLabels,
      easyPaceSecPerKm: paceSeries,
      avgEasyHr: hrSeries,
      longRunDistanceM: longSeries,
    };
  }

  return {
    included: true,
    weekLabels,
    easyPaceSecPerKm: paceSeries,
    avgEasyHr: hrSeries,
    longRunDistanceM: longSeries,
    sparklines: {
      easyPace: sparklineForSeries(paceSeries, true),
      avgEasyHr: sparklineForSeries(hrSeries, true),
      longRunDistance: sparklineForSeries(longSeries, false),
    },
    verdicts: {
      easyPace: strictlyMonotonicVerdict(paceSeries, true),
      avgEasyHr: strictlyMonotonicVerdict(hrSeries, true),
      longRunDistance: strictlyMonotonicVerdict(longSeries, false),
    },
  };
}

function arrowChain(
  series: (number | null)[],
  fmt: (n: number | null) => string,
): string {
  return series.map((v) => (v === null ? EM_DASH : fmt(v))).join(" → ");
}

/** Markdown `## Trends` — always present; empty series degrade gracefully. */
export function buildTrendsMarkdown(
  snapshot: RecapTrendsSnapshot,
  unit: TempoUnitPreference,
  depth: SectionDepth,
  opts?: { tempoParity?: boolean },
): string {
  const parity = opts?.tempoParity === true;
  const lines: string[] = ["## Trends", ""];

  if (!parity && depth === "detailed" && snapshot.weekLabels) {
    lines.push(`Weeks: ${snapshot.weekLabels.join(" → ")}`);
    lines.push("");
  }

  const pace = snapshot.easyPaceSecPerKm;
  const hr = snapshot.avgEasyHr;
  const lng = snapshot.longRunDistanceM;

  const hasLine =
    pace.some((x) => x !== null) ||
    hr.some((x) => x !== null) ||
    lng.some((x) => x !== null);

  if (!hasLine) {
    // tempo-cli omits the whole section when there is nothing to show.
    if (parity) return "";
    lines.push("No trend data for the last four weeks.");
    lines.push("");
    return lines.join("\n");
  }

  const includePaceHr = parity || depth !== "brief";

  if (includePaceHr && pace.some((x) => x !== null)) {
    const chain = arrowChain(pace, (v) =>
      v === null ? EM_DASH : formatPaceFromSecondsPerKm(v, unit),
    );
    const sp = snapshot.sparklines?.easyPace ?? "";
    const vd = (parity || depth === "detailed") ? snapshot.verdicts?.easyPace : undefined;
    const tail =
      [sp && ` ${sp}`, vd && ` (${vd})`].filter(Boolean).join("") || "";
    lines.push(
      `- **Easy pace (≤Z2, list/detail approx.)**: ${chain}${tail}`,
    );
    lines.push("");
  }

  if (includePaceHr && hr.some((x) => x !== null)) {
    const chain = arrowChain(hr, (v) =>
      v === null ? EM_DASH : String(Math.round(v)),
    );
    const sp = snapshot.sparklines?.avgEasyHr ?? "";
    const vd = (parity || depth === "detailed") ? snapshot.verdicts?.avgEasyHr : undefined;
    const tail =
      [sp && ` ${sp}`, vd && ` (${vd})`].filter(Boolean).join("") || "";
    lines.push(`- **Avg easy HR**: ${chain}${tail}`);
    lines.push("");
  }

  if (lng.some((x) => x !== null)) {
    const chain = arrowChain(lng, (v) =>
      v === null ? EM_DASH : formatDistanceM(v, unit),
    );
    const sp = snapshot.sparklines?.longRunDistance ?? "";
    const vd =
      (parity || depth === "detailed") ? snapshot.verdicts?.longRunDistance : undefined;
    const tail =
      [sp && ` ${sp}`, vd && ` (${vd})`].filter(Boolean).join("") || "";
    lines.push(
      `- **Long-run distance** (max long-typed, else max run in week): ${chain}${tail}`,
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Full trend fetch window: start of W−3 through end of this week. */
export function trendsFetchWindow(thisWeek: WeekWindow): WeekWindow {
  const w3 = shiftWeekWindow(thisWeek, -3);
  return { start: w3.start, end: thisWeek.end };
}
