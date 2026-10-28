import { formatWeekRangeShort } from "../clock/weekRangeShort.js";
import { getPrescribedWeekBySessionId } from "../prescribed/store.js";
import { listAllWorkoutsInWindow } from "../recap/listWindow.js";
import type { TempoPort } from "../tempo/port.js";
import type { WeekSession } from "./store.js";

/** A week as History shows it: the session plus what happened and what the coach said. */
export type WeekSummary = WeekSession & {
  /** "Oct 19 – 25"; never an ISO label. */
  localRange: string;
  /** Distance Tempo recorded in the week; null when Tempo could not be read. */
  actualDistanceM: number | null;
  runCount: number | null;
  /**
   * The opening of what the coach wrote with this week's plan, or null when the week has none.
   * It is about this week's plan, not a review of the week before.
   */
  coachHeadline: string | null;
};

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
function ymdInZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** Markdown to plain text for a single line of prose. */
function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First paragraph of the coach's analysis as plain text. Heading lines are
 * skipped, and a leading "Headline:" label (the coach's own section tag) is dropped.
 */
export function headlineFromAnalysis(analysis: string): string | null {
  for (const paragraph of analysis.split(/\n\s*\n/)) {
    const lines = paragraph
      .split("\n")
      .filter((line) => line.trim() !== "" && !/^\s*#{1,6}\s/.test(line));
    if (lines.length === 0) continue;
    const text = plainText(lines.join(" ")).replace(/^headline\s*:\s*/i, "");
    if (text) return text;
  }
  return null;
}

/**
 * Summaries for every week, in the order given. One Tempo read covers all of
 * them; a Tempo failure leaves distance and run count null.
 */
export async function composeWeekSummaries(
  sessions: WeekSession[],
  tempoPort: TempoPort,
): Promise<{ weeks: WeekSummary[]; tempoUnavailable: boolean }> {
  let workouts: Awaited<ReturnType<typeof listAllWorkoutsInWindow>> | null = null;
  if (sessions.length > 0) {
    const starts = sessions.map((s) => Date.parse(s.start));
    const ends = sessions.map((s) => Date.parse(s.end));
    try {
      workouts = await listAllWorkoutsInWindow(tempoPort, {
        start: new Date(Math.min(...starts)).toISOString(),
        end: new Date(Math.max(...ends)).toISOString(),
      });
    } catch {
      workouts = null;
    }
  }

  const weeks: WeekSummary[] = [];
  for (const session of sessions) {
    const lo = Date.parse(session.start);
    const hi = Date.parse(session.end);
    const inWeek = workouts?.filter((w) => {
      const t = Date.parse(w.startedAt);
      return t >= lo && t <= hi;
    });

    // The coach writes its analysis together with a week's plan and stores both on that week.
    // The analysis opens with the plan ("Week 1 of the build…") and then reviews the week
    // before, so its first paragraph belongs to the week the plan is for.
    let coachHeadline: string | null = null;
    try {
      const plan = await getPrescribedWeekBySessionId(session.id);
      coachHeadline = plan
        ? (plan.readSections?.headline ?? headlineFromAnalysis(plan.analysis))
        : null;
    } catch {
      coachHeadline = null;
    }

    weeks.push({
      ...session,
      localRange: formatWeekRangeShort(
        ymdInZone(session.start, session.timezone),
        ymdInZone(session.end, session.timezone),
      ),
      actualDistanceM: inWeek ? inWeek.reduce((n, w) => n + w.distanceM, 0) : null,
      runCount: inWeek ? inWeek.length : null,
      coachHeadline,
    });
  }
  return { weeks, tempoUnavailable: workouts === null && sessions.length > 0 };
}
