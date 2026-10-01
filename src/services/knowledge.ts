import { and, eq, max } from "drizzle-orm";
import type { Tx } from "@/db";
import { aiVisibilityPrompts, competitors, productCompetitors, productFacets, productFaqs, productPricing, products, productSources, queries } from "@/db/schema";
import { suggestFaqQuestions } from "@/core/geo/entity";
import { editFact } from "./provenance";
import type { FacetKind } from "@/core/knowledge/types";
import { slugify } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";

/**
 * Additive knowledge-graph writes (one fact at a time). Unlike the onboarding
 * `sync*` functions they never remove existing items, and every new fact is
 * stored UNVERIFIED: only a human reviewer can verify facts.
 */

async function ownedProduct(tx: Tx, organizationId: string, productId: string) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!p) throw new Error("Product not found");
  return p;
}

async function ownedSource(tx: Tx, organizationId: string, productId: string, sourceId: string | null | undefined) {
  if (!sourceId) return null;
  const s = await tx.query.productSources.findFirst({ where: and(eq(productSources.id, sourceId), eq(productSources.organizationId, organizationId), eq(productSources.productId, productId)) });
  if (!s) throw new Error("Source not found for this product");
  return s.id;
}

export async function addFacet(tx: Tx, actor: Actor, productId: string, input: { kind: FacetKind; name: string; description?: string | null; sourceId?: string | null }) {
  await ownedProduct(tx, actor.organizationId, productId);
  const slug = slugify(input.name);
  if (!slug) throw new Error("Invalid facet name");
  const exists = await tx.query.productFacets.findFirst({ where: and(eq(productFacets.productId, productId), eq(productFacets.kind, input.kind), eq(productFacets.slug, slug)) });
  if (exists) throw new Error(`A ${input.kind.toLowerCase().replace("_", " ")} named "${exists.name}" already exists`);
  const sourceId = await ownedSource(tx, actor.organizationId, productId, input.sourceId);
  const [{ n }] = await tx.select({ n: max(productFacets.sortOrder) }).from(productFacets).where(and(eq(productFacets.productId, productId), eq(productFacets.kind, input.kind)));
  const [row] = await tx
    .insert(productFacets)
    .values({ organizationId: actor.organizationId, productId, kind: input.kind, slug, name: input.name.trim(), description: input.description?.trim() || null, sourceId, sortOrder: (n ?? -1) + 1, verification: "UNVERIFIED" })
    .returning();
  await audit(tx, actor, "knowledge.facet.add", "product_facet", row.id, { productId, kind: input.kind });
  return row;
}

export async function addPricingPlan(
  tx: Tx,
  actor: Actor,
  productId: string,
  input: { planName: string; priceCents: number | null; currency: string | null; interval: (typeof productPricing.$inferInsert)["interval"] | null; description?: string | null; trialDays?: number | null; sourceId?: string | null },
) {
  await ownedProduct(tx, actor.organizationId, productId);
  const existing = await tx.select({ planName: productPricing.planName, sortOrder: productPricing.sortOrder, sourceId: productPricing.sourceId }).from(productPricing).where(eq(productPricing.productId, productId));
  const sourceId = await ownedSource(tx, actor.organizationId, productId, input.sourceId);
  // The same plan may be recorded again only as a claim from another source (conflicts are then detected).
  const same = existing.filter((p) => p.planName.toLowerCase() === input.planName.trim().toLowerCase());
  if (same.length && (!sourceId || same.some((p) => p.sourceId === sourceId || !p.sourceId))) throw new Error(`A plan named "${input.planName.trim()}" already exists`);
  const [row] = await tx
    .insert(productPricing)
    .values({
      organizationId: actor.organizationId,
      productId,
      planName: input.planName.trim(),
      priceCents: input.priceCents,
      currency: input.currency ? input.currency.toUpperCase() : null,
      interval: input.interval ?? null,
      description: input.description?.trim() || null,
      trialDays: input.trialDays ?? null,
      sourceId,
      sortOrder: existing.reduce((m, p) => Math.max(m, p.sortOrder + 1), 0),
      verification: "UNVERIFIED",
    })
    .returning();
  await audit(tx, actor, "knowledge.pricing.add", "product_pricing", row.id, { productId, planName: row.planName });
  return row;
}

export async function addFaq(tx: Tx, actor: Actor, productId: string, input: { question: string; answer: string; sourceId?: string | null }) {
  await ownedProduct(tx, actor.organizationId, productId);
  const sourceId = await ownedSource(tx, actor.organizationId, productId, input.sourceId);
  const [row] = await tx.insert(productFaqs).values({ organizationId: actor.organizationId, productId, question: input.question, answer: input.answer, sourceId, verification: "UNVERIFIED" }).returning();
  await audit(tx, actor, "knowledge.faq.add", "product_faq", row.id, { productId });
  return row;
}

export async function addSource(tx: Tx, actor: Actor, productId: string, input: { title: string; url: string; kind: (typeof productSources.$inferInsert)["kind"] }) {
  await ownedProduct(tx, actor.organizationId, productId);
  if (!/^https:\/\/[^\s]+$/i.test(input.url)) throw new Error("Source URL must be an https:// URL");
  const exists = await tx.query.productSources.findFirst({ where: and(eq(productSources.productId, productId), eq(productSources.url, input.url)) });
  if (exists) throw new Error("That source URL is already linked to this product");
  const [row] = await tx.insert(productSources).values({ organizationId: actor.organizationId, productId, title: input.title.trim(), url: input.url, kind: input.kind }).returning();
  await audit(tx, actor, "knowledge.source.add", "product_source", row.id, { productId, kind: input.kind });
  return row;
}

/** Link a competitor to a product (creating the organisation-level competitor if needed). Existing links are kept. */
export async function addCompetitor(tx: Tx, actor: Actor, productId: string, input: { name: string; domain: string | null }) {
  await ownedProduct(tx, actor.organizationId, productId);
  const slug = slugify(input.name);
  if (!slug) throw new Error("Invalid competitor name");
  const [row] = await tx
    .insert(competitors)
    .values({ organizationId: actor.organizationId, name: input.name.trim(), slug, domain: input.domain })
    .onConflictDoUpdate({ target: [competitors.organizationId, competitors.slug], set: { name: input.name.trim(), ...(input.domain ? { domain: input.domain } : {}) } })
    .returning();
  const linked = await tx.insert(productCompetitors).values({ organizationId: actor.organizationId, productId, competitorId: row.id }).onConflictDoNothing().returning();
  await audit(tx, actor, "knowledge.competitor.add", "product", productId, { competitorId: row.id, linked: linked.length > 0 });
  return { competitor: row, alreadyLinked: linked.length === 0 };
}

/** Append a sourced comparison fact. `verified` records a human verification and is only set from the app by a reviewer. */
export async function addComparisonFact(
  tx: Tx,
  actor: Actor,
  input: { productId: string; competitorId: string; dimension: string; product: string; competitor: string; sourceUrl: string; verified?: boolean },
) {
  const link = await tx.query.productCompetitors.findFirst({ where: and(eq(productCompetitors.productId, input.productId), eq(productCompetitors.competitorId, input.competitorId), eq(productCompetitors.organizationId, actor.organizationId)) });
  if (!link) throw new Error("Competitor not linked to this product");
  const facts = [...link.comparisonFacts, { dimension: input.dimension, product: input.product, competitor: input.competitor, sourceUrl: input.sourceUrl, ...(input.verified ? { verifiedAt: new Date().toISOString() } : {}) }];
  await tx.update(productCompetitors).set({ comparisonFacts: facts }).where(and(eq(productCompetitors.productId, input.productId), eq(productCompetitors.competitorId, input.competitorId)));
  await audit(tx, actor, "knowledge.comparison.add", "product", input.productId, { competitorId: input.competitorId, dimension: input.dimension });
  return { count: facts.length };
}

/**
 * Draft FAQ entries from high-importance PROBLEM / INFORMATIONAL queries and
 * active AI prompts of this product. Drafts are UNVERIFIED, have an empty
 * answer for a human to write, and carry `suggestedFrom`; they are never
 * published or used in generation until answered, sourced and verified.
 */
export async function suggestFaqs(tx: Tx, actor: Actor, productId: string) {
  await ownedProduct(tx, actor.organizationId, productId);
  const existing = await tx.select({ question: productFaqs.question, sortOrder: productFaqs.sortOrder }).from(productFaqs).where(eq(productFaqs.productId, productId));
  const qs = await tx
    .select({ id: queries.id, query: queries.query, intent: queries.intent, importance: queries.importance, status: queries.status })
    .from(queries)
    .where(and(eq(queries.organizationId, actor.organizationId), eq(queries.productId, productId)));
  const prompts = await tx
    .select({ id: aiVisibilityPrompts.id, prompt: aiVisibilityPrompts.prompt, active: aiVisibilityPrompts.active })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.organizationId, actor.organizationId), eq(aiVisibilityPrompts.productId, productId)));
  const suggestions = suggestFaqQuestions(
    existing.map((f) => f.question),
    qs,
    prompts,
  );
  let order = existing.reduce((m, f) => Math.max(m, f.sortOrder + 1), 0);
  for (const sug of suggestions)
    await tx.insert(productFaqs).values({ organizationId: actor.organizationId, productId, question: sug.question, answer: "", suggestedFrom: sug.from, verification: "UNVERIFIED", sortOrder: order++ });
  await audit(tx, actor, "knowledge.faq.suggest", "product", productId, { count: suggestions.length });
  return suggestions;
}

/** Answer (or edit) an FAQ. A verified answer that changes goes back to review. */
export async function answerFaq(tx: Tx, actor: Actor, faqId: string, input: { question: string; answer: string }) {
  return editFact(tx, actor, "faq", faqId, { question: input.question, answer: input.answer });
}
