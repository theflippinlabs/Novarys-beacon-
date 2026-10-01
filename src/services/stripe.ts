import { redactErrorText } from "@/lib/security/redact";
import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, products, revenueEvents, subscriptions, webhookInbox } from "@/db/schema";
import { safeEqual } from "@/lib/security/crypto";
import { recordRevenue, upsertIdentity, type RevenueInput } from "./tracking";

/**
 * Verify a Stripe webhook signature (`Stripe-Signature: t=…,v1=…`):
 * HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret, constant-time
 * comparison, and a timestamp tolerance to prevent replay.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]).filter(([k, v]) => k && v));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const sigs = header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  return sigs.some((s) => safeEqual(s, expected));
}

type StripeObj = Record<string, unknown> & { id: string; metadata?: Record<string, string> };
type Recurring = { interval?: string; interval_count?: number } | null;
type Price = { id?: string; unit_amount?: number | null; currency?: string; recurring?: Recurring; nickname?: string | null; metadata?: Record<string, string> };
type InvoiceLine = {
  amount?: number;
  quantity?: number | null;
  proration?: boolean;
  metadata?: Record<string, string>;
  period?: { start?: number; end?: number };
  /** Legacy shape (API versions before 2025-03-31 "basil"). */
  price?: Price | null;
  /** Current shape: pricing details reference the price by id; no recurring info on the line. */
  pricing?: { type?: string; price_details?: { price?: string | Price; product?: string }; unit_amount_decimal?: string | null } | null;
  parent?: { type?: string; subscription_item_details?: { proration?: boolean; subscription?: string } | null } | null;
};
export type StripeEvent = { id: string; type: string; created: number; data: { object: StripeObj; previous_attributes?: Record<string, unknown> } };

const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : undefined);
const currencyOf = (v: unknown): string | null => (typeof v === "string" && /^[a-z]{3}$/i.test(v) ? v.toUpperCase() : null);

export const monthlyCents = (price: Price | null | undefined, qty = 1) => {
  if (!price?.unit_amount || !price.recurring) return 0;
  const n = price.recurring.interval_count ?? 1;
  const per = price.recurring.interval === "year" ? 12 * n : price.recurring.interval === "week" ? n / 4.345 : price.recurring.interval === "day" ? n / 30 : n;
  return Math.round((price.unit_amount * qty) / per);
};

/** Monthly amount of one invoice line, from the legacy price, or (current shape) from the line amount over its billing period. */
export function lineMonthlyCents(l: InvoiceLine): number {
  if (l.proration || l.parent?.subscription_item_details?.proration) return 0;
  const legacy = l.price ?? (typeof l.pricing?.price_details?.price === "object" ? l.pricing.price_details.price : null);
  if (legacy?.recurring) return monthlyCents(legacy, l.quantity ?? 1);
  const isSubLine = l.parent?.type === "subscription_item_details" || Boolean(l.pricing?.price_details);
  const start = l.period?.start;
  const end = l.period?.end;
  if (!isSubLine || !l.amount || !start || !end || end <= start) return 0;
  const months = Math.max(1, Math.round((end - start) / (30.44 * 86_400)));
  return Math.round(l.amount / months);
}

/** Subscription id of an invoice: legacy `invoice.subscription`, current `invoice.parent.subscription_details.subscription`. */
export function invoiceSubscription(o: StripeObj): string | undefined {
  const parent = o.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return idOf(o.subscription) ?? idOf(parent?.subscription_details?.subscription);
}

function invoiceMetadata(o: StripeObj): Record<string, string> {
  const parent = o.parent as { subscription_details?: { metadata?: Record<string, string> } } | undefined;
  const legacy = o.subscription_details as { metadata?: Record<string, string> } | undefined;
  return { ...(legacy?.metadata ?? {}), ...(parent?.subscription_details?.metadata ?? {}), ...(o.metadata ?? {}) };
}

export type MappedRevenue = RevenueInput & { productSlug?: string };
export type StripeMapping =
  | { action: "ignore"; reason: string }
  | { action: "record"; items: MappedRevenue[] }
  | { action: "link"; subscriptionExternalId: string; identityRef: string; productSlug?: string };

const identityFrom = (meta: Record<string, string>, customer?: string) =>
  meta.beacon_identity ? { identityRef: meta.beacon_identity, identityFallback: false } : customer ? { identityRef: `stripe:${customer}`, identityFallback: true } : {};

/**
 * Map a Stripe event to Beacon revenue input. Supports the legacy and the
 * current (2025-03-31 "basil" and later) invoice shapes. The Beacon product
 * is taken from `metadata.beacon_product` (invoice, subscription, price or
 * line) or the integration's default product; the identity from
 * `metadata.beacon_identity`, else the Stripe customer (`stripe:cus_…`).
 * Amounts keep Stripe's currency; an event without a currency is rejected.
 */
export function mapStripeEvent(event: StripeEvent): StripeMapping {
  const o = event.data.object;
  const occurredAt = new Date(event.created * 1000).toISOString();
  const customer = idOf(o.customer);

  if (event.type === "invoice.paid") {
    const meta = invoiceMetadata(o);
    const lines = ((o.lines as { data?: InvoiceLine[] } | undefined)?.data ?? []) as InvoiceLine[];
    const linePrice = (l: InvoiceLine) => l.price ?? (typeof l.pricing?.price_details?.price === "object" ? l.pricing.price_details.price : null);
    const productSlug = meta.beacon_product || lines.map((l) => linePrice(l)?.metadata?.beacon_product || l.metadata?.beacon_product).find(Boolean);
    const sub = invoiceSubscription(o);
    const currency = currencyOf(o.currency);
    if (!currency) return { action: "ignore", reason: "invoice without currency" };
    const mrr = lines.reduce((s, l) => s + lineMonthlyCents(l), 0);
    const isNew = o.billing_reason === "subscription_create";
    const plan = lines.map((l) => linePrice(l)?.nickname).find(Boolean) ?? undefined;
    return {
      action: "record",
      items: [
        {
          productSlug,
          provider: "stripe",
          externalId: event.id,
          type: sub ? (isNew ? "NEW" : "RENEWAL") : "ONE_TIME",
          amountCents: Number(o.amount_paid ?? 0),
          mrrDeltaCents: isNew ? mrr : 0,
          currency,
          ...identityFrom(meta, customer),
          occurredAt,
          sourceRef: o.id,
          subscription: sub ? { externalId: sub, status: "ACTIVE", mrrCents: mrr, plan } : undefined,
        },
      ],
    };
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const meta = (o.metadata ?? {}) as Record<string, string>;
    const items = ((o.items as { data?: { price?: Price; quantity?: number }[] })?.data ?? []);
    const mrr = items.reduce((s, i) => s + monthlyCents(i.price, i.quantity ?? 1), 0);
    const prevItems = event.data.previous_attributes?.items as { data?: typeof items } | undefined;
    const prevMrr = prevItems?.data ? prevItems.data.reduce((s, i) => s + monthlyCents(i.price, i.quantity ?? 1), 0) : mrr;
    const deleted = event.type === "customer.subscription.deleted";
    const created = event.type === "customer.subscription.created";
    const status = deleted ? "CANCELLED" : o.status === "trialing" ? "TRIALING" : o.status === "past_due" ? "PAST_DUE" : o.status === "canceled" ? "CANCELLED" : "ACTIVE";
    const currency = currencyOf(o.currency) ?? currencyOf(items[0]?.price?.currency);
    if (!currency) return { action: "ignore", reason: "subscription without currency" };
    const delta = deleted ? -mrr : mrr - prevMrr;
    if (!created && !deleted && delta === 0 && !event.data.previous_attributes?.status) return { action: "ignore", reason: "no MRR or status change" };
    const startedAt = typeof o.start_date === "number" ? new Date(o.start_date * 1000).toISOString() : undefined;
    return {
      action: "record",
      items: [
        {
          productSlug: meta.beacon_product || items.map((i) => i.price?.metadata?.beacon_product).find(Boolean),
          provider: "stripe",
          externalId: event.id,
          type: deleted ? "CHURN" : delta > 0 ? "UPGRADE" : delta < 0 ? "DOWNGRADE" : "RENEWAL",
          amountCents: 0,
          mrrDeltaCents: delta,
          currency,
          ...identityFrom(meta, customer),
          occurredAt,
          // Creation only records the subscription (status, trial); revenue and new MRR come from invoice.paid.
          subscriptionOnly: created,
          subscription: { externalId: o.id, plan: items[0]?.price?.nickname ?? undefined, status, mrrCents: deleted ? 0 : mrr, startedAt },
        },
      ],
    };
  }

  if (event.type === "checkout.session.completed") {
    const meta = (o.metadata ?? {}) as Record<string, string>;
    const identityRef = meta.beacon_identity || (typeof o.client_reference_id === "string" && o.client_reference_id ? o.client_reference_id : undefined);
    const sub = idOf(o.subscription);
    if (o.mode === "subscription" && sub) return identityRef ? { action: "link", subscriptionExternalId: sub, identityRef, productSlug: meta.beacon_product } : { action: "ignore", reason: "checkout without beacon_identity or client_reference_id" };
    if (o.mode === "payment" && o.payment_status === "paid" && !o.invoice) {
      const currency = currencyOf(o.currency);
      if (!currency) return { action: "ignore", reason: "checkout without currency" };
      return {
        action: "record",
        items: [
          { productSlug: meta.beacon_product, provider: "stripe", externalId: `checkout:${o.id}`, type: "ONE_TIME", amountCents: Number(o.amount_total ?? 0), mrrDeltaCents: 0, currency, ...(identityRef ? { identityRef, identityFallback: false } : identityFrom({}, customer)), occurredAt, sourceRef: o.id },
        ],
      };
    }
    return { action: "ignore", reason: "checkout already covered by its invoice or not paid" };
  }

  if (event.type === "charge.refunded") {
    const meta = (o.metadata ?? {}) as Record<string, string>;
    const currency = currencyOf(o.currency);
    if (!currency) return { action: "ignore", reason: "charge without currency" };
    const refunds = ((o.refunds as { data?: { id: string; amount: number; status?: string; created?: number }[] } | undefined)?.data ?? []).filter((r) => r.status !== "failed" && r.status !== "canceled");
    const base = { productSlug: meta.beacon_product, provider: "stripe", type: "REFUND" as const, mrrDeltaCents: 0, currency, ...identityFrom(meta, customer), sourceRef: o.id };
    // One revenue event per refund object (refund ids are stable across charge.refunded and refund.created deliveries).
    if (refunds.length) return { action: "record", items: refunds.map((r) => ({ ...base, externalId: `refund:${r.id}`, amountCents: -Number(r.amount ?? 0), occurredAt: r.created ? new Date(r.created * 1000).toISOString() : occurredAt })) };
    // No refund list (not expanded): record only the part of the cumulative refunded total not recorded yet.
    return { action: "record", items: [{ ...base, externalId: event.id, amountCents: -Number(o.amount_refunded ?? 0), cumulativeRefundCents: Number(o.amount_refunded ?? 0), occurredAt }] };
  }

  if (event.type === "refund.created" || event.type === "charge.refund.updated") {
    if (o.status === "failed" || o.status === "canceled") return { action: "ignore", reason: `refund ${String(o.status)}` };
    const meta = (o.metadata ?? {}) as Record<string, string>;
    const currency = currencyOf(o.currency);
    if (!currency) return { action: "ignore", reason: "refund without currency" };
    return {
      action: "record",
      items: [{ productSlug: meta.beacon_product, provider: "stripe", externalId: `refund:${o.id}`, type: "REFUND", amountCents: -Number(o.amount ?? 0), mrrDeltaCents: 0, currency, ...identityFrom(meta, undefined), occurredAt, sourceRef: idOf(o.charge) }],
    };
  }
  return { action: "ignore", reason: `event type ${event.type} is not used by Beacon` };
}

// ── Webhook inbox ─────────────────────────────────────────────────────────
type Integration = typeof integrations.$inferSelect;
type InboxRow = typeof webhookInbox.$inferSelect;
export type InboxOutcome = { status: "PROCESSED" | "UNMAPPED" | "FAILED"; ignored?: string; unmapped?: string; duplicate?: boolean; error?: string };

/** Store a verified provider event (idempotent on the event id). Returns the row and whether it already existed. */
export async function storeInbox(tx: Tx, integ: Integration, event: StripeEvent) {
  const [row] = await tx
    .insert(webhookInbox)
    .values({ organizationId: integ.organizationId, integrationId: integ.id, provider: "stripe", externalId: event.id, eventType: event.type, payload: event as unknown as Record<string, unknown>, eventCreatedAt: new Date(event.created * 1000) })
    .onConflictDoNothing()
    .returning();
  if (row) return { row, existed: false };
  const existing = await tx.query.webhookInbox.findFirst({ where: and(eq(webhookInbox.integrationId, integ.id), eq(webhookInbox.externalId, event.id)) });
  return { row: existing!, existed: true };
}

/** The identity a checkout session linked to a subscription (checkout may arrive before or after the subscription events). */
async function checkoutIdentity(tx: Tx, integ: Integration, subscriptionExternalId: string): Promise<string | null> {
  const r = await tx.execute<{ ref: string | null }>(sql`
    select coalesce(payload->'data'->'object'->'metadata'->>'beacon_identity', payload->'data'->'object'->>'client_reference_id') as ref
    from webhook_inbox where integration_id = ${integ.id} and event_type = 'checkout.session.completed'
      and payload->'data'->'object'->>'subscription' = ${subscriptionExternalId}
    order by received_at desc limit 1`);
  return r.rows[0]?.ref ?? null;
}

async function productFor(tx: Tx, integ: Integration, slug?: string) {
  const s = slug ?? integ.config.defaultProduct;
  return s ? tx.query.products.findFirst({ where: and(eq(products.organizationId, integ.organizationId), eq(products.slug, s)) }) : null;
}

const NO_PRODUCT = "No Beacon product for this event: set metadata.beacon_product on the price, subscription or invoice, or a default product on the integration, then reprocess.";

/**
 * Process one inbox row inside a savepoint: map, resolve the product, record
 * revenue (idempotent), and mark the row PROCESSED, UNMAPPED (with the reason;
 * the integration's last error is set when the product mapping is missing) or
 * FAILED (with the error).
 */
export async function processInboxRow(tx: Tx, integ: Integration, row: InboxRow): Promise<InboxOutcome> {
  const event = row.payload as unknown as StripeEvent;
  let outcome: InboxOutcome;
  try {
    outcome = await tx.transaction(async (sp) => {
      const mapped = mapStripeEvent(event);
      if (mapped.action === "ignore") return { status: "PROCESSED" as const, ignored: mapped.reason };
      if (mapped.action === "link") {
        const sub = await sp.query.subscriptions.findFirst({ where: and(eq(subscriptions.organizationId, integ.organizationId), eq(subscriptions.provider, "stripe"), eq(subscriptions.externalId, mapped.subscriptionExternalId)) });
        if (sub) {
          const identity = await upsertIdentity(sp, integ.organizationId, mapped.identityRef);
          await sp.update(subscriptions).set({ identityId: identity.id }).where(eq(subscriptions.id, sub.id));
          await sp.update(revenueEvents).set({ identityId: identity.id }).where(eq(revenueEvents.subscriptionId, sub.id));
        }
        return { status: "PROCESSED" as const };
      }
      let duplicate = true;
      for (const item of mapped.items) {
        const product = await productFor(sp, integ, item.productSlug);
        if (!product) return { status: "UNMAPPED" as const, unmapped: NO_PRODUCT };
        if (item.identityFallback && item.subscription) {
          const linked = await checkoutIdentity(sp, integ, item.subscription.externalId);
          if (linked) Object.assign(item, { identityRef: linked, identityFallback: false });
        }
        const res = await recordRevenue(sp, integ.organizationId, product.id, item);
        if (!res.duplicate) duplicate = false;
      }
      return { status: "PROCESSED" as const, duplicate };
    });
  } catch (e) {
    outcome = { status: "FAILED", error: (e as Error).message.slice(0, 500) };
  }
  await tx
    .update(webhookInbox)
    .set({ status: outcome.status, error: outcome.unmapped ?? outcome.error ?? outcome.ignored ?? null, attempts: sql`${webhookInbox.attempts} + 1`, processedAt: outcome.status === "PROCESSED" ? new Date() : null })
    .where(eq(webhookInbox.id, row.id));
  if (outcome.status === "PROCESSED") await tx.update(integrations).set({ lastSyncAt: new Date(), status: "CONNECTED", lastError: null }).where(eq(integrations.id, integ.id));
  else await tx.update(integrations).set({ lastError: redactErrorText(`Stripe ${event.type} (${event.id}): ${outcome.unmapped ?? outcome.error}`) }).where(eq(integrations.id, integ.id));
  return outcome;
}

/** Re-run every unmapped, failed or stuck event of an integration (oldest first, up to `limit`). */
export async function reprocessInbox(tx: Tx, integrationId: string, limit = 200) {
  const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, integrationId), eq(integrations.provider, "STRIPE")) });
  if (!integ) throw new Error("Integration not found");
  const rows = await tx
    .select()
    .from(webhookInbox)
    .where(and(eq(webhookInbox.integrationId, integ.id), inArray(webhookInbox.status, ["RECEIVED", "UNMAPPED", "FAILED"])))
    .orderBy(asc(webhookInbox.eventCreatedAt), asc(webhookInbox.receivedAt))
    .limit(limit);
  const counts = { PROCESSED: 0, UNMAPPED: 0, FAILED: 0 };
  for (const r of rows) counts[(await processInboxRow(tx, integ, r)).status] += 1;
  return { total: rows.length, ...counts };
}

/** Inbox counts per status for an integration (settings page). */
export async function inboxSummary(tx: Tx, organizationId: string) {
  const r = await tx.execute<{ integration_id: string; status: string; n: number; last_error: string | null }>(sql`
    select integration_id, status::text as status, count(*)::int as n,
      (array_agg(error order by received_at desc) filter (where error is not null))[1] as last_error
    from webhook_inbox where organization_id = ${organizationId} group by 1, 2`);
  const out = new Map<string, Record<string, { n: number; lastError: string | null }>>();
  for (const x of r.rows) out.set(x.integration_id, { ...(out.get(x.integration_id) ?? {}), [x.status]: { n: Number(x.n), lastError: x.last_error } });
  return out;
}
