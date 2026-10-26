import type { PrescribedWeek } from "../../llm/types.js";
import type { TempoUnitPreference, TempoWorkoutDetail } from "../../tempo/port.js";
import { formatDistanceM } from "../format.js";
import { formatPaceFromSecondsPerKm, formatTitleDate } from "../runByRunFormat.js";
import {
  distanceRatio,
  matchWorkoutOnDate,
  prescribedLongDay,
} from "./match.js";
import type { GradeVerdict, LongRunGrade } from "./types.js";

/** tempo-cli §2.6: ≥75% of prescribed long-run distance qualifies. */
export const LONG_RUN_THRESHOLD = 0.75;

function verdictFor(args: {
  matched: boolean;
  thresholdMet: boolean;
  ratio: number | undefined;
}): GradeVerdict {
  if (!args.matched) return "missed";
  if (args.thresholdMet) return "on_target";
  if (args.ratio !== undefined && args.ratio > 0) return "short";
  return "partial";
}

function verdictGlyph(v: GradeVerdict): string {
  if (v === "on_target") return "✓";
  if (v === "partial" || v === "short") return "⚠";
  return "✗";
}

function verdictSummary(grade: LongRunGrade): string {
  if (grade.verdict === "missed") {
    return "Verdict: no matching long run on prescribed date.";
  }
  if (grade.verdict === "on_target") {
    return "Verdict: on target (≥75% of prescribed distance).";
  }
  if (grade.verdict === "short") {
    return "Verdict: below 75% of prescribed long-run distance.";
  }
  return "Verdict: matched but distance incomplete.";
}

/**
 * Grade prescribed long day vs actual workout on that date.
 * Returns null when the plan has no long day (section omitted).
 */
export function gradeLongRun(args: {
  plan: PrescribedWeek;
  workouts: readonly TempoWorkoutDetail[];
  timeZoneId: string;
  unit: TempoUnitPreference;
}): { grade: LongRunGrade | null; markdown: string } {
  const day = prescribedLongDay(args.plan);
  if (!day || !day.run) {
    return { grade: null, markdown: "" };
  }

  const run = day.run;
  const matched = matchWorkoutOnDate({
    workouts: args.workouts,
    dateYmd: day.date,
    timeZoneId: args.timeZoneId,
    preferLong: true,
  });
  const ratio = matched
    ? distanceRatio(matched.distanceM, run.distanceM)
    : undefined;
  const thresholdMet = ratio !== undefined && ratio >= LONG_RUN_THRESHOLD;
  const verdict = verdictFor({
    matched: !!matched,
    thresholdMet,
    ratio,
  });

  const description =
    run.structure?.trim() ||
    run.paceOrHr?.trim() ||
    "Long run";

  const grade: LongRunGrade = {
    date: day.date,
    description,
    prescribedDistanceM: run.distanceM,
    prescribedPaceOrHr: run.paceOrHr?.trim() || null,
    matched: !!matched,
    thresholdMet,
    verdict,
  };
  if (matched) {
    grade.workoutId = matched.id;
    grade.actualDistanceM = matched.distanceM;
    if (Number.isFinite(matched.avgPaceS) && matched.avgPaceS > 0) {
      grade.actualAvgPaceS = matched.avgPaceS;
    }
    if (
      typeof matched.avgHeartRateBpm === "number" &&
      Number.isFinite(matched.avgHeartRateBpm)
    ) {
      grade.actualAvgHeartRateBpm = matched.avgHeartRateBpm;
    }
    if (typeof matched.runType === "string" && matched.runType.trim()) {
      grade.actualRunType = matched.runType.trim();
    }
    if (ratio !== undefined) grade.distanceRatio = ratio;
  }

  const titleDate = matched
    ? formatTitleDate(matched.startedAt, args.timeZoneId)
    : day.date;
  const prescribedDist = formatDistanceM(run.distanceM, args.unit);
  const paceOrHr = run.paceOrHr?.trim() || "n/a";

  const lines: string[] = [
    `### Long run grade — ${titleDate}`,
    "",
    "### Prescribed vs actual",
    "",
    `Prescribed: ${prescribedDist} · ${paceOrHr}`,
    "",
  ];

  if (!matched) {
    lines.push("Actual: no long run on prescribed date ✗", "");
  } else {
    const bits: string[] = [formatDistanceM(matched.distanceM, args.unit)];
    if (grade.actualAvgPaceS !== undefined) {
      bits.push(formatPaceFromSecondsPerKm(grade.actualAvgPaceS, args.unit));
    }
    if (grade.actualAvgHeartRateBpm !== undefined) {
      bits.push(`avg HR ${Math.round(grade.actualAvgHeartRateBpm)}`);
    }
    if (grade.actualRunType) bits.push(grade.actualRunType);
    if (ratio !== undefined) {
      bits.push(`${Math.round(ratio * 100)}% of plan`);
    }
    lines.push(`Actual: ${bits.join(" · ")} ${verdictGlyph(verdict)}`, "");
    lines.push(
      `Distance vs plan: ${
        ratio !== undefined ? `${Math.round(ratio * 100)}%` : "n/a"
      } (threshold 75%) ${thresholdMet ? "✓" : "✗"}`,
      "",
    );
  }

  lines.push(verdictSummary(grade), "");

  return {
    grade,
    markdown: `${lines.join("\n").trimEnd()}\n`,
  };
}
