"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate, createOrganizationWithOwner, createSession, destroySession, hasAnyUser, SESSION_TTL_MS } from "@/lib/auth/service";
import { SESSION_COOKIE, clientIpHash } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { hmac } from "@/lib/security/crypto";
import { slugify } from "@/core/util/text";

async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

const LoginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(256) });

export async function loginAction(fd: FormData) {
  const parsed = LoginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) redirect("/login?error=Enter a valid email and password.");
  const ipHash = await clientIpHash();
  const [byIp, byEmail] = await Promise.all([rateLimit(`login:ip:${ipHash}`, 20, 900), rateLimit(`login:email:${hmac(parsed.data.email.toLowerCase(), "email")}`, 10, 900)]);
  if (!byIp.allowed || !byEmail.allowed) redirect("/login?error=Too many attempts. Try again in 15 minutes.");
  const res = await authenticate(parsed.data.email, parsed.data.password);
  if (!res.ok) redirect(`/login?error=${res.reason === "locked" ? "Account temporarily locked after repeated failures." : "Invalid email or password."}`);
  const h = await headers();
  const { token } = await createSession(res.userId, { ipHash, userAgent: h.get("user-agent") ?? undefined });
  await setSessionCookie(token);
  redirect("/");
}

export async function logoutAction() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(token);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

const SetupSchema = z.object({
  orgName: z.string().min(2).max(80),
  name: z.string().min(1).max(120),
  email: z.string().email().max(320),
  password: z.string().min(12).max(256),
});

/** First-run bootstrap: only available while no user exists. */
export async function setupAction(fd: FormData) {
  if (await hasAnyUser()) redirect("/login");
  const parsed = SetupSchema.safeParse(Object.fromEntries(fd.entries()));
  if (!parsed.success) redirect(`/setup?error=${encodeURIComponent(parsed.error.issues[0].path.join(".") + ": " + parsed.error.issues[0].message)}`);
  const ipHash = await clientIpHash();
  if (!(await rateLimit(`setup:${ipHash}`, 5, 3600)).allowed) redirect("/setup?error=Too many attempts.");
  let userId: string;
  try {
    const { user } = await createOrganizationWithOwner({ orgName: parsed.data.orgName, orgSlug: slugify(parsed.data.orgName) || "org", email: parsed.data.email, name: parsed.data.name, password: parsed.data.password });
    userId = user.id;
  } catch (e) {
    redirect(`/setup?error=${encodeURIComponent((e as Error).message)}`);
  }
  const { token } = await createSession(userId, { ipHash });
  await setSessionCookie(token);
  redirect("/");
}
