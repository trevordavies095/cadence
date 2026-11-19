import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/session";

/** Pages that load without a session. */
const OPEN_PAGES = new Set(["/login", "/health"]);

/**
 * Sign in with Tempo (ADR 0008). With CADENCE_AUTH_TEMPO_URL set, a page load without the
 * session cookie goes to /login. Presence only: the API verifies the cookie on every call and
 * answers 401, which also sends the page to /login. Off, every page loads as before.
 */
export function proxy(request: NextRequest) {
  if (!process.env.CADENCE_AUTH_TEMPO_URL?.trim()) return NextResponse.next();
  const { pathname } = request.nextUrl;
  // The API gates itself and answers 401 rather than a redirect.
  if (pathname.startsWith("/api/") || OPEN_PAGES.has(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|webmanifest)$).*)"],
};
