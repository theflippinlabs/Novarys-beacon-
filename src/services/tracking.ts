import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { asSystem, type Tx } from "@/db";
import {
  affiliates,
  apiKeys,
  attributionCredits,
  attributionEvents,
  campaigns,
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
import {
  allocateCents,
  attribute,
  ATTRIBUTION_MODELS,
  classifyChannel,
  commissionFor,
  creditsFor,
  DEFAULT_ATTRIBUTION,
  fraudFlags,
  type Attribution,
  type AttributionRules,
  type Channel,
  type Touch,
} from "@/core/attribution/attribution";
import {
  ACCEPTED_EVENT_NAMES,
  analyticsAllowed,
  canonicalEvent,
  forbiddenPublishableFields,
  LIFECYCLE_EVENTS,
  lifecycleStatus,
  PUBLISHABLE_EVENTS,
  utmFromUrl,
  utmParams,
  type CanonicalEvent,
  type Utm,
} from "@/core/conversions/events";
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

/** Resolve a raw API key (system context: the key itself identifies the tenant). */
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
const UtmSchema = z
  .object({ source: z.string().max(200), medium: z.string().max(200), campaign: z.string().max(200), term: z.string().max(200), content: z.string().max(200) })
  .partial();

export const EventSchema = z.object({
  /** Phase 2 canonical names; legacy names (SIGNUP, ACTIVATED, SUBSCRIBED, UPGRADED, CANCELLED) are accepted as aliases. */
  type: z.enum(ACCEPTED_EVENT_NAMES),
  product: z.string().max(80).optional(),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  /** Tracker session (rotates after 30 minutes of inactivity). */
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  identityRef: z.string().max(200).optional(),
  url: z.string().url().max(2000).optional(),
  referrer: z.string().max(2000).optional().nullable(),
  /** Session landing page and UTM captured by the tracker on the first page of the session. */
  landingUrl: z.string().url().max(2000).optional(),
  utm: UtmSchema.optional(),
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

async function orgRules(tx: Tx, organizationId: string): Promise<AttributionRules> {
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
  return org?.settings.attribution ?? DEFAULT_ATTRIBUTION;
}

function touchScope(organizationId: string, opts: { visitorId?: string | null; identityId?: string | null }) {
  const conds = [opts.visitorId ? eq(attributionEvents.visitorId, opts.visitorId) : undefined, opts.identityId ? eq(attributionEvents.identityId, opts.identityId) : undefined].filter((c): c is NonNullable<typeof c> => Boolean(c));
  if (!conds.length) return null;
  return and(eq(attributionEvents.organizationId, organizationId), conds.length === 2 ? or(conds[0], conds[1]) : conds[0]);
}

/**
 * Touches of a visitor/identity inside the lookback window, oldest first.
 * Bounded by the window (not by a "latest N" cut), so the first touch of the
 * window is never lost; a safety cap keeps the oldest 2,000.
 */
async function windowTouches(tx: Tx, organizationId: string, opts: { visitorId?: string | null; identityId?: string | null }, at: Date, lookbackDays: number) {
  const scope = touchScope(organizationId, opts);
  if (!scope) return [];
  return tx
    .select()
    .from(attributionEvents)
    .where(and(scope, gte(attributionEvents.occurredAt, new Date(at.getTime() - lookbackDays * 86_400_000)), lte(attributionEvents.occurredAt, at)))
    .orderBy(asc(attributionEvents.occurredAt))
    .limit(2000);
}

/** The very first touch ever recorded for a visitor/identity (any age). */
async function firstTouch(tx: Tx, organizationId: string, opts: { visitorId?: string | null; identityId?: string | null }) {
  const scope = touchScope(organizationId, opts);
  if (!scope) return null;
  return (await tx.select().from(attributionEvents).where(scope).orderBy(asc(attributionEvents.occurredAt)).limit(1))[0] ?? null;
}

const asTouch = (t: typeof attributionEvents.$inferSelect): Touch => ({ id: t.id, channel: t.channel as Channel, occurredAt: t.occurredAt, referralCodeId: t.referralCodeId, campaignId: t.campaignId });

/** Match a utm_campaign value to a campaign (exact source + medium + campaign first, then campaign alone). */
export async function matchCampaign(tx: Tx, organizationId: string, productId: string, utm: Utm) {
  if (!utm.campaign) return null;
  const rows = await tx
    .select({ id: campaigns.id, source: campaigns.utmSource, medium: campaigns.utmMedium })
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, organizationId), sql`lower(${campaigns.utmCampaign}) = lower(${utm.campaign})`, or(isNull(campaigns.productId), eq(campaigns.productId, productId))))
    .limit(20);
  const lc = (v?: string) => (v ?? "").toLowerCase();
  const score = (r: (typeof rows)[number]) => (lc(r.source) === lc(utm.source) ? 2 : 0) + (lc(r.medium) === lc(utm.medium) ? 1 : 0);
  return rows.sort((a, b) => score(b) - score(a))[0]?.id ?? null;
}

/** Credits for every model, stored for one conversion or revenue event. */
async function storeCredits(
  tx: Tx,
  target: { organizationId: string; productId: string; conversionEventId?: string | null; revenueEventId?: string | null; occurredAt: Date; attributeAt?: Date; amountCents?: number | null; currency?: string | null },
  touches: Touch[],
  lookbackDays: number,
) {
  const rows: (typeof attributionCredits.$inferInsert)[] = [];
  for (const model of ATTRIBUTION_MODELS) {
    const credits = creditsFor(touches, target.attributeAt ?? target.occurredAt, model, lookbackDays);
    const values = target.amountCents === null || target.amountCents === undefined ? null : allocateCents(target.amountCents, credits.map((c) => c.weight));
    credits.forEach((c, i) =>
      rows.push({
        organizationId: target.organizationId,
        productId: target.productId,
        conversionEventId: target.conversionEventId ?? null,
        revenueEventId: target.revenueEventId ?? null,
        touchId: c.touchId,
        model,
        channel: c.channel,
        campaignId: c.campaignId,
        weight: c.weight,
        valueCents: values ? values[i] : null,
        currency: values ? (target.currency ?? null) : null,
        occurredAt: target.occurredAt,
      }),
    );
  }
  if (rows.length) await tx.insert(attributionCredits).values(rows);
}

/** Events that get attribution credits (conversions, not every page view or click). */
const CREDITED: ReadonlySet<CanonicalEvent> = new Set(["SIGNUP_STARTED", "SIGNUP_COMPLETED", "TRIAL_STARTED", "ACTIVATION_COMPLETED", "CHECKOUT_STARTED", "SUBSCRIPTION_STARTED", "SUBSCRIPTION_UPGRADED"]);

const hostOf = (raw: string | null | undefined) => {
  try {
    return raw ? new URL(raw).host.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
const stripQuery = (u: URL | null) => (u ? `${u.origin}${u.pathname}` : null);

/**
 * Ingest one conversion event. Tenant is resolved from the API key.
 *
 * Publishable (browser) keys may only send PAGE_VIEW, CTA_CLICK,
 * PRODUCT_VIEWED and SIGNUP_STARTED from an allowed origin, and may never
 * send identityRef, emailHashInput, consent or traits: identity linking and
 * consent are server-side only (secret key, or POST /api/v1/identify).
 *
 * Order: validation, then the idempotency check (a replay returns before any
 * identity, touch or credit write), then consent, identity, touch,
 * attribution, conversion and credits.
 */
export async function ingestEvent(tx: Tx, key: ResolvedKey, ev: IncomingEvent, meta: { origin: string | null; ipHash: string }) {
  const type = canonicalEvent(ev.type);
  if (key.kind === "PUBLISHABLE") {
    const forbidden = forbiddenPublishableFields(ev);
    if (forbidden.length) throw new IngestError(403, `${forbidden.join(", ")} cannot be sent with a publishable key; link identities and consent server-side with a secret key (POST /api/v1/identify)`);
    if (!PUBLISHABLE_EVENTS.has(type)) throw new IngestError(403, "This event type requires a secret key");
  }
  const product = await resolveProduct(tx, key, ev.product);
  if (!product || product.organizationId !== key.organizationId) throw new IngestError(404, "Unknown product");
  if (!originAllowed(key, meta.origin, product.domain)) throw new IngestError(403, "Origin not allowed for this key");
  if (!ev.visitorId && !ev.identityRef) throw new IngestError(400, "visitorId or identityRef is required");
  const orgId = key.organizationId;
  const occurredAt = ev.occurredAt ? new Date(ev.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new IngestError(400, "occurredAt is in the future");

  // Idempotency first: serialise concurrent replays of one key, then return early on a known key.
  if (ev.idempotencyKey) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${ev.idempotencyKey}`}, 0))`);
    const prior = await tx.query.conversionEvents.findFirst({ where: and(eq(conversionEvents.organizationId, orgId), eq(conversionEvents.idempotencyKey, ev.idempotencyKey)) });
    if (prior) return { id: prior.id, duplicate: true, channel: prior.channel, rule: prior.attributionRule, consent: prior.attributionRule === "consent-denied" ? ("denied" as const) : ("granted" as const) };
  }

  // Consent: consent sent with this (secret-key) event, else the identity's recorded consent.
  const known = ev.identityRef ? await tx.query.identities.findFirst({ where: and(eq(identities.organizationId, orgId), eq(identities.externalRef, ev.identityRef)) }) : null;
  const allowed = analyticsAllowed(known?.consent, ev.consent);
  const identity = ev.identityRef
    ? await upsertIdentity(tx, orgId, ev.identityRef, { emailHash: ev.emailHashInput ? hmac(ev.emailHashInput.trim().toLowerCase(), "email") : null, consent: ev.consent })
    : null;

  const url = ev.url ? new URL(ev.url) : null;
  const rules = await orgRules(tx, orgId);
  let row: { id: string } | undefined;
  let attr: Attribution = { channel: "UNATTRIBUTED", touchId: null, referralCodeId: null, campaignId: null, rule: "consent-denied" };

  if (!allowed) {
    // Analytics consent refused: the event is counted, but with no visitor, identity, session, touch or IP linkage.
    [row] = await tx
      .insert(conversionEvents)
      .values({ organizationId: orgId, productId: product.id, type, pagePath: url?.pathname ?? null, pageUrl: stripQuery(url), ctaId: ev.ctaId ?? null, channel: "UNATTRIBUTED", attributionRule: "consent-denied", properties: {}, idempotencyKey: ev.idempotencyKey ?? null, occurredAt })
      .onConflictDoNothing()
      .returning({ id: conversionEvents.id });
  } else {
    if (identity && ev.visitorId)
      await tx.update(attributionEvents).set({ identityId: identity.id }).where(and(eq(attributionEvents.organizationId, orgId), eq(attributionEvents.visitorId, ev.visitorId), isNull(attributionEvents.identityId)));

    // Acquisition signals: the URL's own UTM wins over the session UTM captured by the tracker.
    const utm: Utm = { ...(ev.utm ?? {}), ...utmFromUrl(url) };
    const referrerHost = hostOf(ev.referrer);
    const ownHosts = [product.domain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")].filter((x): x is string => Boolean(x));
    const internal = Boolean(referrerHost && ownHosts.some((h) => referrerHost === h || referrerHost.endsWith(`.${h}`)));
    const refCode = ev.ref ?? url?.searchParams.get("ref") ?? null;
    const code = refCode ? await tx.query.referralCodes.findFirst({ where: and(eq(referralCodes.code, refCode), eq(referralCodes.organizationId, orgId), eq(referralCodes.active, true)) }) : null;
    const campaignId = code?.campaignId ?? (await matchCampaign(tx, orgId, product.id, utm));
    const landingUrl = ev.landingUrl ? stripQuery(new URL(ev.landingUrl)) : stripQuery(url);
    const hasSignal = Object.keys(utm).length > 0 || Boolean(code) || Boolean(referrerHost && !internal);

    if (type === "PAGE_VIEW" && ev.visitorId) {
      // With a session id: at most one touch per session (its first page view; a measured DIRECT visit when there is no signal).
      // Without one (older trackers, server calls): a touch for every page view that carries an external signal.
      const sessionTouched = ev.sessionId
        ? Boolean(await tx.query.attributionEvents.findFirst({ where: and(eq(attributionEvents.organizationId, orgId), eq(attributionEvents.sessionId, ev.sessionId)), columns: { id: true } }))
        : false;
      if (ev.sessionId ? !sessionTouched : hasSignal)
        await tx.insert(attributionEvents).values({
          organizationId: orgId,
          productId: product.id,
          visitorId: ev.visitorId,
          sessionId: ev.sessionId ?? null,
          identityId: identity?.id ?? null,
          channel: classifyChannel({ referrerHost: internal ? null : referrerHost, utm: utmParams(utm), referralCode: code ? { affiliate: Boolean(code.affiliateId) } : null, ownHosts }),
          referralCodeId: code?.id ?? null,
          campaignId,
          utm: utmParams(utm),
          referrerHost,
          landingUrl,
          ipHash: meta.ipHash,
          occurredAt,
        });
    }

    const scope = { visitorId: ev.visitorId, identityId: identity?.id };
    const touches = (await windowTouches(tx, orgId, scope, occurredAt, rules.lookbackDays)).map(asTouch);
    attr = attribute(touches, occurredAt, rules);
    const first = await firstTouch(tx, orgId, scope);

    [row] = await tx
      .insert(conversionEvents)
      .values({
        organizationId: orgId,
        productId: product.id,
        type,
        visitorId: ev.visitorId ?? null,
        sessionId: ev.sessionId ?? null,
        identityId: identity?.id ?? null,
        pageUrl: stripQuery(url),
        pagePath: url?.pathname ?? null,
        ctaId: ev.ctaId ?? null,
        channel: attr.channel,
        referralCodeId: attr.referralCodeId,
        campaignId: attr.campaignId ?? campaignId,
        utm,
        referrerHost,
        landingUrl,
        attributionRule: attr.rule,
        attributionTouchId: attr.touchId,
        firstTouchId: first?.id ?? null,
        properties: ev.properties ?? {},
        idempotencyKey: ev.idempotencyKey ?? null,
        occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: conversionEvents.id });

    if (row && CREDITED.has(type)) await storeCredits(tx, { organizationId: orgId, productId: product.id, conversionEventId: row.id, occurredAt }, touches, rules.lookbackDays);

    if (identity && type === "SIGNUP_COMPLETED" && !identity.acquisition.channel)
      await tx
        .update(identities)
        .set({ acquisition: { channel: attr.channel, campaignId: attr.campaignId ?? undefined, referralCodeId: attr.referralCodeId ?? undefined, firstTouchAt: first?.occurredAt.toISOString() } })
        .where(eq(identities.id, identity.id));
  }

  if (identity && LIFECYCLE_EVENTS.has(type)) {
    const status = lifecycleStatus(type);
    await tx
      .insert(identityProducts)
      .values({ organizationId: orgId, identityId: identity.id, productId: product.id, status, sharedTraits: ev.traits ?? [], firstSeenAt: occurredAt, lastSeenAt: occurredAt })
      .onConflictDoUpdate({
        target: [identityProducts.identityId, identityProducts.productId],
        set: { lastSeenAt: new Date(), ...(status ? { status } : {}), ...(ev.traits ? { sharedTraits: ev.traits } : {}) },
      });
  }
  return { id: row?.id ?? null, duplicate: !row, channel: attr.channel, rule: attr.rule, consent: allowed ? ("granted" as const) : ("denied" as const) };
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
  /** ISO currency of the amounts (required: Beacon never assumes a currency). */
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()),
  identityRef: z.string().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
  subscription: z
    .object({ externalId: z.string().max(200), plan: z.string().max(100).optional(), status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"]), mrrCents: z.number().int().min(0), startedAt: z.string().datetime().optional() })
    .optional(),
});
export type IncomingRevenue = z.infer<typeof RevenueSchema>;

/** Internal options used by provider adapters (Stripe); not accepted from the public API. */
export type RevenueInput = IncomingRevenue & {
  /** Upsert the subscription only, without a revenue event (e.g. customer.subscription.created, checkout). */
  subscriptionOnly?: boolean;
  /** `identityRef` is a provider fallback (e.g. `stripe:cus_…`): prefer the identity already linked to the subscription. */
  identityFallback?: boolean;
  /** Provider object behind the event (e.g. the charge of a refund). */
  sourceRef?: string;
  /** Cumulative refunded total of `sourceRef` when individual refund ids are unavailable: only the not yet recorded part is stored. */
  cumulativeRefundCents?: number;
};

/**
 * Record a revenue event idempotently (unique on provider + external id; a
 * replay returns before anything else is written), keep the subscription in
 * sync (ignoring provider events older than the last one applied), attribute
 * it to the identity's acquisition touches (credits for every model), and
 * create affiliate commissions (ON_HOLD when fraud heuristics fire).
 */
export async function recordRevenue(tx: Tx, organizationId: string, productId: string, r: RevenueInput) {
  const occurredAt = r.occurredAt ? new Date(r.occurredAt) : new Date();
  if (!r.subscriptionOnly) {
    const prior = await tx.query.revenueEvents.findFirst({ where: and(eq(revenueEvents.organizationId, organizationId), eq(revenueEvents.provider, r.provider), eq(revenueEvents.externalId, r.externalId)), columns: { id: true } });
    if (prior) return { duplicate: true as const, id: prior.id };
  }
  let amountCents = r.amountCents;
  if (r.type === "REFUND" && r.sourceRef && r.cumulativeRefundCents !== undefined) {
    const done = await tx.execute<{ cents: number }>(sql`select coalesce(sum(-amount_cents), 0)::bigint as cents from revenue_events
      where organization_id = ${organizationId} and provider = ${r.provider} and type = 'REFUND' and source_ref = ${r.sourceRef}`);
    const remaining = r.cumulativeRefundCents - Number(done.rows[0]?.cents ?? 0);
    if (remaining <= 0) return { duplicate: true as const, id: null };
    amountCents = -remaining;
  }

  const existingSub = r.subscription
    ? await tx.query.subscriptions.findFirst({ where: and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.provider, r.provider), eq(subscriptions.externalId, r.subscription.externalId)) })
    : null;
  const linked = existingSub?.identityId && (r.identityFallback || !r.identityRef) ? await tx.query.identities.findFirst({ where: eq(identities.id, existingSub.identityId) }) : null;
  const identity = linked ?? (r.identityRef ? await upsertIdentity(tx, organizationId, r.identityRef) : null);
  const rules = await orgRules(tx, organizationId);
  const firstSeen = identity ? await tx.query.identityProducts.findFirst({ where: and(eq(identityProducts.identityId, identity.id), eq(identityProducts.productId, productId)) }) : null;
  // Attribute at the identity's first conversion into this product so renewals keep the original channel.
  const attrAt = firstSeen?.firstSeenAt && firstSeen.firstSeenAt < occurredAt ? firstSeen.firstSeenAt : occurredAt;
  const touchRows = identity ? await windowTouches(tx, organizationId, { identityId: identity.id }, attrAt, rules.lookbackDays) : [];
  const touches = touchRows.map(asTouch);
  const attr = attribute(touches, attrAt, rules);

  let subscriptionId: string | null = existingSub?.id ?? null;
  let stale = false;
  if (r.subscription) {
    // Ordering guard: an event older than the last provider event applied never overwrites newer state.
    stale = Boolean(existingSub?.lastEventAt && existingSub.lastEventAt.getTime() > occurredAt.getTime());
    if (!existingSub) {
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
          lastEventAt: occurredAt,
        })
        .onConflictDoNothing()
        .returning();
      subscriptionId = sub?.id ?? (await tx.query.subscriptions.findFirst({ where: and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.provider, r.provider), eq(subscriptions.externalId, r.subscription.externalId)) }))?.id ?? null;
    } else if (!stale) {
      await tx
        .update(subscriptions)
        .set({
          ...(r.subscription.plan ? { plan: r.subscription.plan } : {}),
          status: r.subscription.status,
          mrrCents: r.subscription.mrrCents,
          cancelledAt: r.subscription.status === "CANCELLED" ? occurredAt : null,
          ...(!existingSub.identityId && identity ? { identityId: identity.id } : {}),
          lastEventAt: occurredAt,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, existingSub.id));
    }
    if (identity && !stale)
      await tx
        .insert(identityProducts)
        .values({ organizationId, identityId: identity.id, productId, plan: r.subscription.plan, status: r.subscription.status, firstSeenAt: occurredAt, lastSeenAt: occurredAt })
        .onConflictDoUpdate({ target: [identityProducts.identityId, identityProducts.productId], set: { ...(r.subscription.plan ? { plan: r.subscription.plan } : {}), status: r.subscription.status, lastSeenAt: new Date() } });
  }
  // Subscription-only events, and stale status events that carry no money, produce no revenue event.
  if (r.subscriptionOnly || (stale && amountCents === 0)) return { duplicate: false as const, id: null, subscriptionId, stale, channel: attr.channel };

  const [ev] = await tx
    .insert(revenueEvents)
    .values({
      organizationId,
      productId,
      subscriptionId,
      identityId: identity?.id ?? null,
      type: r.type,
      amountCents,
      mrrDeltaCents: stale ? 0 : r.mrrDeltaCents,
      currency: r.currency,
      channel: attr.channel,
      campaignId: attr.campaignId,
      referralCodeId: attr.referralCodeId,
      provider: r.provider,
      externalId: r.externalId,
      sourceRef: r.sourceRef ?? null,
      occurredAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!ev) return { duplicate: true as const, id: null };
  await storeCredits(tx, { organizationId, productId, revenueEventId: ev.id, occurredAt, attributeAt: attrAt, amountCents, currency: r.currency }, touches, rules.lookbackDays);

  // Affiliate commission
  if (attr.referralCodeId && amountCents > 0) {
    const code = await tx.query.referralCodes.findFirst({ where: eq(referralCodes.id, attr.referralCodeId) });
    const aff = code?.affiliateId ? await tx.query.affiliates.findFirst({ where: and(eq(affiliates.id, code.affiliateId), eq(affiliates.status, "ACTIVE")) }) : null;
    if (aff) {
      const start = r.subscription?.startedAt ? new Date(r.subscription.startedAt) : firstSeen?.firstSeenAt ?? occurredAt;
      const months = Math.floor((occurredAt.getTime() - start.getTime()) / (30 * 86_400_000));
      const amount = commissionFor({ amountCents, commissionBps: aff.commissionBps, monthsSinceStart: months, commissionMonths: aff.commissionMonths, type: r.type });
      if (amount > 0) {
        const touch = touchRows.find((t) => t.referralCodeId === code!.id);
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
  return { duplicate: false as const, id: ev.id, subscriptionId, stale, channel: attr.channel };
}

// ── Privacy retention ─────────────────────────────────────────────────────
/** Keyed IP hashes are kept for fraud checks only: cleared from touches after this many days. */
export const IP_HASH_RETENTION_DAYS = 90;

/** Clear `ip_hash` on touches older than the retention window (all tenants; maintenance job, system role). */
export async function purgeTrackingIpHashes(days = IP_HASH_RETENTION_DAYS) {
  const r = await asSystem((tx) => tx.execute(sql`update attribution_events set ip_hash = null where ip_hash is not null and occurred_at < now() - make_interval(days => ${days})`));
  return r.rowCount ?? 0;
}
