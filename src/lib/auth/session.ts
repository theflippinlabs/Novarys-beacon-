import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ipHashOf } from "@/lib/http";
import { pickSessionToken, sessionCookieName } from "@/core/auth/session-policy";
import { can, ForbiddenError, type Permission } from "./rbac";
import { resolveSession, type AuthContext } from "./service";

const PRODUCTION = process.env.NODE_ENV === "production";
/** `__Host-beacon_session` in production (Secure, Path=/, no Domain), `beacon_session` in development and tests. */
export const SESSION_COOKIE = sessionCookieName(PRODUCTION);
/** Reads the session token, falling back to the pre-`__Host-` cookie name (migrated by the proxy on the next page load). */
export const sessionTokenFrom = (get: (name: string) => string | undefined) => pickSessionToken(get, PRODUCTION).token;

/**
 * The signed-in member for this request. Memoized per request with React
 * `cache()`, so a layout, a page and its actions resolve the session once.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const store = await cookies();
  return resolveSession(sessionTokenFrom((n) => store.get(n)?.value));
});

/** For pages/layouts: redirects to /login when unauthenticated. */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** For server actions: throws when the member lacks the permission. */
export async function requirePermission(permission: Permission): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, permission)) throw new ForbiddenError(permission);
  return ctx;
}

export async function clientIpHash(): Promise<string> {
  return ipHashOf(await headers());
}
