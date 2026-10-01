import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  competitors,
  productChangelog,
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
  };
}

export async function findProductBySlug(tx: Tx, organizationId: string, slug: string) {
  return tx.query.products.findFirst({ where: and(eq(products.organizationId, organizationId), eq(products.slug, slug)) });
}
