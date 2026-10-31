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
  /**
   * Device-lap intensity, snake_case (active, rest, warmup, cooldown,
   * recovery, interval, other). Null for distance splits and for sources
   * without it (HealthKit, Strava CSV, GPX).
   */
  intensity?: string | null;
  /** Device-lap trigger, snake_case (manual, time, distance, session_end, …). */
  trigger?: string | null;
  /** Structured-workout step this lap belongs to. */
  stepIndex?: number | null;
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
  /**
   * Highest workout max HR in the last 12 months (readings above 230 ignored);
   * null without HR data. Informational: never feeds the resolved max.
   */
  observedMaxHeartRateBpm?: number | null;
  zones: TempoHeartRateZone[];
};

/** The best effort Tempo derived the suggested threshold pace from. */
export type TempoThresholdSuggestionSource = {
  /** Best-effort distance label: "5K" or "10K". */
  distance: string;
  timeS: number;
  /** UTC date the workout started (yyyy-MM-dd). */
  workoutDate: string;
  workoutId: string;
};

/** Tempo GET /settings/thresholds. Paces are seconds per km. */
export type TempoThresholds = {
  /** Athlete-set threshold pace, or null when not set. */
  thresholdPaceS: number | null;
  /** Athlete-set threshold heart rate, or null when not set. */
  thresholdHeartRateBpm: number | null;
  /** Daniels VDOT from the best 5K/10K in the last 90 days; null when none qualifies. */
  suggestedThresholdPaceS: number | null;
  suggestedFrom: TempoThresholdSuggestionSource | null;
};

/**
 * Settings + zones for onboarding prefills / recap.
 * Unit preference is always present (defaults to metric when unset).
 */
export type TempoAthleteSettings = {
  unitPreference: TempoUnitPreference;
  defaultShoeId?: string | null;
  heartRateZones: TempoHeartRateZones;
  /**
   * Threshold pace and heart rate from the running log. Undefined in export
   * mode and against an older Tempo without the endpoint.
   */
  thresholds?: TempoThresholds;
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
  /**
   * With `since`: the best before that date, null for a first effort at the
   * distance. Always null without `since`.
   */
  previousTimeS?: number | null;
};

/** Body of Tempo GET /stats/best-efforts (export array normalized to same shape). */
export type TempoBestEfforts = {
  distances: TempoBestEffort[];
};

/** Query for GET /stats/best-efforts. */
export type BestEffortsQuery = {
  /**
   * yyyy-MM-dd (Tempo compares it with the workout's UTC start date): return
   * only the distances whose best was set on or after it, with previousTimeS.
   */
  since?: string;
};

/**
 * One metric of GET /stats/weekly-recap: current week, previous week, 3-week
 * trailing mean, and current − previous. A field Tempo sends as null (or
 * omits) is absent here; a block with no numbers at all is absent on the stats.
 */
export type TempoWeeklyRecapMetric = {
  current?: number;
  previous?: number;
  trailingAvg?: number;
  deltaVsPrevious?: number;
};

/**
 * Parsed `metrics` of GET /stats/weekly-recap (distance m, duration s,
 * elevation m). Field names mirror Tempo's wire names.
 */
export type TempoWeeklyRecapStats = {
  runs?: TempoWeeklyRecapMetric;
  distanceM?: TempoWeeklyRecapMetric;
  /** Elapsed time summed per run. */
  durationS?: TempoWeeklyRecapMetric;
  elevationGainM?: TempoWeeklyRecapMetric;
  relativeEffortSum?: TempoWeeklyRecapMetric;
  /** Null-bucket weeks (no Easy Run / Recovery) leave `current` etc. absent. */
  easyRunAvgHeartRateBpm?: TempoWeeklyRecapMetric;
  /** Moving time summed per run, falling back to elapsed when a run has none. */
  movingTimeS?: TempoWeeklyRecapMetric;
  /** Longest single run by distance; 0 for a week with no runs. */
  longestRunDistanceM?: TempoWeeklyRecapMetric;
  /** Longest single run by moving (else elapsed) time; may be a different run. */
  longestRunDurationS?: TempoWeeklyRecapMetric;
  /**
   * Current week only: run counts keyed by exact run type (zero counts
   * omitted, untyped runs under `Unspecified`). `{}` for a week with no runs.
   */
  runsByType?: Record<string, number>;
  /**
   * Seconds in HR zone 1..5, summed from each run's stored zone seconds (the
   * values the log shows on a workout). Null buckets — a week with no HR
   * series — leave the field absent, so `current` absent means "unknown".
   */
  zoneSecondsZ1?: TempoWeeklyRecapMetric;
  zoneSecondsZ2?: TempoWeeklyRecapMetric;
  zoneSecondsZ3?: TempoWeeklyRecapMetric;
  zoneSecondsZ4?: TempoWeeklyRecapMetric;
  zoneSecondsZ5?: TempoWeeklyRecapMetric;
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
  /** Unit preference, HR zones, default shoe id and thresholds. */
  getSettings(): Promise<TempoAthleteSettings>;
  listShoes(query?: ListShoesQuery): Promise<TempoShoe[]>;
  /**
   * All-time bests per distance, or with `since` only the new bests set on
   * or after that date. Export mode has no history and returns none for a
   * `since` call.
   */
  getBestEfforts(query?: BestEffortsQuery): Promise<TempoBestEfforts>;
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
