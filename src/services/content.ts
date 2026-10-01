import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, contentVersions, pages, queries } from "@/db/schema";
import { generateContent, factCheckDraft } from "@/ai/tasks";
import type { LlmProvider } from "@/ai/types";
import type { ContentType } from "@/core/content/generate";
import { seoCheck } from "@/core/content/seo-check";
import { assertTransition, statusAfterChecks, type ContentStatus } from "@/core/content/workflow";
import { loadProductGraph } from "@/core/knowledge/load";
import type { PageType } from "@/core/discovery/urls";
import { audit, type Actor } from "@/lib/audit";
import { recomputeCoverage } from "./discovery";

const PAGE_CONTENT: Partial<Record<PageType, ContentType>> = {
  COMPARISON: "COMPARISON",
  ALTERNATIVE: "COMPARISON",
  ANSWER: "FAQ",
  GUIDE: "ARTICLE",
  CHANGELOG: "RELEASE_ANNOUNCEMENT",
};

const PAGE_STATUS_FOR: Partial<Record<ContentStatus, (typeof pages.$inferSelect)["status"]>> = {
  GENERATED: "DRAFT",
  FACT_CHECK: "DRAFT",
  SEO_CHECK: "DRAFT",
  HUMAN_APPROVAL: "IN_REVIEW",
  APPROVED: "APPROVED",
  PUBLISHED: "PUBLISHED",
};

export async function getAsset(tx: Tx, organizationId: string, assetId: string) {
  const asset = await tx.query.contentAssets.findFirst({ where: and(eq(contentAssets.id, assetId), eq(contentAssets.organizationId, organizationId)) });
  if (!asset) throw new Error("Content asset not found");
  return asset;
}

export async function latestVersion(tx: Tx, assetId: string) {
  return tx.query.contentVersions.findFirst({ where: eq(contentVersions.assetId, assetId), orderBy: desc(contentVersions.version) });
}

export async function createAsset(
  tx: Tx,
  actor: Actor,
  input: { productId: string; type: ContentType; title?: string; pageId?: string | null; targetQueryId?: string | null; brief?: string | null },
) {
  let title = input.title?.trim();
  if (input.pageId) {
    const page = await tx.query.pages.findFirst({ where: and(eq(pages.id, input.pageId), eq(pages.organizationId, actor.organizationId)) });
    if (!page) throw new Error("Page not found");
    title ||= page.title;
  }
  if (input.targetQueryId && !title) {
    const q = await tx.query.queries.findFirst({ where: and(eq(queries.id, input.targetQueryId), eq(queries.organizationId, actor.organizationId)) });
    title = q?.query;
  }
  const [asset] = await tx
    .insert(contentAssets)
    .values({
      organizationId: actor.organizationId,
      productId: input.productId,
      pageId: input.pageId ?? null,
      targetQueryId: input.targetQueryId ?? null,
      type: input.type,
      title: title || input.type.replace(/_/g, " ").toLowerCase(),
      brief: input.brief ?? null,
      status: "IDEA",
      createdBy: actor.userId ?? null,
    })
    .returning();
  if (input.pageId) await tx.update(pages).set({ contentAssetId: asset.id }).where(eq(pages.id, input.pageId));
  await audit(tx, actor, "content.create", "content_asset", asset.id, { type: input.type });
  return asset;
}

export async function createAssetForPage(tx: Tx, actor: Actor, pageId: string) {
  const page = await tx.query.pages.findFirst({ where: and(eq(pages.id, pageId), eq(pages.organizationId, actor.organizationId)) });
  if (!page || !page.productId) throw new Error("Page not found");
  if (page.contentAssetId) return getAsset(tx, actor.organizationId, page.contentAssetId);
  return createAsset(tx, actor, { productId: page.productId, pageId, type: PAGE_CONTENT[page.type] ?? "LANDING_PAGE", title: page.title, targetQueryId: page.targetQueryId });
}

async function setStatus(tx: Tx, asset: typeof contentAssets.$inferSelect, to: ContentStatus, extra: Partial<typeof contentAssets.$inferInsert> = {}) {
  await tx.update(contentAssets).set({ status: to, ...extra }).where(eq(contentAssets.id, asset.id));
  const pageStatus = PAGE_STATUS_FOR[to];
  if (asset.pageId && pageStatus) await tx.update(pages).set({ status: pageStatus, ...(to === "PUBLISHED" ? { publishedAt: new Date() } : {}) }).where(eq(pages.id, asset.pageId));
}

/** Run fact + SEO checks on a version and move the asset to the resulting stage. */
async function runChecks(tx: Tx, organizationId: string, asset: typeof contentAssets.$inferSelect, versionId: string) {
  const v = await tx.query.contentVersions.findFirst({ where: eq(contentVersions.id, versionId) });
  if (!v || !asset.productId) throw new Error("Version not found");
  const g = await loadProductGraph(tx, organizationId, asset.productId);
  if (!g) throw new Error("Product not found");
  const fact = factCheckDraft(v.body, g);
  const target = asset.targetQueryId ? await tx.query.queries.findFirst({ where: eq(queries.id, asset.targetQueryId) }) : null;
  const seo = seoCheck({ type: asset.type, body: v.body, metaTitle: v.metaTitle, metaDescription: v.metaDescription, targetQuery: target?.query, structuredData: v.structuredData, brandTerms: [g.product.name] });
  await tx.update(contentVersions).set({ factCheck: fact, seoCheck: seo }).where(eq(contentVersions.id, v.id));
  // GENERATED → FACT_CHECK → SEO_CHECK → HUMAN_APPROVAL, stopping at the first failing gate.
  const target_ = statusAfterChecks(fact, seo);
  await setStatus(tx, asset, target_);
  return { fact, seo, status: target_ };
}

export async function generateVersion(tx: Tx, actor: Actor, assetId: string, llm?: LlmProvider | null, publisher = "Novarys") {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  if (!asset.productId) throw new Error("Asset has no product");
  if (asset.status !== "IDEA") assertTransition(asset.status, "GENERATED");
  const g = await loadProductGraph(tx, actor.organizationId, asset.productId);
  if (!g) throw new Error("Product not found");
  const page = asset.pageId ? await tx.query.pages.findFirst({ where: eq(pages.id, asset.pageId) }) : null;
  const target = asset.targetQueryId ? await tx.query.queries.findFirst({ where: eq(queries.id, asset.targetQueryId) }) : null;
  const { draft, aiRunId, generatedBy } = await generateContent(
    tx,
    actor.organizationId,
    g,
    { type: asset.type, pageType: page?.type, facetId: page?.facetId, competitorId: page?.competitorId, targetQuery: target?.query ?? (asset.type === "ARTICLE" || asset.type === "TUTORIAL" ? asset.title : null), publisher },
    llm,
  );
  const version = asset.currentVersion + 1;
  const [v] = await tx
    .insert(contentVersions)
    .values({
      organizationId: actor.organizationId,
      assetId,
      version,
      body: draft.body,
      metaTitle: draft.metaTitle,
      metaDescription: draft.metaDescription,
      structuredData: draft.structuredData,
      factRefs: draft.factRefs,
      aiRunId,
      createdBy: actor.userId ?? null,
    })
    .returning();
  await tx.update(contentAssets).set({ currentVersion: version, title: draft.title, status: "GENERATED", rejectionReason: null }).where(eq(contentAssets.id, assetId));
  const checks = await runChecks(tx, actor.organizationId, { ...asset, status: "GENERATED", currentVersion: version }, v.id);
  await audit(tx, actor, "content.generate", "content_asset", assetId, { version, generatedBy, status: checks.status });
  return { version: v, ...checks, generatedBy };
}

export async function saveEditedVersion(tx: Tx, actor: Actor, assetId: string, input: { body: string; metaTitle?: string | null; metaDescription?: string | null }) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  if (asset.status === "PUBLISHED" || asset.status === "APPROVED" || asset.status === "REJECTED" || asset.status === "HUMAN_APPROVAL") assertTransition(asset.status, "GENERATED");
  if (input.body.length > 200_000) throw new Error("Body too large");
  const prev = await latestVersion(tx, assetId);
  const version = asset.currentVersion + 1;
  const [v] = await tx
    .insert(contentVersions)
    .values({
      organizationId: actor.organizationId,
      assetId,
      version,
      body: input.body,
      metaTitle: input.metaTitle ?? prev?.metaTitle ?? null,
      metaDescription: input.metaDescription ?? prev?.metaDescription ?? null,
      structuredData: prev?.structuredData ?? [],
      factRefs: prev?.factRefs ?? [],
      createdBy: actor.userId ?? null,
    })
    .returning();
  await tx.update(contentAssets).set({ currentVersion: version, status: "GENERATED" }).where(eq(contentAssets.id, assetId));
  const checks = await runChecks(tx, actor.organizationId, { ...asset, status: "GENERATED" }, v.id);
  await audit(tx, actor, "content.edit", "content_asset", assetId, { version, status: checks.status });
  return { version: v, ...checks };
}

/** Human approval: only possible once the latest version passes fact and SEO checks. */
export async function approveAsset(tx: Tx, actor: Actor, assetId: string) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  assertTransition(asset.status, "APPROVED");
  const v = await latestVersion(tx, assetId);
  if (!v?.factCheck?.passed || !v.seoCheck?.passed) throw new Error("Latest version has not passed fact and SEO checks");
  await setStatus(tx, asset, "APPROVED", { approvedBy: actor.userId ?? null, approvedAt: new Date() });
  await audit(tx, actor, "content.approve", "content_asset", assetId, { version: v.version });
}

export async function rejectAsset(tx: Tx, actor: Actor, assetId: string, reason: string) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  assertTransition(asset.status, "REJECTED");
  await setStatus(tx, asset, "REJECTED", { rejectionReason: reason.slice(0, 1000) });
  if (asset.pageId) await tx.update(pages).set({ status: "DRAFT" }).where(eq(pages.id, asset.pageId));
  await audit(tx, actor, "content.reject", "content_asset", assetId, { reason });
}

/**
 * Publish an approved asset. For web pages, the page must also pass the
 * discovery quality gate (completeness, confidence, uniqueness, usefulness).
 */
export async function publishAsset(tx: Tx, actor: Actor, assetId: string) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  assertTransition(asset.status, "PUBLISHED");
  if (asset.pageId) {
    const page = await tx.query.pages.findFirst({ where: eq(pages.id, asset.pageId) });
    if (page && page.quality.publishable === false) throw new Error(`Page fails the publication quality gate: ${String(page.quality.blockers ?? "")}`);
  }
  await setStatus(tx, asset, "PUBLISHED", { publishedAt: new Date() });
  if (asset.productId) await recomputeCoverage(tx, actor.organizationId, asset.productId);
  await audit(tx, actor, "content.publish", "content_asset", assetId, {});
}
