import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import {
  buildDataOnlyRecap,
  type DataOnlyRecapResult,
} from "./buildDataOnlyRecap.js";
import {
  resolveCheckInStatus,
  type CheckInStatus,
} from "./checkInStatus.js";
import {
  SUBJECTIVE_QUESTIONNAIRE,
  type SubjectiveAnswers,
  type SubjectiveQuestionnaire,
} from "./subjectiveQuestionnaire.js";
import { getSubjectiveAnswers } from "./subjectiveStore.js";
import {
  buildNeedsSubjectiveRuns,
  type NeedsSubjectiveRun,
} from "./subjectiveRuns.js";

const GATE_NOTE =
  "Subjective answers are date-keyed (one row per YYYY-MM-DD; last write wins for same-day doubles). " +
  "Interview once per calendar date using questionnaire.order, then POST /weeks/:id/recap/subjective " +
  "and GET /weeks/:id/recap again. Pass skip_subjective=true to explicitly Skip check-in " +
  "(persisted on the week so refresh does not reopen the interview).";

export type NeedsSubjectivePayload = {
  status: "needs_subjective";
  weekSessionId: string;
  week: string;
  timezone: string;
  localRange: { start: string; end: string };
  note: string;
  runs: NeedsSubjectiveRun[];
  questionnaire: SubjectiveQuestionnaire;
  /** Plan hard-gate (#52): still needed until finish or explicit Skip. */
  checkInStatus: "needed";
};

export type RecapReportResult = DataOnlyRecapResult & {
  /** Plan hard-gate (#52): finished after answers; skipped after durable Skip. */
  checkInStatus: "finished" | "skipped";
};

export type RecapGateResult = NeedsSubjectivePayload | RecapReportResult;

export type ResolveRecapGateOptions = {
  session: WeekSession;
  tempoPort: TempoPort;
  /** Explicit Skip: data-only report + durable unlock (survives refresh). */
  skipSubjective?: boolean;
  /** Force the interview gate even when answers / Skip already exist. */
  refreshSubjective?: boolean;
  unit?: TempoUnitPreference;
};

function withCheckInStatus(
  report: DataOnlyRecapResult,
): RecapReportResult {
  return {
    ...report,
    checkInStatus:
      report.subjective === "present" ? "finished" : "skipped",
  };
}

/**
 * Weekly recap gate (tempo-cli MCP needs_subjective shape).
 * Missing answers and no durable Skip → questionnaire + compact runs;
 * explicit Skip or saved answers → report (Skip persists via week_recaps).
 */
export async function resolveRecapGate(
  options: ResolveRecapGateOptions,
): Promise<RecapGateResult> {
  const { session, tempoPort } = options;
  const skipSubjective = options.skipSubjective === true;
  const refreshSubjective = options.refreshSubjective === true;

  if (skipSubjective) {
    return withCheckInStatus(
      await buildDataOnlyRecap({
        session,
        tempoPort,
        unit: options.unit,
        subjective: "skipped",
        subjectiveAnswers: null,
      }),
    );
  }

  if (!refreshSubjective) {
    const stored = await getSubjectiveAnswers(session.id);
    if (stored) {
      return withCheckInStatus(
        await buildDataOnlyRecap({
          session,
          tempoPort,
          unit: options.unit,
          subjective: "present",
          subjectiveAnswers: stored.answers,
        }),
      );
    }

    // Durable Skip: week_recaps.subjective=skipped from a prior skip_subjective.
    const checkIn = await resolveCheckInStatus(session.id);
    if (checkIn === "skipped") {
      return withCheckInStatus(
        await buildDataOnlyRecap({
          session,
          tempoPort,
          unit: options.unit,
          subjective: "skipped",
          subjectiveAnswers: null,
        }),
      );
    }
  }

  const { runs, localRange } = await buildNeedsSubjectiveRuns({
    session,
    tempoPort,
    unit: options.unit,
  });

  return {
    status: "needs_subjective",
    weekSessionId: session.id,
    week: session.isoWeek,
    timezone: session.timezone,
    localRange,
    note: GATE_NOTE,
    runs,
    questionnaire: SUBJECTIVE_QUESTIONNAIRE,
    checkInStatus: "needed",
  };
}

export type { SubjectiveAnswers, CheckInStatus };
