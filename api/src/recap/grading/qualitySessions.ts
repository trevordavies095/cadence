import type { PrescribedWeek } from "../../llm/types.js";
import type { TempoUnitPreference, TempoWorkoutDetail } from "../../tempo/port.js";
import { formatDistanceM } from "../format.js";
import { formatPaceFromSecondsPerKm, formatTitleDate } from "../runByRunFormat.js";
import {
  distanceRatio,
  isTimedOnlyRun,
  matchWorkoutOnDate,
  normalizeIsoWeekId,
  prescribedQualityDays,
} from "./match.js";
import { formatPrescribedAmount } from "./prescribedAmount.js";
import type { GradeVerdict, QualitySessionGrade } from "./types.js";

/** Session-level: ≥80% of prescribed distance counts as on target. */
const DISTANCE_ON_TARGET = 0.8;

function sessionDescription(day: {
  run?: { structure?: string | null; type?: string } | null;
  dayType: string;
}): string {
  const structure = day.run?.structure?.trim();
  if (structure) return structure;
  if (day.dayType === "race") return "Race";
  return "Quality session";
}

function verdictFor(args: {
  matched: boolean;
  ratio: number | undefined;
  timedOnly: boolean;
}): GradeVerdict {
  if (!args.matched) return "missed";
  if (args.timedOnly) return "on_target";
  if (args.ratio === undefined) return "partial";
  if (args.ratio >= DISTANCE_ON_TARGET) return "on_target";
  return "short";
}

function verdictGlyph(v: GradeVerdict): string {
  if (v === "on_target") return "✓";
  if (v === "partial" || v === "short") return "⚠";
  return "✗";
}

function verdictSummary(v: GradeVerdict): string {
  if (v === "on_target") return "Verdict: on target.";
  if (v === "short") return "Verdict: short of prescribed distance.";
  if (v === "partial") return "Verdict: matched but distance incomplete.";
  return "Verdict: no matching workout on prescribed date.";
}

export function gradeQualitySessions(args: {
  plan: PrescribedWeek;
  workouts: readonly TempoWorkoutDetail[];
  timeZoneId: string;
  unit: TempoUnitPreference;
  resolvedIsoWeek: string;
}): { sessions: QualitySessionGrade[]; markdown: string } {
  const days = prescribedQualityDays(args.plan);
  if (days.length === 0) {
    return { sessions: [], markdown: "" };
  }

  const weekMismatch =
    normalizeIsoWeekId(args.plan.week) !==
    normalizeIsoWeekId(args.resolvedIsoWeek);

  const sessions: QualitySessionGrade[] = [];
  const mdParts: string[] = ["## Quality sessions", ""];

  if (weekMismatch) {
    mdParts.push(
      `> Prescribed week (\`${args.plan.week}\`) does not match recap week (\`${args.resolvedIsoWeek}\`); quality checks may not align.`,
      "",
    );
  }

  for (const day of days) {
    const run = day.run!;
    const matched = matchWorkoutOnDate({
      workouts: args.workouts,
      dateYmd: day.date,
      timeZoneId: args.timeZoneId,
      preferQuality: true,
    });
    const ratio = matched
      ? distanceRatio(matched.distanceM, run.distanceM)
      : undefined;
    const verdict = verdictFor({
      matched: !!matched,
      ratio,
      timedOnly: isTimedOnlyRun(run),
    });
    const description = sessionDescription(day);

    const grade: QualitySessionGrade = {
      date: day.date,
      dayType: day.dayType === "race" ? "race" : "quality",
      description,
      prescribedDistanceM: run.distanceM,
      prescribedPaceOrHr: run.paceOrHr?.trim() || null,
      prescribedStructure: run.structure?.trim() || null,
      matched: !!matched,
      verdict,
    };
    if (run.durationS != null && run.durationS > 0) {
      grade.prescribedDurationS = run.durationS;
    }
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
    sessions.push(grade);

    const titleDate = matched
      ? formatTitleDate(matched.startedAt, args.timeZoneId)
      : day.date;
    const prescribed = formatPrescribedAmount(run, args.unit);
    const paceOrHr = run.paceOrHr?.trim() || "n/a";
    const prescribedLine = `Prescribed: ${prescribed} · ${paceOrHr}`;

    let actualLine: string;
    if (!matched) {
      actualLine = "Actual: no workout/race on prescribed date ✗";
    } else {
      const bits: string[] = [
        formatDistanceM(matched.distanceM, args.unit),
      ];
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
      actualLine = `Actual: ${bits.join(" · ")} ${verdictGlyph(verdict)}`;
    }

    mdParts.push(
      `### Quality session — ${titleDate} — ${description}`,
      "",
      prescribedLine,
      "",
    );
    if (grade.prescribedStructure) {
      mdParts.push(`Structure: ${grade.prescribedStructure}`, "");
    }
    mdParts.push(actualLine, "", verdictSummary(verdict), "");
  }

  return {
    sessions,
    markdown: `${mdParts.join("\n").trimEnd()}\n`,
  };
}
