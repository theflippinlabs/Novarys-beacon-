import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { pages, products, queries, queryClusters, seoAudits } from "@/db/schema";
import { canonicalUrl } from "@/core/discovery/urls";
import { assessQueryCoverage, clusterCoverage, type BeaconPageRef, type CoverageResult, type CrawledPageRef } from "@/core/queries/coverage";
import { searchDemand, type SearchDemand } from "./queries";
import { loadProductGraph } from "@/core/knowledge/load";
import { planPages, type PagePlan } from "@/core/discovery/plan";
import { assessPage, planFingerprint } from "@/core/discovery/quality";
import { tokens } from "@/core/util/text";

/**
 * Upsert the planned page set for a product and re-score every page against
 * the publication gate. Existing page statuses are preserved; a page that
 * fails the gate can never be PUBLISHED by the planner.
 */
export async function syncPagePlan(tx: Tx, organizationId: string, productId: string) {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const { planned, skipped } = planPages(g);
  const existing = await tx.select().from(pages).where(and(eq(pages.organizationId, organizationId), eq(pages.productId, productId)));
  const byPath = new Map(existing.map((p) => [p.path, p]));
  const productQueries = await tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId)));

  const fingerprints = planned.map((p) => ({ path: p.path, fingerprint: planFingerprint(p) }));
  let created = 0;
  for (const plan of planned) {
    const target = bestQueryFor(plan, productQueries);
    const q = assessPage(plan, fingerprints, target?.intent ?? null);
    const prev = byPath.get(plan.path);
    const quality = { ...q, blockers: q.blockers.join(" | "), requirements: plan.requirements.map((r) => `${r.met ? "✓" : "✗"} ${r.label}`).join(" | ") } as Record<string, number | string | boolean>;
    if (prev) {
      await tx
        .update(pages)
        .set({ title: plan.title, quality, qualityScore: q.usefulness, targetQueryId: prev.targetQueryId ?? target?.id ?? null, facetId: plan.facetId ?? null, competitorId: plan.competitorId ?? null })
        .where(eq(pages.id, prev.id));
    } else {
      await tx.insert(pages).values({
        organizationId,
        productId,
        type: plan.type,
        path: plan.path,
        title: plan.title,
        status: "PLANNED",
        origin: "PLANNED",
        facetId: plan.facetId,
        competitorId: plan.competitorId,
        targetQueryId: target?.id,
        quality,
        qualityScore: q.usefulness,
      });
      created++;
    }
  }
  // Link target queries to their pages (coverage is recomputed from page status).
  await recomputeCoverage(tx, organizationId, productId);
  return { planned: planned.length, created, skipped };
}

function bestQueryFor(plan: PagePlan, qs: (typeof queries.$inferSelect)[]) {
  const pt = new Set(tokens(plan.title));
  let best: (typeof queries.$inferSelect) | null = null;
  let bestScore = 0;
  for (const q of qs) {
    if (q.status === "ARCHIVED") continue;
    const qt = tokens(q.query);
    if (!qt.length) continue;
    const s = qt.filter((t) => pt.has(t)).length / qt.length;
    if (s > bestScore) {
      bestScore = s;
      best = q;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/**
 * Query coverage against three evidence sources (see core/queries/coverage.ts):
 * Beacon's own pages, the product's latest crawled website pages (title, H1,
 * headings, URL) and measured search query and page pairs. Stores the
 * coverage, the reason and the covering URL per query, then aggregates per
 * cluster. Updates are batched (one statement per 1000 rows).
 */
export async function recomputeCoverage(tx: Tx, organizationId: string, productId: string, demand?: SearchDemand) {
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!product) return { queries: 0, changed: 0 };
  const ps = await tx.select().from(pages).where(and(eq(pages.organizationId, organizationId), eq(pages.productId, productId)));
  const qs = await tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId)));
  const crawled = await latestCrawledPages(tx, organizationId, productId);
  const d = demand ?? (await searchDemand(tx, organizationId, productId));
  const beaconPages: BeaconPageRef[] = ps.map((p) => ({ id: p.id, title: p.title, status: p.status, targetQueryId: p.targetQueryId, url: canonicalUrl(product.domain, p.path) ?? p.path }));
  const results = new Map<string, CoverageResult>();
  const changed: { id: string; r: CoverageResult }[] = [];
  for (const q of qs) {
    const r = assessQueryCoverage({ id: q.id, query: q.query }, { beaconPages, crawled, search: d.byQuery.get(q.normalized)?.pages ?? [] });
    results.set(q.id, r);
    if (r.coverage !== q.coverage || r.pageId !== q.pageId || r.reason !== q.coverageReason || r.url !== q.coveredByUrl) changed.push({ id: q.id, r });
  }
  for (let i = 0; i < changed.length; i += 1000) {
    const values = changed.slice(i, i + 1000).map(({ id, r }) => sql`(${id}::uuid, ${r.coverage}::coverage_status, ${r.pageId}::uuid, ${r.reason}::text, ${r.url}::text)`);
    await tx.execute(sql`update queries q set coverage = v.coverage, page_id = v.page_id, coverage_reason = v.reason, covered_by_url = v.url, last_checked_at = now()
      from (values ${sql.join(values, sql`, `)}) as v(id, coverage, page_id, reason, url) where q.id = v.id and q.organization_id = ${organizationId}`);
  }
  // Cluster coverage from its members (seed = highest importance member).
  const clusters = await tx.select().from(queryClusters).where(and(eq(queryClusters.organizationId, organizationId), eq(queryClusters.productId, productId)));
  const clusterValues = clusters.flatMap((c) => {
    const members = qs.filter((q) => q.clusterId === c.id && q.status !== "ARCHIVED");
    if (!members.length) return [];
    const seed = [...members].sort((a, b) => b.importance - a.importance || a.normalized.localeCompare(b.normalized))[0];
    const cc = clusterCoverage(members.map((m) => ({ id: m.id, coverage: results.get(m.id)! })), seed.id);
    return [sql`(${c.id}::uuid, ${cc.coverage}::coverage_status, ${cc.reason}::text, ${cc.url}::text)`];
  });
  if (clusterValues.length)
    await tx.execute(sql`update query_clusters c set coverage = v.coverage, coverage_reason = v.reason, covered_by_url = v.url, updated_at = now()
      from (values ${sql.join(clusterValues, sql`, `)}) as v(id, coverage, reason, url) where c.id = v.id and c.organization_id = ${organizationId}`);
  return { queries: qs.length, changed: changed.length };
}

/**
 * Pages of the product's latest successful crawl: URL, title, H1 and
 * headings. Read defensively (h1 and headings may be text, string arrays or
 * {level, text} objects depending on the crawler version).
 */
export async function latestCrawledPages(tx: Tx, organizationId: string, productId: string): Promise<CrawledPageRef[]> {
  const a = await tx
    .select({ id: seoAudits.id })
    .from(seoAudits)
    .where(and(eq(seoAudits.organizationId, organizationId), eq(seoAudits.productId, productId), eq(seoAudits.status, "SUCCEEDED")))
    .orderBy(desc(seoAudits.createdAt))
    .limit(1);
  if (!a[0]) return [];
  const r = await tx.execute<Record<string, unknown>>(sql`select * from crawled_pages where audit_id = ${a[0].id} and organization_id = ${organizationId} limit 2000`);
  const text = (v: unknown): string[] =>
    v == null ? [] : typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(text) : typeof v === "object" && typeof (v as { text?: unknown }).text === "string" ? [(v as { text: string }).text] : [];
  return r.rows
    .filter((row) => typeof row.url === "string" && (row.status == null || (Number(row.status) >= 200 && Number(row.status) < 300)))
    .map((row) => {
      const h1 = text(row.h1);
      return { url: row.url as string, title: typeof row.title === "string" ? row.title : null, h1: h1.length ? h1.join(" ") : null, headings: text(row.headings) };
    });
}
