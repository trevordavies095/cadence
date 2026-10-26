import { pool } from "../db.js";
import type { PrescribedWeek, SafetyCallout } from "../llm/types.js";

/** Persisted prescribed week for a week session (issue #30 / #32). */
export type PrescribedWeekRecord = {
  weekSessionId: string;
  plan: PrescribedWeek;
  analysis: string;
  settingsProposalBullets: string[] | null;
  safetyCallouts: SafetyCallout[] | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  week_session_id: string;
  plan: PrescribedWeek | string;
  analysis: string;
  settings_proposal_bullets: string[] | null;
  safety_callouts: SafetyCallout[] | string | null;
  created_at: Date;
  updated_at: Date;
};

function parseJsonField<T>(value: T | string): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value;
}

function toRecord(row: Row): PrescribedWeekRecord {
  const rawCallouts = row.safety_callouts;
  let safetyCallouts: SafetyCallout[] | null = null;
  if (rawCallouts != null) {
    const parsed = parseJsonField(rawCallouts);
    safetyCallouts = Array.isArray(parsed) ? parsed : null;
  }
  return {
    weekSessionId: row.week_session_id,
    plan: parseJsonField(row.plan),
    analysis: row.analysis,
    settingsProposalBullets: row.settings_proposal_bullets,
    safetyCallouts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Upsert the structured prescribed week for a week session.
 * One plan per session (re-reply replaces).
 */
export async function savePrescribedWeek(input: {
  weekSessionId: string;
  plan: PrescribedWeek;
  analysis: string;
  settingsProposalBullets?: string[] | null;
  safetyCallouts?: SafetyCallout[] | null;
}): Promise<PrescribedWeekRecord> {
  const bullets = input.settingsProposalBullets ?? null;
  const callouts =
    input.safetyCallouts && input.safetyCallouts.length > 0
      ? input.safetyCallouts
      : null;
  const result = await pool.query<Row>(
    `
    INSERT INTO prescribed_weeks (
      week_session_id, plan, analysis, settings_proposal_bullets, safety_callouts
    )
    VALUES ($1, $2::jsonb, $3, $4, $5::jsonb)
    ON CONFLICT (week_session_id) DO UPDATE SET
      plan = EXCLUDED.plan,
      analysis = EXCLUDED.analysis,
      settings_proposal_bullets = EXCLUDED.settings_proposal_bullets,
      safety_callouts = EXCLUDED.safety_callouts,
      updated_at = NOW()
    RETURNING
      week_session_id::text,
      plan,
      analysis,
      settings_proposal_bullets,
      safety_callouts,
      created_at,
      updated_at
    `,
    [
      input.weekSessionId,
      JSON.stringify(input.plan),
      input.analysis,
      bullets,
      callouts ? JSON.stringify(callouts) : null,
    ],
  );
  return toRecord(result.rows[0]!);
}

export async function getPrescribedWeekBySessionId(
  weekSessionId: string,
): Promise<PrescribedWeekRecord | null> {
  const result = await pool.query<Row>(
    `
    SELECT
      week_session_id::text,
      plan,
      analysis,
      settings_proposal_bullets,
      safety_callouts,
      created_at,
      updated_at
    FROM prescribed_weeks
    WHERE week_session_id = $1
    `,
    [weekSessionId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}
