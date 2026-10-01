import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { products } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { normalizeDomain } from "@/core/knowledge/parse";
import { FACET_LABELS, type FacetKind } from "@/core/knowledge/types";
import { computeBeaconScore, type BeaconScore } from "@/core/score/beacon-score";
import { createProduct, updateProduct } from "@/services/products";
import { listMedia, mediaUrl, setProductLogo } from "@/services/media";
import { computeAndStoreScore, latestScoreDetail, latestScores, scoreInput } from "@/services/score";
import { audit } from "@/lib/audit";
import { defineTool } from "../types";
import { agentActor, capped, idRef, iso, limitInput, LIST_CAP, productLinks, productRef, requirePermission, resolveProduct, trim } from "./util";

const STATUS = z.enum(["UNKNOWN", "IN_DEVELOPMENT", "BETA", "LIVE", "DEPRECATED"]);

function scoreSummary(score: BeaconScore) {
  return {
    total: Math.round(score.total),
    components: score.components.map((c) => ({ key: c.key, label: c.label, earned: Math.round(c.earned * 10) / 10, max: c.max, lines: c.lines.map((l) => ({ label: l.label, earned: Math.round(l.earned * 10) / 10, max: l.max, reason: trim(l.reason, 200) })) })),
    fastestPath: { target: score.pathTo.target, tasks: score.pathTo.tasks.slice(0, 8) },
  };
}

export const listProducts = defineTool({
  name: "list_products",
  label: "Listing products",
  description:
    "List the workspace's products with slug, status, domain, knowledge-graph completeness (0 to 100 %), latest stored Beacon Score (or \"not computed yet\") and onboarding state. Use the slug to reference a product in other tools.",
  permission: "read",
  kind: "read",
  input: z.object({}),
  run: async ({ tx, ctx }) => {
    const list = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(asc(products.name));
    const scores = await latestScores(tx, ctx.org.id);
    const rows = [];
    for (const p of list) {
      const g = await loadProductGraph(tx, ctx.org.id, p.id);
      const s = scores.get(p.id);
      rows.push({
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        domain: p.domain,
        completenessPct: g ? Math.round(computeCompleteness(g).score * 100) : 0,
        beaconScore: s ? Math.round(s.total) : "not computed yet",
        onboarding: p.onboardingCompletedAt ? "complete" : `in progress (step ${p.onboardingStep})`,
        link: `/products/${p.slug}`,
      });
    }
    return { ...capped(rows, 100), link: "/products" };
  },
});

export const getProduct = defineTool({
  name: "get_product",
  label: "Reading a product",
  description:
    "Read one product's knowledge graph summary: core fields, facets (features, use cases, audiences, industries, problems, integrations, differentiators) with their verification status and whether they are sourced, pricing plans, FAQs, canonical sources, competitors with comparison-fact counts, completeness with what is missing, and the live Beacon Score breakdown with the fastest path to improve it. Facts marked UNVERIFIED/NEEDS_REVIEW are drafts that a human must verify in the app.",
  permission: "read",
  kind: "read",
  input: z.object({ product: productRef() }),
  run: async ({ tx, ctx }, input) => {
    const p = await resolveProduct(tx, ctx.org.id, input.product);
    const g = (await loadProductGraph(tx, ctx.org.id, p.id))!;
    const completeness = computeCompleteness(g);
    const score = computeBeaconScore(await scoreInput(tx, ctx.org.id, p.id));
    const stored = await latestScoreDetail(tx, ctx.org.id, p.id);
    const sourceIds = new Set(g.sources.map((s) => s.id));
    const facets: Record<string, unknown> = {};
    for (const kind of Object.keys(FACET_LABELS) as FacetKind[]) {
      const list = g.facets.filter((f) => f.kind === kind).map((f) => ({ id: f.id, name: f.name, description: trim(f.description, 200), verification: f.verification, sourced: Boolean(f.sourceId && sourceIds.has(f.sourceId)) }));
      facets[kind] = capped(list);
    }
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      domain: p.domain,
      logoUrl: p.logoUrl,
      category: p.category,
      keywords: p.keywords,
      shortDescription: trim(p.shortDescription, 400),
      fullDescription: trim(p.fullDescription, 1200),
      howItWorks: trim(p.howItWorks, 800),
      releaseDate: p.releaseDate,
      languages: p.languages,
      supportedCountries: p.supportedCountries,
      documentationUrl: p.documentationUrl,
      pricingUrl: p.pricingUrl,
      apiAvailable: p.apiAvailable ?? "unknown",
      freeTrial: p.freeTrial ?? "unknown",
      conversionUrls: p.conversionUrls,
      coreDescriptionVerifiedAt: iso(p.lastVerifiedAt) ?? "not verified",
      onboarding: p.onboardingCompletedAt ? "complete" : `in progress (step ${p.onboardingStep})`,
      facets,
      pricing: g.pricing.map((x) => ({ id: x.id, planName: x.planName, price: x.priceCents === null ? "not public" : x.priceCents, currency: x.currency, interval: x.interval, trialDays: x.trialDays, verification: x.verification, sourced: Boolean(x.sourceId) })),
      faqs: capped(g.faqs.map((f) => ({ id: f.id, question: trim(f.question, 200), answer: trim(f.answer, 300), verification: f.verification, sourced: Boolean(f.sourceId) }))),
      sources: capped(g.sources.map((s) => ({ id: s.id, title: s.title, url: s.url, kind: s.kind }))),
      competitors: g.competitors.map((c) => ({
        id: c.competitor.id,
        name: c.competitor.name,
        domain: c.competitor.domain,
        comparisonFacts: c.comparisonFacts.length,
        sourcedFacts: c.comparisonFacts.filter((f) => f.sourceUrl).length,
        verifiedFacts: c.comparisonFacts.filter((f) => f.verifiedAt).length,
      })),
      proofs: { total: g.proofs.length, verifiedAndPublishable: g.proofs.filter((x) => x.verification === "VERIFIED" && x.publishable).length },
      completeness: { pct: Math.round(completeness.score * 100), missing: completeness.missing.map((m) => ({ item: m.label, status: m.status, hint: m.hint })) },
      beaconScore: { live: scoreSummary(score), lastStored: stored ? { total: Math.round(stored.total), computedAt: iso(stored.computedAt) } : "not computed yet", note: "Measures discovery readiness, not rankings." },
      ...productLinks(p.slug),
    };
  },
});

const productFields = {
  domain: z.string().trim().max(200).optional().describe("Canonical domain, e.g. example.com (no path)."),
  status: STATUS.optional().describe("Lifecycle status."),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Release date, YYYY-MM-DD."),
  category: z.string().trim().max(120).optional().describe("Product category, e.g. \"Live moderation\"."),
  keywords: z.array(z.string().trim().min(1).max(80)).max(30).optional().describe("Category keywords (replaces the list)."),
  shortDescription: z.string().trim().max(300).optional().describe("One precise sentence: what it is and who it is for. Only facts the user stated or that are on the product's own site."),
  fullDescription: z.string().trim().max(6000).optional().describe("Full description (a paragraph or more)."),
  howItWorks: z.string().trim().max(6000).optional().describe("How the product works."),
  documentationUrl: z.string().trim().max(2000).regex(/^https:\/\/\S+$/i, "must be an https:// URL").optional().describe("Documentation URL (https)."),
  pricingUrl: z.string().trim().max(2000).regex(/^https:\/\/\S+$/i, "must be an https:// URL").optional().describe("Public pricing page URL (https)."),
  languages: z.array(z.string().trim().min(2).max(10)).max(30).optional().describe("Supported UI languages as codes, e.g. [\"en\", \"fr\"] (replaces the list)."),
  supportedCountries: z.array(z.string().trim().min(2).max(10)).max(250).optional().describe("Supported country codes, e.g. [\"FR\", \"US\"] (replaces the list)."),
  apiAvailable: z.boolean().optional().describe("Whether a public API is available (omit if unknown)."),
  freeTrial: z.boolean().optional().describe("Whether a free trial exists (omit if unknown)."),
};

type ProductPatch = Partial<typeof products.$inferInsert>;
const CORE_DESCRIPTION: (keyof ProductPatch)[] = ["shortDescription", "fullDescription", "howItWorks", "category", "keywords"];

function toPatch(i: { [K in keyof typeof productFields]?: z.infer<(typeof productFields)[K]> }): ProductPatch {
  const patch: ProductPatch = {};
  if (i.domain !== undefined) {
    const d = i.domain ? normalizeDomain(i.domain) : null;
    if (i.domain && !d) throw new Error("Enter a valid domain, e.g. example.com");
    patch.domain = d;
  }
  if (i.status !== undefined) patch.status = i.status;
  if (i.releaseDate !== undefined) patch.releaseDate = i.releaseDate;
  if (i.category !== undefined) patch.category = i.category || null;
  if (i.keywords !== undefined) patch.keywords = i.keywords;
  if (i.shortDescription !== undefined) patch.shortDescription = i.shortDescription || null;
  if (i.fullDescription !== undefined) patch.fullDescription = i.fullDescription || null;
  if (i.howItWorks !== undefined) patch.howItWorks = i.howItWorks || null;
  if (i.documentationUrl !== undefined) patch.documentationUrl = i.documentationUrl;
  if (i.pricingUrl !== undefined) patch.pricingUrl = i.pricingUrl;
  if (i.languages !== undefined) patch.languages = i.languages.map((l) => l.toLowerCase());
  if (i.supportedCountries !== undefined) patch.supportedCountries = i.supportedCountries.map((c) => c.toUpperCase());
  if (i.apiAvailable !== undefined) patch.apiAvailable = i.apiAvailable;
  if (i.freeTrial !== undefined) patch.freeTrial = i.freeTrial;
  return patch;
}

export const createProductTool = defineTool({
  name: "create_product",
  label: "Creating a product",
  description:
    "Create a new product in the workspace, optionally with its basic onboarding fields (domain, category, descriptions…). Only use facts the user gave you or that come from the product's own website; never invent features, prices or claims. The product starts unverified; the user completes and verifies it in the app. Returns the product slug and links to its onboarding and knowledge graph.",
  permission: "product:write",
  kind: "write",
  input: z.object({
    name: z.string().trim().min(2).max(80).describe("Product name."),
    slug: z.string().trim().max(80).optional().describe("URL slug; derived from the name when omitted."),
    ...productFields,
  }),
  run: async (c, input) => {
    requirePermission(c, "product:write");
    const actor = agentActor(c);
    const { name, slug, ...fields } = input;
    const patch = toPatch(fields);
    const p = await createProduct(c.tx, actor, { name, slug: slug || null });
    if (Object.keys(patch).length) await updateProduct(c.tx, actor, p.id, patch);
    return {
      created: { id: p.id, name: p.name, slug: p.slug },
      fieldsSet: Object.keys(patch),
      next: "Complete onboarding (audience, problems, features, pricing, sources) and verify facts in the app; then sync the page plan and generate query suggestions.",
      link: `/products/${p.slug}/onboarding?step=1`,
      knowledgeLink: `/products/${p.slug}/knowledge`,
    };
  },
});

export const updateProductTool = defineTool({
  name: "update_product",
  label: "Updating a product",
  description:
    "Update a product's core fields (name, domain, status, category, keywords, descriptions, URLs, languages, countries, API/free-trial flags). Only send the fields to change. Only use facts the user gave you or that come from the product's own site. Changing the descriptions, category or keywords of a human-verified product clears its verification so a human re-verifies it in the app.",
  permission: "product:write",
  kind: "write",
  input: z.object({ product: productRef(), name: z.string().trim().min(2).max(80).optional().describe("New product name."), ...productFields }),
  run: async (c, input) => {
    requirePermission(c, "product:write");
    const { product, name, ...fields } = input;
    const p = await resolveProduct(c.tx, c.ctx.org.id, product);
    const patch = toPatch(fields);
    if (name !== undefined) patch.name = name;
    if (!Object.keys(patch).length) throw new Error("Nothing to update: pass at least one field.");
    const touchesCore = CORE_DESCRIPTION.some((k) => k in patch);
    const needsReverification = touchesCore && Boolean(p.lastVerifiedAt);
    if (needsReverification) patch.lastVerifiedAt = null;
    await updateProduct(c.tx, agentActor(c), p.id, patch);
    return { updated: Object.keys(patch).filter((k) => k !== "lastVerifiedAt"), needsReverification, ...productLinks(p.slug) };
  },
});

export const listProductPhotos = defineTool({
  name: "list_product_photos",
  label: "Listing product photos",
  description: "List the images uploaded for a product (id, file name, size, dimensions, visibility, URL). Use an image id with set_product_logo. Does not return image bytes.",
  permission: "read",
  kind: "read",
  input: z.object({ product: productRef(), limit: limitInput }),
  run: async ({ tx, ctx }, input) => {
    const p = await resolveProduct(tx, ctx.org.id, input.product);
    const rows = await listMedia(tx, ctx.org.id, { productId: p.id }, (input.limit ?? LIST_CAP) + 1);
    const items = rows.map((m) => ({ id: m.id, filename: m.filename, width: m.width, height: m.height, sizeBytes: m.sizeBytes, visibility: m.visibility, alt: m.alt, url: mediaUrl(m.id), isLogo: Boolean(p.logoUrl && p.logoUrl.endsWith(`/${m.id}`)), uploadedAt: iso(m.createdAt) }));
    return { ...capped(items, input.limit ?? LIST_CAP), currentLogoUrl: p.logoUrl, ...productLinks(p.slug) };
  },
});

export const setProductLogoTool = defineTool({
  name: "set_product_logo",
  label: "Setting the product logo",
  description: "Use an uploaded image (from list_product_photos or an image the user attached) as the product's logo. The image must be PUBLIC and belong to this workspace.",
  permission: "product:write",
  kind: "write",
  input: z.object({ product: productRef(), mediaId: idRef("Id of the uploaded image to use as the logo.") }),
  run: async (c, input) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, input.product);
    const r = await setProductLogo(c.tx, agentActor(c), p.id, input.mediaId);
    return { logoUrl: r.logoUrl, ...productLinks(p.slug) };
  },
});

export const recomputeBeaconScore = defineTool({
  name: "recompute_beacon_score",
  label: "Recomputing the Beacon Score",
  description: "Recompute and store a product's Beacon Score (0 to 100: technical discovery, content coverage, entity completeness, authority, query coverage, conversion readiness, measurement). Returns the total, each component and the fastest path to improve it. It measures readiness, not rankings.",
  permission: "job:run",
  kind: "write",
  input: z.object({ product: productRef() }),
  run: async (c, input) => {
    requirePermission(c, "job:run");
    const p = await resolveProduct(c.tx, c.ctx.org.id, input.product);
    const score = await computeAndStoreScore(c.tx, c.ctx.org.id, p.id);
    await audit(c.tx, agentActor(c), "score.compute", "product", p.id, { total: score.total });
    return { product: p.slug, ...scoreSummary(score), link: `/products/${p.slug}` };
  },
});
