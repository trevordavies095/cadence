/**
 * Sign in with Tempo (ADR 0008). One variable turns it on: CADENCE_AUTH_TEMPO_URL names the
 * Tempo API that checks the athlete's username and password. Unset, Cadence has no login.
 */

/** The placeholder shipped in docker-compose.yml and .env.example. */
export const PLACEHOLDER_SECRETS: readonly string[] = [
  "change-me-local-dev-only-not-for-prod",
];

export type AuthConfig = {
  /** Tempo API base URL, no trailing slash. Login is checked here, and Settings uses it. */
  tempoUrl: string;
};

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/**
 * Null when sign-in is off. Throws when it is on but cannot be safe: a URL that does not
 * parse, or a data-protection secret that is missing or still the published placeholder,
 * since the session cookie is signed with a key derived from it.
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const raw = (env.CADENCE_AUTH_TEMPO_URL ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthConfigError(
      `CADENCE_AUTH_TEMPO_URL is not a valid URL: ${raw}. Set it to your Tempo API address, for example http://tempo-api:5001.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthConfigError("CADENCE_AUTH_TEMPO_URL must start with http:// or https://.");
  }
  const secret = (env.DATA_PROTECTION_SECRET_KEY ?? "").trim();
  if (!secret || PLACEHOLDER_SECRETS.includes(secret)) {
    throw new AuthConfigError(
      "Sign in with Tempo is on, but DATA_PROTECTION_SECRET_KEY is missing or still the example value. Set a real one (openssl rand -base64 32) and restart.",
    );
  }
  return { tempoUrl: raw.replace(/\/+$/, "") };
}
