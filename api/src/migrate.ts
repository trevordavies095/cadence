import { pool } from "./db.js";

/** Apply schema needed for the current API slice. Safe to run on every startup. */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disclaimer_acceptance (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      accepted_at timestamptz NOT NULL,
      disclaimer_version text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tempo_connection (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      base_url text NOT NULL,
      api_key_ciphertext bytea NOT NULL,
      api_key_last4 text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS anthropic_connection (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      api_key_ciphertext bytea NOT NULL,
      api_key_last4 text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role text NOT NULL CHECK (role IN ('athlete', 'coach', 'system')),
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dossier_versions (
      id bigserial PRIMARY KEY,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dossier_proposals (
      id bigserial PRIMARY KEY,
      summary_bullets text[] NOT NULL,
      proposed_body text NOT NULL,
      kind text NOT NULL DEFAULT 'settings'
        CHECK (kind IN ('settings', 'audit', 'correction', 'onboarding')),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      resolved_at timestamptz
    );

    ALTER TABLE dossier_proposals
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'settings';

    -- Notes the coach takes apply on their own and can be undone, so a proposal
    -- remembers which version it installed and which one it replaced.
    ALTER TABLE dossier_proposals
      ADD COLUMN IF NOT EXISTS applied_version_id bigint,
      ADD COLUMN IF NOT EXISTS previous_version_id bigint;

    ALTER TABLE dossier_proposals
      DROP CONSTRAINT IF EXISTS dossier_proposals_status_check;
    ALTER TABLE dossier_proposals
      ADD CONSTRAINT dossier_proposals_status_check
      CHECK (status IN ('pending', 'accepted', 'rejected', 'undone'));

    -- Cadence for coach-initiated dossier audit/trim (#40).
    CREATE TABLE IF NOT EXISTS dossier_audit_meta (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_audit_at timestamptz,
      next_audit_due_at timestamptz,
      interval_weeks integer NOT NULL DEFAULT 5,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS week_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      iso_week text NOT NULL,
      timezone text NOT NULL,
      start_at timestamptz NOT NULL,
      end_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      -- NULL = live; set when the next ISO week session starts (#33).
      archived_at timestamptz,
      UNIQUE (iso_week, timezone)
    );

    ALTER TABLE week_sessions
      ADD COLUMN IF NOT EXISTS archived_at timestamptz;

    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS week_session_id uuid
        REFERENCES week_sessions (id);

    CREATE TABLE IF NOT EXISTS onboarding_answers (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      answers jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS last_outbound_packet (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      saved_at timestamptz NOT NULL DEFAULT NOW(),
      summary jsonb NOT NULL,
      packet jsonb NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prescribed_weeks (
      week_session_id uuid PRIMARY KEY
        REFERENCES week_sessions (id) ON DELETE CASCADE,
      plan jsonb NOT NULL,
      analysis text NOT NULL DEFAULT '',
      settings_proposal_bullets text[],
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS week_subjective_answers (
      week_session_id uuid PRIMARY KEY
        REFERENCES week_sessions (id) ON DELETE CASCADE,
      answers jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    -- One weekly recap document per session; regenerate replaces (#25).
    CREATE TABLE IF NOT EXISTS week_recaps (
      week_session_id uuid PRIMARY KEY
        REFERENCES week_sessions (id) ON DELETE CASCADE,
      markdown text NOT NULL,
      subjective text NOT NULL
        CHECK (subjective IN ('skipped', 'present')),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    ALTER TABLE prescribed_weeks
      ADD COLUMN IF NOT EXISTS safety_callouts jsonb;

    -- Coaching summary only (ModelPacketAttachment shape); never GPS/route geometry (#36).
    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS attachment jsonb;

    -- Append-only record of every LLM call (full request, raw response, usage).
    -- No foreign keys: rows are written best-effort and must never block
    -- coaching or session deletes.
    CREATE TABLE IF NOT EXISTS llm_call_log (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      operation text NOT NULL,
      provider text NOT NULL CHECK (provider IN ('anthropic', 'stub')),
      model text,
      app_version text NOT NULL,
      week_session_id uuid,
      parent_call_id uuid,
      request jsonb,
      response_raw text,
      http_status integer,
      latency_ms integer,
      stop_reason text,
      input_tokens integer,
      output_tokens integer,
      cache_read_tokens integer,
      cache_creation_tokens integer,
      outcome text NOT NULL CHECK (outcome IN (
        'ok', 'http_error', 'transport_error', 'schema_invalid',
        'rejected_by_route', 'repaired'
      )),
      error_message text
    );

    -- 'repaired': the reply was accepted after the validator fixed a soft
    -- field (an over-long safety callout, #4); error_message says what.
    ALTER TABLE llm_call_log
      DROP CONSTRAINT IF EXISTS llm_call_log_outcome_check;
    ALTER TABLE llm_call_log
      ADD CONSTRAINT llm_call_log_outcome_check
      CHECK (outcome IN (
        'ok', 'http_error', 'transport_error', 'schema_invalid',
        'rejected_by_route', 'repaired'
      ));

    ALTER TABLE llm_call_log
      ADD COLUMN IF NOT EXISTS thinking_tokens integer;

    -- Which LLM call produced this coach message (plain uuid, no FK).
    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS llm_call_id uuid;

    -- One server-side execution of the weekly reply per row. At most one may be
    -- pending per week, so a second request is refused instead of racing.
    CREATE TABLE IF NOT EXISTS weekly_reply_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      week_session_id uuid NOT NULL REFERENCES week_sessions (id),
      status text NOT NULL CHECK (status IN ('pending', 'ok', 'failed')),
      llm_call_id uuid,
      error_message text,
      started_at timestamptz NOT NULL DEFAULT NOW(),
      finished_at timestamptz
    );

    CREATE UNIQUE INDEX IF NOT EXISTS weekly_reply_runs_one_pending
      ON weekly_reply_runs (week_session_id)
      WHERE status = 'pending';

    -- When the athlete opened the plan this run produced (clears the home banner).
    ALTER TABLE weekly_reply_runs
      ADD COLUMN IF NOT EXISTS seen_at timestamptz;

    -- Rows are stamped from the app clock (#7), so under a pinned clock many share
    -- one instant. seq keeps insertion order as the tie-breaker; uuid ids are random.
    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS seq bigserial;
    ALTER TABLE weekly_reply_runs
      ADD COLUMN IF NOT EXISTS seq bigserial;

    -- Last unit preference read from Tempo, so plans keep the athlete's units
    -- when Tempo is unreachable.
    CREATE TABLE IF NOT EXISTS athlete_preferences (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      unit_preference text NOT NULL CHECK (unit_preference IN ('metric', 'imperial')),
      read_at timestamptz NOT NULL DEFAULT NOW()
    );

    -- The note a coach message produced, so the card shows under that reply.
    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS dossier_proposal_id bigint;

    -- Structured safety callouts that came with a coach message, so the UI can
    -- render them as notices instead of text woven into the body.
    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS safety_callouts jsonb;

    -- What a message is, beyond who wrote it. "weekly_read" is the short Sunday
    -- message that points at the plan; the full read lives on the plan record.
    ALTER TABLE thread_messages
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat'
        CHECK (kind IN ('chat', 'weekly_read'));
  `);

  await rotateKeyDerivation();
}

/**
 * The HKDF strings changed from "ai-coach:*" to "cadence:*" with no legacy
 * fallback, so stored Tempo and Anthropic keys can no longer be decrypted.
 * Delete them exactly once; Settings then reports "not connected" through the
 * ordinary no-row path. The marker row makes this run only on the first boot
 * after the upgrade, so keys entered afterwards survive later boots.
 */
async function rotateKeyDerivation(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS key_derivation_rotation (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        rotated_at timestamptz NOT NULL DEFAULT NOW(),
        label text NOT NULL
      )
    `);
    const marked = await client.query(
      `INSERT INTO key_derivation_rotation (id, label)
       VALUES (1, 'cadence-hkdf')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
    );
    if (marked.rowCount) {
      await client.query("DELETE FROM tempo_connection");
      await client.query("DELETE FROM anthropic_connection");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
