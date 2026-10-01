"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession, destroySession } from "@/lib/auth/service";
import { clientIpHash, sessionTokenFrom } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookie";
import { rateLimit } from "@/lib/security/rate-limit";
import { hmac } from "@/lib/security/crypto";
import { withFlash } from "@/lib/flash";
import { acceptInvitation, INVITE_ERRORS } from "@/services/invitations";

const Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), token: z.string().min(20).max(200), name: z.string().max(120), password: z.string().max(256), confirm: z.string().max(256) }),
  z.object({ mode: z.literal("signin"), token: z.string().min(20).max(200), password: z.string().max(256) }),
]);

/** Accept an invitation from /invite/[token]: set a password for a new account, or sign in to an existing one. */
export async function acceptInvitationAction(fd: FormData) {
  const parsed = Schema.safeParse(Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith("$ACTION")).map(([k, v]) => [k, typeof v === "string" ? v : ""])));
  const token = typeof fd.get("token") === "string" ? String(fd.get("token")) : "";
  const back = (msg: string, mode?: string) => withFlash(`/invite/${encodeURIComponent(token)}${mode ? `?mode=${mode}` : ""}`, "error", msg, null);
  if (!parsed.success || !/^[A-Za-z0-9_-]+$/.test(token)) redirect(back(INVITE_ERRORS.invalid));
  const ipHash = await clientIpHash();
  const [byIp, byToken] = [await rateLimit(`invite:ip:${ipHash}`, 20, 900), await rateLimit(`invite:token:${hmac(token, "invite")}`, 10, 900)];
  if (!byIp.allowed || !byToken.allowed) redirect(back("Too many attempts. Try again in 15 minutes.", parsed.data.mode));
  const res = await acceptInvitation({ ...parsed.data, ipHash });
  if (!res.ok) redirect(back(res.error, parsed.data.mode));
  const store = await cookies();
  const previous = sessionTokenFrom((n) => store.get(n)?.value);
  if (previous) await destroySession(previous);
  const h = await headers();
  const { token: session } = await createSession(res.userId, { ipHash, userAgent: h.get("user-agent") ?? undefined, organizationId: res.organizationId });
  await setSessionCookie(session);
  redirect(withFlash("/", "ok", "Welcome to Beacon. Your invitation was accepted.", res.userId));
}
