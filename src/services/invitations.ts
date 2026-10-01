import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { asSystem, type Tx } from "@/db";
import { invitations, memberships, organizations, users } from "@/db/schema";
import { audit, type Actor } from "@/lib/audit";
import { authenticate, normalizeEmail, validatePasswordStrength } from "@/lib/auth/service";
import type { Role } from "@/lib/auth/rbac";
import { env } from "@/lib/env";
import { hashPassword, randomToken, sha256, verifyPassword } from "@/lib/security/crypto";

/** Short-lived, path-scoped cookie that hands the last invitation link to the admin who created it (settings page). */
export const INVITE_LINK_COOKIE = "beacon_invite_link";

/** How long an invitation link stays valid. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const INVITE_ERRORS = {
  invalid: "This invitation is invalid or has expired. Ask an administrator for a new one.",
  credentials: "Invalid email or password.",
  name: "Enter your name.",
  mismatch: "The two passwords do not match.",
  member: "This person is already a member.",
} as const;

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The invitation email (plain text and HTML); the link is the only credential and expires in 7 days. */
export function invitationEmail(i: { to: string; link: string; orgName: string; inviter: string; role: string }) {
  const role = i.role.toLowerCase();
  const text = [
    `${i.inviter} invited you to join ${i.orgName} on Novarys Beacon as ${role}.`,
    "",
    `Accept the invitation: ${i.link}`,
    "",
    "You will set your own password, or sign in if you already use Beacon. The link expires in 7 days. If you did not expect this email, ignore it.",
  ].join("\n");
  const html = `<p>${esc(i.inviter)} invited you to join <strong>${esc(i.orgName)}</strong> on Novarys Beacon as ${esc(role)}.</p><p><a href="${esc(i.link)}">Accept the invitation</a></p><p>You will set your own password, or sign in if you already use Beacon. The link expires in 7 days. If you did not expect this email, ignore it.</p>`;
  return { to: i.to, subject: `Invitation to join ${i.orgName} on Beacon`, text, html };
}

export const invitationLink = (token: string) => `${env().BEACON_BASE_URL.replace(/\/+$/, "")}/invite/${token}`;

/**
 * Invites `email` with `role`. Nobody is attached to the organisation until
 * they accept; the result is the same whether or not the email already has
 * a Beacon account (no account enumeration). A pending invitation for the
 * same email is replaced. Returns the raw token (only its hash is stored).
 */
export async function createInvitation(tx: Tx, actor: Actor, input: { email: string; role: Role }) {
  const email = normalizeEmail(input.email);
  // Users are global identities: the membership check needs the system role, scoped to this organisation.
  const already = await asSystem(async (stx) => {
    const [row] = await stx
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, actor.organizationId), eq(users.email, email)))
      .limit(1);
    return Boolean(row);
  });
  if (already) throw new Error(INVITE_ERRORS.member);
  const now = new Date();
  await tx
    .update(invitations)
    .set({ revokedAt: now })
    .where(and(eq(invitations.organizationId, actor.organizationId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  const token = randomToken(32);
  const [inv] = await tx
    .insert(invitations)
    .values({ organizationId: actor.organizationId, email, role: input.role, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + INVITATION_TTL_MS), invitedBy: actor.userId ?? null })
    .returning();
  await audit(tx, actor, "member.invite", "invitation", inv.id, { role: input.role });
  return { invitation: inv, token, link: invitationLink(token) };
}

/** Pending (not accepted, not revoked, not expired) invitations of the organisation, newest first. */
export async function pendingInvitations(tx: Tx, organizationId: string) {
  return tx
    .select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
    .from(invitations)
    .where(and(eq(invitations.organizationId, organizationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt))
    .limit(100);
}

export async function revokeInvitation(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, id), eq(invitations.organizationId, actor.organizationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id });
  if (!row) throw new Error("Invitation not found");
  await audit(tx, actor, "member.invite_revoke", "invitation", row.id);
}

/**
 * The pending invitation behind a raw token (and its organisation), or null.
 * Resolved with system privileges: the token is the only credential here.
 */
export async function invitationByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  return asSystem(async (tx) => {
    const [row] = await tx
      .select({ invitation: invitations, orgName: organizations.name, displayName: organizations.branding })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .where(and(eq(invitations.tokenHash, sha256(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
      .limit(1);
    if (!row) return null;
    return { invitation: row.invitation, orgName: row.displayName.displayName ?? row.orgName };
  });
}

export type AcceptInput =
  | { token: string; mode: "create"; name: string; password: string; confirm: string; ipHash?: string }
  | { token: string; mode: "signin"; password: string; ipHash?: string };
export type AcceptResult = { ok: true; userId: string; organizationId: string } | { ok: false; error: string };

/**
 * Accepts an invitation. "create" sets the invitee's own password (strength
 * rules apply); "signin" proves an existing account with its password. Both
 * paths answer with the same generic errors, so the page never states whether
 * the invited email already has an account. Acceptance is atomic: the
 * invitation row is locked, re-checked and consumed in one transaction.
 */
export async function acceptInvitation(input: AcceptInput): Promise<AcceptResult> {
  const found = await invitationByToken(input.token);
  if (!found) return { ok: false, error: INVITE_ERRORS.invalid };
  const email = found.invitation.email;

  let userId: string | null = null;
  let newUser: { name: string; passwordHash: string } | null = null;
  if (input.mode === "signin") {
    const auth = await authenticate(email, input.password, { ipHash: input.ipHash });
    if (!auth.ok) return { ok: false, error: auth.reason === "throttled" ? "Too many failed attempts. Wait a moment and try again." : INVITE_ERRORS.credentials };
    userId = auth.userId;
  } else {
    const name = input.name.trim();
    if (!name) return { ok: false, error: INVITE_ERRORS.name };
    const weak = validatePasswordStrength(input.password);
    if (weak) return { ok: false, error: weak };
    if (input.password !== input.confirm) return { ok: false, error: INVITE_ERRORS.mismatch };
    const existing = await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.email, email) }));
    if (existing) {
      // The address already has an account: only its own password accepts (never overwritten).
      if (!(await verifyPassword(input.password, existing.passwordHash))) return { ok: false, error: INVITE_ERRORS.credentials };
      userId = existing.id;
    } else newUser = { name: name.slice(0, 120), passwordHash: await hashPassword(input.password) };
  }

  return asSystem(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, found.invitation.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
      .for("update");
    if (!inv) return { ok: false, error: INVITE_ERRORS.invalid } as const;
    let uid = userId;
    if (!uid && newUser) {
      const [created] = await tx.insert(users).values({ email, name: newUser.name, passwordHash: newUser.passwordHash }).onConflictDoNothing().returning({ id: users.id });
      if (!created) return { ok: false, error: INVITE_ERRORS.credentials } as const;
      uid = created.id;
    }
    if (!uid) return { ok: false, error: INVITE_ERRORS.invalid } as const;
    // An existing membership keeps its role (an invitation never changes it).
    await tx.insert(memberships).values({ organizationId: inv.organizationId, userId: uid, role: inv.role }).onConflictDoNothing();
    await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: uid }).where(eq(invitations.id, inv.id));
    await audit(tx, { organizationId: inv.organizationId, userId: uid, actorType: "USER", ipHash: input.ipHash }, "member.invite_accept", "invitation", inv.id, { role: inv.role, newAccount: Boolean(newUser) });
    return { ok: true, userId: uid, organizationId: inv.organizationId } as const;
  });
}
