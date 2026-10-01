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
  productClaims,
} from "@/db/schema";
import { CLAIM_FIELDS, CLAIM_PROPERTY, claimValue, type ClaimField } from "./provenance";
import type { Verification } from "./confidence";

export type Product = typeof products.$inferSelect;
export type Facet = typeof productFacets.$inferSelect;
export type FacetKind = Facet["kind"];
export type PricingPlan = typeof productPricing.$inferSelect;
export type Faq = typeof productFaqs.$inferSelect;
export type Proof = typeof productProofs.$inferSelect;
export type Source = typeof productSources.$inferSelect;
export type ChangelogEntry = typeof productChangelog.$inferSelect;
export type Competitor = typeof competitors.$inferSelect;
export type Claim = typeof productClaims.$inferSelect;
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
  /** Per-field scalar claims (product_claims). Absent or empty = legacy product: `lastVerifiedAt` applies. */
  claims?: Claim[];
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

/** The claim backing a scalar field's current value (same serialised value), if any. */
export function currentClaim(g: ProductGraph, field: ClaimField): Claim | undefined {
  const value = claimValue(g.product, field);
  if (value === null) return undefined;
  const list = (g.claims ?? []).filter((c) => c.field === field);
  return list.find((c) => c.value === value && c.verification === "VERIFIED") ?? list.find((c) => c.value === value);
}

/**
 * Verification of a scalar product field. Uses the per-field claim; products
 * without any claim rows (legacy data) fall back to `lastVerifiedAt`.
 * Empty fields have no claim and report UNVERIFIED.
 */
export function claimVerification(g: ProductGraph, field: ClaimField): Verification {
  if (claimValue(g.product, field) === null) return "UNVERIFIED";
  if (!g.claims?.length) return g.product.lastVerifiedAt ? "VERIFIED" : "UNVERIFIED";
  return currentClaim(g, field)?.verification ?? "UNVERIFIED";
}

const EMPTY_VALUE: Record<ClaimField, unknown> = {
  category: null,
  short_description: null,
  full_description: null,
  how_it_works: null,
  status: "UNKNOWN",
  release_date: null,
  api_available: null,
  free_trial: null,
  languages: [],
  supported_countries: [],
  domain: null,
  documentation_url: null,
  pricing_url: null,
};

/**
 * Public view of the graph: only human-verified facts. Used for anything
 * exposed without authentication (entity JSON, public recommendations).
 * Scalar fields are kept only when their claim is VERIFIED; legacy products
 * without claims keep the previous rule (descriptions and category need
 * `lastVerifiedAt`). Keywords are internal targeting, shown only after a
 * product-level verification.
 */
export function verifiedOnly(g: ProductGraph): ProductGraph {
  const pv = Boolean(g.product.lastVerifiedAt);
  let product: Product;
  if (!g.claims?.length) product = pv ? g.product : { ...g.product, shortDescription: null, fullDescription: null, howItWorks: null, category: null, keywords: [] };
  else {
    const patch: Record<string, unknown> = {};
    for (const f of CLAIM_FIELDS) if (claimVerification(g, f) !== "VERIFIED") patch[CLAIM_PROPERTY[f]] = EMPTY_VALUE[f];
    product = { ...g.product, ...patch, keywords: pv ? g.product.keywords : [] } as Product;
  }
  return {
    ...g,
    product,
    facets: g.facets.filter(isVerified),
    pricing: g.pricing.filter(isVerified),
    faqs: g.faqs.filter(isVerified),
    proofs: g.proofs.filter((p) => isVerified(p) && p.publishable),
    changelog: g.changelog.filter(isVerified),
    competitors: g.competitors.map((c) => ({ ...c, comparisonFacts: c.comparisonFacts.filter((f) => f.verifiedAt && f.sourceUrl) })),
    claims: (g.claims ?? []).filter(isVerified),
  };
}
