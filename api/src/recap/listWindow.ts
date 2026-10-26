import type { TempoPort, TempoWorkoutSummary } from "../tempo/port.js";
import type { WeekWindow } from "./weekWindows.js";

/**
 * Keep only workouts whose `startedAt` instant is inside [start, end].
 * Tempo's startDate/endDate filters match by calendar date, not time, so a run
 * on a window's end DATE but after its end INSTANT leaks into that window
 * (e.g. next week's Monday run appearing in last week).
 */
export function workoutsStartedInWindow(
  items: readonly TempoWorkoutSummary[],
  window: WeekWindow,
): TempoWorkoutSummary[] {
  const lo = Date.parse(window.start);
  const hi = Date.parse(window.end);
  return items.filter((w) => {
    const t = Date.parse(w.startedAt);
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
}

/**
 * Page through TempoPort listWorkouts for an inclusive window, keeping only
 * workouts that started inside the window instants.
 */
export async function listAllWorkoutsInWindow(
  port: TempoPort,
  window: WeekWindow,
): Promise<TempoWorkoutSummary[]> {
  const pageSize = 100;
  let page = 1;
  const items: TempoWorkoutSummary[] = [];
  for (;;) {
    const result = await port.listWorkouts({
      startDate: window.start,
      endDate: window.end,
      page,
      pageSize,
      sortBy: "startedAt",
      sortOrder: "asc",
    });
    items.push(...result.items);
    if (page >= result.totalPages || result.items.length === 0) break;
    page += 1;
  }
  return workoutsStartedInWindow(items, window);
}
