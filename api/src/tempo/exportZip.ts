import { open as yauzlOpen, type Entry, type ZipFile } from "yauzl";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { ignore } from "stream-json/filters/ignore.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import {
  parseAthleteSettingsFromExport,
  parseBestEfforts,
  parseShoesList,
} from "./mapAthlete.js";
import {
  isValidWorkoutId,
  TempoExportError,
  TempoHttpError,
  type ListShoesQuery,
  type ListWorkoutsQuery,
  type ListWorkoutsResult,
  type TempoAthleteSettings,
  type BestEffortsQuery,
  type TempoBestEfforts,
  type TempoPort,
  type TempoShoe,
  type TempoTimeSeriesPoint,
  type TempoWorkoutDetail,
} from "./port.js";
import { sanitizeWorkoutDetail, sanitizeWorkoutSummary } from "./sanitize.js";

/** Keys stripped while streaming workouts.json (GPS / raw blobs / nested join sources). */
const WORKOUT_IGNORE =
  /^(?:\d+\.)?(?:rawFitData|rawGpxData|rawFileData|rawStravaData|rawHealthKitData|rawFileName|rawFileType|route|media|externalIdentities|timeSeries|splits|healthKitUuid)\b/;

const SPLIT_IGNORE = /^(?:\d+\.)?workout\b/;
const ROUTE_IGNORE = /^(?:\d+\.)?routeGeoJson\b/;

export type ExportTempoPortOptions = {
  /** Absolute or relative path to a Tempo export zip. */
  exportPath: string;
  /**
   * When true (default), load HR-bearing time-series samples into getWorkout.
   * Disable to keep memory lower for huge exports when recap HR is not needed yet.
   */
  loadTimeSeries?: boolean;
  /**
   * When set, runs that start after this instant are invisible, as if the export
   * had been taken then. The demo instance pins the clock in the past while the
   * export holds runs up to its "now".
   */
  asOf?: () => Date;
};

export type ExportTempoBundle = {
  settings: unknown;
  shoes: unknown[];
  bestEfforts: unknown;
  /** Workout ids that have a route entry (geometry never loaded). */
  workoutIdsWithRoute: ReadonlySet<string>;
};

type IndexedWorkout = Record<string, unknown>;

type ExportIndex = {
  workoutsById: Map<string, IndexedWorkout>;
  /** All workouts sorted by startedAt ascending (filter/sort applied per query). */
  workouts: IndexedWorkout[];
  splitsByWorkoutId: Map<string, unknown[]>;
  timeSeriesByWorkoutId: Map<string, TempoTimeSeriesPoint[]>;
  workoutIdsWithRoute: Set<string>;
  settings: unknown;
  shoes: unknown[];
  bestEfforts: unknown;
};

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzlOpen(
      path,
      { lazyEntries: true, autoClose: false },
      (err, zip) => {
        if (err || !zip) {
          reject(
            new TempoExportError(`failed to open export zip: ${path}`, {
              cause: err,
            }),
          );
          return;
        }
        resolve(zip);
      },
    );
  });
}

function listDataEntries(zip: ZipFile): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve(entries));
    zip.on("entry", (entry: Entry) => {
      if (entry.fileName.startsWith("data/")) {
        entries.set(entry.fileName, entry);
      }
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(
          new TempoExportError(`failed to read zip entry ${entry.fileName}`, {
            cause: err,
          }),
        );
        return;
      }
      resolve(stream);
    });
  });
}

async function readEntryText(zip: ZipFile, entry: Entry): Promise<string> {
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function* streamJsonArray(
  stream: NodeJS.ReadableStream,
  ignoreFilter?: RegExp,
): AsyncGenerator<unknown> {
  const stages: unknown[] = [stream, parser()];
  if (ignoreFilter) {
    stages.push(ignore({ filter: ignoreFilter }));
  }
  stages.push(streamArray());
  const pipeline = chain(stages as Parameters<typeof chain>[0]);
  for await (const item of pipeline as AsyncIterable<{ value: unknown }>) {
    yield item.value;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function workoutStartedAtMs(w: IndexedWorkout): number {
  const raw = w.startedAt;
  if (typeof raw !== "string") return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function matchesQuery(w: IndexedWorkout, query: ListWorkoutsQuery): boolean {
  const startedMs = workoutStartedAtMs(w);
  if (query.startDate) {
    const start = Date.parse(query.startDate);
    if (Number.isFinite(start) && startedMs < start) return false;
  }
  if (query.endDate) {
    const end = Date.parse(query.endDate);
    if (Number.isFinite(end) && startedMs > end) return false;
  }
  const distance =
    typeof w.distanceM === "number" && Number.isFinite(w.distanceM)
      ? w.distanceM
      : null;
  if (query.minDistanceM !== undefined && distance !== null) {
    if (distance < query.minDistanceM) return false;
  }
  if (query.maxDistanceM !== undefined && distance !== null) {
    if (distance > query.maxDistanceM) return false;
  }
  if (query.runType) {
    if (typeof w.runType !== "string" || w.runType !== query.runType) {
      return false;
    }
  }
  if (query.keyword) {
    const needle = query.keyword.toLowerCase();
    const name = typeof w.name === "string" ? w.name.toLowerCase() : "";
    const notes = typeof w.notes === "string" ? w.notes.toLowerCase() : "";
    if (!name.includes(needle) && !notes.includes(needle)) return false;
  }
  return true;
}

function sortWorkouts(
  items: IndexedWorkout[],
  sortBy: string | undefined,
  sortOrder: string | undefined,
): IndexedWorkout[] {
  const order = (sortOrder ?? "desc").toLowerCase() === "asc" ? 1 : -1;
  const key = (sortBy ?? "startedAt").toLowerCase();
  const sorted = [...items];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (key === "distance" || key === "distancem") {
      const da = typeof a.distanceM === "number" ? a.distanceM : 0;
      const db = typeof b.distanceM === "number" ? b.distanceM : 0;
      cmp = da - db;
    } else if (key === "duration" || key === "durations") {
      const da = typeof a.durationS === "number" ? a.durationS : 0;
      const db = typeof b.durationS === "number" ? b.durationS : 0;
      cmp = da - db;
    } else {
      cmp = workoutStartedAtMs(a) - workoutStartedAtMs(b);
    }
    return cmp * order;
  });
  return sorted;
}

async function loadExportIndex(
  exportPath: string,
  loadTimeSeries: boolean,
): Promise<ExportIndex> {
  let zip: ZipFile | undefined;
  try {
    zip = await openZip(exportPath);
    const entries = await listDataEntries(zip);

    const workoutsEntry = entries.get("data/workouts.json");
    if (!workoutsEntry) {
      throw new TempoExportError("export zip missing data/workouts.json");
    }
    const splitsEntry = entries.get("data/splits.json");
    if (!splitsEntry) {
      throw new TempoExportError("export zip missing data/splits.json");
    }

    const workouts: IndexedWorkout[] = [];
    const workoutsById = new Map<string, IndexedWorkout>();
    for await (const raw of streamJsonArray(
      await openEntryStream(zip, workoutsEntry),
      WORKOUT_IGNORE,
    )) {
      const rec = asRecord(raw);
      if (!rec || typeof rec.id !== "string") continue;
      workouts.push(rec);
      workoutsById.set(rec.id, rec);
    }

    const splitsByWorkoutId = new Map<string, unknown[]>();
    for await (const raw of streamJsonArray(
      await openEntryStream(zip, splitsEntry),
      SPLIT_IGNORE,
    )) {
      const rec = asRecord(raw);
      if (!rec || typeof rec.workoutId !== "string") continue;
      const list = splitsByWorkoutId.get(rec.workoutId) ?? [];
      list.push(rec);
      splitsByWorkoutId.set(rec.workoutId, list);
    }
    for (const [, list] of splitsByWorkoutId) {
      list.sort((a, b) => {
        const ai = asRecord(a)?.idx;
        const bi = asRecord(b)?.idx;
        const an = typeof ai === "number" ? ai : 0;
        const bn = typeof bi === "number" ? bi : 0;
        return an - bn;
      });
    }

    const timeSeriesByWorkoutId = new Map<string, TempoTimeSeriesPoint[]>();
    if (loadTimeSeries) {
      const tsEntry = entries.get("data/time-series.json");
      if (tsEntry) {
        for await (const raw of streamJsonArray(
          await openEntryStream(zip, tsEntry),
          /^(?:\d+\.)?workout\b/,
        )) {
          const rec = asRecord(raw);
          if (!rec || typeof rec.workoutId !== "string") continue;
          if (rec.heartRateBpm == null) continue;
          const point: TempoTimeSeriesPoint = {
            elapsedSeconds:
              typeof rec.elapsedSeconds === "number" ? rec.elapsedSeconds : null,
            heartRateBpm:
              typeof rec.heartRateBpm === "number" ? rec.heartRateBpm : null,
          };
          if (typeof rec.distanceM === "number") point.distanceM = rec.distanceM;
          if (typeof rec.cadenceRpm === "number") point.cadenceRpm = rec.cadenceRpm;
          if (typeof rec.speedMps === "number") point.speedMps = rec.speedMps;
          if (typeof rec.elevationM === "number") point.elevationM = rec.elevationM;
          if (typeof rec.powerWatts === "number") point.powerWatts = rec.powerWatts;
          const list = timeSeriesByWorkoutId.get(rec.workoutId) ?? [];
          list.push(point);
          timeSeriesByWorkoutId.set(rec.workoutId, list);
        }
      }
    }

    const workoutIdsWithRoute = new Set<string>();
    const routesEntry = entries.get("data/routes.json");
    if (routesEntry) {
      for await (const raw of streamJsonArray(
        await openEntryStream(zip, routesEntry),
        ROUTE_IGNORE,
      )) {
        const rec = asRecord(raw);
        if (rec && typeof rec.workoutId === "string") {
          workoutIdsWithRoute.add(rec.workoutId);
        }
      }
    }

    let settings: unknown = null;
    const settingsEntry = entries.get("data/settings.json");
    if (settingsEntry) {
      settings = JSON.parse(await readEntryText(zip, settingsEntry));
    }

    let shoes: unknown[] = [];
    const shoesEntry = entries.get("data/shoes.json");
    if (shoesEntry) {
      const parsed: unknown = JSON.parse(await readEntryText(zip, shoesEntry));
      shoes = Array.isArray(parsed) ? parsed : [];
    }

    let bestEfforts: unknown = [];
    const bestEffortsEntry = entries.get("data/best-efforts.json");
    if (bestEffortsEntry) {
      bestEfforts = JSON.parse(await readEntryText(zip, bestEffortsEntry));
    }

    workouts.sort((a, b) => workoutStartedAtMs(a) - workoutStartedAtMs(b));

    return {
      workoutsById,
      workouts,
      splitsByWorkoutId,
      timeSeriesByWorkoutId,
      workoutIdsWithRoute,
      settings,
      shoes,
      bestEfforts,
    };
  } catch (err) {
    if (err instanceof TempoExportError) throw err;
    throw new TempoExportError(
      err instanceof Error ? err.message : "tempo_export_load_failed",
      { cause: err },
    );
  } finally {
    zip?.close();
  }
}

export type ExportTempoPort = TempoPort & {
  /**
   * Raw athlete settings from the export (zones, unit preference, default shoe).
   * Prefer {@link TempoPort.getSettings} for the normalized coach shape.
   */
  getExportSettings(): Promise<unknown>;
  /** Raw shoes catalog from the export. Prefer {@link TempoPort.listShoes}. */
  listExportShoes(): Promise<unknown[]>;
  /** Route presence only — never geometry. */
  getExportMeta(): Promise<Pick<ExportTempoBundle, "workoutIdsWithRoute">>;
};

/**
 * TempoPort backed by a local Tempo full-export zip (offline / CI).
 * Coach reads never include GPS route geometry or raw GPX/FIT blobs.
 */
export function createExportTempoPort(
  options: ExportTempoPortOptions,
): ExportTempoPort {
  const exportPath = options.exportPath.trim();
  if (!exportPath) {
    throw new TempoExportError("TEMPO_EXPORT_PATH is empty");
  }
  const loadTimeSeries = options.loadTimeSeries !== false;
  const asOf = options.asOf;
  const isVisible = (w: IndexedWorkout): boolean =>
    !asOf || workoutStartedAtMs(w) <= asOf().getTime();

  let indexPromise: Promise<ExportIndex> | null = null;

  function getIndex(): Promise<ExportIndex> {
    if (!indexPromise) {
      indexPromise = loadExportIndex(exportPath, loadTimeSeries).catch((err) => {
        indexPromise = null;
        throw err;
      });
    }
    return indexPromise;
  }

  return {
    async listWorkouts(query: ListWorkoutsQuery = {}): Promise<ListWorkoutsResult> {
      const index = await getIndex();
      const filtered = sortWorkouts(
        index.workouts.filter((w) => isVisible(w) && matchesQuery(w, query)),
        query.sortBy,
        query.sortOrder,
      );
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const totalCount = filtered.length;
      const totalPages =
        totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
      const start = (page - 1) * pageSize;
      const slice = filtered.slice(start, start + pageSize);
      const items = slice.map((raw) => {
        const withFlags = {
          ...raw,
          hasRoute: index.workoutIdsWithRoute.has(String(raw.id)),
          splitsCount: index.splitsByWorkoutId.get(String(raw.id))?.length ?? 0,
        };
        return sanitizeWorkoutSummary(withFlags);
      });
      return { items, page, pageSize, totalCount, totalPages };
    },

    async getWorkout(id: string): Promise<TempoWorkoutDetail | null> {
      const trimmed = id.trim();
      if (!isValidWorkoutId(trimmed)) {
        throw new TempoHttpError(400, "invalid_workout_id");
      }
      const index = await getIndex();
      const raw = index.workoutsById.get(trimmed);
      if (!raw || !isVisible(raw)) return null;
      const splits = index.splitsByWorkoutId.get(trimmed) ?? [];
      const timeSeries = index.timeSeriesByWorkoutId.get(trimmed);
      const detailRaw: Record<string, unknown> = {
        ...raw,
        splits,
        hasRoute: index.workoutIdsWithRoute.has(trimmed),
        splitsCount: splits.length,
      };
      if (timeSeries && timeSeries.length > 0) {
        detailRaw.timeSeries = timeSeries;
      }
      return sanitizeWorkoutDetail(detailRaw);
    },

    async getSettings(): Promise<TempoAthleteSettings> {
      return parseAthleteSettingsFromExport((await getIndex()).settings);
    },

    async listShoes(query: ListShoesQuery = {}): Promise<TempoShoe[]> {
      const shoes = parseShoesList((await getIndex()).shoes);
      const status = query.status ?? "active";
      if (status === "all") return shoes;
      if (status === "retired") return shoes.filter((s) => s.isRetired);
      return shoes.filter((s) => !s.isRetired);
    },

    async getBestEfforts(
      query: BestEffortsQuery = {},
    ): Promise<TempoBestEfforts> {
      // An export holds only all-time bests, so it cannot say what was new.
      if (query.since) return { distances: [] };
      return parseBestEfforts((await getIndex()).bestEfforts);
    },

    async getExportSettings(): Promise<unknown> {
      return (await getIndex()).settings;
    },

    async listExportShoes(): Promise<unknown[]> {
      return (await getIndex()).shoes;
    },

    async getExportMeta() {
      const index = await getIndex();
      return { workoutIdsWithRoute: index.workoutIdsWithRoute };
    },
  };
}

/** Resolve export path from env; returns null when unset. */
export function resolveTempoExportPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.TEMPO_EXPORT_PATH?.trim();
  return raw ? raw : null;
}
