/**
 * Makes a finished build safe to publish: moves build-time stamps into the fiction,
 * removes secrets, and checks the written snapshot for leaks.
 */
import fs from "node:fs";
import os from "node:os";
import { sql } from "./api.mjs";

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Rows are stamped with the real database time. Each recorded step has the real window it
 * ran in and the fictional instant it stands for: shift every timestamptz in that window
 * by the same offset (order and durations survive). Fails if any stamp is still inside a
 * real window afterwards. Returns the number of values moved.
 */
export function fixTimestamps(steps) {
  if (steps.length === 0) throw new Error("no recorded steps to map timestamps from");
  const values = steps
    .map((s) => `(${lit(s.realStart)}::timestamptz, ${lit(s.realEnd)}::timestamptz, ${lit(s.fictionAt)}::timestamptz)`)
    .join(",\n");
  const out = sql(`
BEGIN;
CREATE TEMP TABLE demo_steps (real_start timestamptz, real_end timestamptz, fiction_at timestamptz);
INSERT INTO demo_steps VALUES ${values};
CREATE TEMP TABLE demo_result (moved bigint);
DO $$
DECLARE
  r record;
  n bigint;
  total bigint := 0;
  stuck bigint;
BEGIN
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'
    ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'UPDATE %1$I t SET %2$I = (SELECT d.fiction_at + (t.%2$I - d.real_start) FROM demo_steps d
         WHERE t.%2$I BETWEEN d.real_start AND d.real_end LIMIT 1)
       WHERE EXISTS (SELECT 1 FROM demo_steps d WHERE t.%2$I BETWEEN d.real_start AND d.real_end)',
      r.table_name, r.column_name);
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXECUTE format(
      'SELECT count(*) FROM %1$I t WHERE EXISTS (SELECT 1 FROM demo_steps d WHERE t.%2$I BETWEEN d.real_start AND d.real_end)',
      r.table_name, r.column_name) INTO stuck;
    IF stuck > 0 THEN
      RAISE EXCEPTION 'unmapped build-time stamps remain in %.%', r.table_name, r.column_name;
    END IF;
  END LOOP;
  INSERT INTO demo_result VALUES (total);
END $$;
SELECT moved FROM demo_result;
COMMIT;
`);
  return Number(out.trim().split("\n").pop());
}

/**
 * Every model call in the database must have come from the provider this build was meant to
 * use. A live build that quietly ran on the stub would publish placeholder coaching.
 */
export function assertProvider(expected) {
  const found = sql("SELECT DISTINCT provider FROM llm_call_log ORDER BY 1;")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (found.length === 0) throw new Error("no model calls were logged");
  if (found.length !== 1 || found[0] !== expected) {
    throw new Error(`expected every model call to be ${expected}, the call log has: ${found.join(", ")}`);
  }
}

/** Delete the saved Anthropic key and Tempo credentials. The LLM call log stays. */
export function scrubSecrets() {
  sql("DELETE FROM anthropic_connection; DELETE FROM tempo_connection;");
}

/** Strings that must never appear in a published snapshot. */
function forbidden() {
  const items = [
    ["an Anthropic key prefix", "sk-ant"],
    ["the data protection key", process.env.DATA_PROTECTION_SECRET_KEY || "change-me-local-dev-only-not-for-prod"],
    ["your home directory", os.homedir()],
  ];
  if (process.env.ANTHROPIC_API_KEY) items.push(["the Anthropic key in use", process.env.ANTHROPIC_API_KEY]);
  const user = os.userInfo().username;
  if (user.length > 3) items.push(["your OS username", user]);
  return items;
}

/** Throws (after deleting the file) if the snapshot contains anything it should not. */
export function assertNoLeaks(file) {
  const text = fs.readFileSync(file, "utf8");
  const found = forbidden().filter(([, needle]) => needle && text.includes(needle)).map(([what]) => what);
  if (found.length > 0) {
    fs.rmSync(file);
    throw new Error(`snapshot leak check failed, deleted ${file}: contains ${found.join(", ")}`);
  }
}
