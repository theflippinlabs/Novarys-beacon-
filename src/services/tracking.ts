import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  affiliates,
  apiKeys,
  attributionEvents,
  commissions,
  conversionEvents,
  identities,
  identityProducts,
  organizations,
  products,
  referralCodes,
  revenueEvents,
  subscriptions,
} from "@/db/schema";
import { attribute, classifyChannel, commissionFor, DEFAULT_ATTRIBUTION, fraudFlags, type Channel } from "@/core/attribution/attribution";
import { hmac, randomToken } from "@/lib/security/crypto";

// ── API keys ──────────────────────────────────────────────────────────────
export type ApiKeyKind = "PUBLISHABLE" | "SECRET";

export function generateApiKey(kind: ApiKeyKind) {
  const prefix = randomToken(6).replace(/[-_]/g, "x").slice(0, 8);
  const secret = randomToken(24);
  const key = `${kind === "PUBLISHABLE" ? "bpk" : "bsk"}_${prefix}_${secret}`;
  return { key, prefix, keyHash: hmac(key, "apikey") };
}

export type ResolvedKey = { id: string; organizationId: string; productId: string | null; kind: ApiKeyKind; allowedOrigins: string[]; scopes: string[] };

/** Resolve a raw API key (system context — the key itself identifies the tenant). */
export async function resolveApiKey(tx: Tx, raw: string | null | undefined): Promise<ResolvedKey | null> {
  if (!raw || !/^b[ps]k_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,64}$/.test(raw)) return null;
  const row = await tx.query.apiKeys.findFirst({ where: and(eq(apiKeys.keyHash, hmac(raw, "apikey")), isNull(apiKeys.revokedAt)) });
  if (!row) return null;
  await tx.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return { id: row.id, organizationId: row.organizationId, productId: row.productId, kind: row.kind, allowedOrigins: row.allowedOrigins, scopes: row.scopes };
}

export function originAllowed(key: ResolvedKey, origin: string | null, productDomain: string | null): boolean {
  if (key.kind === "SECRET") return true;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = [...key.allowedOrigins, ...(productDomain ? [productDomain] : [])].map((o) => o.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase());
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

// ── Event ingestion ───────────────────────────────────────────────────────
export const EventSchema = z.object({
  type: z.enum(["PAGE_VIEW", "CTA_CLICK", "SIGNUP", "TRIAL_STARTED", "ACTIVATED", "CHECKOUT_STARTED", "SUBSCRIBED", "UPGRADED", "CANCELLED"]),
  product: z.string().max(80).optional(),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  identityRef: z.string().max(200).optional(),
  url: z.string().url().max(2000).optional(),
  referrer: z.string().max(2000).optional().nullable(),
  ctaId: z.string().max(100).optional(),
  ref: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/).optional(),
  properties: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
  traits: z.array(z.string().regex(/^[a-z0-9_:.-]{1,60}$/)).max(20).optional(),
  consent: z.object({ analytics: z.boolean(), marketing: z.boolean(), crossProduct: z.boolean() }).optional(),
  emailHashInput: z.string().email().max(320).optional(),
  idempotencyKey: z.string().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type IncomingEvent = z.infer<typeof EventSchema>;

const PUBLISHABLE_TYPES = new Set(["PAGE_VIEW", "CTA_CLICK"]);

export class IngestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function resolveProduct(tx: Tx, key: ResolvedKey, slug?: string) {
  if (key.productId) return tx.query.products.findFirst({ where: eq(products.id, key.productId) });
  if (!slug) return null;
  return tx.query.products.findFirst({ where: and(eq(products.organizationId, key.organizationId), eq(products.slug, slug)) });
}

export async function upsertIdentity(tx: Tx, organizationId: string, externalRef: string, extra: { emailHash?: string | null; consent?: IncomingEvent["consent"] } = {}) {
  const [row] = await tx
    .insert(identities)
    .values({ organizationId, externalRef, emailHash: extra.emailHash ?? null, ...(extra.consent ? { consent: { ...extra.consent, updatedAt: new Date().toISOString() } } : {}) })
    .onConflictDoUpdate({
      target: [identities.organizationId, identities.externalRef],
      set: {
        ...(extra.emailHash ? { emailHash: extra.emailHash } : {}),
        ...(extra.consent ? { consent: { ...extra.consent, updatedAt: new Date().toISOString() } } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

async function orgRules(tx: Tx, organizationId: string) {
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
  return org?.settings.attribution ?? DEFAULT_ATTRIBUTION;
}

async function touchesFor(tx: Tx, organizationId: string, opts: { visitorId?: string | null; identityId?: string | null }) {
  const conds = [opts.visitorId ? eq(attributionEvents.visitorId, opts.visitorId) : undefined, opts.identityId ? eq(attributionEvents.identityId, opts.identityId) : undefined].filter(Boolean);
  if (!conds.length) return [];
  return tx
    .select()
    .from(attributionEvents)
    .where(and(eq(attributionEvents.organizationId, organizationId), conds.length === 2 ? sql`(${conds[0]} or ${conds[1]})` : conds[0]))
    .orderBy(desc(attributionEvents.occurredAt))
    .limit(200);
}

/**
 * Ingest one conversion event. Tenant is resolved from the API key.
 * Publishable (browser) keys may only send PAGE_VIEW and CTA_CLICK from an
 * allowed origin; lifecycle events (signup → subscription) require a secret
 * server-side key so they cannot be forged from the browser.
 */
export async function ingestEvent(tx: Tx, key: ResolvedKey, ev: IncomingEvent, meta: { origin: string | null; ipHash: string }) {
  if (key.kind === "PUBLISHABLE" && !PUBLISHABLE_TYPES.has(ev.type)) throw new IngestError(403, "This event type requires a secret key");
  const product = await resolveProduct(tx, key, ev.product);
  if (!product || product.organizationId !== key.organizationId) throw new IngestError(404, "Unknown product");
  if (!originAllowed(key, meta.origin, product.domain)) throw new IngestError(403, "Origin not allowed for this key");
  if (!ev.visitorId && !ev.identityRef) throw new IngestError(400, "visitorId or identityRef is required");
  const orgId = key.organizationId;
  const occurredAt = ev.occurredAt ? new Date(ev.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new IngestError(400, "occurredAt is in the future");

  const identity = ev.identityRef
    ? await upsertIdentity(tx, orgId, ev.identityRef, { emailHash: ev.emailHashInput ? hmac(ev.emailHashInput.trim().toLowerCase(), "email") : null, consent: ev.consent })
    : null;
  if (identity && ev.visitorId)
    await tx.update(attributionEvents).set({ identityId: identity.id }).where(and(eq(attributionEvents.organizationId, orgId), eq(attributionEvents.visitorId, ev.visitorId), isNull(attributionEvents.identityId)));

  // Acquisition touch
  const url = ev.url ? new URL(ev.url) : null;
  const utm: Record<string, string> = {};
  if (url) for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) if (url.searchParams.get(k)) utm[k] = url.searchParams.get(k)!.slice(0, 200);
  let referrerHost: string | null = null;
  try {
    referrerHost = ev.referrer ? new URL(ev.referrer).host.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    referrerHost = null;
  }
  const ownHosts = [product.domain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")].filter((x): x is string => Boolean(x));
  const internal = referrerHost && ownHosts.some((h) => referrerHost === h || referrerHost!.endsWith(`.${h}`));
  const refCode = ev.ref ?? url?.searchParams.get("ref") ?? null;
  const code = refCode ? await tx.query.referralCodes.findFirst({ where: and(eq(referralCodes.code, refCode), eq(referralCodes.organizationId, orgId), eq(referralCodes.active, true)) }) : null;
  const isTouch = ev.type === "PAGE_VIEW" && (Object.keys(utm).length > 0 || code || (referrerHost && !internal));
  if (isTouch && ev.visitorId) {
    await tx.insert(attributionEvents).values({
      organizationId: orgId,
      productId: product.id,
      visitorId: ev.visitorId,
      identityId: identity?.id ?? null,
      channel: classifyChannel({ referrerHost, utm, referralCode: code ? { affiliate: Boolean(code.affiliateId) } : null, ownHosts }),
      referralCodeId: code?.id ?? null,
      campaignId: code?.campaignId ?? null,
      utm,
      referrerHost,
      landingUrl: url ? `${url.origin}${url.pathname}` : null,
      ipHash: meta.ipHash,
      occurredAt,
    });
  }

  const touches = await touchesFor(tx, orgId, { visitorId: ev.visitorId, identityId: identity?.id });
  const attr = attribute(
    touches.map((t) => ({ id: t.id, channel: t.channel as Channel, occurredAt: t.occurredAt, referralCodeId: t.referralCodeId, campaignId: t.campaignId })),
    occurredAt,
    await orgRules(tx, orgId),
  );

  const [row] = await tx
    .insert(conversionEvents)
    .values({
      organizationId: orgId,
      productId: product.id,
      type: ev.type,
      visitorId: ev.visitorId ?? null,
      identityId: identity?.id ?? null,
      pageUrl: url ? `${url.origin}${url.pathname}` : null,
      pagePath: url?.pathname ?? null,
      ctaId: ev.ctaId ?? null,
      channel: attr.channel,
      referralCodeId: attr.referralCodeId,
      campaignId: attr.campaignId,
      properties: ev.properties ?? {},
      idempotencyKey: ev.idempotencyKey ?? null,
      occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: conversionEvents.id });

  if (identity && ["SIGNUP", "TRIAL_STARTED", "ACTIVATED", "SUBSCRIBED", "UPGRADED", "CANCELLED"].includes(ev.type)) {
    const status = ev.type === "CANCELLED" ? "CANCELLED" : ev.type === "SUBSCRIBED" || ev.type === "UPGRADED" ? "ACTIVE" : ev.type === "TRIAL_STARTED" ? "TRIALING" : null;
    await tx
      .insert(identityProducts)
      .values({ organizationId: orgId, identityId: identity.id, productId: product.id, status, sharedTraits: ev.traits ?? [] })
      .onConflictDoUpdate({
        target: [identityProducts.identityId, identityProducts.productId],
        set: { lastSeenAt: new Date(), ...(status ? { status } : {}), ...(ev.traits ? { sharedTraits: ev.traits } : {}) },
      });
    if (ev.type === "SIGNUP" && !identity.acquisition.channel)
      await tx
        .update(identities)
        .set({ acquisition: { channel: attr.channel, campaignId: attr.campaignId ?? undefined, referralCodeId: attr.referralCodeId ?? undefined, firstTouchAt: touches.at(-1)?.occurredAt.toISOString() } })
        .where(eq(identities.id, identity.id));
  }
  return { id: row?.id ?? null, duplicate: !row, channel: attr.channel, rule: attr.rule };
}

// ── Referral links ────────────────────────────────────────────────────────
export async function resolveReferral(tx: Tx, code: string) {
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) return null;
  const row = await tx.query.referralCodes.findFirst({ where: and(eq(referralCodes.code, code), eq(referralCodes.active, true)) });
  if (!row) return null;
  const product = row.productId ? await tx.query.products.findFirst({ where: eq(products.id, row.productId) }) : null;
  return { code: row, product };
}

/** Destination must be https on the product's own domain (prevents open redirects). */
export function safeReferralDestination(destination: string, productDomain: string | null | undefined): string | null {
  try {
    const u = new URL(destination);
    if (u.protocol !== "https:") return null;
    const d = productDomain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!d || !(u.host.toLowerCase() === d || u.host.toLowerCase().endsWith(`.${d}`))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function recordReferralVisit(tx: Tx, code: typeof referralCodes.$inferSelect, visitorId: string, ipHash: string, referrer: string | null) {
  let referrerHost: string | null = null;
  try {
    referrerHost = referrer ? new URL(referrer).host : null;
  } catch {
    /* ignore */
  }
  await tx.insert(attributionEvents).values({
    organizationId: code.organizationId,
    productId: code.productId,
    visitorId,
    channel: code.affiliateId ? "AFFILIATE" : "REFERRAL",
    referralCodeId: code.id,
    campaignId: code.campaignId,
    utm: {},
    referrerHost,
    landingUrl: code.destinationUrl,
    ipHash,
  });
}

// ── Revenue ───────────────────────────────────────────────────────────────
export const RevenueSchema = z.object({
  product: z.string().max(80).optional(),
  provider: z.string().max(40).default("api"),
  externalId: z.string().min(1).max(200),
  type: z.enum(["NEW", "RENEWAL", "UPGRADE", "DOWNGRADE", "CHURN", "ONE_TIME", "REFUND"]),
  amountCents: z.number().int(),
  mrrDeltaCents: z.number().int().default(0),
  currency: z.string().length(3).default("EUR"),
  identityRef: z.string().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
  subscription: z
    .object({ externalId: z.string().max(200), plan: z.string().max(100).optional(), status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"]), mrrCents: z.number().int().min(0), startedAt: z.string().datetime().optional() })
    .optional(),
});
export type IncomingRevenue = z.infer<typeof RevenueSchema>;

/**
 * Record a revenue event idempotently (unique on provider + external id),
 * attribute it to the identity's acquisition channel, and create affiliate
 * commissions (flagged ON_HOLD when fraud heuristics fire).
 */
export async function recordRevenue(tx: Tx, organizationId: string, productId: string, r: IncomingRevenue) {
  const occurredAt = r.occurredAt ? new Date(r.occurredAt) : new Date();
  const identity = r.identityRef ? await upsertIdentity(tx, organizationId, r.identityRef) : null;
  const touches = identity ? await touchesFor(tx, organizationId, { identityId: identity.id }) : [];
  const rules = await orgRules(tx, organizationId);
  const firstSeen = identity ? await tx.query.identityProducts.findFirst({ where: and(eq(identityProducts.identityId, identity.id), eq(identityProducts.productId, productId)) }) : null;
  // Attribute at the identity's first conversion into this product so renewals keep the original channel.
  const attrAt = firstSeen?.firstSeenAt && firstSeen.firstSeenAt < occurredAt ? firstSeen.firstSeenAt : occurredAt;
  const attr = attribute(touches.map((t) => ({ id: t.id, channel: t.channel as Channel, occurredAt: t.occurredAt, referralCodeId: t.referralCodeId, campaignId: t.campaignId })), attrAt, rules);

  let subscriptionId: string | null = null;
  if (r.subscription) {
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        organizationId,
        productId,
        identityId: identity?.id ?? null,
        provider: r.provider,
        externalId: r.subscription.externalId,
        plan: r.subscription.plan,
        status: r.subscription.status,
        mrrCents: r.subscription.mrrCents,
        currency: r.currency,
        channel: attr.channel,
        referralCodeId: attr.referralCodeId,
        campaignId: attr.campaignId,
        startedAt: r.subscription.startedAt ? new Date(r.subscription.startedAt) : occurredAt,
        cancelledAt: r.subscription.status === "CANCELLED" ? occurredAt : null,
      })
      .onConflictDoUpdate({
        target: [subscriptions.organizationId, subscriptions.provider, subscriptions.externalId],
        set: { plan: r.subscription.plan, status: r.subscription.status, mrrCents: r.subscription.mrrCents, cancelledAt: r.subscription.status === "CANCELLED" ? occurredAt : null, updatedAt: new Date() },
      })
      .returning();
    subscriptionId = sub.id;
    if (identity)
      await tx
        .insert(identityProducts)
        .values({ organizationId, identityId: identity.id, productId, plan: r.subscription.plan, status: r.subscription.status })
        .onConflictDoUpdate({ target: [identityProducts.identityId, identityProducts.productId], set: { plan: r.subscription.plan, status: r.subscription.status, lastSeenAt: new Date() } });
  }

  const [ev] = await tx
    .insert(revenueEvents)
    .values({
      organizationId,
      productId,
      subscriptionId,
      identityId: identity?.id ?? null,
      type: r.type,
      amountCents: r.amountCents,
      mrrDeltaCents: r.mrrDeltaCents,
      currency: r.currency,
      channel: attr.channel,
      campaignId: attr.campaignId,
      referralCodeId: attr.referralCodeId,
      provider: r.provider,
      externalId: r.externalId,
      occurredAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!ev) return { duplicate: true as const };

  // Affiliate commission
  if (attr.referralCodeId && r.amountCents > 0) {
    const code = await tx.query.referralCodes.findFirst({ where: eq(referralCodes.id, attr.referralCodeId) });
    const aff = code?.affiliateId ? await tx.query.affiliates.findFirst({ where: and(eq(affiliates.id, code.affiliateId), eq(affiliates.status, "ACTIVE")) }) : null;
    if (aff) {
      const start = r.subscription?.startedAt ? new Date(r.subscription.startedAt) : firstSeen?.firstSeenAt ?? occurredAt;
      const months = Math.floor((occurredAt.getTime() - start.getTime()) / (30 * 86_400_000));
      const amount = commissionFor({ amountCents: r.amountCents, commissionBps: aff.commissionBps, monthsSinceStart: months, commissionMonths: aff.commissionMonths, type: r.type });
      if (amount > 0) {
        const touch = touches.find((t) => t.referralCodeId === code!.id);
        const ipVelocity = touch?.ipHash
          ? Number(
              (
                await tx
                  .select({ n: sql<number>`count(distinct ${attributionEvents.visitorId})::int` })
                  .from(attributionEvents)
                  .where(and(eq(attributionEvents.organizationId, organizationId), eq(attributionEvents.ipHash, touch.ipHash), gte(attributionEvents.occurredAt, new Date(Date.now() - 86_400_000))))
              )[0]?.n ?? 0,
            )
          : 0;
        const flags = fraudFlags({
          referrerEmailHash: aff.contactEmailHash,
          customerEmailHash: identity?.emailHash,
          clickToConversionSeconds: touch ? (occurredAt.getTime() - touch.occurredAt.getTime()) / 1000 : null,
          signupsFromSameIpLast24h: ipVelocity,
        });
        await tx
          .insert(commissions)
          .values({ organizationId, affiliateId: aff.id, revenueEventId: ev.id, amountCents: amount, currency: r.currency, status: flags.length ? "ON_HOLD" : "PENDING", fraudFlags: flags, payableAfter: new Date(occurredAt.getTime() + aff.holdDays * 86_400_000) })
          .onConflictDoNothing();
      }
    }
  }
  if (r.type === "REFUND" && subscriptionId) {
    // Refunds put pending commissions on hold for review.
    await tx.execute(sql`update commissions set status = 'ON_HOLD', fraud_flags = fraud_flags || '["REFUNDED"]'::jsonb
      where organization_id = ${organizationId} and status = 'PENDING' and revenue_event_id in (select id from revenue_events where subscription_id = ${subscriptionId})`);
  }
  return { duplicate: false as const, id: ev.id, channel: attr.channel };
}
