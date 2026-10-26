/**
 * Domain seam for Tempo athlete training reads.
 * Domain / route code must call this port — never Tempo HTTP or DB directly.
 */

/** Query for listing workouts (Tempo OpenAPI names). */
export type ListWorkoutsQuery = {
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  minDistanceM?: number;
  maxDistanceM?: number;
  keyword?: string;
  runType?: string;
  sortBy?: string;
  sortOrder?: string;
};

/** Coach-facing workout summary — no GPS / route geometry. */
export type TempoWorkoutSummary = {
  id: string;
  startedAt: string;
  durationS: number;
  distanceM: number;
  avgPaceS: number;
  elevGainM?: number | null;
  elevLossM?: number | null;
  movingTimeS?: number | null;
  timerTimeS?: number | null;
  maxHeartRateBpm?: number | null;
  avgHeartRateBpm?: number | null;
  minHeartRateBpm?: number | null;
  /** One-foot cadence RPM (steps per minute = 2x); Tempo summary field. */
  avgCadenceRpm?: number | null;
  relativeEffort?: number | null;
  rpe?: number | null;
  runType?: string | null;
  name?: string | null;
  notes?: string | null;
  source?: string | null;
  device?: string | null;
  shoeId?: string | null;
  /** Whether Tempo has a route; geometry is never exposed via this port. */
  hasRoute?: boolean;
  splitsCount?: number;
};

export type TempoWorkoutSplit = {
  idx?: number;
  kind?: string | null;
  distanceM?: number | null;
  durationS?: number | null;
  paceS?: number | null;
  avgHeartRateBpm?: number | null;
  startElapsedS?: number | null;
  endElapsedS?: number | null;
  startDistanceM?: number | null;
};

/** Sparse time-series sample for recap HR analytics (no GPS). */
export type TempoTimeSeriesPoint = {
  elapsedSeconds?: number | null;
  heartRateBpm?: number | null;
  distanceM?: number | null;
  cadenceRpm?: number | null;
  speedMps?: number | null;
  elevationM?: number | null;
  powerWatts?: number | null;
};

/** Coach-facing workout detail — splits included; GPS / raw blobs stripped. */
export type TempoWorkoutDetail = TempoWorkoutSummary & {
  splits: TempoWorkoutSplit[];
  /** Present when the backing store has samples (export / some live payloads). */
  timeSeries?: TempoTimeSeriesPoint[];
  /**
   * Set by the recap loader when a time-series fetch failed or returned no
   * samples; short, secret-free reason (e.g. "HTTP 500").
   */
  timeSeriesUnavailableReason?: string;
  /**
   * Set by the recap loader (run-by-run only) with the best similar-route row
   * (route-less, whitelisted fields).
   */
  similarRoute?: TempoSimilarRoute;
  /** Set when the similar-routes request failed; short, secret-free reason. */
  similarRouteUnavailableReason?: string;
  weather?: unknown;
  heartRateZoneTimes?: unknown;
  shoe?: unknown;
};

/**
 * One past effort on a similar route (GET /workouts/{id}/similar-routes row,
 * wrapper + nested workout flattened). Whitelisted — no GPS / route geometry.
 */
export type TempoSimilarRoute = {
  startedAt?: string;
  distanceM?: number;
  name?: string;
  runType?: string;
  avgPaceS?: number;
  avgHeartRateBpm?: number;
  /** API-supplied pace delta (sec/km; positive = current faster). */
  paceDifferenceSecondsPerKm?: number;
  /** API-supplied avg HR delta (bpm; shown verbatim). */
  heartRateDifferenceBpm?: number;
};

export type ListWorkoutsResult = {
  items: TempoWorkoutSummary[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

/** Athlete distance/pace display preference from Tempo. */
export type TempoUnitPreference = "metric" | "imperial";

export type TempoHeartRateZone = {
  zoneNumber: number;
  minBpm: number;
  maxBpm: number;
};

/** Coach-facing HR zones (live OpenAPI shape + export-normalized). */
export type TempoHeartRateZones = {
  calculationMethod: string;
  age?: number | null;
  restingHeartRateBpm?: number | null;
  maxHeartRateBpm?: number | null;
  zones: TempoHeartRateZone[];
};

/**
 * Settings + zones for onboarding prefills / recap.
 * Unit preference is always present (defaults to metric when unset).
 */
export type TempoAthleteSettings = {
  unitPreference: TempoUnitPreference;
  defaultShoeId?: string | null;
  heartRateZones: TempoHeartRateZones;
};

export type ListShoesQuery = {
  /** Tempo default is active when omitted. */
  status?: "active" | "retired" | "all";
};

/** Coach-facing shoe row — nested workout join data stripped. */
export type TempoShoe = {
  id: string;
  brand: string;
  model: string;
  isRetired: boolean;
  initialMileageM?: number | null;
  totalMileage?: number | null;
  unit?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type TempoBestEffort = {
  distance: string;
  distanceM: number;
  timeS: number;
  workoutId: string;
  workoutDate: string;
};

/** Body of Tempo GET /stats/best-efforts (export array normalized to same shape). */
export type TempoBestEfforts = {
  distances: TempoBestEffort[];
};

/** One metric of GET /stats/weekly-recap: current week, previous week, 3-week trailing mean. */
export type TempoWeeklyRecapMetric = {
  current?: number;
  previous?: number;
  trailingAvg?: number;
};

/** Parsed `metrics` of GET /stats/weekly-recap (distance m, duration s, elevation m). */
export type TempoWeeklyRecapStats = {
  runs?: TempoWeeklyRecapMetric;
  distanceM?: TempoWeeklyRecapMetric;
  durationS?: TempoWeeklyRecapMetric;
  elevationGainM?: TempoWeeklyRecapMetric;
  relativeEffortSum?: TempoWeeklyRecapMetric;
  easyRunAvgHeartRateBpm?: TempoWeeklyRecapMetric;
};

/** Query for GET /stats/weekly-recap (tempo-cli params). */
export type WeeklyRecapStatsQuery = {
  /** Local Monday yyyy-MM-dd selecting the "current" week. */
  referenceDate: string;
  /** Offset minutes east of UTC at Monday 00:00 local (negative behind UTC). */
  timezoneOffsetMinutes: number;
};

export type TempoPort = {
  listWorkouts(query?: ListWorkoutsQuery): Promise<ListWorkoutsResult>;
  /** Returns null when Tempo responds 404. */
  getWorkout(id: string): Promise<TempoWorkoutDetail | null>;
  /** Unit preference, HR zones, and default shoe id. */
  getSettings(): Promise<TempoAthleteSettings>;
  listShoes(query?: ListShoesQuery): Promise<TempoShoe[]>;
  getBestEfforts(): Promise<TempoBestEfforts>;
  /**
   * Sparse per-sample series (no GPS) for one workout. Live port only; export
   * mode attaches `timeSeries` on getWorkout instead. Returns [] on 404 and
   * throws Tempo*Error on other failures — recap callers must catch.
   */
  getWorkoutTimeSeries?(id: string): Promise<TempoTimeSeriesPoint[]>;
  /**
   * Tempo weekly-recap stats (prev week / 3-wk trailing avg). Live port only;
   * export mode leaves it undefined. Returns null when the response has no
   * usable metrics; throws Tempo*Error on HTTP / transport failures — recap
   * callers must catch and fall back to computing from workout windows.
   */
  getWeeklyRecapStats?(
    query: WeeklyRecapStatsQuery,
  ): Promise<TempoWeeklyRecapStats | null>;
  /**
   * Past efforts on similar routes (best first). Live port only; export mode
   * leaves it undefined. Returns [] when there are none; throws Tempo*Error on
   * failures (including 404) — recap callers must catch.
   */
  getSimilarRoutes?(id: string, maxResults?: number): Promise<TempoSimilarRoute[]>;
};

export class TempoNotConfiguredError extends Error {
  readonly code = "tempo_not_configured" as const;

  constructor(message = "Tempo base URL and API key are not configured") {
    super(message);
    this.name = "TempoNotConfiguredError";
  }
}

export class TempoHttpError extends Error {
  readonly code = "tempo_http_error" as const;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TempoHttpError";
  }
}

export class TempoTransportError extends Error {
  readonly code = "tempo_transport_error" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TempoTransportError";
  }
}

export class TempoExportError extends Error {
  readonly code = "tempo_export_error" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TempoExportError";
  }
}

const UUID_RE =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export function isValidWorkoutId(id: string): boolean {
  return UUID_RE.test(id.trim());
}
