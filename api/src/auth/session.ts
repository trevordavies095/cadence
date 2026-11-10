import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SecretProtector } from "../crypto/secretProtector.js";

/** The sign-in cookie. Holds no identity: an instance has one athlete. */
export const SESSION_COOKIE = "cadence_session";

/** Thirty days, reissued past the halfway point so a weekly athlete is never asked again. */
export const SESSION_TTL_S = 30 * 24 * 60 * 60;

type Payload = { iat: number; exp: number; n: string };

export type Session = Payload;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export class SessionSigner {
  private readonly key: Buffer;

  constructor(dataProtectionKey?: string) {
    this.key = new SecretProtector(dataProtectionKey).signingKey("session-cookie");
  }

  /** A new session starting at `nowS` (seconds). */
  issue(nowS: number): { value: string; session: Session } {
    const session: Session = {
      iat: nowS,
      exp: nowS + SESSION_TTL_S,
      n: b64url(randomBytes(12)),
    };
    const body = b64url(Buffer.from(JSON.stringify(session), "utf8"));
    return { value: `${body}.${this.mac(body)}`, session };
  }

  /** The session when the cookie is signed by this key and not expired; null otherwise. */
  verify(value: string | undefined, nowS: number): Session | null {
    if (!value) return null;
    const dot = value.indexOf(".");
    if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
    const body = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1), "base64url");
    const expected = Buffer.from(this.mac(body), "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!isPayload(parsed)) return null;
    if (parsed.exp <= nowS || parsed.iat > nowS + 60) return null;
    return parsed;
  }

  /** True once more than half the session's life has passed. */
  static dueForRenewal(session: Session, nowS: number): boolean {
    return nowS - session.iat > (session.exp - session.iat) / 2;
  }

  private mac(body: string): string {
    return b64url(createHmac("sha256", this.key).update(body).digest());
  }
}

function isPayload(v: unknown): v is Payload {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.iat === "number" &&
    Number.isFinite(o.iat) &&
    typeof o.exp === "number" &&
    Number.isFinite(o.exp) &&
    typeof o.n === "string"
  );
}
