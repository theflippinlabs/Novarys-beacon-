import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { invitations, memberships, sessions, users } from "@/db/schema";
import { createSession, resolveSession } from "@/lib/auth/service";
import { hashPassword, sha256 } from "@/lib/security/crypto";
import { acceptInvitation, createInvitation, invitationByToken, invitationEmail, INVITE_ERRORS } from "@/services/invitations";
import { newOrg, PASSWORD, uid } from "./helpers";

/**
 * Server actions run through `act()` as in production; only the Next.js
 * request APIs are replaced (cookie jar + headers) and redirect() throws.
 */
let session: string | null = null;
const jar = new Map<string, string>();
class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "beacon_session" && session ? { value: session } : jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers({ "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Redirect("/404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const { inviteMemberAction, changePasswordAction } = await import("@/app/actions/settings");

async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("_back", "/settings");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (e) {
    if (!(e instanceof Redirect)) throw e;
    const u = new URL(e.url, "http://x");
    return { ok: u.searchParams.get("ok"), error: u.searchParams.get("error") };
  }
  throw new Error("action did not redirect");
}

type Ctx = Awaited<ReturnType<typeof newOrg>>;
let A: Ctx;
let B: Ctx;
let ownerToken: string;
beforeAll(async () => {
  A = await newOrg("w2d-auth-a");
  B = await newOrg("w2d-auth-b");
  ownerToken = (await createSession(A.user.id)).token;
});
afterAll(closeDb);

describe("session idle timeout and absolute maximum", () => {
  it("ends a session unused for 24 hours and deletes it", async () => {
    const s = await createSession(A.user.id);
    await asSystem((tx) => tx.update(sessions).set({ lastSeenAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(sessions.tokenHash, sha256(s.token))));
    expect(await resolveSession(s.token)).toBeNull();
    expect(await asSystem((tx) => tx.query.sessions.findFirst({ where: eq(sessions.tokenHash, sha256(s.token)) }))).toBeUndefined();
  });

  it("slides the idle window at most once an hour", async () => {
    const s = await createSession(A.user.id);
    const recent = new Date(Date.now() - 10 * 60_000);
    await asSystem((tx) => tx.update(sessions).set({ lastSeenAt: recent }).where(eq(sessions.tokenHash, sha256(s.token))));
    expect(await resolveSession(s.token)).not.toBeNull();
    const after1 = await asSystem((tx) => tx.query.sessions.findFirst({ where: eq(sessions.tokenHash, sha256(s.token)) }));
    expect(after1!.lastSeenAt.getTime()).toBe(recent.getTime());
    await asSystem((tx) => tx.update(sessions).set({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(sessions.tokenHash, sha256(s.token))));
    expect(await resolveSession(s.token)).not.toBeNull();
    const after2 = await asSystem((tx) => tx.query.sessions.findFirst({ where: eq(sessions.tokenHash, sha256(s.token)) }));
    expect(Date.now() - after2!.lastSeenAt.getTime()).toBeLessThan(60_000);
  });

  it("ends a session 30 days after sign-in even when active", async () => {
    const s = await createSession(A.user.id);
    await asSystem((tx) => tx.update(sessions).set({ createdAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(sessions.tokenHash, sha256(s.token))));
    expect(await resolveSession(s.token)).toBeNull();
  });
});

describe("member invitations", () => {
  it("answers the same for a known and an unknown email and attaches nobody before acceptance", async () => {
    session = ownerToken;
    const [known] = await asSystem(async (tx) => tx.insert(users).values({ email: `known-${uid()}@example.test`, name: "Known", passwordHash: await hashPassword(PASSWORD) }).returning());
    const unknown = `unknown-${uid()}@example.test`;
    jar.clear();
    const r1 = await run(inviteMemberAction, { email: known.email, role: "VIEWER" });
    const link1 = JSON.parse(jar.get("beacon_invite_link")!).link as string;
    jar.clear();
    const r2 = await run(inviteMemberAction, { email: unknown, role: "VIEWER" });
    const link2 = JSON.parse(jar.get("beacon_invite_link")!).link as string;
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r1.ok!.replace(known.email, "X")).toBe(r2.ok!.replace(unknown, "X"));
    expect(link1).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
    expect(link2).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
    // Existing users are no longer attached without consent; unknown emails get no account yet.
    const m = await asSystem((tx) => tx.query.memberships.findFirst({ where: and(eq(memberships.organizationId, A.org.id), eq(memberships.userId, known.id)) }));
    expect(m).toBeUndefined();
    expect(await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.email, unknown) }))).toBeUndefined();
    // Only the hash of the token is stored.
    const rows = await withOrg(A.org.id, (tx) => tx.select().from(invitations).where(eq(invitations.organizationId, A.org.id)));
    expect(rows.some((r) => link1.endsWith(r.tokenHash))).toBe(false);
    session = null;
  });

  it("a new invitee sets their own password (strength rules) and becomes a member", async () => {
    const email = `new-${uid()}@example.test`;
    const { token } = await withOrg(A.org.id, (tx) => createInvitation(tx, A.actor, { email, role: "EDITOR" }));
    expect((await acceptInvitation({ token, mode: "create", name: "New", password: "short", confirm: "short" })).ok).toBe(false);
    expect(await acceptInvitation({ token, mode: "create", name: "New", password: "a very long pass 42", confirm: "another long pass 42" })).toEqual({ ok: false, error: INVITE_ERRORS.mismatch });
    const r = await acceptInvitation({ token, mode: "create", name: "New", password: "a very long pass 42", confirm: "a very long pass 42" });
    expect(r.ok).toBe(true);
    const m = await asSystem((tx) => tx.select().from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.organizationId, A.org.id), eq(users.email, email))));
    expect(m[0].memberships.role).toBe("EDITOR");
    // Single use.
    expect(await invitationByToken(token)).toBeNull();
    expect((await acceptInvitation({ token, mode: "signin", password: "a very long pass 42" })).ok).toBe(false);
  });

  it("an existing account signs in to accept; its password is never overwritten", async () => {
    const email = `exists-${uid()}@example.test`;
    const [u] = await asSystem(async (tx) => tx.insert(users).values({ email, name: "Exists", passwordHash: await hashPassword(PASSWORD) }).returning());
    const { token } = await withOrg(A.org.id, (tx) => createInvitation(tx, A.actor, { email, role: "ANALYST" }));
    expect(await acceptInvitation({ token, mode: "signin", password: "wrong password 42" })).toEqual({ ok: false, error: INVITE_ERRORS.credentials });
    // The "create" path cannot take over an existing account with a new password.
    expect(await acceptInvitation({ token, mode: "create", name: "Attacker", password: "attacker pass 4242", confirm: "attacker pass 4242" })).toEqual({ ok: false, error: INVITE_ERRORS.credentials });
    const r = await acceptInvitation({ token, mode: "signin", password: PASSWORD });
    expect(r).toEqual({ ok: true, userId: u.id, organizationId: A.org.id });
    const after = await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.id, u.id) }));
    expect(after!.passwordHash).toBe(u.passwordHash);
  });

  it("expired and revoked invitations are refused with the generic message", async () => {
    const email = `exp-${uid()}@example.test`;
    const { token, invitation } = await withOrg(A.org.id, (tx) => createInvitation(tx, A.actor, { email, role: "VIEWER" }));
    await withOrg(A.org.id, (tx) => tx.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, invitation.id)));
    expect(await acceptInvitation({ token, mode: "create", name: "Late", password: "a very long pass 42", confirm: "a very long pass 42" })).toEqual({ ok: false, error: INVITE_ERRORS.invalid });
    // Re-inviting the same email revokes the previous pending invitation.
    const first = await withOrg(A.org.id, (tx) => createInvitation(tx, A.actor, { email: `re-${email}`, role: "VIEWER" }));
    await withOrg(A.org.id, (tx) => createInvitation(tx, A.actor, { email: `re-${email}`, role: "VIEWER" }));
    expect(await invitationByToken(first.token)).toBeNull();
    expect(await invitationByToken("garbage")).toBeNull();
  });

  it("the invitation email escapes names and carries the link", () => {
    const m = invitationEmail({ to: "a@b.test", link: "https://beacon.test/invite/abc", orgName: "<Acme & Co>", inviter: "Eve", role: "EDITOR" });
    expect(m.html).toContain("&lt;Acme &amp; Co&gt;");
    expect(m.html).not.toContain("<Acme");
    expect(m.text).toContain("https://beacon.test/invite/abc");
    expect(m.subject).toBe("Invitation to join <Acme & Co> on Beacon");
  });

  it("invitations are tenant-isolated", async () => {
    await withOrg(A.org.id, (tx) => createInvitation(tx, A.actor, { email: `iso-${uid()}@example.test`, role: "VIEWER" }));
    const seenByB = await withOrg(B.org.id, (tx) => tx.select().from(invitations));
    expect(seenByB.every((r) => r.organizationId === B.org.id)).toBe(true);
  });

  it("refuses inviting an existing member and roles at or above the inviter's", async () => {
    session = ownerToken;
    expect((await run(inviteMemberAction, { email: A.email, role: "VIEWER" })).error).toBe(INVITE_ERRORS.member);
    const [admin] = await asSystem(async (tx) => tx.insert(users).values({ email: `admin-${uid()}@example.test`, name: "Admin", passwordHash: await hashPassword(PASSWORD) }).returning());
    await asSystem((tx) => tx.insert(memberships).values({ organizationId: A.org.id, userId: admin.id, role: "ADMIN" }));
    session = (await createSession(admin.id)).token;
    expect((await run(inviteMemberAction, { email: `x-${uid()}@example.test`, role: "ADMIN" })).error).toBe("You cannot assign a role equal to or above your own.");
    session = null;
  });
});

describe("password change", () => {
  it("is rate limited per user", async () => {
    const [u] = await asSystem(async (tx) => tx.insert(users).values({ email: `pw-${uid()}@example.test`, name: "Pw", passwordHash: await hashPassword(PASSWORD) }).returning());
    await asSystem((tx) => tx.insert(memberships).values({ organizationId: A.org.id, userId: u.id, role: "VIEWER" }));
    session = (await createSession(u.id)).token;
    const errors: (string | null)[] = [];
    for (let i = 0; i < 6; i++) errors.push((await run(changePasswordAction, { current: "wrong password 42", next: "a brand new pass 42" })).error);
    expect(errors.slice(0, 5).every((e) => e === "Current password is incorrect.")).toBe(true);
    expect(errors[5]).toBe("Too many attempts. Try again in 15 minutes.");
    session = null;
  });
});
