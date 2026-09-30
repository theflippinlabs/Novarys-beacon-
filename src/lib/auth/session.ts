import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { hmac } from "@/lib/security/crypto";
import { can, ForbiddenError, type Permission } from "./rbac";
import { resolveSession, type AuthContext } from "./service";

export const SESSION_COOKIE = "beacon_session";

export async function getAuthContext(): Promise<AuthContext | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

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
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return hmac(ip, "ip");
}
