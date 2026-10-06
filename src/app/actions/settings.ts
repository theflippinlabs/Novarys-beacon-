"use server";

import { and, eq, ne } from "drizzle-orm";
import { cleanApiKey } from "@/ai/registry";
import { z } from "zod";
import { asSystem } from "@/db";
import { integrations, memberships, organizations, products, sessions, users } from "@/db/schema";
import { act, actStaged, zId, zOptText } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { canAssignRole, ROLES } from "@/lib/auth/rbac";
import { hashPassword, verifyPassword } from "@/lib/security/crypto";
import { validatePasswordStrength } from "@/lib/auth/service";
import { rateLimit } from "@/lib/security/rate-limit";
import { createInvitation, INVITE_LINK_COOKIE, invitationEmail, revokeInvitation } from "@/services/invitations";
import { emailConfig, sendEmail } from "@/integrations/email";
import { log } from "@/lib/logger";
import { cookies } from "next/headers";
import { enqueue, retryJob } from "@/jobs/queue";
import { catalogEntry, INTEGRATION_CATALOG, INTEGRATION_PROVIDERS, isSyncableProvider } from "@/integrations/registry";
import { saveIntegration } from "@/services/visibility";
import { checkIntegration, parseSites } from "@/services/integration-health";
import { reprocessInbox } from "@/services/stripe";

export async function updateOrgSettingsAction(fd: FormData) {
  return act(
    fd,
    "settings:manage",
    z.object({
      displayName: zOptText(80),
      model: z.enum(["LAST_TOUCH", "FIRST_TOUCH", "LINEAR", "POSITION_BASED"]),
      lookbackDays: z.coerce.number().int().min(1).max(180),
      referralPrecedence: z.string().optional(),
      crossSellDailyCap: z.coerce.number().int().min(0).max(10),
    }),
    async ({ tx, actor }, i) => {
      const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
      if (!org) throw new Error("Organisation not found");
      await tx
        .update(organizations)
        .set({
          branding: { ...org.branding, displayName: i.displayName ?? undefined },
          settings: { ...org.settings, attribution: { model: i.model, lookbackDays: i.lookbackDays, referralPrecedence: i.referralPrecedence === "on" }, crossSell: { globalDailyCap: i.crossSellDailyCap } },
        })
        .where(eq(organizations.id, org.id));
      await audit(tx, actor, "org.settings", "organization", org.id, { attribution: i.model, lookbackDays: i.lookbackDays });
      return { ok: "Settings saved. Attribution rules apply to new events." };
    },
  );
}

/**
 * Turn the organisation's public surfaces (hosted pages, sitemap, llms.txt,
 * entity and published APIs, /ask) on or off. Off answers 404 everywhere.
 */
export async function setPublicSiteAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ enabled: z.enum(["true", "false"]) }), async ({ tx, actor }, i) => {
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
    if (!org) throw new Error("Organisation not found");
    const enabled = i.enabled === "true";
    await tx.update(organizations).set({ settings: { ...org.settings, publicSiteEnabled: enabled } }).where(eq(organizations.id, org.id));
    await audit(tx, actor, enabled ? "org.public_site_enabled" : "org.public_site_disabled", "organization", org.id, { publicSiteEnabled: enabled });
    return { ok: enabled ? "Public site turned on." : "Public site turned off: public URLs now answer 404." };
  });
}

const ROLE = z.enum(ROLES);

/**
 * Invites a member. Nobody is attached without accepting: the invitee opens
 * the link, sets their own password or signs in to an existing account. The
 * answer is identical whether or not the email already has a Beacon account.
 */
export async function inviteMemberAction(fd: FormData) {
  return actStaged(fd, "member:manage", z.object({ email: z.string().email().max(320), role: ROLE }), async ({ actor, ctx, run }, i) => {
    if (!canAssignRole(ctx.role, i.role)) throw new Error("You cannot assign a role equal to or above your own.");
    const limit = await rateLimit(`invite:create:${ctx.user.id}`, 30, 3600);
    if (!limit.allowed) throw new Error("Too many invitations. Try again later.");
    const { link, invitation } = await run((tx) => createInvitation(tx, actor, { email: i.email, role: i.role }));
    // With an email provider connected, the link goes to the invitee only (sent with no transaction open).
    if (emailConfig().configured) {
      try {
        await sendEmail(invitationEmail({ to: invitation.email, link, orgName: ctx.org.branding.displayName ?? ctx.org.name, inviter: ctx.user.name, role: i.role }));
        return { ok: `Invitation emailed to ${invitation.email}.` };
      } catch (e) {
        log.warn("invite.email_failed", { err: (e as Error).message });
      }
    }
    const store = await cookies();
    store.set(INVITE_LINK_COOKIE, JSON.stringify({ email: invitation.email, link }), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/settings", maxAge: 600 });
    return { ok: `Invitation created for ${invitation.email}. Copy the link below and send it to them.` };
  });
}

/** Monthly token cap of the Beacon agent for this organisation (empty: deployment default, 0: no cap). */
export async function updateAgentBudgetAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ monthlyTokenCap: z.union([z.literal(""), z.coerce.number().int().min(0).max(1_000_000_000)]).optional() }), async ({ tx, actor }, i) => {
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
    if (!org) throw new Error("Organisation not found");
    const cap = i.monthlyTokenCap === "" || i.monthlyTokenCap === undefined ? null : i.monthlyTokenCap;
    await tx.update(organizations).set({ settings: { ...org.settings, agent: { ...org.settings.agent, monthlyTokenCap: cap } } }).where(eq(organizations.id, org.id));
    await audit(tx, actor, "org.agent_budget", "organization", org.id, { monthlyTokenCap: cap });
    return { ok: "Agent budget saved." };
  });
}

export async function revokeInvitationAction(fd: FormData) {
  return act(fd, "member:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await revokeInvitation(tx, actor, i.id);
    return { ok: "Invitation revoked." };
  });
}

export async function changeRoleAction(fd: FormData) {
  return act(fd, "member:manage", z.object({ userId: zId, role: ROLE }), async ({ tx, actor, ctx }, i) => {
    if (i.userId === ctx.user.id) throw new Error("You cannot change your own role.");
    const m = await asSystem((stx) => stx.query.memberships.findFirst({ where: and(eq(memberships.organizationId, actor.organizationId), eq(memberships.userId, i.userId)) }));
    if (!m) throw new Error("Member not found");
    if (!canAssignRole(ctx.role, i.role) || (m.role === "OWNER" && ctx.role !== "OWNER")) throw new Error("Insufficient privileges for this role change.");
    await asSystem((stx) => stx.update(memberships).set({ role: i.role }).where(and(eq(memberships.organizationId, actor.organizationId), eq(memberships.userId, i.userId))));
    await audit(tx, actor, "member.role", "user", i.userId, { from: m.role, to: i.role });
    return { ok: "Role updated." };
  });
}

export async function removeMemberAction(fd: FormData) {
  return act(fd, "member:manage", z.object({ userId: zId }), async ({ tx, actor, ctx }, i) => {
    if (i.userId === ctx.user.id) throw new Error("You cannot remove yourself.");
    const m = await asSystem((stx) => stx.query.memberships.findFirst({ where: and(eq(memberships.organizationId, actor.organizationId), eq(memberships.userId, i.userId)) }));
    if (!m) throw new Error("Member not found");
    if (m.role === "OWNER" && ctx.role !== "OWNER") throw new Error("Only an owner can remove an owner.");
    await asSystem(async (stx) => {
      await stx.delete(memberships).where(and(eq(memberships.organizationId, actor.organizationId), eq(memberships.userId, i.userId)));
      // Revoke the removed member's sessions in this organisation immediately.
      await stx.delete(sessions).where(and(eq(sessions.userId, i.userId), eq(sessions.organizationId, actor.organizationId)));
    });
    await audit(tx, actor, "member.remove", "user", i.userId);
    return { ok: "Member removed." };
  });
}

/** Every declared form field of every provider (the registry is the single source). */
const FIELD_SCHEMA = Object.fromEntries(
  INTEGRATION_CATALOG.flatMap((c) => [...c.configFields, ...c.secretFields]).map((f) => [f.key, zOptText(f.key === "serviceAccountJson" ? 20000 : 500)]),
) as Record<string, ReturnType<typeof zOptText>>;

/** How each AI provider's API keys start (their documented formats), with the message shown otherwise. */
const API_KEY_PREFIX = {
  ANTHROPIC: ["sk-ant-", "This is not an Anthropic API key (it starts with sk-ant-). Copy the key itself, not the page address."],
  OPENAI: ["sk-", "This is not an OpenAI API key (it starts with sk-). Copy the key itself, not the page address."],
  PERPLEXITY: ["pplx-", "This is not a Perplexity API key (it starts with pplx-). Copy the key itself, not the page address."],
} as const;

export async function saveIntegrationAction(fd: FormData) {
  return actStaged(
    fd,
    "integration:manage",
    z.object({ provider: z.enum(INTEGRATION_PROVIDERS), productId: z.union([zId, z.literal("")]).optional(), ...FIELD_SCHEMA }),
    async ({ actor, run }, input) => {
      const i = input as { provider: (typeof INTEGRATION_PROVIDERS)[number]; productId?: string } & Record<string, string | null | undefined>;
      const entry = catalogEntry(i.provider)!;
      const productScoped = entry.scope === "product";
      if (productScoped && !i.productId) throw new Error("Select a product for this integration.");
      const config: Record<string, string> = {};
      const secret: Record<string, string> = {};
      for (const f of entry.configFields) {
        const v = i[f.key];
        if (v) config[f.key] = v;
        else if (f.required) throw new Error(`${f.label.replace(/ \(.*\)$/, "")} is required.`);
      }
      for (const f of entry.secretFields) if (i[f.key]) secret[f.key] = i[f.key]!;
      // Catch a pasted page address or other text before it replaces a working key.
      const keyPrefix = API_KEY_PREFIX[i.provider as keyof typeof API_KEY_PREFIX];
      if (keyPrefix && secret.apiKey && !cleanApiKey(secret.apiKey).startsWith(keyPrefix[0])) throw new Error(keyPrefix[1]);
      if (config.urlPrefix && !/^https?:\/\/[^\s]+$/i.test(config.urlPrefix)) throw new Error("The page URL prefix must start with https://");
      // 1. Store (transaction), 2. test the connection (no transaction open), 3. record the result (transaction).
      const integ = await run(async (tx) => {
        if (productScoped) {
          const p = await tx.query.products.findFirst({ where: and(eq(products.id, i.productId!), eq(products.organizationId, actor.organizationId)) });
          if (!p) throw new Error("Product not found");
        }
        return saveIntegration(tx, actor, { provider: i.provider, productId: productScoped ? i.productId! : null, config, secret: Object.keys(secret).length ? secret : null });
      });
      const res = await checkIntegration(run, actor, integ.id);
      if (!res.ok) throw new Error(`Saved, but the connection test failed: ${res.message}`);
      return { ok: "Integration saved and connected (secrets encrypted at rest)." };
    },
  );
}

/** Test (or reconnect with the stored credentials): the provider call runs outside any transaction. */
export async function testIntegrationAction(fd: FormData) {
  return actStaged(fd, "integration:manage", z.object({ id: zId }), async ({ actor, run }, i) => {
    const res = await checkIntegration(run, actor, i.id);
    if (!res.ok) throw new Error(`Connection test failed: ${res.message}`);
    return { ok: res.message };
  });
}

/** Pick the Search Console property after "Connect with Google". */
export async function selectGoogleSiteAction(fd: FormData) {
  return actStaged(fd, "integration:manage", z.object({ id: zId, siteUrl: z.string().trim().min(1).max(300), urlPrefix: zOptText(500) }), async ({ actor, run }, i) => {
    if (i.urlPrefix && !/^https?:\/\/[^\s]+$/i.test(i.urlPrefix)) throw new Error("The page URL prefix must start with https://");
    await run(async (tx) => {
      const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, i.id), eq(integrations.organizationId, actor.organizationId)) });
      if (!integ || integ.provider !== "GOOGLE_SEARCH_CONSOLE") throw new Error("Integration not found");
      const sites = parseSites(integ.config._sites);
      if (!sites.some((s) => s.siteUrl === i.siteUrl)) throw new Error("Choose one of the properties of the connected Google account.");
      const config: Record<string, string> = { siteUrl: i.siteUrl };
      if (i.urlPrefix) config.urlPrefix = i.urlPrefix;
      await saveIntegration(tx, actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId: integ.productId, config, secret: null });
    });
    const res = await checkIntegration(run, actor, i.id);
    if (!res.ok) throw new Error(`Connection test failed: ${res.message}`);
    return { ok: "Property selected. History import (16 months) is queued." };
  });
}

export async function syncIntegrationNowAction(fd: FormData) {
  return act(fd, "job:run", z.object({ id: zId }), async ({ tx, actor }, i) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, i.id), eq(integrations.organizationId, actor.organizationId)) });
    if (!integ || !isSyncableProvider(integ.provider)) throw new Error("Integration not found");
    if (integ.status === "DISABLED") throw new Error("This integration is disabled. Test it to enable it again.");
    await enqueue("integration.sync", { integrationId: integ.id }, { organizationId: actor.organizationId, idempotencyKey: `sync:manual:${integ.id}:${Math.floor(Date.now() / 60_000)}` });
    return { ok: "Sync queued." };
  });
}

export async function disableIntegrationAction(fd: FormData) {
  return act(fd, "integration:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await tx.update(integrations).set({ status: "DISABLED" }).where(and(eq(integrations.id, i.id), eq(integrations.organizationId, actor.organizationId)));
    await audit(tx, actor, "integration.disable", "integration", i.id);
    return { ok: "Integration disabled." };
  });
}

export async function retryJobAction(fd: FormData) {
  return act(fd, "job:run", z.object({ id: zId }), async ({ actor }, i) => {
    await retryJob(actor.organizationId, i.id);
    return { ok: "Job re-queued." };
  });
}


/** Change own password: verifies the current one, enforces strength, revokes all other sessions. */
export async function changePasswordAction(fd: FormData) {
  return act(fd, "read", z.object({ current: z.string().min(1).max(256), next: z.string().min(12).max(256) }), async ({ tx, actor, ctx }, i) => {
    // Per user: guessing the current password through this form is throttled like a login.
    const limit = await rateLimit(`password-change:${ctx.user.id}`, 5, 900);
    if (!limit.allowed) throw new Error("Too many attempts. Try again in 15 minutes.");
    const weak = validatePasswordStrength(i.next);
    if (weak) throw new Error(weak);
    const user = await asSystem((stx) => stx.query.users.findFirst({ where: eq(users.id, ctx.user.id) }));
    if (!user || !(await verifyPassword(i.current, user.passwordHash))) throw new Error("Current password is incorrect.");
    const passwordHash = await hashPassword(i.next);
    await asSystem(async (stx) => {
      await stx.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
      await stx.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.tokenHash, ctx.sessionTokenHash)));
    });
    await audit(tx, actor, "user.password_change", "user", user.id);
    return { ok: "Password changed. Other sessions were signed out." };
  });
}

/** Re-run unmapped or failed Stripe webhook events (after fixing the product mapping). */
export async function reprocessWebhookInboxAction(fd: FormData) {
  return act(fd, "integration:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, i.id), eq(integrations.organizationId, actor.organizationId)) });
    if (!integ) throw new Error("Integration not found");
    const res = await reprocessInbox(tx, integ.id);
    await audit(tx, actor, "integration.reprocess", "integration", integ.id, res);
    return { ok: `Reprocessed ${res.total} event(s): ${res.PROCESSED} processed, ${res.UNMAPPED} unmapped, ${res.FAILED} failed.` };
  });
}

