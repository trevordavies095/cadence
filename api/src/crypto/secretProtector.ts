import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export type SecretPurpose = "tempo-api-key" | "anthropic-api-key";

/**
 * AES-256-GCM protector. Wrapping key is HKDF-SHA256 of DATA_PROTECTION_SECRET_KEY
 * with a purpose string so Tempo and Anthropic ciphertext are not interchangeable.
 *
 * Blob layout: nonce (12) || ciphertext || tag (16)
 */
export class SecretProtector {
  private readonly masterKey: Buffer;

  constructor(secretKey?: string) {
    const raw = (secretKey ?? process.env.DATA_PROTECTION_SECRET_KEY ?? "").trim();
    if (!raw) {
      throw new Error(
        "DATA_PROTECTION_SECRET_KEY is required to encrypt connection secrets",
      );
    }
    // Accept base64 (decoded) or arbitrary passphrase; always HKDF to 32 bytes.
    let material: Buffer;
    const b64 = Buffer.from(raw, "base64");
    material =
      b64.length >= 16 && /^[A-Za-z0-9+/]+=*$/.test(raw) ? b64 : Buffer.from(raw, "utf8");
    this.masterKey = Buffer.from(
      hkdfSync("sha256", material, Buffer.alloc(0), "cadence:master", KEY_LEN),
    );
  }

  encrypt(plaintext: string, purpose: SecretPurpose): Buffer {
    const key = this.deriveKey(purpose);
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ciphertext, tag]);
  }

  decrypt(blob: Buffer, purpose: SecretPurpose): string {
    if (blob.length < NONCE_LEN + TAG_LEN + 1) {
      throw new Error("ciphertext too short");
    }
    const nonce = blob.subarray(0, NONCE_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
    const key = this.deriveKey(purpose);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  private deriveKey(purpose: SecretPurpose): Buffer {
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.masterKey,
        Buffer.alloc(0),
        Buffer.from(`cadence:${purpose}`, "utf8"),
        KEY_LEN,
      ),
    );
  }
}

/** Last four characters for UI masking; never return full key from GET. */
export function keyLast4(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(-4);
}

export function maskKeyHint(last4: string): string {
  if (!last4) return "••••";
  return `••••${last4}`;
}
