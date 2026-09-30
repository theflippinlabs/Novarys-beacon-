import { and, eq, gte } from "drizzle-orm";
import type { Tx } from "@/db";
import { crossSellEvents, crossSellRules, identities, identityProducts, organizations } from "@/db/schema";
import { evaluateCrossSell } from "@/core/crosssell/engine";
import { withTracking } from "@/core/discovery/urls";

/** Decide (and record impressions for) the cross-sell recommendation shown to an identity inside a product. */
export async function crossSellFor(tx: Tx, organizationId: string, identityRef: string, fromProductId: string, opts: { recordImpression?: boolean } = {}) {
  const identity = await tx.query.identities.findFirst({ where: and(eq(identities.organizationId, organizationId), eq(identities.externalRef, identityRef)) });
  if (!identity) return { recommendations: [], reasons: { identity: "unknown" } };
  const rules = await tx.select().from(crossSellRules).where(and(eq(crossSellRules.organizationId, organizationId), eq(crossSellRules.sourceProductId, fromProductId)));
  const prods = await tx.select().from(identityProducts).where(eq(identityProducts.identityId, identity.id));
  const history = await tx
    .select()
    .from(crossSellEvents)
    .where(and(eq(crossSellEvents.identityId, identity.id), gte(crossSellEvents.occurredAt, new Date(Date.now() - 365 * 86_400_000))));
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
  const decision = evaluateCrossSell(
    rules,
    {
      consentCrossProduct: identity.consent.crossProduct === true,
      products: prods.map((p) => ({ productId: p.productId, status: p.status, sharedTraits: p.sharedTraits, firstSeenAt: p.firstSeenAt })),
      history: history.map((h) => ({ ruleId: h.ruleId, type: h.type, occurredAt: h.occurredAt })),
    },
    fromProductId,
    new Date(),
    org?.settings.crossSell?.globalDailyCap ?? 1,
  );
  if (opts.recordImpression)
    for (const r of decision.eligible) await tx.insert(crossSellEvents).values({ organizationId, ruleId: r.id, identityId: identity.id, type: "IMPRESSION" });
  return {
    recommendations: decision.eligible.map((r) => ({
      ruleId: r.id,
      destinationProductId: r.destinationProductId,
      message: r.message,
      cta: { label: r.ctaLabel, url: withTracking(r.ctaUrl, { utm_source: "beacon-cross-sell", utm_medium: "in-product", utm_campaign: r.id }) },
    })),
    reasons: decision.reasons,
  };
}

export async function recordCrossSellEvent(tx: Tx, organizationId: string, identityRef: string, ruleId: string, type: "CLICK" | "CONVERSION" | "DISMISS", revenueCents?: number) {
  const identity = await tx.query.identities.findFirst({ where: and(eq(identities.organizationId, organizationId), eq(identities.externalRef, identityRef)) });
  const rule = await tx.query.crossSellRules.findFirst({ where: and(eq(crossSellRules.id, ruleId), eq(crossSellRules.organizationId, organizationId)) });
  if (!identity || !rule) return false;
  await tx.insert(crossSellEvents).values({ organizationId, ruleId, identityId: identity.id, type, revenueCents: revenueCents ?? null });
  return true;
}
