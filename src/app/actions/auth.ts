"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate, createOrganizationWithOwner, createSession, destroySession, hasAnyUser } from "@/lib/auth/service";
import { SESSION_COOKIE, clientIpHash, sessionTokenFrom } from "@/lib/auth/session";
import { SESSION_COOKIE_LEGACY } from "@/core/auth/session-policy";
import { setSessionCookie } from "@/lib/auth/cookie";
import { rateLimit } from "@/lib/security/rate-limit";
import { hmac, safeEqual } from "@/lib/security/crypto";
import { slugify } from "@/core/util/text";

const LoginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(256) });

export async function loginAction(fd: FormData) {
  const parsed = LoginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) redirect("/login?error=Enter a valid email and password.");
  const ipHash = await clientIpHash();
  const [byIp, byEmail] = await Promise.all([rateLimit(`login:ip:${ipHash}`, 20, 900), rateLimit(`login:email:${hmac(parsed.data.email.toLowerCase(), "email")}`, 10, 900)]);
  if (!byIp.allowed || !byEmail.allowed) redirect("/login?error=Too many attempts. Try again in 15 minutes.");
  const res = await authenticate(parsed.data.email, parsed.data.password, { ipHash });
  if (!res.ok) redirect(`/login?error=${res.reason === "throttled" ? "Too many failed attempts. Wait a moment and try again." : "Invalid email or password."}`);
  const h = await headers();
  const { token } = await createSession(res.userId, { ipHash, userAgent: h.get("user-agent") ?? undefined });
  await setSessionCookie(token);
  redirect("/");
}

export async function logoutAction() {
  const store = await cookies();
  const token = sessionTokenFrom((n) => store.get(n)?.value);
  if (token) await destroySession(token);
  store.delete(SESSION_COOKIE);
  if (SESSION_COOKIE !== SESSION_COOKIE_LEGACY) store.delete(SESSION_COOKIE_LEGACY);
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
  // When BEACON_SETUP_TOKEN is set (required in production), first-run setup needs it,
  // so nobody else can claim a freshly deployed instance.
  const expected = process.env.BEACON_SETUP_TOKEN;
  if (expected) {
    const given = String(fd.get("setupToken") ?? "");
    if (!safeEqual(given, expected)) redirect("/setup?error=Invalid setup token.");
  } else if (process.env.NODE_ENV === "production") redirect("/setup?error=Set BEACON_SETUP_TOKEN to enable first-run setup.");
  const { setupToken: _t, ...fields } = Object.fromEntries(fd.entries());
  const parsed = SetupSchema.safeParse(fields);
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
