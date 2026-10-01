import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE_LEGACY } from "@/core/auth/session-policy";
import { SESSION_COOKIE } from "./session";
import { SESSION_TTL_MS } from "./service";

/** Sets the session cookie (`__Host-` prefixed in production: Secure, Path=/, no Domain) and drops the legacy one. */
export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  if (SESSION_COOKIE !== SESSION_COOKIE_LEGACY && store.get(SESSION_COOKIE_LEGACY)) store.delete(SESSION_COOKIE_LEGACY);
}
