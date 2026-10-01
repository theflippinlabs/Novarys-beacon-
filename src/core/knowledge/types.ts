import type {
  competitors,
  productChangelog,
  productFacets,
  productFaqs,
  productPricing,
  productProofs,
  products,
  productSources,
  productCompetitors,
} from "@/db/schema";

export type Product = typeof products.$inferSelect;
export type Facet = typeof productFacets.$inferSelect;
export type FacetKind = Facet["kind"];
export type PricingPlan = typeof productPricing.$inferSelect;
export type Faq = typeof productFaqs.$inferSelect;
export type Proof = typeof productProofs.$inferSelect;
export type Source = typeof productSources.$inferSelect;
export type ChangelogEntry = typeof productChangelog.$inferSelect;
export type Competitor = typeof competitors.$inferSelect;
export type ProductCompetitor = typeof productCompetitors.$inferSelect & { competitor: Competitor };

/** The complete knowledge graph for one product: the single source of truth for generation. */
export type ProductGraph = {
  product: Product;
  facets: Facet[];
  pricing: PricingPlan[];
  faqs: Faq[];
  proofs: Proof[];
  sources: Source[];
  changelog: ChangelogEntry[];
  competitors: ProductCompetitor[];
};

export const FACET_LABELS: Record<FacetKind, { singular: string; plural: string }> = {
  FEATURE: { singular: "Feature", plural: "Features" },
  USE_CASE: { singular: "Use case", plural: "Use cases" },
  AUDIENCE: { singular: "Audience", plural: "Target audiences" },
  INDUSTRY: { singular: "Industry", plural: "Industries" },
  PROBLEM: { singular: "Problem solved", plural: "Problems solved" },
  INTEGRATION: { singular: "Integration", plural: "Integrations" },
  DIFFERENTIATOR: { singular: "Differentiator", plural: "Differentiators" },
};

export const facetsOf = (g: ProductGraph, kind: FacetKind) => g.facets.filter((f) => f.kind === kind && f.verification !== "REJECTED");

/** A fact is "usable" for public generation when it has not been rejected. Verified facts carry more confidence. */
export const isVerified = (x: { verification: string }) => x.verification === "VERIFIED";

/**
 * Public view of the graph: only human-verified facts. Used for anything
 * exposed without authentication (entity JSON, public recommendations).
 */
export function verifiedOnly(g: ProductGraph): ProductGraph {
  const pv = Boolean(g.product.lastVerifiedAt);
  return {
    ...g,
    product: pv ? g.product : { ...g.product, shortDescription: null, fullDescription: null, howItWorks: null, category: null, keywords: [] },
    facets: g.facets.filter(isVerified),
    pricing: g.pricing.filter(isVerified),
    faqs: g.faqs.filter(isVerified),
    proofs: g.proofs.filter((p) => isVerified(p) && p.publishable),
    competitors: g.competitors.map((c) => ({ ...c, comparisonFacts: c.comparisonFacts.filter((f) => f.verifiedAt && f.sourceUrl) })),
  };
}
