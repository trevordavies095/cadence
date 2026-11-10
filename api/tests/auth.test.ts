import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthConfigError, resolveAuthConfig } from "../src/auth/config.js";
import { SESSION_COOKIE, SESSION_TTL_S, SessionSigner } from "../src/auth/session.js";
import { LOCK_MS, LoginThrottle, MAX_FAILURES, WINDOW_MS } from "../src/auth/throttle.js";
import { migrate } from "../src/migrate.js";
import { acceptAndReady, json, resetAppTables, TEST_DATA_PROTECTION_KEY } from "./helpers.js";

const TEMPO = "http://tempo.test:5001";
const START = Date.UTC(2026, 10, 9, 12, 0, 0);

type Call = { url: string; body: Record<string, unknown> };

/** A Tempo that knows one athlete. `mode` makes it fail the way a real one can. */
function fakeTempo(mode: "ok" | "down" | "error" = "ok") {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "error") return new Response("oops", { status: 500 });
    const ok = body.username === "lauren" && body.password === "correct horse battery";
    return ok
      ? new Response(JSON.stringify({ userId: "u1", username: "lauren" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "authToken=tempo-jwt; Path=/; HttpOnly",
          },
        })
      : new Response(null, { status: 401 });
  };
  return { calls, fetchImpl };
}

function setup(options?: { mode?: "ok" | "down" | "error" }) {
  const tempo = fakeTempo(options?.mode);
  let now = START;
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    auth: {
      config: { tempoUrl: TEMPO },
      fetchImpl: tempo.fetchImpl,
      now: () => now,
      failureDelayMs: 0,
    },
  });
  return {
    app,
    tempo,
    advance(ms: number) {
      now += ms;
    },
  };
}

function login(app: ReturnType<typeof createApp>, username: string, password: string) {
  return app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

/** The session cookie's value from a response, or null. */
function sessionFrom(res: Response): string | null {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`));
    if (match) return match[1] || null;
  }
  return null;
}

function withSession(value: string): RequestInit {
  return { headers: { cookie: `${SESSION_COOKIE}=${value}` } };
}

describe("resolveAuthConfig", () => {
  const secret = "a-real-secret-for-tests-only-1234567890";

  it("is off without the variable", () => {
    expect(resolveAuthConfig({ DATA_PROTECTION_SECRET_KEY: secret })).toBeNull();
    expect(resolveAuthConfig({ CADENCE_AUTH_TEMPO_URL: "  " })).toBeNull();
  });

  it("names the Tempo, without a trailing slash", () => {
    expect(
      resolveAuthConfig({ CADENCE_AUTH_TEMPO_URL: "https://tempo.example/api/", DATA_PROTECTION_SECRET_KEY: secret }),
    ).toEqual({ tempoUrl: "https://tempo.example/api" });
  });

  it("refuses the example secret, a missing secret and a bad URL", () => {
    for (const env of [
      { CADENCE_AUTH_TEMPO_URL: TEMPO, DATA_PROTECTION_SECRET_KEY: "change-me-local-dev-only-not-for-prod" },
      { CADENCE_AUTH_TEMPO_URL: TEMPO },
      { CADENCE_AUTH_TEMPO_URL: "not a url", DATA_PROTECTION_SECRET_KEY: secret },
      { CADENCE_AUTH_TEMPO_URL: "ftp://tempo", DATA_PROTECTION_SECRET_KEY: secret },
    ]) {
      expect(() => resolveAuthConfig(env)).toThrow(AuthConfigError);
    }
  });
});

describe("SessionSigner", () => {
  const signer = new SessionSigner(TEST_DATA_PROTECTION_KEY);
  const t = 1_800_000_000;

  it("accepts its own cookie until it expires", () => {
    const { value } = signer.issue(t);
    expect(signer.verify(value, t)).not.toBeNull();
    expect(signer.verify(value, t + SESSION_TTL_S - 1)).not.toBeNull();
    expect(signer.verify(value, t + SESSION_TTL_S)).toBeNull();
  });

  it("rejects a tampered cookie, another key's cookie and junk", () => {
    const { value } = signer.issue(t);
    const [body, mac] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ iat: t, exp: t + 10 * SESSION_TTL_S, n: "x" })).toString("base64url");
    expect(signer.verify(`${forged}.${mac}`, t)).toBeNull();
    expect(signer.verify(`${body}.${mac.slice(0, -2)}AA`, t)).toBeNull();
    expect(new SessionSigner("another-key-entirely-for-this-test").verify(value, t)).toBeNull();
    for (const junk of [undefined, "", "abc", "a.b.c", ".", `${body}.`]) {
      expect(signer.verify(junk, t)).toBeNull();
    }
  });

  it("is due for renewal past the halfway point", () => {
    const { session } = signer.issue(t);
    expect(SessionSigner.dueForRenewal(session, t + SESSION_TTL_S / 2)).toBe(false);
    expect(SessionSigner.dueForRenewal(session, t + SESSION_TTL_S / 2 + 1)).toBe(true);
  });
});

describe("LoginThrottle", () => {
  it("closes after ten failures in fifteen minutes, for fifteen minutes", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < MAX_FAILURES - 1; i++) throttle.recordFailure();
    expect(throttle.locked()).toBe(false);
    throttle.recordFailure();
    expect(throttle.locked()).toBe(true);
    now += LOCK_MS - 1;
    expect(throttle.locked()).toBe(true);
    now += 1;
    expect(throttle.locked()).toBe(false);
  });

  it("forgets failures older than the window, and after a success", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < MAX_FAILURES - 1; i++) throttle.recordFailure();
    now += WINDOW_MS;
    throttle.recordFailure();
    expect(throttle.locked()).toBe(false);
    for (let i = 0; i < MAX_FAILURES - 2; i++) throttle.recordFailure();
    throttle.recordSuccess();
    throttle.recordFailure();
    expect(throttle.locked()).toBe(false);
  });
});

describe("Sign in with Tempo", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    await acceptAndReady();
  });

  it("gates every route but health and sign-in", async () => {
    const { app } = setup();
    expect((await app.request("/health")).status).toBe(200);
    for (const path of ["/settings", "/disclaimer", "/home", "/thread", "/dossier"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect((await json(res)).error).toBe("auth_required");
    }
  });

  it("signs in through Tempo, sends Tempo nothing more, and keeps none of its token", async () => {
    const { app, tempo } = setup();
    const res = await login(app, " lauren ", "correct horse battery");
    expect(res.status).toBe(200);
    expect(tempo.calls).toEqual([
      {
        url: `${TEMPO}/auth/login`,
        body: { username: "lauren", password: "correct horse battery", rememberMe: false },
      },
    ]);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("authToken="))).toBe(false);
    const header = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(new RegExp(`Max-Age=${SESSION_TTL_S}`));

    const session = sessionFrom(res)!;
    expect((await app.request("/settings", withSession(session))).status).toBe(200);
  });

  it("says a wrong password is wrong, and a missing one is missing", async () => {
    const { app } = setup();
    const wrong = await login(app, "lauren", "nope");
    expect(wrong.status).toBe(401);
    expect((await json(wrong)).error).toBe("invalid_credentials");
    expect(sessionFrom(wrong)).toBeNull();
    expect((await login(app, "lauren", "")).status).toBe(400);
  });

  it("says when Tempo can't be reached, and does not count it as a failure", async () => {
    for (const mode of ["down", "error"] as const) {
      const { app } = setup({ mode });
      for (let i = 0; i < MAX_FAILURES + 1; i++) {
        const res = await login(app, "lauren", "correct horse battery");
        expect(res.status).toBe(502);
        expect((await json(res)).error).toBe("tempo_unreachable");
      }
    }
  });

  it("closes sign-in after ten wrong passwords, even to the right one, without asking Tempo", async () => {
    const { app, tempo, advance } = setup();
    for (let i = 0; i < MAX_FAILURES; i++) await login(app, "lauren", `guess ${i}`);
    const asked = tempo.calls.length;
    const closed = await login(app, "lauren", "correct horse battery");
    expect(closed.status).toBe(429);
    expect((await json(closed)).error).toBe("too_many_attempts");
    expect(tempo.calls.length).toBe(asked);
    advance(LOCK_MS);
    expect((await login(app, "lauren", "correct horse battery")).status).toBe(200);
  });

  it("renews a session past halfway, and turns an expired one away", async () => {
    const { app, advance } = setup();
    const session = sessionFrom(await login(app, "lauren", "correct horse battery"))!;

    const early = await app.request("/settings", withSession(session));
    expect(sessionFrom(early)).toBeNull();

    advance((SESSION_TTL_S / 2 + 60) * 1000);
    const renewed = await app.request("/settings", withSession(session));
    expect(renewed.status).toBe(200);
    const fresh = sessionFrom(renewed);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(session);

    advance((SESSION_TTL_S / 2) * 1000);
    const expired = await app.request("/settings", withSession(session));
    expect(expired.status).toBe(401);
    // The stale cookie is cleared, so the page is sent to sign in rather than looping.
    expect(expired.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
    expect((await app.request("/settings", withSession(fresh!))).status).toBe(200);
  });

  it("signs out by clearing the cookie", async () => {
    const { app } = setup();
    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
  });

  it("tells Settings sign-in is on, and keeps the Tempo connection on the sign-in Tempo", async () => {
    const { app } = setup();
    const session = sessionFrom(await login(app, "lauren", "correct horse battery"))!;
    const settings = await json(await app.request("/settings", withSession(session)));
    expect(settings.auth).toEqual({ enabled: true, tempoUrl: TEMPO });

    const put = await app.request("/settings/tempo", {
      method: "PUT",
      headers: { cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://somewhere-else:5001", apiKey: "tmp_key" }),
    });
    expect(put.status).toBe(200);
    expect((await json(put)).baseUrl).toBe(TEMPO);
  });

  it("changes nothing when sign-in is off", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY, auth: null });
    expect((await app.request("/settings")).status).toBe(200);
    expect((await json(await app.request("/settings"))).auth).toEqual({ enabled: false, tempoUrl: null });
    expect((await app.request("/auth/login", { method: "POST" })).status).toBe(404);
  });
});
