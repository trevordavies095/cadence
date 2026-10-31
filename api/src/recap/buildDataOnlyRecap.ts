import type { GoalContext } from "../goal/context.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import { buildRecapLongRun } from "./buildLongRun.js";
import { buildRecapNotable } from "./buildNotable.js";
import { buildRecapTrends } from "./buildTrends.js";
import { buildRecapRunByRun } from "./buildRunByRun.js";
import { buildRecapSummary, resolveRecapUnit } from "./buildSummary.js";
import { buildRecapZones } from "./buildZones.js";
import { fetchWeeklyRecapStats } from "./fetchWeeklyRecapStats.js";
import type { RecapGoal, RecapPhase } from "./phase.js";
import {
  buildCoachQuestionsMarkdown,
  buildSubjectiveRecapMarkdown,
  subjectiveRunsToDateMap,
} from "./formatSubjective.js";
import { buildRunByRunMarkdown } from "./runByRunFormat.js";
import type { SubjectiveAnswers } from "./subjectiveQuestionnaire.js";
import { loadWeekGoalContext } from "./weekGoalContext.js";
import { formatRecapWeekRangeLabel } from "./weekRangeLabel.js";

export type DataOnlyRecapResult = {
  status: "report";
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  /** The phase and recap goal the report was built for (from the stored goal). */
  phase: RecapPhase;
  goal: RecapGoal;
  /** The full resolved context: weeks to race, race passed, and the knobs. */
  goalContext: GoalContext;
  /** skipped = escape hatch; present = answers saved; missing reserved for future soft omit */
  subjective: "skipped" | "present";
  subjectiveAnswers: SubjectiveAnswers | null;
  sections: {
    summary: string;
    zones: string;
    runByRun: string;
    /** Empty when tempo-cli would omit the section or its fetch failed. */
    longRun: string;
    trends: string;
    notable: string;
    subjective: string;
    questions: string;
  };
  reportMarkdown: string;
};

/**
 * Assemble a weekly recap (summary + zones + run-by-run).
 * When subjective answers are present, merge RPE/Felt/Pain into run-by-run and
 * append Subjective recap + Questions for coach sections.
 */
export async function buildDataOnlyRecap(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
  subjective: "skipped" | "present";
  subjectiveAnswers?: SubjectiveAnswers | null;
}): Promise<DataOnlyRecapResult> {
  const { session, tempoPort } = args;
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const answers = args.subjectiveAnswers ?? null;
  const goalContext = await loadWeekGoalContext(session);
  const { phase, recapGoal: goal, knobs } = goalContext;

  // Optional sections never block the recap: a failed fetch omits the section.
  const optional = async (
    build: () => Promise<{ markdown: string }>,
  ): Promise<string> => {
    try {
      return (await build()).markdown.trim();
    } catch {
      return "";
    }
  };

  // One weekly-recap call per report, shared by summary and zones.
  const weeklyStats = fetchWeeklyRecapStats(tempoPort, session);
  const [summary, zones, runByRun, longRunMd, trendsMd, notableMd] =
    await Promise.all([
      buildRecapSummary({ session, tempoPort, unit, weeklyStats, knobs }),
      buildRecapZones({
        session,
        tempoPort,
        weeklyStats,
        easyShareTarget: knobs.thresholds.easyShareTarget,
        easyShareVerdict: knobs.thresholds.easyShareVerdict,
      }),
      buildRecapRunByRun({ session, tempoPort, unit, knobs }),
      optional(() =>
        buildRecapLongRun({
          session,
          tempoPort,
          unit,
          phase,
          goal,
          knobs,
          tempoParity: true,
        }),
      ),
      optional(() =>
        buildRecapTrends({
          session,
          tempoPort,
          unit,
          phase,
          goal,
          knobs,
          tempoParity: true,
        }),
      ),
      optional(() =>
        buildRecapNotable({
          session,
          tempoPort,
          unit,
          phase,
          goal,
          knobs,
          tempoParity: true,
        }),
      ),
    ]);

  const subjectiveByDate =
    answers && answers.runs.length > 0
      ? subjectiveRunsToDateMap(answers.runs)
      : undefined;

  const runByRunMarkdown =
    subjectiveByDate && subjectiveByDate.size > 0
      ? buildRunByRunMarkdown(runByRun.runs, unit, {
          subjectiveByDate,
          timeZoneId: session.timezone,
        })
      : runByRun.markdown;

  const subjectiveMarkdown =
    args.subjective === "present"
      ? buildSubjectiveRecapMarkdown(answers?.weekly, answers?.runs)
      : "";
  const questionsMarkdown =
    args.subjective === "present"
      ? buildCoachQuestionsMarkdown(answers?.weekly?.questions_for_coach)
      : "";

  const sections = {
    summary: summary.markdown,
    zones: zones.markdown,
    runByRun: runByRunMarkdown,
    longRun: longRunMd,
    trends: trendsMd,
    notable: notableMd,
    subjective: subjectiveMarkdown,
    questions: questionsMarkdown,
  };

  const parts = [
    `# Weekly Recap — ${formatRecapWeekRangeLabel(
      session.isoWeek,
      session.start,
      session.end,
      session.timezone,
    )}`,
    "",
    summary.markdown.trim(),
    "",
    zones.markdown.trim(),
    "",
    runByRunMarkdown.trim(),
  ];
  // tempo-cli order: Run-by-run, Long run, Trends, Notable, Subjective, Questions.
  for (const optionalMd of [longRunMd, trendsMd, notableMd]) {
    if (optionalMd) parts.push("", optionalMd);
  }
  if (subjectiveMarkdown.trim()) {
    parts.push("", subjectiveMarkdown.trim());
  }
  if (questionsMarkdown.trim()) {
    parts.push("", questionsMarkdown.trim());
  }
  parts.push("");
  const reportMarkdown = parts.join("\n");

  return {
    status: "report",
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    phase,
    goal,
    goalContext,
    subjective: args.subjective,
    subjectiveAnswers: answers,
    sections,
    reportMarkdown,
  };
}
