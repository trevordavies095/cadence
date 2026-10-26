import type { TempoUnitPreference } from "../tempo/port.js";
import { formatDistanceM, formatDuration } from "./format.js";
import {
  formatSubjectiveRunLine,
  type SubjectiveRunFields,
} from "./formatSubjective.js";
import type { RunByRunEntry } from "./runByRunTypes.js";
import { workoutLocalDate } from "./subjectiveRuns.js";

const METERS_PER_MILE = 1609.344;

/** `avgPaceS` / split `paceS` from Tempo are seconds per kilometer. */
export function formatPaceFromSecondsPerKm(
  secPerKm: number,
  unit: TempoUnitPreference,
): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "n/a";
  const secPerUnit =
    unit === "imperial" ? secPerKm * (METERS_PER_MILE / 1000) : secPerKm;
  const m = Math.floor(secPerUnit / 60);
  const s = Math.round(secPerUnit % 60);
  const suf = unit === "imperial" ? "/mi" : "/km";
  return `${m}:${String(s).padStart(2, "0")}${suf}`;
}

/** API cadence is one-foot RPM; recap copy uses steps per minute (both feet). */
export function cadenceRpmToSpm(rpm: number): number {
  return Math.round(rpm * 2);
}

export function formatTitleDate(
  startedAt: string,
  timeZoneId: string,
): string {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZoneId,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).formatToParts(d);
    const weekday = parts.find((p) => p.type === "weekday")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (weekday && month && day) return `${weekday} ${month} ${day}`;
  } catch {
    // invalid IANA zone — fall through
  }
  return startedAt;
}

export function formatSplitPaceList(
  pacesS: readonly number[],
  unit: TempoUnitPreference,
): string | undefined {
  if (pacesS.length === 0) return undefined;
  return pacesS.map((p) => formatPaceFromSecondsPerKm(p, unit)).join(" / ");
}

function formatElevGainLoss(
  elevGainM: number | null | undefined,
  elevLossM: number | null | undefined,
  unit: TempoUnitPreference,
): string | undefined {
  const fmt = (m: number) => {
    if (unit === "imperial") return `${Math.round(m * 3.28084)} ft`;
    return `${Math.round(m)} m`;
  };
  const bits: string[] = [];
  if (typeof elevGainM === "number" && Number.isFinite(elevGainM)) {
    bits.push(`↑${fmt(elevGainM)}`);
  }
  if (typeof elevLossM === "number" && Number.isFinite(elevLossM)) {
    bits.push(`↓${fmt(elevLossM)}`);
  }
  return bits.length > 0 ? bits.join(" ") : undefined;
}

function formatZoneLine(zonePct: Record<string, number> | undefined): string {
  if (!zonePct || Object.keys(zonePct).length === 0) {
    return "Time in zones: n/a (no HR data)";
  }
  const parts = Object.keys(zonePct)
    .sort()
    .map((k) => `${k.toUpperCase()} ${zonePct[k]}%`);
  return `Time in zones: ${parts.join(" · ")}`;
}

function formatOneRunMarkdown(
  run: RunByRunEntry,
  unit: TempoUnitPreference,
  subjective?: SubjectiveRunFields,
): string {
  const distStr = formatDistanceM(run.distanceM, unit);
  const durStr = formatDuration(run.durationS);
  const lines: string[] = [];
  lines.push(`### ${run.titleDate} — ${run.runType} — ${distStr} / ${durStr}`);
  lines.push("");

  const paceBits: string[] = [];
  paceBits.push(`Pace: ${formatPaceFromSecondsPerKm(run.avgPaceS, unit)}`);
  if (
    typeof run.avgHeartRateBpm === "number" &&
    Number.isFinite(run.avgHeartRateBpm)
  ) {
    const pct =
      typeof run.pctMaxHr === "number" ? ` (${run.pctMaxHr}% max)` : "";
    paceBits.push(`Avg HR ${Math.round(run.avgHeartRateBpm)}${pct}`);
  }
  if (
    typeof run.maxHeartRateBpm === "number" &&
    Number.isFinite(run.maxHeartRateBpm)
  ) {
    paceBits.push(`Max HR ${Math.round(run.maxHeartRateBpm)}`);
  }
  if (typeof run.cadenceSpm === "number" && Number.isFinite(run.cadenceSpm)) {
    paceBits.push(`Cad ${run.cadenceSpm} spm`);
  }
  lines.push(paceBits.join("  ·  "));
  lines.push("");

  lines.push(`Splits: ${run.splitPacesFormatted ?? "n/a"}`);
  lines.push("");

  if (run.drift) {
    const sign = run.drift.driftBpm >= 0 ? "+" : "";
    const severity = run.driftSeverity ? ` ${run.driftSeverity}` : "";
    lines.push(
      `HR drift: ${run.drift.q1AvgHr} → ${run.drift.q4AvgHr} (${sign}${run.drift.driftBpm} bpm)${severity}`,
    );
  } else if (run.timeSeriesUnavailableReason) {
    lines.push(
      `HR drift: n/a (time-series unavailable: ${run.timeSeriesUnavailableReason})`,
    );
  } else {
    lines.push("HR drift: n/a");
  }
  lines.push("");

  lines.push(formatZoneLine(run.zonePct));
  lines.push("");

  const elev = formatElevGainLoss(run.elevGainM, run.elevLossM, unit);
  const envBits: string[] = [];
  if (elev) envBits.push(`Elevation: ${elev}`);
  if (run.weather) envBits.push(`Weather: ${run.weather}`);
  if (envBits.length > 0) {
    lines.push(envBits.join("  ·  "));
    lines.push("");
  }

  if (run.shoe) {
    const mi =
      run.shoe.mileageMi !== undefined
        ? ` (${run.shoe.mileageMi.toFixed(0)} mi)`
        : "";
    lines.push(`Shoe: ${run.shoe.label}${mi}`);
    lines.push("");
  } else if (run.shoeId) {
    lines.push(`Shoe: n/a (id ${run.shoeId})`);
    lines.push("");
  }

  if (
    typeof run.relativeEffort === "number" &&
    Number.isFinite(run.relativeEffort)
  ) {
    lines.push(`Relative effort: ${Math.round(run.relativeEffort)}`);
    lines.push("");
  }

  if (run.similarRouteText !== undefined) {
    lines.push(`Similar route: ${run.similarRouteText}`);
    lines.push("");
  }

  if (typeof run.notes === "string" && run.notes.trim()) {
    lines.push(`Notes (from app): "${run.notes.trim()}"`);
    lines.push("");
  }

  if (subjective) {
    const subjectiveLine = formatSubjectiveRunLine(subjective);
    if (subjectiveLine) {
      lines.push(subjectiveLine);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

export type BuildRunByRunMarkdownOptions = {
  /** Date-keyed RPE/Felt/Pain (YYYY-MM-DD in session timezone). */
  subjectiveByDate?: ReadonlyMap<string, SubjectiveRunFields>;
  timeZoneId?: string;
};

/** Markdown `## Run-by-run` section; optional subjective lines when provided. */
export function buildRunByRunMarkdown(
  runs: readonly RunByRunEntry[],
  unit: TempoUnitPreference,
  options?: BuildRunByRunMarkdownOptions,
): string {
  const lines = ["## Run-by-run", ""];
  if (runs.length === 0) {
    lines.push("No runs recorded this week.");
    lines.push("");
    return lines.join("\n");
  }
  const byDate = options?.subjectiveByDate;
  const tz = options?.timeZoneId;
  const blocks = runs.map((r) => {
    let subjective: SubjectiveRunFields | undefined;
    if (byDate && tz) {
      const date = workoutLocalDate(r.startedAt, tz);
      if (date) subjective = byDate.get(date);
    }
    return formatOneRunMarkdown(r, unit, subjective);
  });
  lines.push(blocks.join("\n\n"));
  lines.push("");
  return lines.join("\n");
}
