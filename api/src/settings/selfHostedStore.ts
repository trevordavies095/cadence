import { pool } from "../db.js";
import {
  keyLast4,
  maskKeyHint,
  SecretProtector,
  type SecretPurpose,
} from "../crypto/secretProtector.js";

const PURPOSE: SecretPurpose = "self-hosted-api-key";

export type SelfHostedConnectionView = {
  configured: boolean;
  baseUrl: string | null;
  keyConfigured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};

type Row = {
  base_url: string;
  api_key_ciphertext: Buffer | null;
  api_key_last4: string | null;
  updated_at: Date;
};

/**
 * The base URL as it will be stored, or null when it is not an absolute http(s) URL.
 * Trailing slashes are stripped; a path already ending in `/v1` is kept as given, so
 * callers append `/v1/...` only when it is absent.
 */
export function normalizeSelfHostedBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return trimmed.replace(/\/+$/, "");
}

export async function getSelfHostedConnection(): Promise<SelfHostedConnectionView> {
  const result = await pool.query<Row>(
    `SELECT base_url, api_key_ciphertext, api_key_last4, updated_at
     FROM self_hosted_connection WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      configured: false,
      baseUrl: null,
      keyConfigured: false,
      maskedKey: null,
      updatedAt: null,
    };
  }
  const keyConfigured = row.api_key_ciphertext !== null;
  return {
    configured: true,
    baseUrl: row.base_url,
    keyConfigured,
    maskedKey: keyConfigured ? maskKeyHint(row.api_key_last4 ?? "") : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Save the connection. `baseUrl` must already be normalized (normalizeSelfHostedBaseUrl).
 * `apiKey` undefined keeps the saved key, `""` removes it, any other string replaces it.
 */
export async function putSelfHostedConnection(
  baseUrl: string,
  apiKey: string | undefined,
  protector: SecretProtector,
): Promise<SelfHostedConnectionView> {
  if (apiKey === undefined) {
    // Keep whatever key is saved; a first save has none.
    await pool.query(
      `
      INSERT INTO self_hosted_connection (id, base_url, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE SET
        base_url = EXCLUDED.base_url,
        updated_at = NOW()
      `,
      [baseUrl],
    );
    return getSelfHostedConnection();
  }
  const key = apiKey.trim();
  const ciphertext = key ? protector.encrypt(key, PURPOSE) : null;
  const last4 = key ? keyLast4(key) : null;
  await pool.query(
    `
    INSERT INTO self_hosted_connection (id, base_url, api_key_ciphertext, api_key_last4, updated_at)
    VALUES (1, $1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE SET
      base_url = EXCLUDED.base_url,
      api_key_ciphertext = EXCLUDED.api_key_ciphertext,
      api_key_last4 = EXCLUDED.api_key_last4,
      updated_at = NOW()
    `,
    [baseUrl, ciphertext, last4],
  );
  return getSelfHostedConnection();
}

export async function deleteSelfHostedConnection(): Promise<void> {
  await pool.query(`DELETE FROM self_hosted_connection WHERE id = 1`);
}

/** Decrypt the stored self-hosted key (server-side use only; never expose via GET). */
export async function readSelfHostedApiKey(
  protector: SecretProtector,
): Promise<string | null> {
  const result = await pool.query<Pick<Row, "api_key_ciphertext">>(
    `SELECT api_key_ciphertext FROM self_hosted_connection WHERE id = 1`,
  );
  const blob = result.rows[0]?.api_key_ciphertext;
  if (!blob) return null;
  return protector.decrypt(Buffer.from(blob), PURPOSE);
}
