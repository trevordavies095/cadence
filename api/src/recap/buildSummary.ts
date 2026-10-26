import { listAllWorkoutsInWindow } from "./listWindow.js";
import type {
  TempoPort,
  TempoUnitPreference,
  TempoWeeklyRecapStats,
} from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import { aggregateWorkouts, type WeekAggregate } from "./aggregate.js";
import {
  buildSummaryComparison,
  buildSummaryComparisonFromStats,
  type SummaryComparison,
} from "./compare.js";
import {
  buildSummaryMarkdown,
  buildSummaryTableRows,
  type RecapSummaryTableRow,
} from "./format.js";
import { weeklyRecapQueryForWeek } from "./weeklyRecapParams.js";
import { priorWeekWindows, type WeekWindow } from "./weekWindows.js";

export type RecapSummaryResult = {
  weekSessionId: string;
  isoWeek: string;
  timezone: string;
  range: { start: string; end: string };
  unit: TempoUnitPreference;
  thisWeek: WeekAggregate;
  comparison: SummaryComparison;
  /** Where prev / 3-wk columns came from: Tempo stats or the week windows. */
  comparisonSource: "weekly-recap" | "windows";
  rows: RecapSummaryTableRow[];
  markdown: string;
};

type PortWithOptionalSettings = TempoPort & {
  getExportSettings?: () => Promise<unknown>;
};

/**
 * Resolve display units without requiring unfinished TempoPort settings methods.
 * Prefer getSettings when present; else export settings; else metric.
 */
export async function resolveRecapUnit(
  port: TempoPort,
): Promise<TempoUnitPreference> {
  const p = port as PortWithOptionalSettings;
  if (typeof p.getSettings === "function") {
    try {
      const settings = await p.getSettings();
      if (
        settings?.unitPreference === "imperial" ||
        settings?.unitPreference === "metric"
      ) {
        return settings.unitPreference;
      }
    } catch {
      // fall through
    }
  }
  if (typeof p.getExportSettings === "function") {
    try {
      const raw = await p.getExportSettings();
      if (raw && typeof raw === "object" && "unitPreference" in raw) {
        const u = (raw as { unitPreference: unknown }).unitPreference;
        if (u === "imperial" || u === "metric") return u;
      }
    } catch {
      // fall through
    }
  }
  return "metric";
}

async function fetchWeeklyRecapStats(
  port: TempoPort,
  session: WeekSession,
): Promise<TempoWeeklyRecapStats | null> {
  if (typeof port.getWeeklyRecapStats !== "function") return null;
  try {
    return await port.getWeeklyRecapStats(
      weeklyRecapQueryForWeek(session.start, session.timezone),
    );
  } catch {
    // 404 / HTTP / transport / bad JSON: fall back to the week windows.
    return null;
  }
}

/** Build Summary section for a persisted week session via TempoPort. */
export async function buildRecapSummary(args: {
  session: WeekSession;
  tempoPort: TempoPort;
  unit?: TempoUnitPreference;
}): Promise<RecapSummaryResult> {
  const { session, tempoPort } = args;
  const unit = args.unit ?? (await resolveRecapUnit(tempoPort));
  const thisWindow: WeekWindow = { start: session.start, end: session.end };
  const { prev, trailing } = priorWeekWindows(thisWindow);

  // Prev / 3-wk columns: Tempo GET /stats/weekly-recap when the port offers it
  // and it answers; otherwise computed from the (instant-filtered) windows.
  const statsPromise = fetchWeeklyRecapStats(tempoPort, session);
  const [thisItems, stats] = await Promise.all([
    listAllWorkoutsInWindow(tempoPort, thisWindow),
    statsPromise,
  ]);
  const thisWeek = aggregateWorkouts(thisItems);

  let comparison: SummaryComparison;
  let comparisonSource: "weekly-recap" | "windows";
  if (stats) {
    comparison = buildSummaryComparisonFromStats({ thisWeek, stats });
    comparisonSource = "weekly-recap";
  } else {
    const [prevItems, ...trailingItemSets] = await Promise.all([
      listAllWorkoutsInWindow(tempoPort, prev),
      ...trailing.map((w) => listAllWorkoutsInWindow(tempoPort, w)),
    ]);
    comparison = buildSummaryComparison({
      thisWeek,
      prevWeek: aggregateWorkouts(prevItems),
      trailingWeeks: trailingItemSets.map((items) => aggregateWorkouts(items)),
    });
    comparisonSource = "windows";
  }
  const rows = buildSummaryTableRows({ thisWeek, comparison, unit });
  const markdown = buildSummaryMarkdown(rows);

  return {
    weekSessionId: session.id,
    isoWeek: session.isoWeek,
    timezone: session.timezone,
    range: { start: session.start, end: session.end },
    unit,
    thisWeek,
    comparison,
    comparisonSource,
    rows,
    markdown,
  };
}
