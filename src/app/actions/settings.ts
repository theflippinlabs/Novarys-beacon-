"use server";

import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { asSystem } from "@/db";
import { integrations, memberships, organizations, products, sessions, users } from "@/db/schema";
import { act, zId, zOptText } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { canAssignRole, ROLES } from "@/lib/auth/rbac";
import { hashPassword, verifyPassword } from "@/lib/security/crypto";
import { normalizeEmail, validatePasswordStrength } from "@/lib/auth/service";
import { enqueue, retryJob } from "@/jobs/queue";
import { isVisibilityProvider, VISIBILITY_ADAPTERS } from "@/integrations/registry";
import { loadSecret, saveIntegration } from "@/services/visibility";
import { buildProvider } from "@/ai/registry";

export async function updateOrgSettingsAction(fd: FormData) {
  return act(
    fd,
    "settings:manage",
    z.object({
      displayName: zOptText(80),
      model: z.enum(["LAST_TOUCH", "FIRST_TOUCH"]),
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

const ROLE = z.enum(ROLES);

/** Adds a member. New users get the provided initial password (communicate it out-of-band; they should change it). */
export async function addMemberAction(fd: FormData) {
  return act(fd, "member:manage", z.object({ email: z.string().email().max(320), name: z.string().trim().min(1).max(120), role: ROLE, password: z.string().max(256).optional() }), async ({ tx, actor, ctx }, i) => {
    if (!canAssignRole(ctx.role, i.role)) throw new Error("You cannot assign a role equal to or above your own.");
    const email = normalizeEmail(i.email);
    // Users are global identities (not tenant rows): look up with system privileges, then scope membership to this org.
    let user = await asSystem((stx) => stx.query.users.findFirst({ where: eq(users.email, email) }));
    if (!user) {
      if (!i.password) throw new Error("Set an initial password for a new user.");
      const weak = validatePasswordStrength(i.password);
      if (weak) throw new Error(weak);
      const passwordHash = await hashPassword(i.password);
      user = (await asSystem((stx) => stx.insert(users).values({ email, name: i.name, passwordHash }).returning()))[0];
    }
    await asSystem((stx) => stx.insert(memberships).values({ organizationId: actor.organizationId, userId: user!.id, role: i.role }).onConflictDoNothing());
    await audit(tx, actor, "member.add", "user", user.id, { role: i.role });
    return { ok: `${email} added as ${i.role.toLowerCase()}.` };
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

const PROVIDER = z.enum(["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "BING_WEBMASTER", "STRIPE", "ANTHROPIC", "OPENAI", "PERPLEXITY"]);

export async function saveIntegrationAction(fd: FormData) {
  return act(
    fd,
    "integration:manage",
    z.object({
      provider: PROVIDER,
      productId: z.union([zId, z.literal("")]).optional(),
      siteUrl: zOptText(300),
      propertyId: zOptText(40),
      defaultProduct: zOptText(80),
      model: zOptText(80),
      serviceAccountJson: zOptText(20000),
      apiKey: zOptText(500),
      webhookSecret: zOptText(300),
    }),
    async ({ tx, actor }, i) => {
      const productScoped = ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "BING_WEBMASTER"].includes(i.provider);
      if (productScoped && !i.productId) throw new Error("Select a product for this integration.");
      if (i.productId) {
        const p = await tx.query.products.findFirst({ where: and(eq(products.id, i.productId), eq(products.organizationId, actor.organizationId)) });
        if (!p) throw new Error("Product not found");
      }
      const config: Record<string, string> = {};
      const secret: Record<string, string> = {};
      if (i.siteUrl) config.siteUrl = i.siteUrl;
      if (i.propertyId) config.propertyId = i.propertyId;
      if (i.defaultProduct) config.defaultProduct = i.defaultProduct;
      if (i.model) config.model = i.model;
      if (i.serviceAccountJson) secret.serviceAccountJson = i.serviceAccountJson;
      if (i.apiKey) secret.apiKey = i.apiKey;
      if (i.webhookSecret) secret.webhookSecret = i.webhookSecret;
      if (i.provider === "GOOGLE_SEARCH_CONSOLE" && !config.siteUrl) throw new Error("Property is required.");
      if (i.provider === "GOOGLE_ANALYTICS" && !config.propertyId) throw new Error("Property ID is required.");
      if (i.provider === "BING_WEBMASTER" && !config.siteUrl) throw new Error("Site URL is required.");
      await saveIntegration(tx, actor, { provider: i.provider, productId: productScoped ? i.productId! : null, config, secret: Object.keys(secret).length ? secret : null });
      return { ok: "Integration saved (secrets encrypted at rest)." };
    },
  );
}

export async function testIntegrationAction(fd: FormData) {
  return act(fd, "integration:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, i.id), eq(integrations.organizationId, actor.organizationId)) });
    if (!integ) throw new Error("Integration not found");
    const secret = await loadSecret(tx, integ.id);
    let result: { ok: boolean; message: string };
    if (isVisibilityProvider(integ.provider)) result = await VISIBILITY_ADAPTERS[integ.provider]().testConnection(integ.config, secret);
    else if (integ.provider === "ANTHROPIC" || integ.provider === "OPENAI" || integ.provider === "PERPLEXITY") {
      if (!secret.apiKey) result = { ok: false, message: "No API key stored." };
      else
        try {
          const p = buildProvider(integ.provider.toLowerCase() as "anthropic" | "openai" | "perplexity", { apiKey: secret.apiKey, model: integ.config.model });
          await p.answer("Reply with the single word: ok");
          result = { ok: true, message: `${p.label} (${p.model}) responded.` };
        } catch (e) {
          result = { ok: false, message: (e as Error).message };
        }
    } else result = { ok: Boolean(secret.webhookSecret), message: secret.webhookSecret ? "Webhook secret stored; deliveries are verified on receipt." : "No webhook secret stored." };
    await tx.update(integrations).set({ status: result.ok ? "CONNECTED" : "ERROR", lastError: result.ok ? null : result.message.slice(0, 500) }).where(eq(integrations.id, integ.id));
    await audit(tx, actor, "integration.test", "integration", integ.id, { ok: result.ok });
    if (!result.ok) throw new Error(`Connection test failed: ${result.message}`);
    return { ok: result.message };
  });
}

export async function syncIntegrationNowAction(fd: FormData) {
  return act(fd, "job:run", z.object({ id: zId }), async ({ tx, actor }, i) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, i.id), eq(integrations.organizationId, actor.organizationId)) });
    if (!integ) throw new Error("Integration not found");
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
