import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_EXEMPT, HSTS } from "@/lib/csp";
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE_LEGACY, SESSION_COOKIE_PROD } from "@/core/auth/session-policy";

/**
 * Production only: move a session still held in the legacy `beacon_session`
 * cookie to `__Host-beacon_session` (Secure, Path=/, no Domain), once.
 */
function migrateSessionCookie(request: NextRequest, res: NextResponse) {
  const legacy = request.cookies.get(SESSION_COOKIE_LEGACY)?.value;
  if (!legacy || request.cookies.get(SESSION_COOKIE_PROD)) return;
  res.cookies.set(SESSION_COOKIE_PROD, legacy, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000) });
  res.cookies.delete(SESSION_COOKIE_LEGACY);
}

/**
 * Per-request nonce Content-Security-Policy for HTML documents, plus HSTS in
 * production. Next.js reads the nonce from the request's CSP header and puts
 * it on its own scripts. APIs (CORS, JSON), the public tracker script and
 * static assets are excluded by the matcher and by `CSP_EXEMPT`.
 */
export function proxy(request: NextRequest) {
  const production = process.env.NODE_ENV === "production";
  if (CSP_EXEMPT.test(request.nextUrl.pathname)) {
    const res = NextResponse.next();
    if (production) {
      res.headers.set("strict-transport-security", HSTS);
      migrateSessionCookie(request, res);
    }
    return res;
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", https: (process.env.BEACON_BASE_URL ?? "").startsWith("https://") });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);
  if (production) {
    res.headers.set("strict-transport-security", HSTS);
    migrateSessionCookie(request, res);
  }
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|beacon.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
