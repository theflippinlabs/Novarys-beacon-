import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/security/crypto";
import type { IncomingRevenue } from "./tracking";

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

const monthlyCents = (price: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } | null } | undefined, qty = 1) => {
  if (!price?.unit_amount || !price.recurring) return 0;
  const n = price.recurring.interval_count ?? 1;
  const per = price.recurring.interval === "year" ? 12 * n : price.recurring.interval === "week" ? n / 4.345 : price.recurring.interval === "day" ? n / 30 : n;
  return Math.round((price.unit_amount * qty) / per);
};

/**
 * Map a Stripe event to Beacon revenue input. The Beacon product is taken
 * from `metadata.beacon_product` (subscription, price or invoice) or the
 * integration's default product; the identity from `metadata.beacon_identity`
 * or the Stripe customer id.
 */
export function mapStripeEvent(event: { id: string; type: string; created: number; data: { object: StripeObj; previous_attributes?: Record<string, unknown> } }): (IncomingRevenue & { productSlug?: string }) | null {
  const o = event.data.object;
  const occurredAt = new Date(event.created * 1000).toISOString();
  const meta = (o.metadata ?? {}) as Record<string, string>;
  const customer = typeof o.customer === "string" ? o.customer : undefined;
  const identityRef = meta.beacon_identity || (customer ? `stripe:${customer}` : undefined);

  if (event.type === "invoice.paid") {
    const lines = ((o.lines as { data?: { price?: { unit_amount?: number; recurring?: { interval?: string; interval_count?: number }; metadata?: Record<string, string> }; quantity?: number; metadata?: Record<string, string> }[] })?.data ?? []);
    const productSlug = meta.beacon_product || lines.find((l) => l.price?.metadata?.beacon_product)?.price?.metadata?.beacon_product || lines.find((l) => l.metadata?.beacon_product)?.metadata?.beacon_product;
    const sub = typeof o.subscription === "string" ? o.subscription : undefined;
    const mrr = lines.reduce((s, l) => s + monthlyCents(l.price, l.quantity ?? 1), 0);
    const isNew = o.billing_reason === "subscription_create";
    return {
      productSlug,
      provider: "stripe",
      externalId: event.id,
      type: sub ? (isNew ? "NEW" : "RENEWAL") : "ONE_TIME",
      amountCents: Number(o.amount_paid ?? 0),
      mrrDeltaCents: isNew ? mrr : 0,
      currency: String(o.currency ?? "eur").toUpperCase(),
      identityRef,
      occurredAt,
      subscription: sub ? { externalId: sub, status: "ACTIVE", mrrCents: mrr } : undefined,
    };
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const items = ((o.items as { data?: { price?: { unit_amount?: number; recurring?: { interval?: string; interval_count?: number }; nickname?: string; metadata?: Record<string, string> }; quantity?: number }[] })?.data ?? []);
    const mrr = items.reduce((s, i) => s + monthlyCents(i.price, i.quantity ?? 1), 0);
    const prevItems = (event.data.previous_attributes?.items as typeof o.items | undefined) as { data?: typeof items } | undefined;
    const prevMrr = prevItems?.data ? prevItems.data.reduce((s, i) => s + monthlyCents(i.price, i.quantity ?? 1), 0) : mrr;
    const deleted = event.type === "customer.subscription.deleted";
    const status = deleted ? "CANCELLED" : o.status === "trialing" ? "TRIALING" : o.status === "past_due" ? "PAST_DUE" : o.status === "canceled" ? "CANCELLED" : "ACTIVE";
    const delta = deleted ? -mrr : mrr - prevMrr;
    if (!deleted && delta === 0 && !event.data.previous_attributes?.status) return null;
    return {
      productSlug: meta.beacon_product || items.find((i) => i.price?.metadata?.beacon_product)?.price?.metadata?.beacon_product,
      provider: "stripe",
      externalId: event.id,
      type: deleted ? "CHURN" : delta > 0 ? "UPGRADE" : delta < 0 ? "DOWNGRADE" : "RENEWAL",
      amountCents: 0,
      mrrDeltaCents: delta,
      currency: String((items[0]?.price as { currency?: string } | undefined)?.currency ?? "eur").toUpperCase(),
      identityRef,
      occurredAt,
      subscription: { externalId: o.id, plan: items[0]?.price?.nickname ?? undefined, status, mrrCents: deleted ? 0 : mrr },
    };
  }
  if (event.type === "charge.refunded") {
    return {
      productSlug: meta.beacon_product,
      provider: "stripe",
      externalId: event.id,
      type: "REFUND",
      amountCents: -Number(o.amount_refunded ?? 0),
      mrrDeltaCents: 0,
      currency: String(o.currency ?? "eur").toUpperCase(),
      identityRef,
      occurredAt,
    };
  }
  return null;
}
