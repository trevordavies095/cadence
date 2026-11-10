/**
 * Sign in with Tempo (ADR 0008). The API answers 401 `auth_required` when the session is
 * missing, forged or expired, and clears the cookie; the page then goes to sign in.
 */

/** Must match the API's cookie name. The proxy checks only that it is present. */
export const SESSION_COOKIE = "cadence_session";

export function isSignedOut(status: number, body: string): boolean {
  if (status !== 401) return false;
  try {
    return (JSON.parse(body) as { error?: unknown }).error === "auth_required";
  } catch {
    return false;
  }
}

/**
 * Leave for the sign-in page. Never settles, so the page keeps its loading state instead
 * of flashing an error while the browser navigates away.
 */
export function goToSignIn(): Promise<never> {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load, so nothing from the signed-out page stays in memory
  if (typeof window !== "undefined") window.location.assign("/login");
  return new Promise<never>(() => {});
}

export type SignInResult = "ok" | "invalid" | "unreachable" | "throttled" | "failed";

export async function signIn(username: string, password: string): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return "unreachable";
  }
  if (res.ok) return "ok";
  if (res.status === 429) return "throttled";
  if (res.status === 401 || res.status === 400) return "invalid";
  if (res.status === 502 || res.status === 503 || res.status === 504) return "unreachable";
  return "failed";
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load, so nothing from the signed-out page stays in memory
  window.location.assign("/login");
}
