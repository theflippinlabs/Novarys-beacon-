import { z } from "zod";
import { INTERVALS, normalizeDomain, SOURCE_KINDS } from "@/core/knowledge/parse";
import { addComparisonFact, addCompetitor, addFacet, addFaq, addPricingPlan, addSource } from "@/services/knowledge";
import { defineTool } from "../types";
import { agentActor, idRef, productRef, requirePermission, resolveProduct } from "./util";

const DRAFT_NOTE = "Saved as UNVERIFIED: a human must review and verify it in the app before it is used publicly.";
const FACET_KINDS = z.enum(["FEATURE", "USE_CASE", "AUDIENCE", "INDUSTRY", "PROBLEM", "INTEGRATION", "DIFFERENTIATOR"]);
const sourceIdInput = idRef("Id of one of the product's canonical sources backing this fact (see get_product → sources). Strongly recommended.").optional();
const FACT_RULE = "Only add facts the user stated or that appear on a source you can cite — never invent features, prices, numbers, customers or awards.";

export const addProductFacet = defineTool({
  name: "add_product_facet",
  label: "Adding a knowledge-graph fact",
  description: `Add one item to a product's knowledge graph: a feature, use case, audience, industry, problem solved, integration or differentiator. ${FACT_RULE} ${DRAFT_NOTE}`,
  permission: "product:write",
  kind: "write",
  input: z.object({
    product: productRef(),
    kind: FACET_KINDS.describe("Which part of the graph this item belongs to."),
    name: z.string().trim().min(2).max(120).describe("Short name, e.g. \"Keyword filters\"."),
    description: z.string().trim().max(2000).optional().describe("Factual description (≥ 60 characters lets Beacon plan a dedicated page)."),
    sourceId: sourceIdInput,
  }),
  run: async (c, i) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const row = await addFacet(c.tx, agentActor(c), p.id, { kind: i.kind, name: i.name, description: i.description, sourceId: i.sourceId });
    return { added: { id: row.id, kind: row.kind, name: row.name, verification: row.verification }, note: DRAFT_NOTE, link: `/products/${p.slug}/knowledge` };
  },
});

export const addPricingPlanTool = defineTool({
  name: "add_pricing_plan",
  label: "Adding a pricing plan",
  description: `Add a pricing plan to a product. Leave priceMinorUnits out when the price is not public — never guess it. ${FACT_RULE} ${DRAFT_NOTE}`,
  permission: "product:write",
  kind: "write",
  input: z.object({
    product: productRef(),
    planName: z.string().trim().min(1).max(80).describe("Plan name, e.g. \"Pro\"."),
    priceMinorUnits: z.number().int().min(0).max(100_000_000).optional().describe("Price in minor units (cents), e.g. 2900 for 29.00. Omit if not public."),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional().describe("ISO currency code (default EUR)."),
    interval: z.enum(INTERVALS).optional().describe("Billing interval (default MONTH)."),
    trialDays: z.number().int().min(0).max(365).optional().describe("Free-trial length in days, if any."),
    description: z.string().trim().max(1000).optional().describe("What the plan includes."),
    sourceId: sourceIdInput,
  }),
  run: async (c, i) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const row = await addPricingPlan(c.tx, agentActor(c), p.id, {
      planName: i.planName,
      priceCents: i.priceMinorUnits ?? null,
      currency: i.currency ?? "EUR",
      interval: i.interval ?? "MONTH",
      trialDays: i.trialDays ?? null,
      description: i.description ?? null,
      sourceId: i.sourceId,
    });
    return { added: { id: row.id, planName: row.planName, price: row.priceCents ?? "not public", currency: row.currency, interval: row.interval, verification: row.verification }, note: DRAFT_NOTE, link: `/products/${p.slug}/knowledge` };
  },
});

export const addProductFaq = defineTool({
  name: "add_product_faq",
  label: "Adding an FAQ",
  description: `Add a factual FAQ entry (question + answer) to a product. ${FACT_RULE} ${DRAFT_NOTE}`,
  permission: "product:write",
  kind: "write",
  input: z.object({
    product: productRef(),
    question: z.string().trim().min(5).max(300).describe("The question, as a user would ask it."),
    answer: z.string().trim().min(10).max(3000).describe("A factual answer."),
    sourceId: sourceIdInput,
  }),
  run: async (c, i) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const row = await addFaq(c.tx, agentActor(c), p.id, { question: i.question, answer: i.answer, sourceId: i.sourceId ?? null });
    return { added: { id: row.id, question: row.question, verification: row.verification }, note: DRAFT_NOTE, link: `/products/${p.slug}/knowledge` };
  },
});

export const addProductSource = defineTool({
  name: "add_product_source",
  label: "Adding a source",
  description: "Add a canonical source (an https page on the product's site, its docs, pricing page, changelog, repository…) that facts can cite. Returns the source id to pass as sourceId when adding facts.",
  permission: "product:write",
  kind: "write",
  input: z.object({
    product: productRef(),
    title: z.string().trim().min(2).max(200).describe("Human-readable title of the page."),
    url: z.string().trim().max(2000).regex(/^https:\/\/\S+$/i, "must be an https:// URL").describe("The https URL."),
    kind: z.enum(SOURCE_KINDS).optional().describe("Kind of source (default WEBSITE)."),
  }),
  run: async (c, i) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const row = await addSource(c.tx, agentActor(c), p.id, { title: i.title, url: i.url, kind: i.kind ?? "WEBSITE" });
    return { added: { id: row.id, title: row.title, url: row.url, kind: row.kind }, link: `/products/${p.slug}/knowledge` };
  },
});

export const addCompetitorTool = defineTool({
  name: "add_competitor",
  label: "Adding a competitor",
  description: "Link a competitor to a product (creating it in the workspace if needed). Existing competitors are kept. Returns the competitor id for add_comparison_fact.",
  permission: "product:write",
  kind: "write",
  input: z.object({
    product: productRef(),
    name: z.string().trim().min(2).max(80).describe("Competitor name."),
    domain: z.string().trim().max(200).optional().describe("Competitor's domain, e.g. rival.com."),
  }),
  run: async (c, i) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const domain = i.domain ? normalizeDomain(i.domain) : null;
    if (i.domain && !domain) throw new Error("Enter a valid competitor domain, e.g. rival.com");
    const r = await addCompetitor(c.tx, agentActor(c), p.id, { name: i.name, domain });
    return { competitor: { id: r.competitor.id, name: r.competitor.name, domain: r.competitor.domain }, alreadyLinked: r.alreadyLinked, link: `/products/${p.slug}/knowledge` };
  },
});

export const addComparisonFactTool = defineTool({
  name: "add_comparison_fact",
  label: "Adding a comparison fact",
  description: `Add one sourced comparison point between a product and a linked competitor (e.g. dimension "Free plan": product "Yes", competitor "No"). Every fact needs an https source URL that shows it. ${FACT_RULE} Saved unverified; comparison pages need at least 3 sourced, human-verified facts.`,
  permission: "product:write",
  kind: "write",
  input: z.object({
    product: productRef(),
    competitorId: idRef("Id of a competitor linked to the product (see get_product → competitors)."),
    dimension: z.string().trim().min(2).max(120).describe("What is compared, e.g. \"Free plan\"."),
    productValue: z.string().trim().min(1).max(300).describe("The product's value on this dimension."),
    competitorValue: z.string().trim().min(1).max(300).describe("The competitor's value on this dimension."),
    sourceUrl: z.string().trim().max(2000).regex(/^https:\/\/\S+$/i, "must be an https:// URL").describe("https URL where the competitor's value can be checked."),
  }),
  run: async (c, i) => {
    requirePermission(c, "product:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const r = await addComparisonFact(c.tx, agentActor(c), { productId: p.id, competitorId: i.competitorId, dimension: i.dimension, product: i.productValue, competitor: i.competitorValue, sourceUrl: i.sourceUrl, verified: false });
    return { added: { dimension: i.dimension, verified: false }, factsForCompetitor: r.count, note: "Unverified until a human verifies it in the app.", link: `/products/${p.slug}/knowledge` };
  },
});
