import { pool } from "../db.js";
import type { SubjectiveAnswers } from "./subjectiveQuestionnaire.js";

export type StoredSubjectiveAnswers = {
  weekSessionId: string;
  answers: SubjectiveAnswers;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  week_session_id: string;
  answers: SubjectiveAnswers;
  created_at: Date;
  updated_at: Date;
};

function toStored(row: Row): StoredSubjectiveAnswers {
  return {
    weekSessionId: row.week_session_id,
    answers: row.answers,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getSubjectiveAnswers(
  weekSessionId: string,
): Promise<StoredSubjectiveAnswers | null> {
  const result = await pool.query<Row>(
    `
    SELECT week_session_id::text, answers, created_at, updated_at
    FROM week_subjective_answers
    WHERE week_session_id = $1
    `,
    [weekSessionId],
  );
  const row = result.rows[0];
  return row ? toStored(row) : null;
}

/** Upsert subjective answers for a week session (completion path for needs_subjective). */
export async function saveSubjectiveAnswers(
  at: Date,
  weekSessionId: string,
  answers: SubjectiveAnswers,
): Promise<StoredSubjectiveAnswers> {
  const result = await pool.query<Row>(
    `
    INSERT INTO week_subjective_answers (week_session_id, answers, created_at, updated_at)
    VALUES ($1::uuid, $2::jsonb, $3, $3)
    ON CONFLICT (week_session_id) DO UPDATE
      SET answers = EXCLUDED.answers,
          updated_at = EXCLUDED.updated_at
    RETURNING week_session_id::text, answers, created_at, updated_at
    `,
    [weekSessionId, JSON.stringify(answers), at],
  );
  return toStored(result.rows[0]!);
}
