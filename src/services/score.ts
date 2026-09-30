import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { beaconScores, integrations } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { computeBeaconScore, type BeaconScore, type ScoreInput } from "@/core/score/beacon-score";
import { isVerified } from "@/core/knowledge/types";
import { latestAudit, openIssueCounts } from "./seo";

export async function scoreInput(tx: Tx, organizationId: string, productId: string): Promise<ScoreInput> {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const audit = await latestAudit(tx, organizationId, productId);
  const pageStats = (
    await tx.execute<{ planned: number; published: number; product_pub: number; answers: number; comp_planned: number; comp_pub: number }>(sql`
    select count(*)::int as planned,
      count(*) filter (where status = 'PUBLISHED')::int as published,
      count(*) filter (where status = 'PUBLISHED' and type = 'PRODUCT')::int as product_pub,
      count(*) filter (where status = 'PUBLISHED' and type = 'ANSWER')::int as answers,
      count(*) filter (where type in ('COMPARISON','ALTERNATIVE'))::int as comp_planned,
      count(*) filter (where type in ('COMPARISON','ALTERNATIVE') and status = 'PUBLISHED')::int as comp_pub
    from pages where product_id = ${productId} and origin = 'PLANNED'`)
  ).rows[0];
  const q = (
    await tx.execute<{ active: number; covered: number; total: number }>(sql`
    select count(*)::int as active,
      coalesce(sum(case coverage when 'COVERED' then importance when 'PARTIAL' then importance * 0.4 else 0 end), 0)::float as covered,
      coalesce(sum(importance), 0)::float as total
    from queries where product_id = ${productId} and status = 'ACTIVE'`)
  ).rows[0];
  const ev = (
    await tx.execute<{ cta: number; any: number }>(sql`
    select count(*) filter (where type = 'CTA_CLICK')::int as cta, count(*)::int as any
    from conversion_events where product_id = ${productId} and occurred_at >= now() - interval '30 days'`)
  ).rows[0];
  const rev = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from revenue_events where product_id = ${productId}`)).rows[0];
  const ai = (
    await tx.execute<{ tests: number; mentions: number }>(sql`
    select count(distinct t.id)::int as tests, count(distinct m.id)::int as mentions
    from ai_visibility_tests t left join ai_mentions m on m.test_id = t.id and m.product_id = ${productId}
    where t.organization_id = ${organizationId} and t.ran_at >= now() - interval '90 days'`)
  ).rows[0];
  const refDomains = (
    await tx.execute<{ v: number | null }>(sql`
    select value::float as v from visibility_metrics where product_id = ${productId} and metric = 'referring_domains' order by day desc limit 1`)
  ).rows[0];
  const integ = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.status, "CONNECTED")));
  const has = (p: string, product = true) => integ.some((i) => i.provider === p && (!product || i.productId === productId));
  return {
    completeness: computeCompleteness(g).score,
    audit: audit ? { openIssues: await openIssueCounts(tx, audit.id), pagesCrawled: audit.pagesCrawled, ageDays: Math.floor((Date.now() - (audit.finishedAt ?? audit.createdAt).getTime()) / 86_400_000) } : null,
    pages: {
      planned: Number(pageStats?.planned ?? 0),
      published: Number(pageStats?.published ?? 0),
      productPagePublished: Number(pageStats?.product_pub ?? 0) > 0,
      answerPagesPublished: Number(pageStats?.answers ?? 0),
      comparisonPlanned: Number(pageStats?.comp_planned ?? 0),
      comparisonPublished: Number(pageStats?.comp_pub ?? 0),
    },
    authority: {
      verifiedProofs: g.proofs.filter((p) => p.publishable && isVerified(p)).length,
      sources: g.sources.length,
      referringDomains: refDomains?.v ?? null,
      aiMentions90d: Number(ai?.mentions ?? 0),
      aiTests90d: Number(ai?.tests ?? 0),
    },
    queries: { active: Number(q?.active ?? 0), weightedCovered: Number(q?.covered ?? 0), weightedTotal: Number(q?.total ?? 0) },
    conversion: {
      conversionUrls: g.product.conversionUrls.length,
      ctaEvents30d: Number(ev?.cta ?? 0),
      pricingPlans: g.pricing.length,
      hasTrialOrDemo: Boolean(g.product.freeTrial) || g.pricing.some((p) => (p.trialDays ?? 0) > 0) || g.product.conversionUrls.some((c) => ["TRY_FREE", "VIEW_DEMO", "BOOK_DEMO"].includes(c.kind)),
    },
    measurement: {
      searchConsole: has("GOOGLE_SEARCH_CONSOLE") || has("BING_WEBMASTER"),
      analytics: has("GOOGLE_ANALYTICS"),
      eventsReceived30d: Number(ev?.any ?? 0) > 0,
      revenueSource: has("STRIPE", false) || Number(rev?.n ?? 0) > 0,
    },
  };
}

export async function computeAndStoreScore(tx: Tx, organizationId: string, productId: string): Promise<BeaconScore> {
  const score = computeBeaconScore(await scoreInput(tx, organizationId, productId));
  await tx.insert(beaconScores).values({ organizationId, productId, total: score.total, components: score });
  return score;
}

export async function scoreHistory(tx: Tx, organizationId: string, productId: string, days = 90) {
  return tx
    .select({ total: beaconScores.total, computedAt: beaconScores.computedAt })
    .from(beaconScores)
    .where(and(eq(beaconScores.organizationId, organizationId), eq(beaconScores.productId, productId), gte(beaconScores.computedAt, new Date(Date.now() - days * 86_400_000))))
    .orderBy(beaconScores.computedAt);
}

export async function latestScores(tx: Tx, organizationId: string) {
  const r = await tx.execute<{ product_id: string; total: number; computed_at: string }>(sql`
    select distinct on (product_id) product_id, total, computed_at from beacon_scores
    where organization_id = ${organizationId} order by product_id, computed_at desc`);
  return new Map(r.rows.map((x) => [x.product_id, { total: Number(x.total), computedAt: x.computed_at }]));
}

export async function latestScoreDetail(tx: Tx, organizationId: string, productId: string) {
  const row = await tx.query.beaconScores.findFirst({ where: and(eq(beaconScores.organizationId, organizationId), eq(beaconScores.productId, productId)), orderBy: desc(beaconScores.computedAt) });
  return row ? { ...row, components: row.components as BeaconScore } : null;
}
