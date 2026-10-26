/**
 * Recap-side loader: workout detail + per-second samples.
 *
 * Export mode already attaches `timeSeries` on getWorkout; the live port needs a
 * second call (`getWorkoutTimeSeries`). A failed or empty series never throws —
 * the detail carries `timeSeriesUnavailableReason` and the recap renders n/a.
 */
import type {
  TempoPort,
  TempoWorkoutDetail,
  TempoWorkoutSummary,
} from "../tempo/port.js";

/** Modest fan-out against Tempo (tempo-cli uses 4 as well). */
export const RECAP_WORKOUT_FETCH_CONCURRENCY = 4;

/** Short, secret-free reason for an n/a line. */
export function timeSeriesFailureReason(err: unknown): string {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return `HTTP ${status}`;
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code === "tempo_not_configured") return "Tempo not configured";
  }
  return "request failed";
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** tempo-cli RECAP_SIMILAR_ROUTES_MAX_RESULTS. */
export const RECAP_SIMILAR_ROUTES_MAX_RESULTS = 3;

export type RecapDetailLoadOptions = {
  /** Also fetch similar routes for runs with a route (run-by-run only). */
  includeSimilarRoutes?: boolean;
};

async function attachTimeSeries(
  port: TempoPort,
  detail: TempoWorkoutDetail,
): Promise<TempoWorkoutDetail> {
  if (detail.timeSeries && detail.timeSeries.length > 0) return detail;
  if (!port.getWorkoutTimeSeries) return detail;
  try {
    const points = await port.getWorkoutTimeSeries(detail.id);
    if (points.length > 0) {
      return { ...detail, timeSeries: points };
    }
    return { ...detail, timeSeriesUnavailableReason: "no samples returned" };
  } catch (err) {
    return {
      ...detail,
      timeSeriesUnavailableReason: timeSeriesFailureReason(err),
    };
  }
}

/** Best similar route for runs with a route; failures never throw. */
async function attachSimilarRoute(
  port: TempoPort,
  detail: TempoWorkoutDetail,
): Promise<TempoWorkoutDetail> {
  if (!detail.hasRoute || !port.getSimilarRoutes) return detail;
  try {
    const rows = await port.getSimilarRoutes(
      detail.id,
      RECAP_SIMILAR_ROUTES_MAX_RESULTS,
    );
    const first = rows[0];
    return first ? { ...detail, similarRoute: first } : detail;
  } catch (err) {
    return {
      ...detail,
      similarRouteUnavailableReason: timeSeriesFailureReason(err),
    };
  }
}

/** getWorkout + live time-series attach. Null when Tempo has no such workout. */
export async function loadRecapWorkoutDetail(
  port: TempoPort,
  id: string,
  options?: RecapDetailLoadOptions,
): Promise<TempoWorkoutDetail | null> {
  const detail = await port.getWorkout(id);
  if (!detail) return null;
  let out = await attachTimeSeries(port, detail);
  if (options?.includeSimilarRoutes) out = await attachSimilarRoute(port, out);
  return out;
}

/** Details for each summary (same order), nulls where Tempo returned 404. */
export async function loadRecapWorkoutDetails(
  port: TempoPort,
  summaries: readonly TempoWorkoutSummary[],
  options?: RecapDetailLoadOptions,
): Promise<Array<TempoWorkoutDetail | null>> {
  return mapPool(summaries, RECAP_WORKOUT_FETCH_CONCURRENCY, (s) =>
    loadRecapWorkoutDetail(port, s.id, options),
  );
}
