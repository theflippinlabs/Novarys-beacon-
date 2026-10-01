import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { contentAssets, contentVersions, pages, products, queries } from "@/db/schema";
import { createAsset, createAssetForPage, createAssetFromOpportunity, derivativesOf, generateVersion, getAsset, repurposeAsset } from "@/services/content";
import { CONTENT_TYPES, OPPORTUNITY_CONTENT_TYPES, REPURPOSE_LABELS, REPURPOSE_TYPES } from "@/core/content/types";
import { severityCounts } from "@/core/content/fact-check";
import { enqueue } from "@/jobs/queue";
import type { Actor } from "@/lib/audit";
import type { Tx } from "@/db";
import { defineTool, type AgentToolContext } from "../types";
import { agentActor, capped, idRef, iso, limitInput, LIST_CAP, optionalProductRef, requirePermission, resolveOptionalProduct, resolveProduct, trim } from "./util";

const TYPES = z.enum(CONTENT_TYPES);
const STATUSES = z.enum(["IDEA", "GENERATED", "FACT_CHECK", "SEO_CHECK", "HUMAN_APPROVAL", "APPROVED", "PUBLISHED", "REJECTED"]);
const HUMAN_NOTE = "Approval and publication are human decisions made in the app by a reviewer; the agent never approves or publishes.";
const BODY_MAX = 6000;

/**
 * Generate the next draft version. The deterministic generator runs now (fact-grounded,
 * no LLM); an LLM rewrite is queued for the worker. Checks leave the asset at most in
 * HUMAN_APPROVAL, never APPROVED or PUBLISHED.
 */
async function draft(c: AgentToolContext, actor: Actor, assetId: string, useLlm: boolean) {
  if (useLlm) {
    const asset = await getAsset(c.tx, c.ctx.org.id, assetId);
    await enqueue("content.generate", { assetId, userId: actor.userId ?? null, useLlm: true, baseVersion: asset.currentVersion, baseStatus: asset.status }, { organizationId: actor.organizationId, idempotencyKey: `gen:${assetId}:${asset.currentVersion + 1}` });
    return { generation: "queued (LLM rewrite constrained to the product's facts; the draft appears when the worker finishes)" };
  }
  const r = await generateVersion(c.tx, actor, assetId, c.ctx.org.branding.displayName ?? c.ctx.org.name);
  return {
    generation: "done",
    version: r.version.version,
    status: r.status,
    factCheck: { passed: r.fact.passed, unsupportedClaims: r.fact.claims.filter((x) => x.status !== "SUPPORTED").length, bySeverity: severityCounts(r.fact.claims) },
    seoCheck: { passed: r.seo.passed, failing: r.seo.checks.filter((x) => !x.ok).map((x) => x.message).slice(0, 8) },
    qualityCheck: { passed: r.quality.passed, failing: r.quality.checks.filter((x) => !x.ok).map((x) => x.message).slice(0, 8) },
  };
}

async function assetSummary(tx: Tx, organizationId: string, id: string) {
  const a = await getAsset(tx, organizationId, id);
  return { id: a.id, title: a.title, type: a.type, status: a.status, currentVersion: a.currentVersion };
}

export const listContent = defineTool({
  name: "list_content",
  label: "Reading content",
  description: "List content assets (most recently updated first) with type, status in the pipeline IDEA → GENERATED → FACT_CHECK → SEO_CHECK → HUMAN_APPROVAL → APPROVED → PUBLISHED (or REJECTED), product and current version. Filter by product, status or type.",
  permission: "read",
  kind: "read",
  input: z.object({ product: optionalProductRef(), status: STATUSES.optional().describe("Only this status."), type: TYPES.optional().describe("Only this content type."), limit: limitInput }),
  run: async ({ tx, ctx }, i) => {
    const product = await resolveOptionalProduct(tx, ctx.org.id, i.product);
    const limit = i.limit ?? LIST_CAP;
    const rows = await tx
      .select({ a: contentAssets, productSlug: products.slug })
      .from(contentAssets)
      .leftJoin(products, eq(products.id, contentAssets.productId))
      .where(and(eq(contentAssets.organizationId, ctx.org.id), product ? eq(contentAssets.productId, product.id) : undefined, i.status ? eq(contentAssets.status, i.status) : undefined, i.type ? eq(contentAssets.type, i.type) : undefined))
      .orderBy(desc(contentAssets.updatedAt))
      .limit(limit + 1);
    return {
      ...capped(rows.map(({ a, productSlug }) => ({ id: a.id, title: a.title, type: a.type, status: a.status, product: productSlug, currentVersion: a.currentVersion, updatedAt: iso(a.updatedAt), link: `/content/${a.id}` })), limit),
      link: product ? `/content?product=${product.slug}` : "/content",
    };
  },
});

export const getContent = defineTool({
  name: "get_content",
  label: "Reading a content draft",
  description: `Read one content asset: status, brief, target query, linked page, the current version's text (trimmed), meta title/description, and fact-check and SEO/GEO check results (unsupported claims, failing checks). Body lines starting with "> TODO(editor):" mark missing facts that block approval. ${HUMAN_NOTE}`,
  permission: "read",
  kind: "read",
  input: z.object({ id: idRef("Content asset id.") }),
  run: async ({ tx, ctx }, i) => {
    const a = await getAsset(tx, ctx.org.id, i.id);
    const v = await tx.query.contentVersions.findFirst({ where: eq(contentVersions.assetId, a.id), orderBy: desc(contentVersions.version) });
    const product = a.productId ? await tx.query.products.findFirst({ where: eq(products.id, a.productId) }) : null;
    const page = a.pageId ? await tx.query.pages.findFirst({ where: eq(pages.id, a.pageId) }) : null;
    const target = a.targetQueryId ? await tx.query.queries.findFirst({ where: eq(queries.id, a.targetQueryId) }) : null;
    return {
      id: a.id,
      title: a.title,
      type: a.type,
      status: a.status,
      brief: trim(a.brief, 1000),
      rejectionReason: a.rejectionReason,
      product: product ? { name: product.name, slug: product.slug } : null,
      page: page ? { id: page.id, path: page.path, status: page.status, publishable: page.quality.publishable ?? null } : null,
      targetQuery: target ? { id: target.id, query: target.query } : null,
      currentVersion: v
        ? {
            version: v.version,
            metaTitle: v.metaTitle,
            metaDescription: v.metaDescription,
            body: trim(v.body, BODY_MAX),
            bodyTruncated: v.body.length > BODY_MAX,
            editorTodos: (v.body.match(/^> TODO\(editor\):.*$/gm) ?? []).slice(0, 15),
            factCheck: v.factCheck
              ? { passed: v.factCheck.passed, bySeverity: severityCounts(v.factCheck.claims), flaggedClaims: v.factCheck.claims.filter((x) => x.status !== "SUPPORTED").slice(0, 15).map((x) => ({ claim: trim(x.claim, 200), status: x.status, kind: x.kind ?? null, severity: x.severity ?? null, reason: x.reason ?? null })) }
              : "not run",
            qualityCheck: v.qualityCheck ? { passed: v.qualityCheck.passed, failing: v.qualityCheck.checks.filter((x) => !x.ok).map((x) => ({ rule: x.rule, message: x.message })) } : "not run",
            seoCheck: v.seoCheck ? { passed: v.seoCheck.passed, failing: v.seoCheck.checks.filter((x) => !x.ok).map((x) => ({ rule: x.rule, message: x.message })).slice(0, 15) } : "not run",
            createdAt: iso(v.createdAt),
          }
        : "no version generated yet",
      approvedAt: iso(a.approvedAt),
      publishedAt: iso(a.publishedAt),
      liveVersion: a.publishedVersionId ? (await tx.query.contentVersions.findFirst({ where: eq(contentVersions.id, a.publishedVersionId) }))?.version ?? null : null,
      repurposedFrom: a.sourceAssetId ? { assetId: a.sourceAssetId, stale: Boolean(a.sourceStaleAt), link: `/content/${a.sourceAssetId}` } : null,
      derivatives: (await derivativesOf(tx, a)).slice(0, 15).map((d) => ({ id: d.id, type: d.type, status: d.status, stale: d.stale, link: `/content/${d.id}` })),
      note: HUMAN_NOTE,
      link: `/content/${a.id}`,
    };
  },
});

export const createContentDraft = defineTool({
  name: "create_content_draft",
  label: "Creating a content draft",
  description: `Create a content asset and generate its first fact-grounded draft. Give exactly one origin: opportunityId (drafts for the opportunity's target query and marks the opportunity IN_PROGRESS), pageId (a planned discovery page from list_planned_pages; the type follows the page), or product (+ type, title, brief, optional targetQueryId). The draft is composed only from the product's knowledge-graph facts; missing material becomes "> TODO(editor):" markers. Fact and SEO/GEO checks then move it to FACT_CHECK, SEO_CHECK or HUMAN_APPROVAL (ready for a human). ${HUMAN_NOTE}`,
  permission: "content:write",
  kind: "write",
  input: z.object({
    opportunityId: idRef("Create the draft from this opportunity.").optional(),
    pageId: idRef("Create the draft for this planned page.").optional(),
    product: optionalProductRef("The product the content is about (when not using opportunityId/pageId)"),
    type: TYPES.optional().describe("Content type. Required with product; with opportunityId one of LANDING_PAGE, ARTICLE, FAQ, TUTORIAL, COMPARISON (default ARTICLE); ignored with pageId."),
    title: z.string().trim().max(200).optional().describe("Working title (with product)."),
    brief: z.string().trim().max(2000).optional().describe("What the piece should cover (with product)."),
    targetQueryId: idRef("Target query id (with product), from list_queries.").optional(),
    generate: z.boolean().optional().describe("Generate the first draft now (default true). false saves only the idea."),
    useLlm: z.boolean().optional().describe("Queue an LLM rewrite constrained to the facts instead of the immediate deterministic draft (default false)."),
  }),
  run: async (c, i) => {
    requirePermission(c, "content:write");
    const actor = agentActor(c);
    const origins = [i.opportunityId, i.pageId, i.product].filter(Boolean).length;
    if (origins !== 1) throw new Error("Give exactly one of opportunityId, pageId or product.");
    let assetId: string;
    if (i.opportunityId) {
      const type = i.type ?? "ARTICLE";
      const allowed = OPPORTUNITY_CONTENT_TYPES.find((x) => x === type);
      if (!allowed) throw new Error(`From an opportunity, type must be one of ${OPPORTUNITY_CONTENT_TYPES.join(", ")}.`);
      assetId = (await createAssetFromOpportunity(c.tx, actor, i.opportunityId, allowed)).id;
    } else if (i.pageId) {
      const a = await createAssetForPage(c.tx, actor, i.pageId);
      if (a.status !== "IDEA") return { existing: await assetSummary(c.tx, c.ctx.org.id, a.id), note: `This page already has a content asset. Use regenerate_content_draft to produce a new version. ${HUMAN_NOTE}`, link: `/content/${a.id}` };
      assetId = a.id;
    } else {
      if (!i.type) throw new Error("type is required when creating content for a product.");
      const p = await resolveProduct(c.tx, c.ctx.org.id, i.product!);
      if (i.targetQueryId) {
        const q = await c.tx.query.queries.findFirst({ where: and(eq(queries.id, i.targetQueryId), eq(queries.organizationId, c.ctx.org.id)) });
        if (!q) throw new Error("Target query not found");
      }
      assetId = (await createAsset(c.tx, actor, { productId: p.id, type: i.type, title: i.title, targetQueryId: i.targetQueryId ?? null, brief: i.brief ?? null })).id;
    }
    const generation = i.generate === false ? { generation: "not requested (idea saved)" } : await draft(c, actor, assetId, Boolean(i.useLlm));
    return { asset: await assetSummary(c.tx, c.ctx.org.id, assetId), ...generation, note: HUMAN_NOTE, link: `/content/${assetId}` };
  },
});

export const regenerateContentDraft = defineTool({
  name: "regenerate_content_draft",
  label: "Regenerating a draft",
  description: `Generate a new draft version of an existing content asset (e.g. after facts were added to the knowledge graph), then re-run the fact and SEO/GEO checks. Not allowed on APPROVED or PUBLISHED content: changing those is a human decision in the app. ${HUMAN_NOTE}`,
  permission: "content:write",
  kind: "write",
  input: z.object({ id: idRef("Content asset id."), useLlm: z.boolean().optional().describe("Queue an LLM rewrite constrained to the facts instead of the immediate deterministic draft (default false).") }),
  run: async (c, i) => {
    requirePermission(c, "content:write");
    const a = await getAsset(c.tx, c.ctx.org.id, i.id);
    if (a.status === "APPROVED" || a.status === "PUBLISHED") throw new Error(`This content is ${a.status.toLowerCase()}; regenerating it would undo a human decision. Ask the user to do it in the app.`);
    const actor = agentActor(c);
    const generation = await draft(c, actor, a.id, Boolean(i.useLlm));
    return { asset: await assetSummary(c.tx, c.ctx.org.id, a.id), ...generation, note: HUMAN_NOTE, link: `/content/${a.id}` };
  },
});

export const repurposeContent = defineTool({
  name: "repurpose_content",
  label: "Repurposing content",
  description: `Create derivative drafts from an APPROVED or PUBLISHED content asset: ${REPURPOSE_TYPES.map((t) => `${t} (${REPURPOSE_LABELS[t]})`).join(", ")}. Each derivative uses only the facts of the source version, is fact checked against the knowledge graph and the source text, and stays a draft that a human must approve (derivatives are flagged stale when the source publishes a newer version). Drafts only. ${HUMAN_NOTE}`,
  permission: "content:write",
  kind: "write",
  input: z.object({
    id: idRef("Source content asset id (must be APPROVED or PUBLISHED)."),
    types: z.array(z.enum(REPURPOSE_TYPES)).min(1).max(REPURPOSE_TYPES.length).describe("Derivative formats to draft."),
  }),
  run: async (c, i) => {
    requirePermission(c, "content:write");
    const actor = agentActor(c);
    const r = await repurposeAsset(c.tx, actor, i.id, i.types, c.ctx.org.branding.displayName ?? c.ctx.org.name);
    return {
      source: { id: i.id, version: r.sourceVersion, link: `/content/${i.id}` },
      derivatives: r.derivatives.map((d) => ({ ...d, link: `/content/${d.id}` })),
      note: HUMAN_NOTE,
    };
  },
});
