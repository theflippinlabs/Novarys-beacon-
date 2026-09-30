import type { ChangelogEntry, Competitor, Facet, FacetKind, Faq, PricingPlan, Product, ProductCompetitor, ProductGraph, Proof, Source } from "@/core/knowledge/types";

/** Fixed timestamp so fixtures never depend on the wall clock. */
export const FIXED_DATE = new Date("2026-01-15T12:00:00.000Z");
export const ORG_ID = "00000000-0000-4000-8000-000000000001";
export const PRODUCT_ID = "00000000-0000-4000-8000-0000000000aa";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    organizationId: ORG_ID,
    slug: "acme",
    name: "Acme",
    domain: null,
    logoUrl: null,
    screenshots: [],
    shortDescription: null,
    fullDescription: null,
    howItWorks: null,
    category: null,
    status: "UNKNOWN",
    releaseDate: null,
    languages: [],
    supportedCountries: [],
    documentationUrl: null,
    apiAvailable: null,
    freeTrial: null,
    pricingUrl: null,
    socialAccounts: [],
    conversionUrls: [],
    trackingParams: {},
    keywords: [],
    semanticEntities: [],
    onboardingStep: 0,
    onboardingCompletedAt: null,
    lastVerifiedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: nextId("src"),
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    url: "https://acme.example/",
    title: "Acme website",
    kind: "WEBSITE",
    lastCheckedAt: null,
    httpStatus: null,
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeFacet(kind: FacetKind, name: string, overrides: Partial<Facet> = {}): Facet {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    id: nextId(`facet-${kind.toLowerCase()}`),
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    kind,
    slug,
    name,
    description: null,
    sourceId: null,
    verification: "VERIFIED",
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makePricing(overrides: Partial<PricingPlan> = {}): PricingPlan {
  return {
    id: nextId("price"),
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    planName: "Pro",
    priceCents: 4900,
    currency: "EUR",
    interval: "MONTH",
    description: null,
    includedFeatures: [],
    trialDays: null,
    sourceId: null,
    verification: "VERIFIED",
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeFaq(question: string, answer: string, overrides: Partial<Faq> = {}): Faq {
  return {
    id: nextId("faq"),
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    question,
    answer,
    sourceId: null,
    verification: "VERIFIED",
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeProof(overrides: Partial<Proof> = {}): Proof {
  return {
    id: nextId("proof"),
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    kind: "TESTIMONIAL",
    title: "Customer quote",
    content: "It saved our moderators hours every week.",
    attribution: "Jane, Agency lead",
    sourceId: null,
    verification: "VERIFIED",
    publishable: true,
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeChangelog(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: nextId("chg"),
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    version: "1.2.0",
    releasedOn: "2026-01-10",
    title: "Keyword filters",
    body: "Added keyword filters for live chat.",
    sourceId: null,
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeCompetitor(name: string, facts: ProductCompetitor["comparisonFacts"] = [], overrides: Partial<Competitor> = {}): ProductCompetitor {
  const competitor: Competitor = {
    id: nextId("comp"),
    organizationId: ORG_ID,
    name,
    slug: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    domain: null,
    notes: null,
    createdAt: FIXED_DATE,
    ...overrides,
  };
  return { organizationId: ORG_ID, productId: PRODUCT_ID, competitorId: competitor.id, comparisonFacts: facts, createdAt: FIXED_DATE, competitor };
}

export function sourcedFacts(n: number, sourced = true): ProductCompetitor["comparisonFacts"] {
  return Array.from({ length: n }, (_, i) => ({
    dimension: `Dimension ${i + 1}`,
    product: `Acme value ${i + 1}`,
    competitor: `Rival value ${i + 1}`,
    sourceUrl: sourced ? `https://rival.example/pricing#${i + 1}` : "",
    verifiedAt: "2026-01-01",
  }));
}

export function makeGraph(overrides: Partial<Omit<ProductGraph, "product">> & { product?: Partial<Product> } = {}): ProductGraph {
  const { product, ...rest } = overrides;
  return {
    product: makeProduct(product),
    facets: [],
    pricing: [],
    faqs: [],
    proofs: [],
    sources: [],
    changelog: [],
    competitors: [],
    ...rest,
  };
}

/**
 * A realistic, complete product graph for "Beacon Live", a TikTok live
 * moderation product. Used by generation / fact-check tests.
 */
export function completeGraph(): ProductGraph {
  const site = makeSource({ url: "https://beaconlive.example/", title: "Beacon Live" });
  const docs = makeSource({ url: "https://beaconlive.example/docs", title: "Docs", kind: "DOCUMENTATION" });
  const pricingSrc = makeSource({ url: "https://beaconlive.example/pricing", title: "Pricing", kind: "PRICING" });
  return makeGraph({
    product: {
      slug: "beacon-live",
      name: "Beacon Live",
      domain: "beaconlive.example",
      shortDescription: "Real-time moderation for TikTok live streams.",
      fullDescription: "Beacon Live filters spam and abusive comments in TikTok live chats so creators and agencies can keep streams safe.",
      howItWorks: "1. Connect your TikTok account.\n2. Choose keyword filters.\n3. Go live and let Beacon Live hide spam.",
      category: "Live moderation",
      status: "LIVE",
      languages: ["en"],
      apiAvailable: false,
      freeTrial: true,
      pricingUrl: "https://beaconlive.example/pricing",
      documentationUrl: "https://beaconlive.example/docs",
      conversionUrls: [{ label: "Start free trial", url: "https://beaconlive.example/signup", kind: "TRY_FREE" }],
      socialAccounts: [{ network: "x", url: "https://x.com/beaconlive" }],
      keywords: ["tiktok live moderation"],
      lastVerifiedAt: FIXED_DATE,
    },
    sources: [site, docs, pricingSrc],
    facets: [
      makeFacet("FEATURE", "Keyword filters", { description: "Hide live comments that contain blocked keywords or phrases.", sourceId: docs.id }),
      makeFacet("FEATURE", "Spam detection", { description: "Detect repeated spam messages in live chat automatically.", sourceId: docs.id }),
      makeFacet("FEATURE", "Moderator dashboard", { description: "Review hidden comments and moderator actions in one dashboard.", sourceId: docs.id }),
      makeFacet("AUDIENCE", "TikTok agencies", { description: "Agencies that manage many TikTok live creators.", sourceId: site.id }),
      makeFacet("PROBLEM", "Spam in TikTok live chat", { description: "Spam and abusive comments disrupt TikTok live streams.", sourceId: site.id }),
      makeFacet("INTEGRATION", "TikTok", { description: "Connects to TikTok live via the official account login.", sourceId: docs.id }),
    ],
    pricing: [makePricing({ planName: "Pro", priceCents: 2900, interval: "MONTH", trialDays: 14, sourceId: pricingSrc.id })],
    faqs: [makeFaq("Does Beacon Live work with TikTok live?", "Yes, Beacon Live moderates TikTok live chats in real time.", { sourceId: site.id })],
    proofs: [makeProof()],
    changelog: [makeChangelog()],
    competitors: [makeCompetitor("Rival", sourcedFacts(3))],
  });
}
