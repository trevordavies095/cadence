import type { PrescribedDay, PrescribedWeek } from "../../llm/types.js";
import type { TempoWorkoutDetail } from "../../tempo/port.js";
import { workoutLocalDate } from "../subjectiveRuns.js";

/** Normalize ISO week id for comparison (e.g. 2026-W9 → 2026-W09). */
export function normalizeIsoWeekId(raw: string): string {
  const m = /^(\d{4})-W(\d{1,2})$/i.exec(raw.trim());
  if (!m) return raw.trim();
  const w = String(Number.parseInt(m[2]!, 10)).padStart(2, "0");
  return `${m[1]}-W${w}`;
}

/** Quality / race days with a planned run. */
export function prescribedQualityDays(plan: PrescribedWeek): PrescribedDay[] {
  return plan.days.filter(
    (d) =>
      (d.dayType === "quality" || d.dayType === "race") &&
      d.run != null &&
      Number.isFinite(d.run.distanceM) &&
      d.run.distanceM > 0,
  );
}

/** First long day with a planned run, if any. */
export function prescribedLongDay(plan: PrescribedWeek): PrescribedDay | null {
  const day = plan.days.find(
    (d) =>
      d.dayType === "long" &&
      d.run != null &&
      Number.isFinite(d.run.distanceM) &&
      d.run.distanceM > 0,
  );
  return day ?? null;
}

/** Workout / Race style runs preferred for quality matching (tempo-cli shape). */
export function isQualitySessionRunType(runType: unknown): boolean {
  if (typeof runType !== "string") return false;
  const t = runType.trim().toLowerCase();
  return (
    t === "workout" ||
    t === "race" ||
    /\brace\b/.test(t) ||
    /\bworkout\b/.test(t) ||
    t.includes("quality") ||
    t.includes("tempo") ||
    t.includes("interval") ||
    t.includes("threshold")
  );
}

export function isLongRunType(runType: unknown): boolean {
  return typeof runType === "string" && runType.toLowerCase().includes("long");
}

/**
 * Pick the best workout on a local calendar date.
 * Prefer quality-typed runs when `preferQuality`; prefer long-typed when `preferLong`.
 */
export function matchWorkoutOnDate(args: {
  workouts: readonly TempoWorkoutDetail[];
  dateYmd: string;
  timeZoneId: string;
  preferQuality?: boolean;
  preferLong?: boolean;
}): TempoWorkoutDetail | undefined {
  const onDate: TempoWorkoutDetail[] = [];
  for (const w of args.workouts) {
    const local = workoutLocalDate(w.startedAt, args.timeZoneId);
    if (local === args.dateYmd) onDate.push(w);
  }
  if (onDate.length === 0) return undefined;

  if (args.preferQuality) {
    const typed = onDate.filter((w) => isQualitySessionRunType(w.runType));
    if (typed.length > 0) {
      typed.sort((a, b) => b.distanceM - a.distanceM || a.id.localeCompare(b.id));
      return typed[0];
    }
  }
  if (args.preferLong) {
    const typed = onDate.filter((w) => isLongRunType(w.runType));
    if (typed.length > 0) {
      typed.sort((a, b) => b.distanceM - a.distanceM || a.id.localeCompare(b.id));
      return typed[0];
    }
  }

  onDate.sort((a, b) => b.distanceM - a.distanceM || a.id.localeCompare(b.id));
  return onDate[0];
}

/** Distance completion ratio; undefined when planned distance is invalid. */
export function distanceRatio(
  actualM: number,
  prescribedM: number,
): number | undefined {
  if (!Number.isFinite(prescribedM) || prescribedM <= 0) return undefined;
  if (!Number.isFinite(actualM) || actualM < 0) return undefined;
  return actualM / prescribedM;
}
