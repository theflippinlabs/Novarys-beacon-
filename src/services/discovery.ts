import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { pages, queries } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { planPages, type PagePlan } from "@/core/discovery/plan";
import { assessPage, planFingerprint } from "@/core/discovery/quality";
import { normalizeQuery, tokens } from "@/core/util/text";

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
 * Query coverage: COVERED when a published page targets the query; PARTIAL
 * when a page exists but is not yet published, or a published page's title
 * contains most query terms; NONE otherwise.
 */
export async function recomputeCoverage(tx: Tx, organizationId: string, productId: string) {
  const ps = await tx.select().from(pages).where(and(eq(pages.organizationId, organizationId), eq(pages.productId, productId)));
  const qs = await tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId)));
  for (const q of qs) {
    const targeted = ps.filter((p) => p.targetQueryId === q.id);
    const published = ps.filter((p) => p.status === "PUBLISHED");
    const qt = tokens(q.query);
    const titleMatch = published.find((p) => {
      const pt = new Set(tokens(p.title));
      return qt.length > 0 && qt.filter((t) => pt.has(t)).length / qt.length >= 0.75;
    });
    const pub = targeted.find((p) => p.status === "PUBLISHED");
    const coverage = pub ? "COVERED" : targeted.length || titleMatch ? "PARTIAL" : "NONE";
    const pageId = pub?.id ?? titleMatch?.id ?? targeted[0]?.id ?? null;
    if (coverage !== q.coverage || pageId !== q.pageId) await tx.update(queries).set({ coverage, pageId, lastCheckedAt: new Date() }).where(eq(queries.id, q.id));
  }
}

export async function pagesForProduct(tx: Tx, organizationId: string, productId: string) {
  return tx.select().from(pages).where(and(eq(pages.organizationId, organizationId), eq(pages.productId, productId))).orderBy(pages.type, pages.path);
}

export async function queryIdsByNormalized(tx: Tx, organizationId: string, list: string[]) {
  if (!list.length) return new Map<string, string>();
  const rows = await tx.select({ id: queries.id, normalized: queries.normalized }).from(queries).where(and(eq(queries.organizationId, organizationId), inArray(queries.normalized, list.map(normalizeQuery))));
  return new Map(rows.map((r) => [r.normalized, r.id]));
}

export async function pageCounts(tx: Tx, organizationId: string) {
  const r = await tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from pages where organization_id = ${organizationId} group by status`);
  return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)])) as Record<string, number>;
}
