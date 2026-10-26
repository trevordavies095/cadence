import pg from "pg";

const { Pool } = pg;

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/ai_coach";

export type PoolTimings = {
  /** How long to wait for a connection, whether a free one or a new one. */
  connectionTimeoutMillis: number;
  /** How long an unused connection stays open before it is closed. */
  idleTimeoutMillis: number;
};

/**
 * Defaults sized for a shared home server, where opening a connection can stall for a
 * second or two while other work runs. Idle connections stay open for five minutes, so the
 * pages that load right after a long coach reply reuse warm connections instead of opening
 * several at once.
 */
export const DEFAULT_POOL_TIMINGS: PoolTimings = {
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 300_000,
};

function millisFromEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a whole number of milliseconds above 0, got "${raw}"`);
  }
  return value;
}

/** Pool timings from the environment. An invalid value stops the API at startup. */
export function poolTimingsFromEnv(env: NodeJS.ProcessEnv): PoolTimings {
  return {
    connectionTimeoutMillis: millisFromEnv(
      "DATABASE_CONNECT_TIMEOUT_MS",
      env.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_POOL_TIMINGS.connectionTimeoutMillis,
    ),
    idleTimeoutMillis: millisFromEnv(
      "DATABASE_IDLE_TIMEOUT_MS",
      env.DATABASE_IDLE_TIMEOUT_MS,
      DEFAULT_POOL_TIMINGS.idleTimeoutMillis,
    ),
  };
}

/**
 * Postgres can drop a connection the pool is holding idle (a restart, a network blip).
 * The pool reports that as an "error" event; with no listener, Node would end the process.
 * Log it instead: the pool discards that connection and the next query opens a fresh one.
 */
export function logIdleClientError(err: Error): void {
  console.error(`Postgres dropped an idle connection; the next query opens a new one. ${err.message}`);
}

export function createPool(connectionString: string, timings: PoolTimings): pg.Pool {
  const created = new Pool({ connectionString, ...timings });
  created.on("error", logIdleClientError);
  return created;
}

export const pool = createPool(databaseUrl, poolTimingsFromEnv(process.env));

const READY_PROBE_TIMEOUT_MS = 2000;

/** Returns true when Postgres answers within the readiness timeout. */
export async function canConnect(): Promise<boolean> {
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await Promise.race([
      client.query("SELECT 1"),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("ready probe timeout")), READY_PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
}
