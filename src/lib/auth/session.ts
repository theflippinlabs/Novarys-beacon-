import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ipHashOf } from "@/lib/http";
import { can, ForbiddenError, type Permission } from "./rbac";
import { resolveSession, type AuthContext } from "./service";

export const SESSION_COOKIE = "beacon_session";

/**
 * The signed-in member for this request. Memoized per request with React
 * `cache()`, so a layout, a page and its actions resolve the session once.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
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
