import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { apiKeys, conversionEvents, distributionTargets, integrations, products } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { buildAnswerBlocks } from "@/core/geo/entity";
import { DISTRIBUTION_CATALOG } from "@/core/distribution/catalog";
import { generateQueryUniverse } from "./queries";
import { syncPagePlan } from "./discovery";
import { latestAudit } from "./seo";

export const ONBOARDING_STEPS = [
  "Identity",
  "Website",
  "Category",
  "Description",
  "Audience",
  "Problems solved",
  "Features",
  "Pricing",
  "Competitors",
  "Integrations",
  "Proof / sources",
  "Analytics",
  "Search Console",
  "Conversion events",
] as const;

/**
 * PRODUCT ANALYSIS: runs after onboarding (as a background job):
 * entity model → query map → content-gap analysis & suggested pages →
 * GEO/AEO questions → distribution suggestions. The technical audit,
 * opportunities and score are enqueued as follow-up jobs by the handler.
 */
export async function analyzeProduct(tx: Tx, organizationId: string, productId: string) {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const completeness = computeCompleteness(g);
  const queries = await generateQueryUniverse(tx, organizationId, productId);
  const plan = await syncPagePlan(tx, organizationId, productId);
  const geo = buildAnswerBlocks(g);
  const existing = await tx.select({ name: distributionTargets.name }).from(distributionTargets).where(and(eq(distributionTargets.organizationId, organizationId), eq(distributionTargets.productId, productId)));
  let suggested = 0;
  for (const d of DISTRIBUTION_CATALOG) {
    if (existing.some((e) => e.name === d.name)) continue;
    await tx.insert(distributionTargets).values({ organizationId, productId, kind: d.kind, name: d.name, url: d.url, status: "DISCOVERED", notes: "Suggested from the Beacon venue catalogue. Qualify relevance before preparing a submission." });
    suggested++;
  }
  await tx.update(products).set({ onboardingCompletedAt: new Date() }).where(eq(products.id, productId));
  return { completeness: completeness.score, queries, pages: { planned: plan.planned, skipped: plan.skipped.length }, geo: { answers: geo.answers.length, gaps: geo.gaps.length }, distributionSuggested: suggested };
}

export type ChecklistItem = { label: string; done: boolean; href: string; detail?: string };

/** Launch checklist: every item is derived from real state, nothing is self-reported. */
export async function launchChecklist(tx: Tx, organizationId: string, productId: string): Promise<ChecklistItem[]> {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const p = g.product;
  const c = computeCompleteness(g);
  const audit = await latestAudit(tx, organizationId, productId);
  const stats = (
    await tx.execute<{ q: number; pages: number; published: number }>(sql`
    select (select count(*) from queries where product_id = ${productId} and status = 'ACTIVE')::int as q,
      (select count(*) from pages where product_id = ${productId})::int as pages,
      (select count(*) from pages where product_id = ${productId} and status = 'PUBLISHED')::int as published`)
  ).rows[0];
  const keys = await tx.select().from(apiKeys).where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.productId, productId)));
  const events = await tx.select({ n: sql<number>`count(*)::int` }).from(conversionEvents).where(eq(conversionEvents.productId, productId));
  const integ = await tx.select().from(integrations).where(and(eq(integrations.organizationId, organizationId), eq(integrations.productId, productId)));
  const base = `/products/${p.slug}`;
  return [
    { label: "Knowledge graph ≥ 70% complete", done: c.score >= 0.7, href: `${base}/knowledge`, detail: `${Math.round(c.score * 100)}%` },
    { label: "Canonical domain set", done: Boolean(p.domain), href: `${base}/knowledge` },
    { label: "Conversion URL declared", done: p.conversionUrls.length > 0, href: `${base}/knowledge` },
    { label: "≥ 10 active queries curated", done: Number(stats?.q ?? 0) >= 10, href: `/queries?product=${p.slug}`, detail: `${stats?.q ?? 0} active` },
    { label: "Technical audit run", done: Boolean(audit), href: `/discovery?product=${p.slug}` },
    { label: "Discovery pages planned", done: Number(stats?.pages ?? 0) > 0, href: `/discovery?product=${p.slug}`, detail: `${stats?.pages ?? 0} planned` },
    { label: "Product page published", done: Number(stats?.published ?? 0) > 0, href: `/content?product=${p.slug}` },
    { label: "Tracking keys created", done: keys.some((k) => !k.revokedAt), href: `${base}/tracking` },
    { label: "First events received", done: Number(events[0]?.n ?? 0) > 0, href: `${base}/tracking` },
    { label: "Search Console connected", done: integ.some((i) => i.provider === "GOOGLE_SEARCH_CONSOLE" && i.status === "CONNECTED"), href: `/settings/integrations` },
    { label: "Analytics connected", done: integ.some((i) => i.provider === "GOOGLE_ANALYTICS" && i.status === "CONNECTED"), href: `/settings/integrations` },
  ];
}
