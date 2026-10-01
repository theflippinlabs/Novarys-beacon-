import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { opportunities, products, queries } from "@/db/schema";
import { allProductIds, generateProductOpportunities, setOpportunityStatus } from "@/services/opportunities";
import { audit } from "@/lib/audit";
import { defineTool } from "../types";
import { agentActor, capped, idRef, iso, limitInput, LIST_CAP, optionalProductRef, requirePermission, resolveOptionalProduct, trim } from "./util";

const STATUS = z.enum(["OPEN", "ACCEPTED", "IN_PROGRESS", "DONE", "DISMISSED"]);

export const listOpportunities = defineTool({
  name: "list_opportunities",
  label: "Reading opportunities",
  description:
    "List growth opportunities, highest priority first (priority = impact × confidence × urgency ÷ effort). Each has a type, title, problem, potential (LOW/MEDIUM/HIGH — never a promised number), status and product. Filter by product, status (default OPEN), potential or type. Use get_opportunity for evidence and actions.",
  permission: "read",
  kind: "read",
  input: z.object({
    product: optionalProductRef(),
    status: z.enum(["OPEN", "ACCEPTED", "IN_PROGRESS", "DONE", "DISMISSED", "ALL"]).optional().describe("Status filter (default OPEN)."),
    potential: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Only this potential."),
    type: z.string().trim().max(60).optional().describe("Only this opportunity type (e.g. CONTENT_GAP, STRIKING_DISTANCE, AI_VISIBILITY_GAP)."),
    limit: limitInput,
  }),
  run: async ({ tx, ctx }, i) => {
    const product = await resolveOptionalProduct(tx, ctx.org.id, i.product);
    const status = i.status ?? "OPEN";
    const limit = i.limit ?? LIST_CAP;
    const rows = await tx
      .select({ o: opportunities, productSlug: products.slug })
      .from(opportunities)
      .leftJoin(products, eq(products.id, opportunities.productId))
      .where(
        and(
          eq(opportunities.organizationId, ctx.org.id),
          product ? eq(opportunities.productId, product.id) : undefined,
          status !== "ALL" ? eq(opportunities.status, status) : undefined,
          i.potential ? eq(opportunities.potential, i.potential) : undefined,
          i.type ? eq(opportunities.type, i.type) : undefined,
        ),
      )
      .orderBy(desc(opportunities.priorityScore))
      .limit(limit + 1);
    return {
      ...capped(
        rows.map(({ o, productSlug }) => ({ id: o.id, type: o.type, title: o.title, problem: trim(o.problem, 240), potential: o.potential, priority: Math.round(o.priorityScore * 10) / 10, status: o.status, product: productSlug, link: `/opportunities/${o.id}` })),
        limit,
      ),
      link: "/opportunities",
    };
  },
});

export const getOpportunity = defineTool({
  name: "get_opportunity",
  label: "Reading an opportunity",
  description: "Read one opportunity in full: problem, measured evidence, competitors involved, ordered recommended actions (with done flags), impact/confidence/effort/urgency, status, product and target query.",
  permission: "read",
  kind: "read",
  input: z.object({ id: idRef("Opportunity id.") }),
  run: async ({ tx, ctx }, i) => {
    const o = await tx.query.opportunities.findFirst({ where: and(eq(opportunities.id, i.id), eq(opportunities.organizationId, ctx.org.id)) });
    if (!o) throw new Error("Opportunity not found");
    const product = o.productId ? await tx.query.products.findFirst({ where: eq(products.id, o.productId) }) : null;
    const query = o.queryId ? await tx.query.queries.findFirst({ where: eq(queries.id, o.queryId) }) : null;
    return {
      id: o.id,
      type: o.type,
      title: o.title,
      problem: trim(o.problem, 1500),
      evidence: o.evidence.slice(0, 20),
      competitors: o.competitors.slice(0, 20),
      actions: o.actions.slice(0, 20),
      potential: o.potential,
      scores: { impact: o.impact, confidence: o.confidence, effort: o.effort, urgency: o.urgency, priority: Math.round(o.priorityScore * 10) / 10 },
      status: o.status,
      product: product ? { name: product.name, slug: product.slug } : null,
      targetQuery: query ? { id: query.id, query: query.query, intent: query.intent, coverage: query.coverage } : null,
      generatedBy: o.generatedBy,
      updatedAt: iso(o.updatedAt),
      link: `/opportunities/${o.id}`,
    };
  },
});

export const generateOpportunities = defineTool({
  name: "generate_opportunities",
  label: "Generating opportunities",
  description:
    "Re-run the evidence-based opportunity engine for one product (or all products) now: content gaps, striking-distance queries, AI-visibility gaps, technical issues, missing entity facts, comparisons, orphan/low-converting pages, visibility drops. Idempotent; human decisions (status) are preserved and resolved OPEN items auto-close. Returns counts; then use list_opportunities.",
  permission: "job:run",
  kind: "write",
  input: z.object({ product: optionalProductRef("Only this product") }),
  run: async (c, i) => {
    requirePermission(c, "job:run");
    const org = c.ctx.org.id;
    const product = await resolveOptionalProduct(c.tx, org, i.product);
    const ids = product ? [product.id] : await allProductIds(c.tx, org);
    let total = 0;
    let created = 0;
    let resolved = 0;
    for (const id of ids) {
      const r = await generateProductOpportunities(c.tx, org, id);
      total += r.total;
      created += r.created;
      resolved += r.resolved;
    }
    await audit(c.tx, agentActor(c), "opportunities.generate", product ? "product" : "organization", product?.id ?? org, { products: ids.length, total, created, resolved });
    return { products: ids.length, currentOpportunities: total, newlyCreated: created, autoClosed: resolved, link: product ? `/opportunities?product=${product.slug}` : "/opportunities" };
  },
});

export const setOpportunityStatusTool = defineTool({
  name: "set_opportunity_status",
  label: "Updating an opportunity",
  description:
    "Change an opportunity's status: ACCEPTED (will do), IN_PROGRESS (being worked on), DISMISSED (not relevant), OPEN (reopen), or DONE — only when the user confirms the work is actually finished. Confirm with the user before dismissing.",
  permission: "growth:write",
  kind: "write",
  input: z.object({ id: idRef("Opportunity id."), status: STATUS.describe("New status.") }),
  run: async (c, i) => {
    requirePermission(c, "growth:write");
    const before = await c.tx.query.opportunities.findFirst({ where: and(eq(opportunities.id, i.id), eq(opportunities.organizationId, c.ctx.org.id)) });
    if (!before) throw new Error("Opportunity not found");
    await setOpportunityStatus(c.tx, agentActor(c), i.id, i.status);
    return { id: i.id, title: before.title, from: before.status, to: i.status, link: `/opportunities/${i.id}` };
  },
});
