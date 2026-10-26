/** Thin client for the Cadence API plus the clock restart hook. Node 18+, no dependencies. */
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_SH = path.join(ROOT, "scripts", "demo.sh");
export const API_BASE = `http://localhost:${process.env.API_HOST_PORT || 5002}`;

export class ApiError extends Error {
  constructor(method, route, status, body) {
    super(`${method} ${route} -> ${status} ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Call the API; throws ApiError on any non-2xx unless the status is in `allow`.
 * Plain node:http with no connection pooling: the API container is recreated to change
 * the clock, which leaves a pooled keep-alive socket (as fetch uses) pointing at nothing.
 */
export function api(method, route, body, { allow = [] } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const url = new URL(route, API_BASE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        agent: false,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve({ status, json });
          else if (allow.includes(status)) resolve({ status, json });
          else reject(new ApiError(method, route, status, json));
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Restart the API with "now" pinned to `when` (any Date-parseable string), and the live
 * model's thinking effort set to `effort` when given. Returns the ISO instant.
 */
export function setClock(when, effort) {
  const iso = new Date(when).toISOString();
  const r = spawnSync(DEMO_SH, effort ? ["_clock", iso, effort] : ["_clock", iso], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`could not restart the API at ${iso}`);
  return iso;
}

/** Write a snapshot of the database via pg_dump, tagged with the clock `up` should restore. */
export function dumpSnapshot(file, clockIso) {
  const r = spawnSync(DEMO_SH, ["_dump", file, clockIso], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`snapshot dump to ${file} failed`);
}

/** Run SQL (stdin) against the demo database. Returns stdout; throws on any SQL error. */
export function sql(text) {
  const r = spawnSync(DEMO_SH, ["_sql"], { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** The database's real wall clock, as a timestamptz literal with microseconds. */
export function realNow() {
  return sql("select clock_timestamp()::text;").trim();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
