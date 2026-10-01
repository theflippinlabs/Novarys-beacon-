import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { opportunities, pages, products, queries, seoIssues, visibilityMetrics } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { generateOpportunity, recordRun } from "@/ai/tasks";
import { addDays, isoDay, normalizeQuery } from "@/core/util/text";
import { latestAudit } from "./seo";
import { promptSummaries } from "./ai-visibility";
import { audit, type Actor } from "@/lib/audit";

/** Collect evidence and (re)generate opportunities for a product. Idempotent via fingerprints; human decisions are preserved. */
export async function generateProductOpportunities(tx: Tx, organizationId: string, productId: string) {
  const t0 = Date.now();
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const qs = await tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId), eq(queries.status, "ACTIVE")));
  const since = isoDay(addDays(new Date(), -35));
  const qm = await tx
    .select()
    .from(visibilityMetrics)
    .where(and(eq(visibilityMetrics.productId, productId), inArray(visibilityMetrics.metric, ["query_impressions", "query_clicks", "query_position"]), gte(visibilityMetrics.day, since)));
  const byQuery = new Map<string, { impressions: number; clicks: number; position: number | null }>();
  for (const m of qm) {
    const k = normalizeQuery(m.dimension);
    const cur = byQuery.get(k) ?? { impressions: 0, clicks: 0, position: null };
    if (m.metric === "query_impressions") cur.impressions += m.value;
    if (m.metric === "query_clicks") cur.clicks += m.value;
    if (m.metric === "query_position") cur.position = m.value;
    byQuery.set(k, cur);
  }
  const pageRows = await tx.select().from(pages).where(eq(pages.productId, productId));
  const pageStatus = new Map(pageRows.map((p) => [p.id, p.status]));
  const audit = await latestAudit(tx, organizationId, productId);
  const issues = audit
    ? (
        await tx.execute<{ rule: string; severity: "CRITICAL" | "HIGH"; n: number; url: string }>(sql`
      select rule, severity, count(*)::int as n, min(url) as url from seo_issues
      where audit_id = ${audit.id} and status = 'OPEN' and severity in ('CRITICAL','HIGH') group by rule, severity`)
      ).rows
    : [];
  const orphans = audit ? await tx.select({ url: seoIssues.url }).from(seoIssues).where(and(eq(seoIssues.auditId, audit.id), eq(seoIssues.rule, "links.orphan"), eq(seoIssues.status, "OPEN"))).limit(20) : [];
  const conv = await tx.execute<{ path: string; views: number; clicks: number }>(sql`
    select page_path as path, count(*) filter (where type = 'PAGE_VIEW')::int as views, count(*) filter (where type = 'CTA_CLICK')::int as clicks
    from conversion_events where product_id = ${productId} and occurred_at >= now() - interval '28 days' and page_path is not null
    group by page_path having count(*) filter (where type = 'PAGE_VIEW') >= 200 and count(*) filter (where type = 'CTA_CLICK') < count(*) filter (where type = 'PAGE_VIEW') * 0.005
    order by views desc limit 5`);
  const clicks = await tx.execute<{ now: number; prev: number }>(sql`
    select coalesce(sum(value) filter (where day >= current_date - 31), 0)::float as now,
           coalesce(sum(value) filter (where day < current_date - 31 and day >= current_date - 59), 0)::float as prev
    from visibility_metrics where product_id = ${productId} and metric = 'search_clicks' and dimension = ''`);
  const ai = await promptSummaries(tx, organizationId, productId);

  const drafts = generateOpportunity({
    product: { id: productId, name: g.product.name, slug: g.product.slug },
    queries: qs.map((q) => ({ id: q.id, query: q.query, intent: q.intent, importance: q.importance, coverage: q.coverage, pageStatus: q.pageId ? pageStatus.get(q.pageId) : null, search: byQuery.get(q.normalized) ?? null })),
    aiGaps: ai.map((a) => ({ prompt: a.prompt.prompt, promptId: a.prompt.id, testsRun: a.testsRun, productMentions: a.mentions, competitorsMentioned: a.competitors })),
    seoIssues: issues.map((i) => ({ rule: i.rule, severity: i.severity, count: Number(i.n), exampleUrl: i.url })),
    missingEntity: computeCompleteness(g).missing,
    competitorsWithoutComparison: g.competitors.filter((c) => c.comparisonFacts.filter((f) => f.sourceUrl).length < 3).map((c) => ({ name: c.competitor.name, sourcedFacts: c.comparisonFacts.filter((f) => f.sourceUrl).length })),
    orphanPages: orphans.map((o) => o.url),
    lowConversionPages: conv.rows.map((r) => ({ path: r.path, views: Number(r.views), ctaClicks: Number(r.clicks) })),
    searchTrend: clicks.rows[0] ? { clicksNow: Number(clicks.rows[0].now), clicksPrev: Number(clicks.rows[0].prev) } : null,
  });

  let created = 0;
  for (const d of drafts) {
    const [row] = await tx
      .insert(opportunities)
      .values({ organizationId, ...d })
      .onConflictDoUpdate({
        target: [opportunities.organizationId, opportunities.fingerprint],
        // Refresh evidence but never overwrite a human decision (status).
        set: { title: d.title, problem: d.problem, evidence: d.evidence, competitors: d.competitors, actions: d.actions, potential: d.potential, impact: d.impact, confidence: d.confidence, effort: d.effort, urgency: d.urgency, priorityScore: d.priorityScore, updatedAt: new Date() },
      })
      .returning({ created: sql<boolean>`(xmax = 0)` });
    if (row?.created) created++;
  }
  // Auto-close OPEN opportunities whose condition no longer holds.
  const live = new Set(drafts.map((d) => d.fingerprint));
  const open = await tx.select().from(opportunities).where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.productId, productId), eq(opportunities.status, "OPEN")));
  const resolved = open.filter((o) => !live.has(o.fingerprint));
  if (resolved.length) await tx.update(opportunities).set({ status: "DONE" }).where(inArray(opportunities.id, resolved.map((o) => o.id)));
  await recordRun(tx, { organizationId, task: "generateOpportunity", provider: "beacon-rules", model: "deterministic", input: { productId }, output: { total: drafts.length, created, resolved: resolved.length }, confidence: 1, latencyMs: Date.now() - t0, status: "SUCCEEDED" });
  return { total: drafts.length, created, resolved: resolved.length };
}

export async function allProductIds(tx: Tx, organizationId: string) {
  return (await tx.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId))).map((r) => r.id);
}

export type OpportunityStatus = (typeof opportunities.$inferSelect)["status"];

export async function setOpportunityStatus(tx: Tx, actor: Actor, id: string, status: OpportunityStatus) {
  const [row] = await tx
    .update(opportunities)
    .set({ status })
    .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, actor.organizationId)))
    .returning({ id: opportunities.id });
  await audit(tx, actor, "opportunity.status", "opportunity", id, { status });
  return row ?? null;
}
