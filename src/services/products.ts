import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { competitors, productCompetitors, productFacets, productPricing, products, productSources } from "@/db/schema";
import type { FacetKind } from "@/core/knowledge/types";
import { slugify } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";

export async function getProductBySlug(tx: Tx, organizationId: string, slug: string) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.organizationId, organizationId), eq(products.slug, slug)) });
  if (!p) throw new Error("Product not found");
  return p;
}

export async function createProduct(tx: Tx, actor: Actor, input: { name: string; slug?: string | null }) {
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new Error("Invalid product name");
  const exists = await tx.query.products.findFirst({ where: and(eq(products.organizationId, actor.organizationId), eq(products.slug, slug)) });
  if (exists) throw new Error(`A product with the slug "${slug}" already exists`);
  const [p] = await tx.insert(products).values({ organizationId: actor.organizationId, name: input.name.trim(), slug, onboardingStep: 1 }).returning();
  await audit(tx, actor, "product.create", "product", p.id, { name: p.name });
  return p;
}

export async function updateProduct(tx: Tx, actor: Actor, productId: string, patch: Partial<typeof products.$inferInsert>) {
  const { id: _i, organizationId: _o, createdAt: _c, ...safe } = patch;
  await tx.update(products).set(safe).where(and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)));
  await audit(tx, actor, "product.update", "product", productId, { fields: Object.keys(safe) });
}

/**
 * Permanently delete a product and everything that belongs to it (knowledge
 * graph, queries, pages, content, audits, opportunities, scores…: cascading
 * foreign keys). Uploaded photos and revenue history are kept, detached.
 */
export async function deleteProduct(tx: Tx, actor: Actor, productId: string) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) });
  if (!p) throw new Error("Product not found");
  await tx.delete(products).where(and(eq(products.id, p.id), eq(products.organizationId, actor.organizationId)));
  await audit(tx, actor, "product.delete", "product", p.id, { name: p.name, slug: p.slug });
  return p;
}

/**
 * Sync a facet list from the wizard: upsert by slug (preserving verification
 * and source links of unchanged items) and remove items no longer listed.
 */
export async function syncFacets(tx: Tx, actor: Actor, productId: string, kind: FacetKind, items: { name: string; slug: string; description: string | null }[]) {
  const existing = await tx.select().from(productFacets).where(and(eq(productFacets.productId, productId), eq(productFacets.kind, kind)));
  const bySlug = new Map(existing.map((f) => [f.slug, f]));
  for (const [i, it] of items.entries()) {
    const prev = bySlug.get(it.slug);
    if (prev) {
      const changed = prev.name !== it.name || (prev.description ?? null) !== it.description;
      await tx
        .update(productFacets)
        .set({ name: it.name, description: it.description, sortOrder: i, ...(changed && prev.verification === "VERIFIED" ? { verification: "NEEDS_REVIEW" as const } : {}) })
        .where(eq(productFacets.id, prev.id));
    } else await tx.insert(productFacets).values({ organizationId: actor.organizationId, productId, kind, slug: it.slug, name: it.name, description: it.description, sortOrder: i });
  }
  const keep = items.map((i) => i.slug);
  await tx.delete(productFacets).where(and(eq(productFacets.productId, productId), eq(productFacets.kind, kind), keep.length ? notInArray(productFacets.slug, keep) : undefined));
  await audit(tx, actor, "product.facets.sync", "product", productId, { kind, count: items.length });
}

export async function replacePricing(tx: Tx, actor: Actor, productId: string, plans: Omit<typeof productPricing.$inferInsert, "organizationId" | "productId">[]) {
  const existing = await tx.select().from(productPricing).where(eq(productPricing.productId, productId));
  const byName = new Map(existing.map((p) => [p.planName.toLowerCase(), p]));
  for (const plan of plans) {
    const prev = byName.get(plan.planName.toLowerCase());
    if (prev) {
      const changed = prev.priceCents !== plan.priceCents || prev.currency !== plan.currency || prev.interval !== plan.interval || prev.trialDays !== plan.trialDays;
      await tx
        .update(productPricing)
        .set({ ...plan, ...(changed && prev.verification === "VERIFIED" ? { verification: "NEEDS_REVIEW" as const } : {}) })
        .where(eq(productPricing.id, prev.id));
    } else await tx.insert(productPricing).values({ organizationId: actor.organizationId, productId, ...plan });
  }
  const keep = plans.map((p) => p.planName.toLowerCase());
  const remove = existing.filter((p) => !keep.includes(p.planName.toLowerCase())).map((p) => p.id);
  if (remove.length) await tx.delete(productPricing).where(inArray(productPricing.id, remove));
  await audit(tx, actor, "product.pricing.sync", "product", productId, { plans: plans.length });
}

export async function syncSources(tx: Tx, actor: Actor, productId: string, sources: { title: string; url: string; kind: (typeof productSources.$inferInsert)["kind"] }[]) {
  for (const s of sources)
    await tx
      .insert(productSources)
      .values({ organizationId: actor.organizationId, productId, title: s.title, url: s.url, kind: s.kind })
      .onConflictDoUpdate({ target: [productSources.productId, productSources.url], set: { title: s.title, kind: s.kind } });
  const keep = sources.map((s) => s.url);
  // Sources removed from the list are deleted; facts pointing at them lose their source link (FK set null).
  await tx.delete(productSources).where(and(eq(productSources.productId, productId), keep.length ? notInArray(productSources.url, keep) : undefined));
  await audit(tx, actor, "product.sources.sync", "product", productId, { count: sources.length });
}

export async function syncCompetitors(tx: Tx, actor: Actor, productId: string, list: { name: string; domain: string | null }[]) {
  const ids: string[] = [];
  for (const c of list) {
    const slug = slugify(c.name);
    if (!slug) continue;
    const [row] = await tx
      .insert(competitors)
      .values({ organizationId: actor.organizationId, name: c.name, slug, domain: c.domain })
      .onConflictDoUpdate({ target: [competitors.organizationId, competitors.slug], set: { name: c.name, ...(c.domain ? { domain: c.domain } : {}) } })
      .returning();
    ids.push(row.id);
    await tx.insert(productCompetitors).values({ organizationId: actor.organizationId, productId, competitorId: row.id }).onConflictDoNothing();
  }
  await tx.delete(productCompetitors).where(and(eq(productCompetitors.productId, productId), ids.length ? notInArray(productCompetitors.competitorId, ids) : undefined));
  await audit(tx, actor, "product.competitors.sync", "product", productId, { count: ids.length });
}
