import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { asSystem, closeDb } from "@/db";
import { memberships, organizations, sessions, users } from "@/db/schema";
import { authenticate, createOrganizationWithOwner, createSession, destroySession, resolveSession } from "@/lib/auth/service";
import { sha256 } from "@/lib/security/crypto";
import { newOrg, PASSWORD, uid } from "./helpers";

afterAll(closeDb);

describe("auth service", () => {
  it("createOrganizationWithOwner creates org, user (normalised email, hashed password) and OWNER membership", async () => {
    const id = uid();
    const { org, user } = await createOrganizationWithOwner({ orgName: "Auth Org", orgSlug: `auth-${id}`, email: `  Mixed.Case-${id}@Example.TEST `, name: "Owner", password: PASSWORD });
    expect(org.slug).toBe(`auth-${id}`);
    expect(org.settings.attribution).toEqual({ model: "LAST_TOUCH", lookbackDays: 30, referralPrecedence: true });
    expect(user.email).toBe(`mixed.case-${id}@example.test`);
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    const m = await asSystem((tx) => tx.select().from(memberships).where(eq(memberships.organizationId, org.id)));
    expect(m).toEqual([expect.objectContaining({ userId: user.id, role: "OWNER" })]);
  });

  it("rejects weak passwords and duplicate org slugs", async () => {
    await expect(createOrganizationWithOwner({ orgName: "W", orgSlug: `w-${uid()}`, email: `w-${uid()}@example.test`, name: "W", password: "short" })).rejects.toThrow(/at least 12/);
    const { org } = await newOrg("dup");
    await expect(createOrganizationWithOwner({ orgName: "Dup", orgSlug: org.slug, email: `d-${uid()}@example.test`, name: "D", password: PASSWORD })).rejects.toThrow();
  });

  it("authenticate succeeds with the right password (case-insensitive email) and fails otherwise", async () => {
    const { user, email } = await newOrg("authn");
    expect(await authenticate(email.toUpperCase(), PASSWORD)).toEqual({ ok: true, userId: user.id });
    expect(await authenticate(email, "wrong password 123")).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticate(`nobody-${uid()}@example.test`, PASSWORD)).toEqual({ ok: false, reason: "invalid" });
    const u = await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.id, user.id) }));
    expect(u!.failedLoginCount).toBe(1);
    // A successful login resets the counter.
    expect((await authenticate(email, PASSWORD)).ok).toBe(true);
    const u2 = await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.id, user.id) }));
    expect(u2!.failedLoginCount).toBe(0);
    expect(u2!.lastLoginAt).toBeInstanceOf(Date);
  });

  it("locks the account after 10 failures, even for the correct password", async () => {
    const { user, email } = await newOrg("lock");
    for (let i = 0; i < 9; i++) expect(await authenticate(email, `bad password ${i}`)).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticate(email, "bad password 10")).toEqual({ ok: false, reason: "invalid" });
    const u = await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.id, user.id) }));
    expect(u!.failedLoginCount).toBe(10);
    expect(u!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(await authenticate(email, PASSWORD)).toEqual({ ok: false, reason: "locked" });
    // Once the lock expires, the right password works again.
    await asSystem((tx) => tx.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, user.id)));
    expect(await authenticate(email, PASSWORD)).toEqual({ ok: true, userId: user.id });
  });

  it("createSession + resolveSession returns user, org and role; stores only the token hash", async () => {
    const { org, user } = await newOrg("sess");
    const { token, expiresAt } = await createSession(user.id, { ipHash: "iphash", userAgent: "x".repeat(500) });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const row = await asSystem((tx) => tx.query.sessions.findFirst({ where: eq(sessions.tokenHash, sha256(token)) }));
    expect(row).toBeDefined();
    expect(row!.organizationId).toBe(org.id);
    expect(row!.userAgent!.length).toBe(300);
    const none = await asSystem((tx) => tx.query.sessions.findFirst({ where: eq(sessions.tokenHash, token) }));
    expect(none).toBeUndefined();

    const ctx = await resolveSession(token);
    expect(ctx).not.toBeNull();
    expect(ctx!.user).toEqual({ id: user.id, email: user.email, name: user.name });
    expect(ctx!.org.id).toBe(org.id);
    expect(ctx!.org.slug).toBe(org.slug);
    expect(ctx!.role).toBe("OWNER");
    expect(ctx!.sessionTokenHash).toBe(sha256(token));
  });

  it("expired, unknown, malformed or destroyed tokens resolve to null", async () => {
    const { user } = await newOrg("sess2");
    expect(await resolveSession(null)).toBeNull();
    expect(await resolveSession("short")).toBeNull();
    expect(await resolveSession("u".repeat(43))).toBeNull();

    const expired = await createSession(user.id);
    await asSystem((tx) => tx.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, sha256(expired.token))));
    expect(await resolveSession(expired.token)).toBeNull();

    const live = await createSession(user.id);
    expect(await resolveSession(live.token)).not.toBeNull();
    await destroySession(live.token);
    expect(await resolveSession(live.token)).toBeNull();
    const gone = await asSystem((tx) => tx.query.sessions.findFirst({ where: eq(sessions.tokenHash, sha256(live.token)) }));
    expect(gone).toBeUndefined();
  });

  it("a session whose membership was removed no longer resolves", async () => {
    const { org, user } = await newOrg("sess3");
    const s = await createSession(user.id);
    await asSystem((tx) => tx.delete(memberships).where(eq(memberships.organizationId, org.id)));
    expect(await resolveSession(s.token)).toBeNull();
    // Deleting the org nulls the session's organization (FK set null) → still null.
    await asSystem((tx) => tx.delete(organizations).where(eq(organizations.id, org.id)));
    expect(await resolveSession(s.token)).toBeNull();
  });
});
