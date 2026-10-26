import { SecretProtector } from "../crypto/secretProtector.js";
import { readTempoApiKey } from "../settings/tempoStore.js";
import {
  parseBestEfforts,
  parseHeartRateZonesLive,
  parseShoesList,
  parseUnitPreference,
} from "./mapAthlete.js";
import {
  isValidWorkoutId,
  TempoHttpError,
  TempoNotConfiguredError,
  TempoTransportError,
  type ListShoesQuery,
  type ListWorkoutsQuery,
  type ListWorkoutsResult,
  type TempoAthleteSettings,
  type TempoBestEfforts,
  type TempoPort,
  type TempoTimeSeriesPoint,
  type TempoShoe,
  type TempoSimilarRoute,
  type TempoWeeklyRecapStats,
  type TempoWorkoutDetail,
  type WeeklyRecapStatsQuery,
} from "./port.js";
import { parseWeeklyRecapStats } from "./weeklyRecapStats.js";
import {
  assertNoGpsFields,
  mapSimilarRoute,
  mapTimeSeriesPoint,
  sanitizeWorkoutDetail,
  sanitizeWorkoutSummary,
  similarRouteRows,
} from "./sanitize.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const WORKOUTS_PATH = "/workouts";
const UNIT_PREFERENCE_PATH = "/settings/unit-preference";
const HEART_RATE_ZONES_PATH = "/settings/heart-rate-zones";
const DEFAULT_SHOE_PATH = "/settings/default-shoe";
const SHOES_PATH = "/shoes";
const BEST_EFFORTS_PATH = "/stats/best-efforts";
const WEEKLY_RECAP_PATH = "/stats/weekly-recap";
/** Matches tempo-cli: API default page size, with a hard page cap. */
const TIME_SERIES_PAGE_SIZE = 1000;
const TIME_SERIES_MAX_PAGES = 500;
/** Share one fetch across recap sections built in the same request burst. */
const TIME_SERIES_CACHE_TTL_MS = 30_000;

export { isValidWorkoutId };

export type LiveTempoPortOptions = {
  /** Override wrapping key (tests). Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
  /** Injected fetch for tests (fake Tempo HTTP). */
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Override credential loader (defaults to decrypting tempo_connection). */
  readCredentials?: () => Promise<{ baseUrl: string; apiKey: string } | null>;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function buildListPath(query: ListWorkoutsQuery = {}): string {
  const q = new URLSearchParams();
  if (query.page !== undefined) q.set("page", String(query.page));
  if (query.pageSize !== undefined) q.set("pageSize", String(query.pageSize));
  if (query.startDate !== undefined) q.set("startDate", query.startDate);
  if (query.endDate !== undefined) q.set("endDate", query.endDate);
  if (query.minDistanceM !== undefined) {
    q.set("minDistanceM", String(query.minDistanceM));
  }
  if (query.maxDistanceM !== undefined) {
    q.set("maxDistanceM", String(query.maxDistanceM));
  }
  if (query.keyword !== undefined) q.set("keyword", query.keyword);
  if (query.runType !== undefined) q.set("runType", query.runType);
  if (query.sortBy !== undefined) q.set("sortBy", query.sortBy);
  if (query.sortOrder !== undefined) q.set("sortOrder", query.sortOrder);
  const qs = q.toString();
  return qs ? `${WORKOUTS_PATH}?${qs}` : WORKOUTS_PATH;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    return Number.parseInt(v.trim(), 10);
  }
  return fallback;
}

export function createLiveTempoPort(options?: LiveTempoPortOptions): TempoPort {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readCredentials =
    options?.readCredentials ??
    (() => {
      const protector = new SecretProtector(options?.dataProtectionKey);
      return readTempoApiKey(protector);
    });

  async function authorizedGet(path: string): Promise<Response> {
    const creds = await readCredentials();
    if (!creds) {
      throw new TempoNotConfiguredError();
    }
    const url = `${normalizeBaseUrl(creds.baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers({
      Authorization: `Bearer ${creds.apiKey}`,
      Accept: "application/json",
    });
    try {
      return await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        credentials: "omit",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "tempo_fetch_failed";
      throw new TempoTransportError(message, { cause: err });
    }
  }

  async function getJson(path: string): Promise<unknown> {
    const response = await authorizedGet(path);
    const text = await response.text();
    if (!response.ok) {
      throw new TempoHttpError(response.status, `GET ${path} returned ${response.status}`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new TempoHttpError(502, `tempo_invalid_json:${path}`);
    }
  }

  const timeSeriesCache = new Map<
    string,
    { at: number; promise: Promise<TempoTimeSeriesPoint[]> }
  >();

  async function fetchTimeSeriesAllPages(
    id: string,
  ): Promise<TempoTimeSeriesPoint[]> {
    const byElapsed = new Map<number, TempoTimeSeriesPoint>();
    const noElapsed: TempoTimeSeriesPoint[] = [];
    for (let page = 1; page <= TIME_SERIES_MAX_PAGES; page++) {
      const path = `${WORKOUTS_PATH}/${encodeURIComponent(id)}/time-series?page=${page}&pageSize=${TIME_SERIES_PAGE_SIZE}`;
      const response = await authorizedGet(path);
      if (response.status === 404) break; // first page 404 => no series
      const text = await response.text();
      if (!response.ok) {
        throw new TempoHttpError(
          response.status,
          `GET ${path} returned ${response.status}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new TempoHttpError(502, "tempo_time_series_invalid_json");
      }
      const rows = Array.isArray(parsed)
        ? parsed
        : isPlainObject(parsed)
          ? (parsed.items ?? parsed.data)
          : undefined;
      if (!Array.isArray(rows)) {
        throw new TempoHttpError(502, "tempo_time_series_unexpected_shape");
      }
      for (const row of rows) {
        // Whitelist mapper: GPS / route keys are dropped here.
        const point = mapTimeSeriesPoint(row);
        if (typeof point.elapsedSeconds === "number") {
          byElapsed.set(Math.max(0, Math.floor(point.elapsedSeconds)), point);
        } else {
          noElapsed.push(point);
        }
      }
      if (rows.length < TIME_SERIES_PAGE_SIZE) break;
    }
    const points = [
      ...[...byElapsed.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
      ...noElapsed,
    ];
    assertNoGpsFields(points);
    return points;
  }

  return {
    async getWeeklyRecapStats(
      query: WeeklyRecapStatsQuery,
    ): Promise<TempoWeeklyRecapStats | null> {
      const q = new URLSearchParams();
      q.set("timezoneOffsetMinutes", String(query.timezoneOffsetMinutes));
      q.set("referenceDate", query.referenceDate);
      const parsed = await getJson(`${WEEKLY_RECAP_PATH}?${q.toString()}`);
      return parseWeeklyRecapStats(parsed) ?? null;
    },

    async getSimilarRoutes(
      id: string,
      maxResults = 3,
    ): Promise<TempoSimilarRoute[]> {
      const trimmed = id.trim();
      if (!isValidWorkoutId(trimmed)) {
        throw new TempoHttpError(400, "invalid_workout_id");
      }
      const path = `${WORKOUTS_PATH}/${encodeURIComponent(trimmed)}/similar-routes?maxResults=${maxResults}`;
      const parsed = await getJson(path);
      const rows: TempoSimilarRoute[] = [];
      for (const raw of similarRouteRows(parsed)) {
        const row = mapSimilarRoute(raw);
        if (row) rows.push(row);
      }
      assertNoGpsFields(rows);
      return rows;
    },

    async getWorkoutTimeSeries(id: string): Promise<TempoTimeSeriesPoint[]> {
      const trimmed = id.trim();
      if (!isValidWorkoutId(trimmed)) {
        throw new TempoHttpError(400, "invalid_workout_id");
      }
      const now = Date.now();
      const hit = timeSeriesCache.get(trimmed);
      if (hit && now - hit.at < TIME_SERIES_CACHE_TTL_MS) return hit.promise;
      const promise = fetchTimeSeriesAllPages(trimmed);
      timeSeriesCache.set(trimmed, { at: now, promise });
      promise.catch(() => {
        if (timeSeriesCache.get(trimmed)?.promise === promise) {
          timeSeriesCache.delete(trimmed);
        }
      });
      return promise;
    },

    async listWorkouts(query: ListWorkoutsQuery = {}): Promise<ListWorkoutsResult> {
      const response = await authorizedGet(buildListPath(query));
      const text = await response.text();
      if (!response.ok) {
        throw new TempoHttpError(
          response.status,
          `GET ${WORKOUTS_PATH} returned ${response.status}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new TempoHttpError(502, "tempo_workouts_list_invalid_json");
      }
      if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) {
        throw new TempoHttpError(502, "tempo_workouts_list_unexpected_shape");
      }
      return {
        items: parsed.items.map(sanitizeWorkoutSummary),
        page: asInt(parsed.page, query.page ?? 1),
        pageSize: asInt(parsed.pageSize, query.pageSize ?? 20),
        totalCount: asInt(parsed.totalCount, parsed.items.length),
        totalPages: asInt(parsed.totalPages, 1),
      };
    },

    async getWorkout(id: string): Promise<TempoWorkoutDetail | null> {
      const trimmed = id.trim();
      if (!isValidWorkoutId(trimmed)) {
        throw new TempoHttpError(400, "invalid_workout_id");
      }
      const path = `${WORKOUTS_PATH}/${encodeURIComponent(trimmed)}`;
      const response = await authorizedGet(path);
      if (response.status === 404) {
        return null;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new TempoHttpError(
          response.status,
          `GET ${path} returned ${response.status}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new TempoHttpError(502, "tempo_workout_invalid_json");
      }
      return sanitizeWorkoutDetail(parsed);
    },

    async getSettings(): Promise<TempoAthleteSettings> {
      const [unitRaw, zonesRaw, shoeRaw] = await Promise.all([
        getJson(UNIT_PREFERENCE_PATH),
        getJson(HEART_RATE_ZONES_PATH),
        getJson(DEFAULT_SHOE_PATH),
      ]);
      const unitPreference = parseUnitPreference(unitRaw);
      const heartRateZones = parseHeartRateZonesLive(zonesRaw);
      const settings: TempoAthleteSettings = {
        unitPreference,
        heartRateZones,
      };
      if (isPlainObject(shoeRaw) && "defaultShoeId" in shoeRaw) {
        const id = shoeRaw.defaultShoeId;
        settings.defaultShoeId =
          id === null || id === undefined
            ? null
            : typeof id === "string"
              ? id
              : String(id);
      }
      return settings;
    },

    async listShoes(query: ListShoesQuery = {}): Promise<TempoShoe[]> {
      const status = query.status ?? "active";
      const path = `${SHOES_PATH}?status=${encodeURIComponent(status)}`;
      const parsed = await getJson(path);
      return parseShoesList(parsed);
    },

    async getBestEfforts(): Promise<TempoBestEfforts> {
      const parsed = await getJson(BEST_EFFORTS_PATH);
      return parseBestEfforts(parsed);
    },
  };
}
