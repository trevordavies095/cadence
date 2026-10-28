import { pool } from "../db.js";

export type ReplyRunStatus = "pending" | "ok" | "failed";

/** One server-side execution of the weekly reply for a reviewed week. */
export type ReplyRun = {
  id: string;
  weekSessionId: string;
  status: ReplyRunStatus;
  llmCallId: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** When the athlete opened the plan this run produced; null until then. */
  seenAt: string | null;
};

type Row = {
  id: string;
  week_session_id: string;
  status: ReplyRunStatus;
  llm_call_id: string | null;
  error_message: string | null;
  started_at: Date;
  finished_at: Date | null;
  seen_at: Date | null;
};

const COLUMNS =
  "id::text, week_session_id::text, status, llm_call_id::text, error_message, started_at, finished_at, seen_at";

function toRun(row: Row): ReplyRun {
  return {
    id: row.id,
    weekSessionId: row.week_session_id,
    status: row.status,
    llmCallId: row.llm_call_id,
    errorMessage: row.error_message,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    seenAt: row.seen_at ? row.seen_at.toISOString() : null,
  };
}

/**
 * Starts a pending run for the week. Returns null when one is already pending
 * (the unique partial index allows at most one pending run per week).
 */
export async function createPendingRun(
  at: Date,
  weekSessionId: string,
): Promise<ReplyRun | null> {
  const result = await pool.query<Row>(
    `
    INSERT INTO weekly_reply_runs (week_session_id, status, started_at)
    VALUES ($1, 'pending', $2)
    ON CONFLICT (week_session_id) WHERE status = 'pending' DO NOTHING
    RETURNING ${COLUMNS}
    `,
    [weekSessionId, at],
  );
  const row = result.rows[0];
  return row ? toRun(row) : null;
}

export async function finishRun(
  id: string,
  outcome: {
    status: "ok" | "failed";
    llmCallId?: string | null;
    errorMessage?: string | null;
    at: Date;
  },
): Promise<ReplyRun | null> {
  const result = await pool.query<Row>(
    `
    UPDATE weekly_reply_runs
    SET status = $2, llm_call_id = $3, error_message = $4, finished_at = $5
    WHERE id = $1
    RETURNING ${COLUMNS}
    `,
    [
      id,
      outcome.status,
      outcome.llmCallId ?? null,
      outcome.errorMessage ?? null,
      outcome.at,
    ],
  );
  const row = result.rows[0];
  return row ? toRun(row) : null;
}

export async function getLatestRun(
  weekSessionId: string,
): Promise<ReplyRun | null> {
  const result = await pool.query<Row>(
    `
    SELECT ${COLUMNS}
    FROM weekly_reply_runs
    WHERE week_session_id = $1
    ORDER BY started_at DESC, seq DESC
    LIMIT 1
    `,
    [weekSessionId],
  );
  const row = result.rows[0];
  return row ? toRun(row) : null;
}

export async function hasPendingRun(weekSessionId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM weekly_reply_runs WHERE week_session_id = $1 AND status = 'pending' LIMIT 1",
    [weekSessionId],
  );
  return result.rows.length > 0;
}

/**
 * A run lives in the API process, so a restart orphans any pending row.
 * Mark those failed at startup so they never block the week.
 */
export async function failInterruptedRuns(at: Date): Promise<number> {
  const result = await pool.query(
    `
    UPDATE weekly_reply_runs
    SET status = 'failed',
        error_message = 'Interrupted by a restart',
        finished_at = $1
    WHERE status = 'pending'
    `,
    [at],
  );
  return result.rowCount ?? 0;
}

/** The athlete opened the plan from the latest finished run: stop announcing it. */
export async function markLatestRunSeen(
  at: Date,
  weekSessionId: string,
): Promise<ReplyRun | null> {
  const result = await pool.query<Row>(
    `
    UPDATE weekly_reply_runs
    SET seen_at = COALESCE(seen_at, $2)
    WHERE id = (
      SELECT id FROM weekly_reply_runs
      WHERE week_session_id = $1 AND status = 'ok'
      ORDER BY started_at DESC, seq DESC
      LIMIT 1
    )
    RETURNING ${COLUMNS}
    `,
    [weekSessionId, at],
  );
  const row = result.rows[0];
  return row ? toRun(row) : null;
}
