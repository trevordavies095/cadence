import { pool } from "../db.js";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION } from "./text.js";

export type DisclaimerState = {
  accepted: boolean;
  acceptedAt: string | null;
  version: string;
  text: string;
};

type Row = {
  accepted_at: Date;
  disclaimer_version: string;
};

export async function isDisclaimerAccepted(): Promise<boolean> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM disclaimer_acceptance WHERE id = 1`,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getDisclaimerState(): Promise<DisclaimerState> {
  const result = await pool.query<Row>(
    `SELECT accepted_at, disclaimer_version FROM disclaimer_acceptance WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      accepted: false,
      acceptedAt: null,
      version: DISCLAIMER_VERSION,
      text: DISCLAIMER_TEXT,
    };
  }
  return {
    accepted: true,
    acceptedAt: row.accepted_at.toISOString(),
    version: row.disclaimer_version,
    text: DISCLAIMER_TEXT,
  };
}

/** Persist acceptance. Idempotent if already accepted. */
export async function acceptDisclaimer(): Promise<DisclaimerState> {
  await pool.query(
    `
    INSERT INTO disclaimer_acceptance (id, accepted_at, disclaimer_version)
    VALUES (1, NOW(), $1)
    ON CONFLICT (id) DO NOTHING
    `,
    [DISCLAIMER_VERSION],
  );
  return getDisclaimerState();
}
