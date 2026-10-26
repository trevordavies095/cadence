import { pool } from "../db.js";
import type { OnboardingAnswers } from "./questionnaire.js";

export type StoredOnboardingAnswers = {
  answers: OnboardingAnswers;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  answers: OnboardingAnswers;
  created_at: Date;
  updated_at: Date;
};

function toStored(row: Row): StoredOnboardingAnswers {
  return {
    answers: row.answers,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getOnboardingAnswers(): Promise<StoredOnboardingAnswers | null> {
  const result = await pool.query<Row>(
    `
    SELECT answers, created_at, updated_at
    FROM onboarding_answers
    WHERE id = 1
    `,
  );
  const row = result.rows[0];
  return row ? toStored(row) : null;
}

/** Upsert single-athlete onboarding answers (visible to later dossier generation). */
export async function saveOnboardingAnswers(
  answers: OnboardingAnswers,
): Promise<StoredOnboardingAnswers> {
  const result = await pool.query<Row>(
    `
    INSERT INTO onboarding_answers (id, answers)
    VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET answers = EXCLUDED.answers,
          updated_at = NOW()
    RETURNING answers, created_at, updated_at
    `,
    [JSON.stringify(answers)],
  );
  return toStored(result.rows[0]!);
}
