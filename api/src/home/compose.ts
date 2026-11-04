import { boundsForIsoWeek } from "../clock/isoWeek.js";
import type { Clock } from "../clock/clock.js";
import { todayYmdForSession } from "../prescribed/patch.js";
import { expectedPlanDates } from "../llm/schema.js";
import type { PrescribedDay } from "../llm/types.js";
import { resolveLoopStatus, type LoopStatus } from "../loop/status.js";
import {
  loadActualDistanceByDate,
  planDayOutcomes,
  ymdInZone,
  type PlanDayState,
} from "../prescribed/dayOutcomes.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import type { RuntimeSources } from "../settings/sources.js";
import { resolveUnitPreference } from "../settings/unitPreferenceStore.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";
import { findWeekSession } from "../week/store.js";

/** What Home shows when something needs the athlete. At most one. */
export type HomeBanner = {
  kind:
    | "setup_incomplete"
    | "needs_onboarding"
    | "onboarding_review"
    | "reply_pending"
    | "reply_failed"
    | "needs_check_in"
    | "needs_plan"
    | "plan_ready"
    | "audit_pending";
  text: string;
  /** A link, or an action the page performs itself. Null when there is nothing to do. */
  cta:
    | { label: string; href: string }
    | { label: string; action: "retry_reply_run" }
    | null;
};

/**
 * A day's outcome against the plan, from the one helper the Sunday packet
 * also uses ({@link PlanDayState}): done, today, upcoming, rest, missed,
 * unknown (Tempo could not be read) or not_filed (a day Cadence could not read).
 */
export type HomeDayState = PlanDayState;

export type HomeWeekDay = {
  date: string;
  /** Planned day type, or null when the week has no plan. */
  dayType: PrescribedDay["dayType"] | null;
  plannedDistanceM: number | null;
  /** Planned duration in seconds, when the day's run was prescribed by time. */
  plannedDurationS: number | null;
  /** Distance Tempo recorded on this local date; null when Tempo could not be read. */
  actualDistanceM: number | null;
  state: HomeDayState;
  isToday: boolean;
  /**
   * False when Cadence could not read the day's structure from Coach Cade's
   * line, or the plan gave no line for the date. True for every other day,
   * including old stored plans without the field and weeks with no plan.
   */
  parsed: boolean;
  /**
   * On a day Cadence could not read, Coach Cade's line as written; null when
   * the plan gave no line for the date. Always null on a day Cadence read (the
   * Today card has the read day's line in `today`).
   */
  line: string | null;
};

export type HomeRead = {
  weekSessionId: string | null;
  isoWeek: string | null;
  banner: HomeBanner | null;
  today: PrescribedDay | null;
  week: HomeWeekDay[];
  totals: {
    actualDistanceM: number;
    plannedDistanceM: number;
    /** Planned seconds on days prescribed by duration with no distance; 0 when there are none. */
    plannedDurationS: number;
  };
  units: TempoUnitPreference;
  /** True when Tempo could not be read; the week then shows the plan only. */
  tempoUnavailable: boolean;
};

const PLAN_READY_PHASES = new Set<LoopStatus["phase"]>([
  "mid_week",
  "week_ending",
  "needs_plan",
]);

async function deriveBanner(status: LoopStatus): Promise<HomeBanner | null> {
  const phase = status.phase;
  if (phase === "setup_incomplete") {
    return {
      kind: "setup_incomplete",
      text: "Finish connecting your accounts",
      cta: { label: "Settings", href: "/settings" },
    };
  }
  if (phase === "needs_onboarding") {
    return {
      kind: "needs_onboarding",
      text: "Coach Cade needs a few answers to get started",
      cta: { label: "Start", href: "/onboarding" },
    };
  }
  if (phase === "onboarding_review") {
    return {
      kind: "onboarding_review",
      text: "Here’s what Coach Cade understood",
      cta: { label: "Have a look", href: "/dossier" },
    };
  }

  const run = status.replyRun;
  if (run?.status === "pending") {
    return {
      kind: "reply_pending",
      text: "Coach Cade is reading your week",
      cta: null,
    };
  }
  if (run?.status === "failed") {
    return {
      kind: "reply_failed",
      text: "Coach Cade couldn’t finish reading your week",
      cta: { label: "Retry", action: "retry_reply_run" },
    };
  }

  if (phase === "needs_check_in") {
    return {
      kind: "needs_check_in",
      text: "Time for your weekly check-in",
      cta: { label: "Start", href: "/check-in" },
    };
  }

  if (run?.status === "ok" && !run.seenAt && PLAN_READY_PHASES.has(phase)) {
    return {
      kind: "plan_ready",
      text: "Next week’s plan is ready",
      cta: { label: "See it", href: "/plan" },
    };
  }

  if (phase === "needs_plan") {
    return {
      kind: "needs_plan",
      text: "Coach Cade hasn’t planned next week yet",
      cta: { label: "Open Plan", href: "/plan" },
    };
  }

  // Lowest priority: a tidy-up waiting for a yes never gets in the way of the week.
  if (status.flags.auditPending) {
    return {
      kind: "audit_pending",
      text: "Coach Cade tidied what it knows about you",
      cta: { label: "Have a look", href: "/dossier" },
    };
  }

  return null;
}

export async function composeHome(options: {
  clock: Clock;
  athleteTimezone: string;
  tempoPort: TempoPort;
  sources: RuntimeSources;
}): Promise<HomeRead> {
  const { clock, athleteTimezone, tempoPort, sources } = options;
  const status = await resolveLoopStatus(clock, athleteTimezone, sources);
  const banner = await deriveBanner(status);
  const units = await resolveUnitPreference(tempoPort);

  const empty: HomeRead = {
    weekSessionId: status.week.weekSessionId,
    isoWeek: status.week.isoWeek,
    banner,
    today: null,
    week: [],
    totals: { actualDistanceM: 0, plannedDistanceM: 0, plannedDurationS: 0 },
    units,
    tempoUnavailable: false,
  };

  const sessionId = status.week.weekSessionId;
  if (!sessionId || !status.week.isoWeek) return empty;
  const timezone = status.week.timezone;
  const session = await findWeekSession(status.week.isoWeek, timezone);
  if (!session) return empty;

  const todayYmd = todayYmdForSession(clock, timezone);
  const record = await getPrescribedWeekBySessionId(session.id);
  const planByDate = new Map<string, PrescribedDay>(
    (record?.plan.days ?? []).map((d) => [d.date, d]),
  );
  const monday = boundsForIsoWeek(session.isoWeek, timezone);
  const mondayYmd = ymdInZone(monday.start, timezone);
  const dates = expectedPlanDates(mondayYmd);

  // Actual distance per local date from Tempo. A Tempo failure degrades to plan only.
  const actualByDate = await loadActualDistanceByDate(
    tempoPort,
    { start: session.start, end: session.end },
    timezone,
  );
  const tempoUnavailable = actualByDate === null;

  const week: HomeWeekDay[] = planDayOutcomes({
    dates,
    days: record?.plan.days,
    actualDistanceByDate: actualByDate,
    todayYmd,
  }).map((day) => ({
    date: day.date,
    dayType: day.planned?.dayType ?? null,
    plannedDistanceM: day.plannedDistanceM,
    plannedDurationS: day.plannedDurationS,
    actualDistanceM: day.actualDistanceM,
    state: day.state,
    isToday: day.isToday,
    parsed: day.parsed,
    line: day.parsed ? null : (day.planned?.line ?? null),
  }));

  return {
    ...empty,
    today: planByDate.get(todayYmd) ?? null,
    week,
    totals: {
      actualDistanceM: week.reduce((sum, d) => sum + (d.actualDistanceM ?? 0), 0),
      plannedDistanceM: week.reduce((sum, d) => sum + (d.plannedDistanceM ?? 0), 0),
      plannedDurationS: week.reduce(
        (sum, d) =>
          (d.plannedDistanceM ?? 0) > 0 ? sum : sum + (d.plannedDurationS ?? 0),
        0,
      ),
    },
    tempoUnavailable,
  };
}
