import type { WeekSession } from "../week/store.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import { buildRecapGrading } from "./buildGrading.js";
import { buildRecapLongRun } from "./buildLongRun.js";
import { buildRecapNotable } from "./buildNotable.js";
import { buildRecapRunByRun } from "./buildRunByRun.js";
import { buildRecapSummary } from "./buildSummary.js";
import { buildRecapTrends } from "./buildTrends.js";
import { buildRecapZones } from "./buildZones.js";
import { fetchWeeklyRecapStats } from "./fetchWeeklyRecapStats.js";
import {
  RECAP_SKELETON_ORDER,
  resolveRecapDepthKnobs,
  type RecapGoal,
  type RecapPhase,
} from "./phase.js";

export type RecapSkeletonResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  phase: RecapPhase;
  goal: RecapGoal;
  knobs: ReturnType<typeof resolveRecapDepthKnobs>;
  /** Stable section ids in order. */
  sectionOrder: readonly string[];
  gradingIncluded: boolean;
  sections: {
    summary: string;
    zones: string;
    runByRun: string;
    quality: string;
    longRun: string;
    trends: string;
    notable: string;
    subjective: string;
    questions: string;
  };
  markdown: string;
};

const SUBJECTIVE_PLACEHOLDER = [
  "## Subjective recap",
  "",
  "_(not collected yet)_",
  "",
].join("\n");

const QUESTIONS_PLACEHOLDER = [
  "## Questions for coach",
  "",
  "_(not collected yet)_",
  "",
].join("\n");

function trimSection(md: string): string {
  if (!md.trim()) return "";
  return md.replace(/\s+$/u, "") + "\n";
}

/**
 * Assemble the weekly recap skeleton in stable order.
 * Phase/goal knobs change depth of long-run / trends / notable (and leave order intact).
 * Quality / long-run grading slots fill when a prescribed week exists (#41).
 * Subjective / questions slots are placeholders here; the gated recap path
 * (buildDataOnlyRecap) merges saved answers into the full report.
 */
export async function buildRecapSkeleton(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
  phase?: RecapPhase;
  goal?: RecapGoal;
}): Promise<RecapSkeletonResult> {
  const { session, tempoPort } = args;
  const knobs = resolveRecapDepthKnobs({
    phase: args.phase,
    goal: args.goal,
  });

  // One weekly-recap call per report, shared by summary and zones.
  const weeklyStats = fetchWeeklyRecapStats(tempoPort, session);
  const [summary, zones, runByRun, longRun, trends, notable, grading] =
    await Promise.all([
      buildRecapSummary({
        session,
        tempoPort,
        unit: args.unit,
        weeklyStats,
      }),
      buildRecapZones({
        session,
        tempoPort,
        weeklyStats,
        easyShareTarget: knobs.thresholds.easyShareTarget,
      }),
      buildRecapRunByRun({
        session,
        tempoPort,
        unit: args.unit,
      }),
      buildRecapLongRun({
        session,
        tempoPort,
        unit: args.unit,
        phase: knobs.phase,
        goal: knobs.goal,
      }),
      buildRecapTrends({
        session,
        tempoPort,
        unit: args.unit,
        phase: knobs.phase,
        goal: knobs.goal,
      }),
      buildRecapNotable({
        session,
        tempoPort,
        unit: args.unit,
        phase: knobs.phase,
        goal: knobs.goal,
      }),
      buildRecapGrading({
        session,
        tempoPort,
        unit: args.unit,
      }),
    ]);

  const unit = summary.unit;
  const longRunMd = trimSection(longRun.markdown);
  const longRunGradeMd = trimSection(grading.longRunGradeMarkdown);
  const longRunCombined =
    longRunGradeMd && longRunMd
      ? `${longRunMd.replace(/\s+$/u, "")}\n\n${longRunGradeMd}`
      : longRunMd || longRunGradeMd;

  const sections = {
    summary: trimSection(summary.markdown),
    zones: trimSection(zones.markdown),
    runByRun: trimSection(runByRun.markdown),
    quality: trimSection(grading.qualityMarkdown),
    longRun: longRunCombined,
    trends: trimSection(trends.markdown),
    notable: trimSection(notable.markdown),
    subjective: SUBJECTIVE_PLACEHOLDER,
    questions: QUESTIONS_PLACEHOLDER,
  };

  const markdown =
    RECAP_SKELETON_ORDER.map((id) => sections[id])
      .filter((s) => s.trim().length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n";

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    phase: knobs.phase,
    goal: knobs.goal,
    knobs,
    sectionOrder: [...RECAP_SKELETON_ORDER],
    gradingIncluded: grading.included,
    sections,
    markdown,
  };
}
