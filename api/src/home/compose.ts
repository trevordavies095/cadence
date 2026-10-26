import { boundsForIsoWeek } from "../clock/isoWeek.js";
import type { Clock } from "../clock/clock.js";
import { todayYmdForSession } from "../prescribed/patch.js";
import { expectedPlanDates } from "../llm/schema.js";
import type { PrescribedDay } from "../llm/types.js";
import { resolveLoopStatus, type LoopStatus } from "../loop/status.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import { listAllWorkoutsInWindow } from "../recap/listWindow.js";
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

export type HomeDayState =
  | "done"
  | "today"
  | "upcoming"
  | "rest"
  | "missed"
  /** A past day with a planned run while Tempo could not be read. */
  | "unknown";

export type HomeWeekDay = {
  date: string;
  /** Planned day type, or null when the week has no plan. */
  dayType: PrescribedDay["dayType"] | null;
  plannedDistanceM: number | null;
  /** Distance Tempo recorded on this local date; null when Tempo could not be read. */
  actualDistanceM: number | null;
  state: HomeDayState;
  isToday: boolean;
};

export type HomeRead = {
  weekSessionId: string | null;
  isoWeek: string | null;
  banner: HomeBanner | null;
  today: PrescribedDay | null;
  week: HomeWeekDay[];
  totals: { actualDistanceM: number; plannedDistanceM: number };
  units: TempoUnitPreference;
  /** True when Tempo could not be read; the week then shows the plan only. */
  tempoUnavailable: boolean;
};

const PLAN_READY_PHASES = new Set<LoopStatus["phase"]>([
  "mid_week",
  "week_ending",
  "needs_plan",
]);

/** Local calendar date of an instant in a timezone, as YYYY-MM-DD. */
function ymdInZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

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
}): Promise<HomeRead> {
  const { clock, athleteTimezone, tempoPort } = options;
  const status = await resolveLoopStatus(clock, athleteTimezone);
  const banner = await deriveBanner(status);
  const units = await resolveUnitPreference(tempoPort);

  const empty: HomeRead = {
    weekSessionId: status.week.weekSessionId,
    isoWeek: status.week.isoWeek,
    banner,
    today: null,
    week: [],
    totals: { actualDistanceM: 0, plannedDistanceM: 0 },
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
  const actualByDate = new Map<string, number>();
  let tempoUnavailable = false;
  try {
    const workouts = await listAllWorkoutsInWindow(tempoPort, {
      start: session.start,
      end: session.end,
    });
    for (const w of workouts) {
      const ymd = ymdInZone(w.startedAt, timezone);
      actualByDate.set(ymd, (actualByDate.get(ymd) ?? 0) + w.distanceM);
    }
  } catch {
    tempoUnavailable = true;
  }

  const week: HomeWeekDay[] = dates.map((date) => {
    const planned = planByDate.get(date) ?? null;
    const plannedDistanceM = planned?.run?.distanceM ?? null;
    const plannedRun = plannedDistanceM != null;
    const actual = tempoUnavailable ? null : (actualByDate.get(date) ?? 0);
    const isToday = date === todayYmd;

    let state: HomeDayState;
    if (actual != null && actual > 0) state = "done";
    else if (isToday) state = "today";
    else if (date < todayYmd) {
      if (!plannedRun) state = "rest";
      else state = actual == null ? "unknown" : "missed";
    }
    else state = plannedRun || !planned ? "upcoming" : "rest";

    return {
      date,
      dayType: planned?.dayType ?? null,
      plannedDistanceM,
      actualDistanceM: actual,
      state,
      isToday,
    };
  });

  return {
    ...empty,
    today: planByDate.get(todayYmd) ?? null,
    week,
    totals: {
      actualDistanceM: week.reduce((sum, d) => sum + (d.actualDistanceM ?? 0), 0),
      plannedDistanceM: week.reduce((sum, d) => sum + (d.plannedDistanceM ?? 0), 0),
    },
    tempoUnavailable,
  };
}
