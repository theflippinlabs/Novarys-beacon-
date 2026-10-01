import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_EXEMPT, HSTS } from "@/lib/csp";

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
    if (production) res.headers.set("strict-transport-security", HSTS);
    return res;
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", https: (process.env.BEACON_BASE_URL ?? "").startsWith("https://") });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);
  if (production) res.headers.set("strict-transport-security", HSTS);
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
