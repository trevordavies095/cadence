import { pool } from "../db.js";
import type { Clock } from "../clock/clock.js";
import { boundsForIsoWeek, resolveIsoWeek } from "../clock/isoWeek.js";

export type WeekSession = {
  id: string;
  isoWeek: string;
  timezone: string;
  start: string;
  end: string;
  createdAt: string;
  /** True once a later ISO week session has been started (#33). */
  archived: boolean;
  archivedAt: string | null;
};

type Row = {
  id: string;
  iso_week: string;
  timezone: string;
  start_at: Date;
  end_at: Date;
  created_at: Date;
  archived_at: Date | null;
};

const SESSION_COLUMNS = `id::text, iso_week, timezone, start_at, end_at, created_at, archived_at`;

function toSession(row: Row): WeekSession {
  return {
    id: row.id,
    isoWeek: row.iso_week,
    timezone: row.timezone,
    start: row.start_at.toISOString(),
    end: row.end_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    archived: row.archived_at != null,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  };
}

export async function getWeekSessionById(
  id: string,
): Promise<WeekSession | null> {
  const result = await pool.query<Row>(
    `SELECT ${SESSION_COLUMNS}
     FROM week_sessions
     WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toSession(row) : null;
}

/** Read-only lookup by identity (iso_week, timezone); never creates. */
export async function findWeekSession(
  isoWeek: string,
  timezone: string,
): Promise<WeekSession | null> {
  const result = await pool.query<Row>(
    `SELECT ${SESSION_COLUMNS}
     FROM week_sessions
     WHERE iso_week = $1 AND timezone = $2`,
    [isoWeek, timezone],
  );
  const row = result.rows[0];
  return row ? toSession(row) : null;
}

/**
 * Archive week sessions in this timezone that started before the current week.
 * Future sessions are never archived.
 * Idempotent — already-archived rows keep their original archived_at.
 */
export async function archivePriorWeekSessions(
  at: Date,
  timezone: string,
  currentWeekStart: Date,
): Promise<number> {
  const result = await pool.query(
    `
    UPDATE week_sessions
    SET archived_at = COALESCE(archived_at, $3)
    WHERE timezone = $1
      AND start_at < $2
      AND archived_at IS NULL
    `,
    [timezone, currentWeekStart, at],
  );
  return result.rowCount ?? 0;
}

/**
 * Resolve the ISO week for `clock` + timezone and return the persisted session,
 * inserting when missing. Identity is (iso_week, timezone).
 * Starting a new week archives prior sessions in the same timezone (#33).
 */
export async function getOrCreateCurrentWeekSession(
  clock: Clock,
  timezone = "UTC",
): Promise<{ session: WeekSession; created: boolean }> {
  const now = clock.now();
  const bounds = resolveIsoWeek(clock, timezone);

  const inserted = await pool.query<Row>(
    `
    INSERT INTO week_sessions (iso_week, timezone, start_at, end_at, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (iso_week, timezone) DO NOTHING
    RETURNING ${SESSION_COLUMNS}
    `,
    [bounds.isoWeek, bounds.timezone, bounds.start, bounds.end, now],
  );

  let session: WeekSession;
  let created: boolean;
  if (inserted.rows[0]) {
    session = toSession(inserted.rows[0]);
    created = true;
  } else {
    const existing = await pool.query<Row>(
      `SELECT ${SESSION_COLUMNS}
       FROM week_sessions
       WHERE iso_week = $1 AND timezone = $2`,
      [bounds.isoWeek, bounds.timezone],
    );
    session = toSession(existing.rows[0]!);
    created = false;
  }

  if (session.archived) {
    // A week that becomes current is live, even if archived earlier.
    const cleared = await pool.query<Row>(
      `UPDATE week_sessions SET archived_at = NULL
       WHERE id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [session.id],
    );
    session = toSession(cleared.rows[0]!);
  }

  await archivePriorWeekSessions(now, bounds.timezone, new Date(bounds.start));
  return { session, created };
}

/**
 * Ensure a week session exists for `(isoWeek, timezone)` without archiving peers.
 * Unlike {@link getOrCreateCurrentWeekSession}, this does not call
 * {@link archivePriorWeekSessions}, so a future week can sit beside the live
 * current session.
 *
 * If the row already exists, return it unchanged (including archived_at).
 */
export async function ensureWeekSession(
  at: Date,
  isoWeek: string,
  timezone = "UTC",
): Promise<{ session: WeekSession; created: boolean }> {
  const bounds = boundsForIsoWeek(isoWeek, timezone);

  const inserted = await pool.query<Row>(
    `
    INSERT INTO week_sessions (iso_week, timezone, start_at, end_at, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (iso_week, timezone) DO NOTHING
    RETURNING ${SESSION_COLUMNS}
    `,
    [bounds.isoWeek, bounds.timezone, bounds.start, bounds.end, at],
  );

  if (inserted.rows[0]) {
    return { session: toSession(inserted.rows[0]), created: true };
  }

  const existing = await pool.query<Row>(
    `SELECT ${SESSION_COLUMNS}
     FROM week_sessions
     WHERE iso_week = $1 AND timezone = $2`,
    [bounds.isoWeek, bounds.timezone],
  );
  return { session: toSession(existing.rows[0]!), created: false };
}

/** Newest week first (by week start, then iso label). Includes archived weeks. */
export async function listWeekSessions(): Promise<WeekSession[]> {
  const result = await pool.query<Row>(
    `SELECT ${SESSION_COLUMNS}
     FROM week_sessions
     ORDER BY start_at DESC, iso_week DESC, id DESC`,
  );
  return result.rows.map(toSession);
}
