import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, contentVersions, organizations, pages, products } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { verifiedOnly, type ProductGraph } from "@/core/knowledge/types";

/** Public surfaces are on unless an admin switched them off (existing organisations default to on). */
export const isPublicSiteEnabled = (settings: { publicSiteEnabled?: boolean } | null | undefined) => settings?.publicSiteEnabled !== false;

/**
 * The organisation behind a public URL slug, or null (callers answer 404)
 * when the slug is unknown or the organisation turned its public site off.
 */
export async function orgBySlug(tx: Tx, slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.slug, slug) });
  return org && isPublicSiteEnabled(org.settings) ? org : null;
}

/** Verified-only graphs of an organisation's live, onboarded products. */
export async function publicGraphs(tx: Tx, organizationId: string): Promise<ProductGraph[]> {
  const prods = await tx.select().from(products).where(eq(products.organizationId, organizationId)).orderBy(asc(products.name));
  const out: ProductGraph[] = [];
  for (const p of prods) {
    if (p.status === "DEPRECATED" || !p.onboardingCompletedAt) continue;
    const g = await loadProductGraph(tx, organizationId, p.id);
    if (g) out.push(verifiedOnly(g));
  }
  return out;
}

/**
 * Published pages with their published version (for the hosted site, sitemap,
 * llms.txt and export API). The published version keeps being served while a
 * newer draft of the same asset is edited, checked or awaiting approval.
 */
export async function publishedPages(tx: Tx, organizationId: string, productId?: string) {
  const rows = await tx
    .select({ page: pages, asset: contentAssets, product: products })
    .from(pages)
    .innerJoin(contentAssets, eq(contentAssets.id, pages.contentAssetId))
    .innerJoin(products, eq(products.id, pages.productId))
    .where(and(eq(pages.organizationId, organizationId), eq(pages.status, "PUBLISHED"), isNotNull(contentAssets.publishedVersionId), productId ? eq(pages.productId, productId) : undefined))
    .orderBy(asc(pages.path));
  if (!rows.length) return [];
  const versions = await tx.select().from(contentVersions).where(inArray(contentVersions.id, rows.map((r) => r.asset.publishedVersionId!)));
  return rows.map((r) => ({ ...r, version: versions.find((v) => v.id === r.asset.publishedVersionId) ?? null })).filter((r) => r.version);
}
