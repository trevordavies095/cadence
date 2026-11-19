import { Hono, type MiddlewareHandler } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthConfig } from "./config.js";
import { SESSION_COOKIE, SESSION_TTL_S, SessionSigner } from "./session.js";
import { LoginThrottle } from "./throttle.js";

/** Reachable without a session: health checks and signing in or out. */
const OPEN_PATHS = new Set(["/health", "/ready", "/auth/login", "/auth/logout"]);

/** How long Tempo gets to answer a sign-in. */
const TEMPO_LOGIN_TIMEOUT_MS = 10_000;

export type AuthOptions = {
  config: AuthConfig;
  /** Override DATA_PROTECTION_SECRET_KEY (tests). */
  dataProtectionKey?: string;
  /** Fetch used to reach Tempo (tests inject a fake). */
  fetchImpl?: typeof globalThis.fetch;
  /** Wall clock in ms (tests). Real time, never the pinned app clock. */
  now?: () => number;
  /** Wait before answering a failed sign-in, in ms. Default 1000; tests set 0. */
  failureDelayMs?: number;
};

export type Auth = {
  /** The gate: 401 `auth_required` for any request without a valid session. */
  middleware: MiddlewareHandler;
  routes: Hono;
};

function cookieOptions(maxAgeS: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: maxAgeS,
  };
}

function setSession(c: Context, signer: SessionSigner, nowS: number): void {
  const { value } = signer.issue(nowS);
  setCookie(c, SESSION_COOKIE, value, cookieOptions(SESSION_TTL_S));
}

function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

type TempoVerdict = "ok" | "rejected" | "unreachable";

/** Ask Tempo whether the password is right. Tempo's token and cookie are thrown away. */
async function askTempo(
  config: AuthConfig,
  fetchImpl: typeof globalThis.fetch,
  username: string,
  password: string,
): Promise<TempoVerdict> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.tempoUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password, rememberMe: false }),
      signal: AbortSignal.timeout(TEMPO_LOGIN_TIMEOUT_MS),
      credentials: "omit",
      redirect: "manual",
    });
  } catch {
    return "unreachable";
  }
  // Drain the body so the connection is released; nothing in it is kept.
  await res.arrayBuffer().catch(() => undefined);
  if (res.ok) return "ok";
  if (res.status === 400 || res.status === 401) return "rejected";
  return "unreachable";
}

export function createAuth(options: AuthOptions): Auth {
  const { config } = options;
  const signer = new SessionSigner(options.dataProtectionKey);
  const now = options.now ?? Date.now;
  const nowS = () => Math.floor(now() / 1000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const failureDelayMs = options.failureDelayMs ?? 1000;
  const throttle = new LoginThrottle(now);

  const middleware: MiddlewareHandler = async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) return next();
    const session = signer.verify(getCookie(c, SESSION_COOKIE), nowS());
    if (!session) {
      clearSession(c);
      return c.json({ error: "auth_required" }, 401);
    }
    if (SessionSigner.dueForRenewal(session, nowS())) setSession(c, signer, nowS());
    return next();
  };

  const routes = new Hono();

  routes.post("/auth/login", async (c) => {
    if (throttle.locked()) return c.json({ error: "too_many_attempts" }, 429);
    let body: { username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      return c.json({ error: "username_and_password_required" }, 400);
    }

    const verdict = await askTempo(config, fetchImpl, username, password);
    if (verdict === "unreachable") return c.json({ error: "tempo_unreachable" }, 502);
    if (verdict === "rejected") {
      throttle.recordFailure();
      if (failureDelayMs > 0) await new Promise((r) => setTimeout(r, failureDelayMs));
      return c.json({ error: "invalid_credentials" }, 401);
    }
    throttle.recordSuccess();
    setSession(c, signer, nowS());
    return c.json({ signedIn: true });
  });

  routes.post("/auth/logout", (c) => {
    clearSession(c);
    return c.json({ signedIn: false });
  });

  return { middleware, routes };
}
