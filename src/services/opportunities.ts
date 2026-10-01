import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { crossSellRules, distributionTargets, opportunities, pages, productRelationships, products, queries, seoIssues } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import type { OpportunitySignals } from "@/core/opportunities/engine";
import { generateOpportunity, recordRun } from "@/ai/tasks";
import { addDays, isoDay, normalizeQuery } from "@/core/util/text";
import { latestAudit } from "./seo";
import { citationDomains, promptSummaries } from "./ai-visibility";
import { importSearchQueries, reclusterProduct, searchDemand, type SearchDemand } from "./queries";
import { recomputeCoverage } from "./discovery";
import { contentGapsForProduct } from "./content-gaps";
import { audit, type Actor } from "@/lib/audit";

type QueryMetric = { impressions: number; clicks: number; position: number | null };

/**
 * Per-query search metrics without inflation. Preferred source: normalized
 * daily rows (search_daily) summed over the window with an
 * impressions-weighted position. Fallback for legacy data in
 * visibility_metrics (28-day aggregates re-stored every day): only the
 * LATEST snapshot per query is read, never a sum of overlapping snapshots.
 */
export async function queryMetrics(tx: Tx, organizationId: string, productId: string, demand?: SearchDemand): Promise<{ byQuery: Map<string, QueryMetric>; source: "search_daily" | "visibility_metrics" | null; days: number }> {
  const d = demand ?? (await searchDemand(tx, organizationId, productId));
  if (d.connected) return { byQuery: new Map([...d.byQuery].map(([k, v]) => [k, { impressions: v.impressions, clicks: v.clicks, position: v.position }])), source: "search_daily", days: d.days };
  const since = isoDay(addDays(new Date(), -35));
  const latest = await tx.execute<{ metric: string; dimension: string; value: number }>(sql`
    select distinct on (metric, dimension) metric, dimension, value from visibility_metrics
    where organization_id = ${organizationId} and product_id = ${productId} and metric in ('query_impressions', 'query_clicks', 'query_position') and day >= ${since}
    order by metric, dimension, day desc`);
  const byQuery = new Map<string, QueryMetric>();
  for (const m of latest.rows) {
    const k = normalizeQuery(m.dimension);
    const cur = byQuery.get(k) ?? { impressions: 0, clicks: 0, position: null };
    if (m.metric === "query_impressions") cur.impressions = Number(m.value);
    if (m.metric === "query_clicks") cur.clicks = Number(m.value);
    if (m.metric === "query_position") cur.position = Number(m.value);
    byQuery.set(k, cur);
  }
  return { byQuery, source: byQuery.size ? "visibility_metrics" : null, days: 28 };
}

const DIST_KIND: Record<string, "DIRECTORY" | "COMMUNITY" | "MEDIA"> = { REVIEW_SITE: "DIRECTORY", DIRECTORY: "DIRECTORY", COMMUNITY: "COMMUNITY", NEWS: "MEDIA" };

/**
 * Collect evidence and (re)generate opportunities for a product. Idempotent
 * via fingerprints, one batched upsert; human decisions are preserved.
 * Opportunities whose condition no longer holds become OBSOLETE and reopen
 * (OPEN) when their fingerprint recurs.
 */
export async function generateProductOpportunities(tx: Tx, organizationId: string, productId: string) {
  const t0 = Date.now();
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  // Real demand first: import measured queries, re-cluster, recompute coverage.
  const demand = await searchDemand(tx, organizationId, productId);
  if (demand.connected) await importSearchQueries(tx, organizationId, productId);
  await reclusterProduct(tx, organizationId, productId, demand);
  await recomputeCoverage(tx, organizationId, productId, demand);

  const qs = await tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId), eq(queries.status, "ACTIVE")));
  const metrics = await queryMetrics(tx, organizationId, productId, demand);
  const pageRows = await tx.select().from(pages).where(and(eq(pages.organizationId, organizationId), eq(pages.productId, productId)));
  const pageStatus = new Map(pageRows.map((p) => [p.id, p.status]));
  const lastAudit = await latestAudit(tx, organizationId, productId);
  const issues = lastAudit
    ? (
        await tx.execute<{ rule: string; severity: "CRITICAL" | "HIGH"; n: number; url: string }>(sql`
      select rule, severity, count(*)::int as n, min(url) as url from seo_issues
      where audit_id = ${lastAudit.id} and status = 'OPEN' and severity in ('CRITICAL','HIGH') group by rule, severity`)
      ).rows
    : [];
  const orphans = lastAudit ? await tx.select({ url: seoIssues.url }).from(seoIssues).where(and(eq(seoIssues.auditId, lastAudit.id), eq(seoIssues.rule, "links.orphan"), eq(seoIssues.status, "OPEN"))).limit(20) : [];
  const conv = await tx.execute<{ path: string; views: number; clicks: number }>(sql`
    select page_path as path, count(*) filter (where type = 'PAGE_VIEW')::int as views, count(*) filter (where type = 'CTA_CLICK')::int as clicks
    from conversion_events where organization_id = ${organizationId} and product_id = ${productId} and occurred_at >= now() - interval '28 days' and page_path is not null
    group by page_path having count(*) filter (where type = 'PAGE_VIEW') >= 200 and count(*) filter (where type = 'CTA_CLICK') < count(*) filter (where type = 'PAGE_VIEW') * 0.005
    order by views desc limit 5`);
  const clicks = await tx.execute<{ now: number; prev: number }>(sql`
    select coalesce(sum(value) filter (where day >= current_date - 31), 0)::float as now,
           coalesce(sum(value) filter (where day < current_date - 31 and day >= current_date - 59), 0)::float as prev
    from visibility_metrics where organization_id = ${organizationId} and product_id = ${productId} and metric = 'search_clicks' and dimension = ''`);
  const ai = await promptSummaries(tx, organizationId, productId);
  const gaps = await contentGapsForProduct(tx, organizationId, productId, demand);
  const domains = await citationDomains(tx, organizationId, { productId });

  // Distribution: source categories cited in sampled answers vs prepared targets.
  const targets = await tx
    .select({ kind: distributionTargets.kind, status: distributionTargets.status })
    .from(distributionTargets)
    .where(and(eq(distributionTargets.organizationId, organizationId), sql`(${distributionTargets.productId} = ${productId} or ${distributionTargets.productId} is null)`));
  const prepared = (kind: string) => targets.filter((t) => t.kind === kind && ["PREPARED", "SUBMITTED", "PUBLISHED", "PERFORMING", "FOLLOW_UP"].includes(t.status)).length;
  const needs = new Map<string, { kind: string; citedCategory: string; tests: Set<string>; domains: Set<string> }>();
  for (const d of domains) {
    const kind = d.kind === "THIRD_PARTY" ? DIST_KIND[d.category] : undefined;
    if (!kind) continue;
    const cur = needs.get(kind) ?? { kind, citedCategory: d.category, tests: new Set<string>(), domains: new Set<string>() };
    d.testIds.forEach((id) => cur.tests.add(id));
    cur.domains.add(d.domain);
    needs.set(kind, cur);
  }

  // Cross-sell: declared relationships and shared identities, without a rule.
  const rels = await tx.select().from(productRelationships).where(and(eq(productRelationships.organizationId, organizationId), eq(productRelationships.fromProductId, productId)));
  const shared = await tx.execute<{ product_id: string; n: number }>(sql`
    select b.product_id, count(*)::int as n from identity_products a join identity_products b on b.identity_id = a.identity_id and b.product_id <> a.product_id
    where a.organization_id = ${organizationId} and a.product_id = ${productId} group by b.product_id`);
  const rules = await tx.select({ to: crossSellRules.destinationProductId }).from(crossSellRules).where(and(eq(crossSellRules.organizationId, organizationId), eq(crossSellRules.sourceProductId, productId)));
  const otherIds = [...new Set([...rels.map((r) => r.toProductId), ...shared.rows.map((r) => r.product_id)])];
  const others = otherIds.length ? await tx.select({ id: products.id, name: products.name }).from(products).where(and(eq(products.organizationId, organizationId), inArray(products.id, otherIds))) : [];

  // Referral: conversions without an active referral code.
  const ref = await tx.execute<{ conv: number; codes: number; affiliates: number }>(sql`
    select
      (select count(*) from conversion_events where organization_id = ${organizationId} and product_id = ${productId} and occurred_at >= now() - interval '90 days'
         and type in ('SIGNUP', 'SIGNUP_COMPLETED', 'SUBSCRIBED', 'SUBSCRIPTION_STARTED', 'TRIAL_STARTED'))::int as conv,
      (select count(*) from referral_codes where organization_id = ${organizationId} and product_id = ${productId} and active)::int as codes,
      (select count(*) from affiliates where organization_id = ${organizationId})::int as affiliates`);

  const signals: OpportunitySignals = {
    product: { id: productId, name: g.product.name, slug: g.product.slug },
    queries: qs.map((q) => ({ id: q.id, query: q.query, intent: q.intent, importance: q.importance, coverage: q.coverage, clusterId: q.clusterId, pageStatus: q.pageId ? pageStatus.get(q.pageId) : null, search: metrics.byQuery.get(q.normalized) ?? null })),
    searchDays: metrics.days,
    contentGaps: gaps,
    aiGaps: ai.map((a) => ({ prompt: a.prompt.prompt, promptId: a.prompt.id, testsRun: a.testsRun, productMentions: a.mentions, competitorsMentioned: a.competitors })),
    citationDomains: domains.filter((d) => d.kind === "THIRD_PARTY"),
    seoIssues: issues.map((i) => ({ rule: i.rule, severity: i.severity, count: Number(i.n), exampleUrl: i.url })),
    missingEntity: computeCompleteness(g).missing,
    competitorsWithoutComparison: g.competitors.filter((c) => c.comparisonFacts.filter((f) => f.sourceUrl).length < 3).map((c) => ({ name: c.competitor.name, sourcedFacts: c.comparisonFacts.filter((f) => f.sourceUrl).length })),
    orphanPages: orphans.map((o) => o.url),
    lowConversionPages: conv.rows.map((r) => ({ path: r.path, views: Number(r.views), ctaClicks: Number(r.clicks) })),
    searchTrend: clicks.rows[0] ? { clicksNow: Number(clicks.rows[0].now), clicksPrev: Number(clicks.rows[0].prev) } : null,
    distributionNeeds: [...needs.values()].map((n) => ({ kind: n.kind, citedCategory: n.citedCategory, citedSamples: n.tests.size, exampleDomains: [...n.domains], preparedTargets: prepared(n.kind) })),
    crossSell: others.map((o) => ({
      productId: o.id,
      productName: o.name,
      sharedIdentities: Number(shared.rows.find((r) => r.product_id === o.id)?.n ?? 0),
      relationship: rels.find((r) => r.toProductId === o.id)?.type ?? null,
      hasRule: rules.some((r) => r.to === o.id),
    })),
    referral: ref.rows[0] ? { conversions90d: Number(ref.rows[0].conv), activeReferralCodes: Number(ref.rows[0].codes), affiliates: Number(ref.rows[0].affiliates) } : null,
  };
  const drafts = generateOpportunity(signals);
  const res = await upsertOpportunities(tx, organizationId, productId, drafts);
  await recordRun(tx, {
    organizationId,
    task: "generateOpportunity",
    provider: "beacon-rules",
    model: "deterministic",
    input: { productId },
    output: { total: drafts.length, ...res, searchSource: metrics.source },
    confidence: 1,
    latencyMs: Date.now() - t0,
    status: "SUCCEEDED",
  });
  return { total: drafts.length, ...res };
}

/**
 * One batched upsert of the drafts. Evidence, scores and rationale refresh;
 * a human status is never overwritten, except OBSOLETE which reopens (the
 * condition is back). Then OPEN opportunities of the product whose
 * fingerprint was not produced become OBSOLETE.
 */
export async function upsertOpportunities(tx: Tx, organizationId: string, productId: string, drafts: ReturnType<typeof generateOpportunity>) {
  let created = 0;
  const fps = drafts.map((d) => d.fingerprint);
  const reopened = fps.length
    ? (await tx.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.status, "OBSOLETE"), inArray(opportunities.fingerprint, fps)))).length
    : 0;
  for (let i = 0; i < drafts.length; i += 500) {
    const chunk = drafts.slice(i, i + 500);
    const rows = await tx
      .insert(opportunities)
      .values(chunk.map((d) => ({ organizationId, ...d })))
      .onConflictDoUpdate({
        target: [opportunities.organizationId, opportunities.fingerprint],
        set: {
          type: sql`excluded.type`,
          category: sql`excluded.category`,
          title: sql`excluded.title`,
          problem: sql`excluded.problem`,
          evidence: sql`excluded.evidence`,
          competitors: sql`excluded.competitors`,
          actions: sql`case when ${opportunities.status} = 'OPEN' or ${opportunities.status} = 'OBSOLETE' then excluded.actions else ${opportunities.actions} end`,
          potential: sql`excluded.potential`,
          impact: sql`excluded.impact`,
          confidence: sql`excluded.confidence`,
          effort: sql`excluded.effort`,
          urgency: sql`excluded.urgency`,
          priorityScore: sql`excluded.priority_score`,
          scoringRationale: sql`excluded.scoring_rationale`,
          nextAction: sql`excluded.next_action`,
          sources: sql`excluded.sources`,
          queryId: sql`excluded.query_id`,
          status: sql`case when ${opportunities.status} = 'OBSOLETE' then 'OPEN'::opportunity_status else ${opportunities.status} end`,
          obsoletedAt: sql`null`,
          updatedAt: new Date(),
        },
      })
      .returning({ created: sql<boolean>`(xmax = 0)` });
    created += rows.filter((r) => r.created).length;
  }
  const open = await tx
    .select({ id: opportunities.id, fingerprint: opportunities.fingerprint })
    .from(opportunities)
    .where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.productId, productId), eq(opportunities.status, "OPEN")));
  const liveSet = new Set(fps);
  const resolved = open.filter((o) => !liveSet.has(o.fingerprint));
  if (resolved.length)
    await tx
      .update(opportunities)
      .set({ status: "OBSOLETE", obsoletedAt: new Date() })
      .where(inArray(opportunities.id, resolved.map((o) => o.id)));
  return { created, reopened, resolved: resolved.length };
}

export async function allProductIds(tx: Tx, organizationId: string) {
  return (await tx.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId))).map((r) => r.id);
}

export type OpportunityStatus = (typeof opportunities.$inferSelect)["status"];

export async function setOpportunityStatus(tx: Tx, actor: Actor, id: string, status: OpportunityStatus) {
  const [row] = await tx
    .update(opportunities)
    .set({ status, obsoletedAt: status === "OBSOLETE" ? new Date() : null })
    .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, actor.organizationId)))
    .returning({ id: opportunities.id });
  await audit(tx, actor, "opportunity.status", "opportunity", id, { status });
  return row ?? null;
}
