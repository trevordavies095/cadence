import { pool } from "../db.js";

/** Persisted weekly recap markdown for a week session (issue #25). */
export type WeekRecapRecord = {
  weekSessionId: string;
  markdown: string;
  subjective: "skipped" | "present";
  createdAt: string;
  updatedAt: string;
};

type Row = {
  week_session_id: string;
  markdown: string;
  subjective: string;
  created_at: Date;
  updated_at: Date;
};

function toRecord(row: Row): WeekRecapRecord {
  return {
    weekSessionId: row.week_session_id,
    markdown: row.markdown,
    subjective: row.subjective as WeekRecapRecord["subjective"],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Upsert the weekly recap markdown for a week session.
 * One document per session — regenerating replaces (no duplicate spam).
 */
export async function saveWeekRecap(input: {
  weekSessionId: string;
  markdown: string;
  subjective: "skipped" | "present";
}): Promise<WeekRecapRecord> {
  const result = await pool.query<Row>(
    `
    INSERT INTO week_recaps (week_session_id, markdown, subjective)
    VALUES ($1::uuid, $2, $3)
    ON CONFLICT (week_session_id) DO UPDATE SET
      markdown = EXCLUDED.markdown,
      subjective = EXCLUDED.subjective,
      updated_at = NOW()
    RETURNING
      week_session_id::text,
      markdown,
      subjective,
      created_at,
      updated_at
    `,
    [input.weekSessionId, input.markdown, input.subjective],
  );
  return toRecord(result.rows[0]!);
}

export async function getWeekRecapBySessionId(
  weekSessionId: string,
): Promise<WeekRecapRecord | null> {
  const result = await pool.query<Row>(
    `
    SELECT
      week_session_id::text,
      markdown,
      subjective,
      created_at,
      updated_at
    FROM week_recaps
    WHERE week_session_id = $1
    `,
    [weekSessionId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}
