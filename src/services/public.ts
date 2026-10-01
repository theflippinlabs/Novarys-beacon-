import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, contentVersions, organizations, pages, products } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { verifiedOnly, type ProductGraph } from "@/core/knowledge/types";

export async function orgBySlug(tx: Tx, slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  return tx.query.organizations.findFirst({ where: eq(organizations.slug, slug) });
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

/** Published pages with their latest approved version (for the hosted site, sitemap, llms.txt and export API). */
export async function publishedPages(tx: Tx, organizationId: string, productId?: string) {
  const rows = await tx
    .select({ page: pages, asset: contentAssets, product: products })
    .from(pages)
    .innerJoin(contentAssets, eq(contentAssets.id, pages.contentAssetId))
    .innerJoin(products, eq(products.id, pages.productId))
    .where(and(eq(pages.organizationId, organizationId), eq(pages.status, "PUBLISHED"), eq(contentAssets.status, "PUBLISHED"), productId ? eq(pages.productId, productId) : undefined))
    .orderBy(asc(pages.path));
  if (!rows.length) return [];
  const versions = await tx.select().from(contentVersions).where(inArray(contentVersions.assetId, rows.map((r) => r.asset.id)));
  return rows.map((r) => ({ ...r, version: versions.filter((v) => v.assetId === r.asset.id && v.version === r.asset.currentVersion)[0] ?? null })).filter((r) => r.version);
}
