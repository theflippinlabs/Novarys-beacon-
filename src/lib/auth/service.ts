import { and, eq, gt, sql } from "drizzle-orm";
import { asSystem, type Tx } from "@/db";
import { memberships, organizations, sessions, users } from "@/db/schema";
import { hashPassword, hmac, randomToken, sha256, verifyPassword } from "@/lib/security/crypto";
import type { Role } from "./rbac";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failures per (email, ip) tolerated before back-off starts. */
export const LOGIN_FREE_FAILURES = 4;
export const LOGIN_MAX_BACKOFF_SEC = 900;

/** Exponential back-off after the free failures: 2s, 4s, 8s ... capped at 15 minutes. */
export function loginBackoffSeconds(failures: number): number {
  if (failures <= LOGIN_FREE_FAILURES) return 0;
  return Math.min(LOGIN_MAX_BACKOFF_SEC, 2 ** (failures - LOGIN_FREE_FAILURES));
}

export type AuthContext = {
  user: { id: string; email: string; name: string };
  org: { id: string; slug: string; name: string; settings: typeof organizations.$inferSelect.settings; branding: typeof organizations.$inferSelect.branding };
  role: Role;
  sessionTokenHash: string;
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 256) return "Password is too long.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9\W_]/.test(password)) return "Password must mix letters with digits or symbols.";
  return null;
}

export async function createOrganizationWithOwner(input: {
  orgName: string;
  orgSlug: string;
  email: string;
  name: string;
  password: string;
}) {
  const weak = validatePasswordStrength(input.password);
  if (weak) throw new Error(weak);
  const passwordHash = await hashPassword(input.password);
  return asSystem(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.orgName, slug: input.orgSlug, settings: { attribution: { model: "LAST_TOUCH", lookbackDays: 30, referralPrecedence: true } } })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({ email: normalizeEmail(input.email), name: input.name, passwordHash })
      .onConflictDoNothing()
      .returning();
    const owner = user ?? (await tx.query.users.findFirst({ where: eq(users.email, normalizeEmail(input.email)) }));
    if (!owner) throw new Error("Could not create user");
    await tx.insert(memberships).values({ organizationId: org.id, userId: owner.id, role: "OWNER" });
    return { org, user: owner };
  });
}

export async function hasAnyUser(): Promise<boolean> {
  return asSystem(async (tx) => {
    const r = await tx.execute<{ exists: boolean }>(sql`select exists(select 1 from users) as exists`);
    return Boolean(r.rows[0]?.exists);
  });
}

export type AuthResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "throttled"; retryAfterSec?: number };

const throttleKey = (email: string, ipHash: string) => hmac(`${normalizeEmail(email)}|${ipHash}`, "login");

/**
 * Constant-ish time authentication with exponential back-off per (email, ip).
 * There is no account-wide lockout, so nobody can lock a member out from
 * another address; unknown emails are throttled exactly like real ones, so the
 * response never reveals whether an account exists. Counters are updated with
 * one atomic upsert (no read-modify-write race between parallel attempts).
 */
export async function authenticate(email: string, password: string, opts: { ipHash?: string } = {}): Promise<AuthResult> {
  const key = throttleKey(email, opts.ipHash ?? "unknown");
  return asSystem(async (tx) => {
    const t = await tx.execute<{ wait: number }>(sql`select ceil(extract(epoch from (blocked_until - now())))::int as wait from login_throttle where key = ${key} and blocked_until > now()`);
    if (t.rows[0]) return { ok: false, reason: "throttled", retryAfterSec: Math.max(1, Number(t.rows[0].wait)) } as const;
    const user = await tx.query.users.findFirst({ where: eq(users.email, normalizeEmail(email)) });
    const valid = user
      ? await verifyPassword(password, user.passwordHash)
      : // Burn comparable time to avoid user enumeration by timing.
        await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86)).then(() => false);
    if (!user || !valid) {
      await tx.execute(sql`
        insert into login_throttle (key, failures, blocked_until, updated_at) values (${key}, 1, null, now())
        on conflict (key) do update set
          failures = login_throttle.failures + 1,
          blocked_until = case when login_throttle.failures + 1 > ${LOGIN_FREE_FAILURES}
            then now() + make_interval(secs => least(${LOGIN_MAX_BACKOFF_SEC}, power(2, login_throttle.failures + 1 - ${LOGIN_FREE_FAILURES})))
            else null end,
          updated_at = now()`);
      return { ok: false, reason: "invalid" } as const;
    }
    await tx.execute(sql`delete from login_throttle where key = ${key}`);
    await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return { ok: true, userId: user.id } as const;
  });
}

export async function purgeLoginThrottle(olderThanHours = 24) {
  await asSystem((tx) => tx.execute(sql`delete from login_throttle where updated_at < now() - make_interval(hours => ${olderThanHours})`));
}

export async function createSession(userId: string, meta: { ipHash?: string; userAgent?: string } = {}) {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  await asSystem(async (tx) => {
    const membership = await tx.query.memberships.findFirst({ where: eq(memberships.userId, userId) });
    await tx.insert(sessions).values({
      tokenHash,
      userId,
      organizationId: membership?.organizationId ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ipHash: meta.ipHash,
      userAgent: meta.userAgent?.slice(0, 300),
    });
  });
  return { token, expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
}

export async function resolveSession(token: string | undefined | null): Promise<AuthContext | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = sha256(token);
  return asSystem(async (tx) => {
    const session = await tx.query.sessions.findFirst({ where: and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())) });
    if (!session?.organizationId) return null;
    return loadContext(tx, session.userId, session.organizationId, tokenHash);
  });
}

async function loadContext(tx: Tx, userId: string, organizationId: string, tokenHash: string): Promise<AuthContext | null> {
  const rows = await tx
    .select({ user: users, org: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    user: { id: row.user.id, email: row.user.email, name: row.user.name },
    org: { id: row.org.id, slug: row.org.slug, name: row.org.name, settings: row.org.settings, branding: row.org.branding },
    role: row.role,
    sessionTokenHash: tokenHash,
  };
}

export async function destroySession(token: string) {
  await asSystem((tx) => tx.delete(sessions).where(eq(sessions.tokenHash, sha256(token))));
}

export async function purgeExpiredSessions() {
  await asSystem((tx) => tx.execute(sql`delete from sessions where expires_at < now()`));
}
