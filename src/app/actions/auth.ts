"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate, createOrganizationWithOwner, createSession, destroySession, hasAnyUser, recoverPassword } from "@/lib/auth/service";
import { SESSION_COOKIE, clientIpHash, sessionTokenFrom } from "@/lib/auth/session";
import { SESSION_COOKIE_LEGACY } from "@/core/auth/session-policy";
import { setSessionCookie } from "@/lib/auth/cookie";
import { rateLimit } from "@/lib/security/rate-limit";
import { hmac, safeEqual } from "@/lib/security/crypto";
import { slugify } from "@/core/util/text";
import { withFlash } from "@/lib/flash";

/** Anonymous (signed-out) error flash for the login and setup pages. */
const fail = (path: string, msg: string) => withFlash(path, "error", msg, null);

const LoginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(256) });

export async function loginAction(fd: FormData) {
  const parsed = LoginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) redirect(fail("/login", "Enter a valid email and password."));
  const ipHash = await clientIpHash();
  const [byIp, byEmail] = await Promise.all([rateLimit(`login:ip:${ipHash}`, 20, 900), rateLimit(`login:email:${hmac(parsed.data.email.toLowerCase(), "email")}`, 10, 900)]);
  if (!byIp.allowed || !byEmail.allowed) redirect(fail("/login", "Too many attempts. Try again in 15 minutes."));
  const res = await authenticate(parsed.data.email, parsed.data.password, { ipHash });
  if (!res.ok) redirect(fail("/login", res.reason === "throttled" ? "Too many failed attempts. Wait a moment and try again." : "Invalid email or password."));
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
    if (!safeEqual(given, expected)) redirect(fail("/setup", "Invalid setup token."));
  } else if (process.env.NODE_ENV === "production") redirect(fail("/setup", "Set BEACON_SETUP_TOKEN to enable first-run setup."));
  const { setupToken: _t, ...fields } = Object.fromEntries(fd.entries());
  const parsed = SetupSchema.safeParse(fields);
  if (!parsed.success) redirect(fail("/setup", parsed.error.issues[0].path.join(".") + ": " + parsed.error.issues[0].message));
  const ipHash = await clientIpHash();
  if (!(await rateLimit(`setup:${ipHash}`, 5, 3600)).allowed) redirect(fail("/setup", "Too many attempts."));
  let userId: string;
  try {
    const { user } = await createOrganizationWithOwner({ orgName: parsed.data.orgName, orgSlug: slugify(parsed.data.orgName) || "org", email: parsed.data.email, name: parsed.data.name, password: parsed.data.password });
    userId = user.id;
  } catch (e) {
    redirect(fail("/setup", (e as Error).message));
  }
  const { token } = await createSession(userId, { ipHash });
  await setSessionCookie(token);
  redirect("/");
}

const RecoverSchema = z.object({ email: z.string().email().max(320), token: z.string().min(1).max(512), password: z.string().min(1).max(256), confirm: z.string().min(1).max(256) });

/** Password recovery with the operator's BEACON_RECOVERY_TOKEN (see recoverPassword). */
export async function recoverAction(fd: FormData) {
  const parsed = RecoverSchema.safeParse({ email: fd.get("email"), token: fd.get("token"), password: fd.get("password"), confirm: fd.get("confirm") });
  if (!parsed.success) redirect(fail("/recover", "Fill in every field."));
  if (parsed.data.password !== parsed.data.confirm) redirect(fail("/recover", "The two passwords do not match."));
  const ipHash = await clientIpHash();
  if (!(await rateLimit(`recover:ip:${ipHash}`, 5, 3600)).allowed) redirect(fail("/recover", "Too many attempts. Try again in an hour."));
  const res = await recoverPassword({ email: parsed.data.email, token: parsed.data.token.trim(), password: parsed.data.password, expectedToken: process.env.BEACON_RECOVERY_TOKEN, ipHash });
  if (!res.ok) {
    if (res.reason === "disabled") redirect(fail("/recover", "Password recovery is not enabled on this server. Ask the operator to set a recovery code."));
    if (res.reason === "weak") redirect(fail("/recover", res.message ?? "Choose a stronger password."));
    if (res.reason === "unknown_email") redirect(fail("/recover", "The recovery code is right, but no Beacon account uses this email address. Use the address you created the workspace with."));
    redirect(fail("/recover", "The recovery code is not valid."));
  }
  redirect(withFlash("/login", "ok", "Password updated. Sign in with your new password.", null));
}
