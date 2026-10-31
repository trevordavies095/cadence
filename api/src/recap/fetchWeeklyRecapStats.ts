import type { TempoPort, TempoWeeklyRecapStats } from "../tempo/port.js";
import type { WeekSession } from "../week/store.js";
import { weeklyRecapQueryForWeek } from "./weeklyRecapParams.js";

/**
 * Tempo weekly-recap stats for a week session, or null when the port has none
 * (export mode) or the call fails. Never throws: every reader falls back.
 */
export async function fetchWeeklyRecapStats(
  port: TempoPort,
  session: WeekSession,
): Promise<TempoWeeklyRecapStats | null> {
  if (typeof port.getWeeklyRecapStats !== "function") return null;
  try {
    return await port.getWeeklyRecapStats(
      weeklyRecapQueryForWeek(session.start, session.timezone),
    );
  } catch {
    // 404 / HTTP / transport / bad JSON: readers fall back.
    return null;
  }
}

/**
 * Stats handed from a report builder to its sections so the report makes one
 * weekly-recap call. Pass the promise so sections keep running in parallel.
 */
export type SharedWeeklyRecapStats = Promise<TempoWeeklyRecapStats | null>;
