import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { productRelationships, products, productSources } from "@/db/schema";
import { audit, type Actor } from "@/lib/audit";
import { eventTypesFor } from "@/core/conversions/events";

export const RELATIONSHIP_TYPES = ["COMPLEMENTARY", "SAME_AUDIENCE", "WORKFLOW_EXTENSION", "UPSELL", "CROSS_SELL"] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Add a typed, explained relationship between two products of the organisation (optionally backed by a source of the origin product). */
export async function addRelationship(tx: Tx, actor: Actor, input: { fromProductId: string; toProductId: string; type: RelationshipType; rationale: string; sourceId?: string | null }) {
  if (input.fromProductId === input.toProductId) throw new Error("A product cannot be related to itself.");
  const owned = await tx.select({ id: products.id }).from(products).where(and(eq(products.organizationId, actor.organizationId), sql`${products.id} in (${input.fromProductId}, ${input.toProductId})`));
  if (owned.length !== 2) throw new Error("Product not found");
  if (input.sourceId) {
    const src = await tx.query.productSources.findFirst({ where: and(eq(productSources.id, input.sourceId), eq(productSources.organizationId, actor.organizationId)) });
    if (!src) throw new Error("Source not found");
  }
  const [row] = await tx
    .insert(productRelationships)
    .values({ organizationId: actor.organizationId, fromProductId: input.fromProductId, toProductId: input.toProductId, type: input.type, rationale: input.rationale, sourceId: input.sourceId ?? null, createdBy: actor.userId ?? null })
    .onConflictDoUpdate({ target: [productRelationships.organizationId, productRelationships.fromProductId, productRelationships.toProductId, productRelationships.type], set: { rationale: input.rationale, sourceId: input.sourceId ?? null } })
    .returning();
  await audit(tx, actor, "ecosystem.relationship", "product_relationship", row.id, { type: input.type, from: input.fromProductId, to: input.toProductId });
  return row;
}

export async function removeRelationship(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.delete(productRelationships).where(and(eq(productRelationships.id, id), eq(productRelationships.organizationId, actor.organizationId))).returning();
  if (row) await audit(tx, actor, "ecosystem.relationship.delete", "product_relationship", id, { type: row.type });
  return Boolean(row);
}

export async function listRelationships(tx: Tx, organizationId: string) {
  return tx.select().from(productRelationships).where(eq(productRelationships.organizationId, organizationId)).orderBy(desc(productRelationships.createdAt));
}

export type RuleFunnel = {
  impressions: number;
  clicks: number;
  dismissals: number;
  signups: number;
  subscriptions: number;
  /** Measured revenue (revenue_events) of the people who converted through the rule, in the destination product, per currency. */
  revenue: { currency: string; cents: number }[];
  /** Revenue the product reported with CONVERSION events (self-reported, not measured by Beacon). */
  reportedRevenueCents: number;
};

/**
 * Full funnel per cross-sell rule from measured events: impressions, clicks
 * and dismissals (cross-sell events recorded by the product back-ends),
 * signups and subscriptions in the destination product whose UTM (the event's
 * own, its credited touch or its first touch) carries utm_source
 * beacon-cross-sell and utm_campaign = the rule id, and the revenue of those
 * converted people in the destination product after their conversion.
 */
export async function ruleFunnels(tx: Tx, organizationId: string): Promise<Map<string, RuleFunnel>> {
  const ev = await tx.execute<{ rule_id: string; imp: number; clk: number; dis: number; reported: number }>(sql`
    select rule_id, count(*) filter (where type = 'IMPRESSION')::int as imp, count(*) filter (where type = 'CLICK')::int as clk,
      count(*) filter (where type = 'DISMISS')::int as dis, coalesce(sum(revenue_cents) filter (where type = 'CONVERSION'), 0)::bigint as reported
    from cross_sell_events where organization_id = ${organizationId} group by rule_id`);
  const signups = sql.join(eventTypesFor("SIGNUP_COMPLETED").map((t) => sql`${t}`), sql`, `);
  const subs = sql.join(eventTypesFor("SUBSCRIPTION_STARTED").map((t) => sql`${t}`), sql`, `);
  const conv = sql`
    select r.id as rule_id, e.id, e.type::text as type, e.identity_id, e.occurred_at, r.destination_product_id
    from cross_sell_rules r
    join conversion_events e on e.organization_id = r.organization_id and e.product_id = r.destination_product_id
    left join attribution_events lt on lt.id = e.attribution_touch_id
    left join attribution_events ft on ft.id = e.first_touch_id
    where r.organization_id = ${organizationId}
      and ((e.utm->>'source' = 'beacon-cross-sell' and e.utm->>'campaign' = r.id::text)
        or (lt.utm->>'utm_source' = 'beacon-cross-sell' and lt.utm->>'utm_campaign' = r.id::text)
        or (ft.utm->>'utm_source' = 'beacon-cross-sell' and ft.utm->>'utm_campaign' = r.id::text))`;
  const counts = await tx.execute<{ rule_id: string; signups: number; subs: number }>(sql`
    select c.rule_id, count(*) filter (where c.type in (${signups}))::int as signups, count(*) filter (where c.type in (${subs}))::int as subs
    from (${conv}) c group by c.rule_id`);
  const revenue = await tx.execute<{ rule_id: string; currency: string; cents: number }>(sql`
    with converted as (
      select c.rule_id, c.identity_id, c.destination_product_id, min(c.occurred_at) as at from (${conv}) c
      where c.identity_id is not null group by 1, 2, 3)
    select v.rule_id, r.currency, sum(r.amount_cents)::bigint as cents
    from converted v join revenue_events r on r.organization_id = ${organizationId} and r.identity_id = v.identity_id and r.product_id = v.destination_product_id and r.occurred_at >= v.at
    group by 1, 2`);
  const out = new Map<string, RuleFunnel>();
  const at = (id: string) => out.get(id) ?? out.set(id, { impressions: 0, clicks: 0, dismissals: 0, signups: 0, subscriptions: 0, revenue: [], reportedRevenueCents: 0 }).get(id)!;
  for (const r of ev.rows) Object.assign(at(r.rule_id), { impressions: Number(r.imp), clicks: Number(r.clk), dismissals: Number(r.dis), reportedRevenueCents: Number(r.reported) });
  for (const r of counts.rows) Object.assign(at(r.rule_id), { signups: Number(r.signups), subscriptions: Number(r.subs) });
  for (const r of revenue.rows) at(r.rule_id).revenue.push({ currency: r.currency, cents: Number(r.cents) });
  return out;
}
