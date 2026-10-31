import type { TempoUnitPreference } from "../tempo/port.js";
import type { WeekAggregate } from "./aggregate.js";
import type { SummaryComparison } from "./compare.js";

const METERS_PER_MILE = 1609.344;
const EM_DASH = "—";

export type RecapSummaryTableRow = {
  metric: string;
  thisWeek: string;
  prevWeek: string;
  threeWkAvg: string;
  delta: string;
};

function cellOrDash(v: string | undefined): string {
  return v !== undefined && v !== "" ? v : EM_DASH;
}

export function formatDistanceM(
  meters: number,
  unit: TempoUnitPreference,
): string {
  if (!Number.isFinite(meters) || meters < 0) return "n/a";
  if (unit === "imperial") {
    return `${(meters / METERS_PER_MILE).toFixed(2)} mi`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "n/a";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatElevationM(
  m: number | undefined,
  unit: TempoUnitPreference,
): string | undefined {
  if (m === undefined || !Number.isFinite(m)) return undefined;
  if (unit === "imperial") {
    return `${Math.round(m * 3.28084)} ft`;
  }
  return `${Math.round(m)} m`;
}

function formatSignedDistanceDelta(
  deltaM: number | undefined,
  unit: TempoUnitPreference,
): string | undefined {
  if (deltaM === undefined || !Number.isFinite(deltaM)) return undefined;
  const d =
    unit === "imperial" ? deltaM / METERS_PER_MILE : deltaM / 1000;
  const sign = d >= 0 ? "+" : "-";
  return `${sign}${Math.abs(d).toFixed(1)}`;
}

function formatSignedRunsDelta(delta: number | undefined): string | undefined {
  if (delta === undefined || !Number.isFinite(delta)) return undefined;
  const sign = delta >= 0 ? "+" : "-";
  return `${sign}${Math.abs(delta).toFixed(1)}`;
}

function formatRunsAvgOneDecimal(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return n.toFixed(1);
}

function formatSignedDurationDeltaSec(
  sec: number | undefined,
): string | undefined {
  if (sec === undefined || !Number.isFinite(sec)) return undefined;
  const sign = sec >= 0 ? "+" : "-";
  const a = Math.abs(Math.round(sec));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  if (h > 0) return `${sign}${h}h ${m}m`;
  if (m > 0) return `${sign}${m}m`;
  return `${sign}${s}s`;
}

function formatSignedElevDeltaM(
  deltaM: number | undefined,
  unit: TempoUnitPreference,
): string | undefined {
  if (deltaM === undefined || !Number.isFinite(deltaM)) return undefined;
  const sign = deltaM >= 0 ? "+" : "-";
  const absVal = Math.abs(deltaM);
  if (unit === "imperial") {
    return `${sign}${Math.round(absVal * 3.28084)} ft`;
  }
  return `${sign}${Math.round(absVal)} m`;
}

function formatSignedIntDelta(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${Math.round(Math.abs(n))}`;
}

/** Six-row Summary table (tempo-cli §2.2 column shape). */
export function buildSummaryTableRows(args: {
  thisWeek: WeekAggregate;
  comparison: SummaryComparison;
  unit: TempoUnitPreference;
}): RecapSummaryTableRow[] {
  const { thisWeek: agg, comparison: sfs, unit } = args;

  const mileagePrev =
    sfs.mileage.prevDistanceM !== undefined
      ? formatDistanceM(sfs.mileage.prevDistanceM, unit)
      : undefined;
  const mileage3 =
    sfs.mileage.threeWkAvgDistanceM !== undefined
      ? formatDistanceM(sfs.mileage.threeWkAvgDistanceM, unit)
      : undefined;
  const mileageDelta = formatSignedDistanceDelta(
    sfs.mileage.deltaVsThreeWkM,
    unit,
  );

  const runsPrev =
    sfs.runs.prev !== undefined ? String(Math.round(sfs.runs.prev)) : undefined;
  const runs3 = formatRunsAvgOneDecimal(sfs.runs.threeWkAvg);
  const runsDelta = formatSignedRunsDelta(sfs.runs.deltaVsThreeWk);

  const timePrev =
    sfs.time.prevDurationS !== undefined
      ? formatDuration(Math.round(sfs.time.prevDurationS))
      : undefined;
  const time3 =
    sfs.time.threeWkAvgDurationS !== undefined
      ? formatDuration(Math.round(sfs.time.threeWkAvgDurationS))
      : undefined;
  const timeDelta = formatSignedDurationDeltaSec(sfs.time.deltaVsThreeWkS);

  // tempo-cli: this-week elevation is always shown (0 ft when none).
  const elevThis = formatElevationM(agg.elevGainM, unit);
  const elevPrev = formatElevationM(sfs.elevation.prevElevM, unit);
  const elev3 = formatElevationM(sfs.elevation.threeWkAvgElevM, unit);
  const elevDelta = formatSignedElevDeltaM(
    sfs.elevation.deltaVsThreeWkM,
    unit,
  );

  // tempo-cli: this-week RE is a dash unless the sum is positive.
  const reThis =
    agg.relativeEffort > 0 ? String(Math.round(agg.relativeEffort)) : undefined;
  const rePrev =
    sfs.relativeEffort.prev !== undefined
      ? String(Math.round(sfs.relativeEffort.prev))
      : undefined;
  const re3 =
    sfs.relativeEffort.threeWkAvg !== undefined
      ? String(Math.round(sfs.relativeEffort.threeWkAvg))
      : undefined;
  const reDelta = formatSignedIntDelta(sfs.relativeEffort.deltaVsThreeWk);

  return [
    {
      metric: "Mileage",
      thisWeek: formatDistanceM(agg.distanceM, unit),
      prevWeek: cellOrDash(mileagePrev),
      threeWkAvg: cellOrDash(mileage3),
      delta: cellOrDash(mileageDelta),
    },
    {
      metric: "Runs",
      thisWeek: String(agg.runCount),
      prevWeek: cellOrDash(runsPrev),
      threeWkAvg: cellOrDash(runs3),
      delta: cellOrDash(runsDelta),
    },
    {
      metric: "Total time",
      thisWeek: formatDuration(agg.durationS),
      prevWeek: cellOrDash(timePrev),
      threeWkAvg: cellOrDash(time3),
      delta: cellOrDash(timeDelta),
    },
    {
      metric: "Total elevation",
      thisWeek: cellOrDash(elevThis),
      prevWeek: cellOrDash(elevPrev),
      threeWkAvg: cellOrDash(elev3),
      delta: cellOrDash(elevDelta),
    },
    {
      metric: "Relative effort",
      thisWeek: cellOrDash(reThis),
      prevWeek: cellOrDash(rePrev),
      threeWkAvg: cellOrDash(re3),
      delta: cellOrDash(reDelta),
    },
    {
      metric: "Avg easy-run HR",
      thisWeek:
        agg.easyRunAvgHr !== undefined ? String(agg.easyRunAvgHr) : EM_DASH,
      prevWeek: sfs.easyRunHr
        ? cellOrDash(
            sfs.easyRunHr.prev !== undefined
              ? String(Math.round(sfs.easyRunHr.prev))
              : undefined,
          )
        : EM_DASH,
      threeWkAvg: sfs.easyRunHr
        ? cellOrDash(
            sfs.easyRunHr.threeWkAvg !== undefined
              ? String(Math.round(sfs.easyRunHr.threeWkAvg))
              : undefined,
          )
        : EM_DASH,
      delta: sfs.easyRunHr
        ? cellOrDash(formatSignedIntDelta(sfs.easyRunHr.deltaVsThreeWk))
        : EM_DASH,
    },
  ];
}

/** Markdown `## Summary` pipe table. */
export function buildSummaryMarkdown(
  rows: readonly RecapSummaryTableRow[],
  /** The goal's lines (summaryGoalLines.ts), printed above the table. */
  goalLinesMarkdown = "",
): string {
  const lines = ["## Summary", ""];
  if (goalLinesMarkdown.trim()) lines.push(goalLinesMarkdown.trim(), "");
  lines.push(
    "| Metric | This week | Prev week | 3-wk avg | Δ |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const r of rows) {
    lines.push(
      `| ${r.metric} | ${r.thisWeek} | ${r.prevWeek} | ${r.threeWkAvg} | ${r.delta} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
