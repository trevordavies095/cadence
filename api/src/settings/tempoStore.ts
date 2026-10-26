import { pool } from "../db.js";
import {
  keyLast4,
  maskKeyHint,
  SecretProtector,
  type SecretPurpose,
} from "../crypto/secretProtector.js";

const PURPOSE: SecretPurpose = "tempo-api-key";

export type TempoConnectionView = {
  configured: boolean;
  baseUrl: string | null;
  maskedKey: string | null;
  updatedAt: string | null;
};

type Row = {
  base_url: string;
  api_key_ciphertext: Buffer;
  api_key_last4: string;
  updated_at: Date;
};

export async function getTempoConnection(): Promise<TempoConnectionView> {
  const result = await pool.query<Row>(
    `SELECT base_url, api_key_ciphertext, api_key_last4, updated_at
     FROM tempo_connection WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      configured: false,
      baseUrl: null,
      maskedKey: null,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    baseUrl: row.base_url,
    maskedKey: maskKeyHint(row.api_key_last4),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function putTempoConnection(
  baseUrl: string,
  apiKey: string,
  protector: SecretProtector,
): Promise<TempoConnectionView> {
  const ciphertext = protector.encrypt(apiKey, PURPOSE);
  const last4 = keyLast4(apiKey);
  await pool.query(
    `
    INSERT INTO tempo_connection (id, base_url, api_key_ciphertext, api_key_last4, updated_at)
    VALUES (1, $1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE SET
      base_url = EXCLUDED.base_url,
      api_key_ciphertext = EXCLUDED.api_key_ciphertext,
      api_key_last4 = EXCLUDED.api_key_last4,
      updated_at = NOW()
    `,
    [baseUrl, ciphertext, last4],
  );
  return getTempoConnection();
}

export async function deleteTempoConnection(): Promise<void> {
  await pool.query(`DELETE FROM tempo_connection WHERE id = 1`);
}

/** Decrypt stored Tempo API key (server-side use only; never expose via GET). */
export async function readTempoApiKey(
  protector: SecretProtector,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const result = await pool.query<Row>(
    `SELECT base_url, api_key_ciphertext, api_key_last4, updated_at
     FROM tempo_connection WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    apiKey: protector.decrypt(row.api_key_ciphertext, PURPOSE),
  };
}
