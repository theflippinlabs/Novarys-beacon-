import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  competitors,
  productChangelog,
  productClaims,
  productCompetitors,
  productFacets,
  productFaqs,
  productPricing,
  productProofs,
  products,
  productSources,
} from "@/db/schema";
import type { ProductGraph } from "./types";

export async function loadProductGraph(tx: Tx, organizationId: string, productId: string): Promise<ProductGraph | null> {
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!product) return null;
  // Sequential on purpose: one transaction = one connection.
  const facets = await tx.select().from(productFacets).where(eq(productFacets.productId, productId)).orderBy(asc(productFacets.kind), asc(productFacets.sortOrder), asc(productFacets.name));
  const pricing = await tx.select().from(productPricing).where(eq(productPricing.productId, productId)).orderBy(asc(productPricing.sortOrder));
  const faqs = await tx.select().from(productFaqs).where(eq(productFaqs.productId, productId)).orderBy(asc(productFaqs.sortOrder));
  const proofs = await tx.select().from(productProofs).where(eq(productProofs.productId, productId));
  const sources = await tx.select().from(productSources).where(eq(productSources.productId, productId));
  const changelog = await tx.select().from(productChangelog).where(eq(productChangelog.productId, productId));
  const claims = await tx.select().from(productClaims).where(eq(productClaims.productId, productId)).orderBy(asc(productClaims.field), asc(productClaims.createdAt));
  const comps = await tx
    .select({ link: productCompetitors, competitor: competitors })
    .from(productCompetitors)
    .innerJoin(competitors, eq(competitors.id, productCompetitors.competitorId))
    .where(eq(productCompetitors.productId, productId));
  return {
    product,
    facets,
    pricing,
    faqs,
    proofs,
    sources,
    changelog: changelog.sort((a, b) => b.releasedOn.localeCompare(a.releasedOn)),
    competitors: comps.map((c) => ({ ...c.link, competitor: c.competitor })),
    claims,
  };
}

/** Groups rows by product id, keeping their order. */
function byProduct<T extends { productId: string | null }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.productId) continue;
    const list = m.get(r.productId);
    if (list) list.push(r);
    else m.set(r.productId, [r]);
  }
  return m;
}

/**
 * Graphs of several products in one query per table (`inArray`), instead of
 * one round of queries per product. Same shape and per-product order as
 * `loadProductGraph`.
 */
export async function loadProductGraphs(tx: Tx, organizationId: string, prods: (typeof products.$inferSelect)[]): Promise<ProductGraph[]> {
  if (!prods.length) return [];
  const ids = prods.map((p) => p.id);
  // Sequential on purpose: one transaction = one connection.
  const facets = byProduct(await tx.select().from(productFacets).where(and(eq(productFacets.organizationId, organizationId), inArray(productFacets.productId, ids))).orderBy(asc(productFacets.kind), asc(productFacets.sortOrder), asc(productFacets.name)));
  const pricing = byProduct(await tx.select().from(productPricing).where(and(eq(productPricing.organizationId, organizationId), inArray(productPricing.productId, ids))).orderBy(asc(productPricing.sortOrder)));
  const faqs = byProduct(await tx.select().from(productFaqs).where(and(eq(productFaqs.organizationId, organizationId), inArray(productFaqs.productId, ids))).orderBy(asc(productFaqs.sortOrder)));
  const proofs = byProduct(await tx.select().from(productProofs).where(and(eq(productProofs.organizationId, organizationId), inArray(productProofs.productId, ids))));
  const sources = byProduct(await tx.select().from(productSources).where(and(eq(productSources.organizationId, organizationId), inArray(productSources.productId, ids))));
  const changelog = byProduct(await tx.select().from(productChangelog).where(and(eq(productChangelog.organizationId, organizationId), inArray(productChangelog.productId, ids))));
  const claims = byProduct(await tx.select().from(productClaims).where(and(eq(productClaims.organizationId, organizationId), inArray(productClaims.productId, ids))).orderBy(asc(productClaims.field), asc(productClaims.createdAt)));
  const comps = await tx
    .select({ link: productCompetitors, competitor: competitors })
    .from(productCompetitors)
    .innerJoin(competitors, eq(competitors.id, productCompetitors.competitorId))
    .where(and(eq(productCompetitors.organizationId, organizationId), inArray(productCompetitors.productId, ids)));
  const compsBy = byProduct(comps.map((c) => ({ productId: c.link.productId, row: { ...c.link, competitor: c.competitor } })));
  return prods.map((product) => ({
    product,
    facets: facets.get(product.id) ?? [],
    pricing: pricing.get(product.id) ?? [],
    faqs: faqs.get(product.id) ?? [],
    proofs: proofs.get(product.id) ?? [],
    sources: sources.get(product.id) ?? [],
    changelog: [...(changelog.get(product.id) ?? [])].sort((a, b) => b.releasedOn.localeCompare(a.releasedOn)),
    competitors: (compsBy.get(product.id) ?? []).map((c) => c.row),
    claims: claims.get(product.id) ?? [],
  }));
}

export async function findProductBySlug(tx: Tx, organizationId: string, slug: string) {
  return tx.query.products.findFirst({ where: and(eq(products.organizationId, organizationId), eq(products.slug, slug)) });
}
