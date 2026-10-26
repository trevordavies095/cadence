import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPool,
  DEFAULT_POOL_TIMINGS,
  pool,
  poolTimingsFromEnv,
} from "../src/db.js";

const TEST_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/ai_coach_test";

/**
 * A link to Postgres that holds every new connection for `delayMs` before passing it on,
 * like a home server busy with other work at the moment a page loads.
 */
async function slowLinkToPostgres(delayMs: number) {
  const target = new URL(TEST_URL);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.pause();
    setTimeout(() => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname, () => {
        client.pipe(upstream).pipe(client);
        client.resume();
      });
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const url = new URL(TEST_URL);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("database pool", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it("waits 10 seconds for a connection and keeps idle ones for 5 minutes by default", () => {
    expect(DEFAULT_POOL_TIMINGS).toEqual({ connectionTimeoutMillis: 10_000, idleTimeoutMillis: 300_000 });
    expect(poolTimingsFromEnv({})).toEqual(DEFAULT_POOL_TIMINGS);
    expect(poolTimingsFromEnv({ DATABASE_CONNECT_TIMEOUT_MS: "", DATABASE_IDLE_TIMEOUT_MS: " " })).toEqual(
      DEFAULT_POOL_TIMINGS,
    );
  });

  it("takes both timings from the environment", () => {
    expect(
      poolTimingsFromEnv({ DATABASE_CONNECT_TIMEOUT_MS: "15000", DATABASE_IDLE_TIMEOUT_MS: "60000" }),
    ).toEqual({ connectionTimeoutMillis: 15_000, idleTimeoutMillis: 60_000 });
  });

  it("refuses a value that is not a whole number of milliseconds", () => {
    for (const bad of ["ten", "0", "-5", "1.5"]) {
      expect(() => poolTimingsFromEnv({ DATABASE_CONNECT_TIMEOUT_MS: bad })).toThrow(
        /DATABASE_CONNECT_TIMEOUT_MS must be a whole number/,
      );
    }
    expect(() => poolTimingsFromEnv({ DATABASE_IDLE_TIMEOUT_MS: "soon" })).toThrow(
      /DATABASE_IDLE_TIMEOUT_MS must be a whole number/,
    );
  });

  it("the app's pool uses the default timings", () => {
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(300_000);
  });

  it("a connection that takes 3 seconds to open now succeeds", async () => {
    const link = await slowLinkToPostgres(3000);
    cleanups.push(link.close);
    const slowPool = createPool(link.url, DEFAULT_POOL_TIMINGS);
    cleanups.push(() => slowPool.end());

    const started = Date.now();
    const result = await slowPool.query("SELECT 1 AS ok");
    expect(result.rows[0]).toEqual({ ok: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  }, 15_000);

  it("the same slow connection failed under the old 2-second limit", async () => {
    const link = await slowLinkToPostgres(3000);
    cleanups.push(link.close);
    const oldPool = createPool(link.url, { connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000 });
    cleanups.push(() => oldPool.end());

    await expect(oldPool.query("SELECT 1")).rejects.toThrow(/connection timeout/);
  }, 15_000);

  it("an idle connection dropped by Postgres is logged, not fatal, and the pool carries on", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const testPool = createPool(TEST_URL, DEFAULT_POOL_TIMINGS);
    cleanups.push(() => testPool.end());

    const client = await testPool.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    client.release(); // now idle in the pool

    // Postgres ends that idle connection, as it would on a restart.
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled(), { timeout: 5000 });
    expect(String(logged.mock.calls[0]![0])).toMatch(/dropped an idle connection/);

    // The next query simply gets a fresh connection.
    const again = await testPool.query("SELECT 1 AS ok");
    expect(again.rows[0]).toEqual({ ok: 1 });
  });
});
