import { pool } from "../db.js";
import {
  keyLast4,
  maskKeyHint,
  SecretProtector,
  type SecretPurpose,
} from "../crypto/secretProtector.js";

const PURPOSE: SecretPurpose = "anthropic-api-key";

export type AnthropicConnectionView = {
  configured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};

type Row = {
  api_key_ciphertext: Buffer;
  api_key_last4: string;
  updated_at: Date;
};

export async function getAnthropicConnection(): Promise<AnthropicConnectionView> {
  const result = await pool.query<Row>(
    `SELECT api_key_ciphertext, api_key_last4, updated_at
     FROM anthropic_connection WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      configured: false,
      maskedKey: null,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    maskedKey: maskKeyHint(row.api_key_last4),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function putAnthropicConnection(
  apiKey: string,
  protector: SecretProtector,
): Promise<AnthropicConnectionView> {
  const ciphertext = protector.encrypt(apiKey, PURPOSE);
  const last4 = keyLast4(apiKey);
  await pool.query(
    `
    INSERT INTO anthropic_connection (id, api_key_ciphertext, api_key_last4, updated_at)
    VALUES (1, $1, $2, NOW())
    ON CONFLICT (id) DO UPDATE SET
      api_key_ciphertext = EXCLUDED.api_key_ciphertext,
      api_key_last4 = EXCLUDED.api_key_last4,
      updated_at = NOW()
    `,
    [ciphertext, last4],
  );
  return getAnthropicConnection();
}

export async function deleteAnthropicConnection(): Promise<void> {
  await pool.query(`DELETE FROM anthropic_connection WHERE id = 1`);
}

/** Decrypt stored Anthropic API key (server-side use only; never expose via GET). */
export async function readAnthropicApiKey(
  protector: SecretProtector,
): Promise<string | null> {
  const result = await pool.query<Row>(
    `SELECT api_key_ciphertext, api_key_last4, updated_at
     FROM anthropic_connection WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return protector.decrypt(row.api_key_ciphertext, PURPOSE);
}
