import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, contentVersions, opportunities, organizations, pages, queries, type FactCheckResult } from "@/db/schema";
import { factCheckDraft, recordRun, rewriteDraft, templateGeneration, type GenerationResult } from "@/ai/tasks";
import type { LlmProvider } from "@/ai/types";
import { DEFAULT_FRESHNESS_DAYS, severityCounts, type FactCheckOptions } from "@/core/content/fact-check";
import { generateDraft, type Draft, type DraftRequest } from "@/core/content/generate";
import { assessContentQuality } from "@/core/content/quality";
import { buildDerivative } from "@/core/content/repurpose";
import { seoCheck } from "@/core/content/seo-check";
import { REPURPOSE_LABELS, REPURPOSE_TYPES, type ContentType, type RepurposeType } from "@/core/content/types";
import { assertTransition, statusAfterChecks, type ContentStatus } from "@/core/content/workflow";
import { loadProductGraph } from "@/core/knowledge/load";
import type { ProductGraph } from "@/core/knowledge/types";
import type { PageType } from "@/core/discovery/urls";
import { audit, type Actor } from "@/lib/audit";
import { recomputeCoverage } from "./discovery";

type Asset = typeof contentAssets.$inferSelect;
type Version = typeof contentVersions.$inferSelect;
type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

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

async function versionById(tx: Tx, organizationId: string, id: string | null) {
  if (!id) return null;
  return (await tx.query.contentVersions.findFirst({ where: and(eq(contentVersions.id, id), eq(contentVersions.organizationId, organizationId)) })) ?? null;
}

/** The version the public site serves (null when nothing is published). */
export async function publishedVersion(tx: Tx, asset: Asset) {
  return versionById(tx, asset.organizationId, asset.publishedVersionId);
}

export async function createAsset(
  tx: Tx,
  actor: Actor,
  input: { productId: string; type: ContentType; title?: string; pageId?: string | null; targetQueryId?: string | null; brief?: string | null; sourceAssetId?: string | null; sourceVersionId?: string | null },
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
      sourceAssetId: input.sourceAssetId ?? null,
      sourceVersionId: input.sourceVersionId ?? null,
    })
    .returning();
  if (input.pageId) await tx.update(pages).set({ contentAssetId: asset.id }).where(eq(pages.id, input.pageId));
  await audit(tx, actor, "content.create", "content_asset", asset.id, { type: input.type, ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}) });
  return asset;
}

export async function createAssetForPage(tx: Tx, actor: Actor, pageId: string) {
  const page = await tx.query.pages.findFirst({ where: and(eq(pages.id, pageId), eq(pages.organizationId, actor.organizationId)) });
  if (!page || !page.productId) throw new Error("Page not found");
  if (page.contentAssetId) return getAsset(tx, actor.organizationId, page.contentAssetId);
  return createAsset(tx, actor, { productId: page.productId, pageId, type: PAGE_CONTENT[page.type] ?? "LANDING_PAGE", title: page.title, targetQueryId: page.targetQueryId });
}

/**
 * Moves the asset (the working draft) to `to`. While a version is published,
 * the page stays PUBLISHED: editing, regenerating or rejecting a newer draft
 * never unpublishes the live version.
 */
async function setStatus(tx: Tx, asset: Asset, to: ContentStatus, extra: Partial<typeof contentAssets.$inferInsert> = {}) {
  await tx.update(contentAssets).set({ status: to, ...extra }).where(eq(contentAssets.id, asset.id));
  const live = Boolean(extra.publishedVersionId ?? asset.publishedVersionId);
  const pageStatus = live ? "PUBLISHED" : PAGE_STATUS_FOR[to];
  if (asset.pageId && pageStatus) await tx.update(pages).set({ status: pageStatus, ...(to === "PUBLISHED" ? { publishedAt: new Date() } : {}) }).where(eq(pages.id, asset.pageId));
}

/** Organisation policies that apply to content checks and approval. */
async function contentPolicy(tx: Tx, organizationId: string) {
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
  return {
    freshnessDays: org?.settings.knowledge?.staleAfterDays ?? DEFAULT_FRESHNESS_DAYS,
    requireDistinctApprover: Boolean(org?.settings.content?.requireDistinctApprover),
    publisher: org?.branding.displayName ?? org?.name ?? "Novarys",
  };
}

/** Fact-check options for an asset: freshness threshold and, for derivatives, the source version's facts and body. */
async function checkOptions(tx: Tx, asset: Asset, freshnessDays: number): Promise<Omit<FactCheckOptions, "metaTitle" | "metaDescription">> {
  const source = asset.sourceVersionId ? await versionById(tx, asset.organizationId, asset.sourceVersionId) : null;
  return { freshnessDays, ...(source ? { allowedRefs: source.factRefs.map((f) => f.ref), sourceBody: source.body } : {}) };
}

/** Other current versions and published versions of the organisation (near-duplicate detection). */
async function qualityPeers(tx: Tx, organizationId: string, assetId: string) {
  const rows = await tx
    .select({ title: contentAssets.title, version: contentVersions.version, body: contentVersions.body })
    .from(contentVersions)
    .innerJoin(contentAssets, eq(contentAssets.id, contentVersions.assetId))
    .where(
      and(
        eq(contentAssets.organizationId, organizationId),
        ne(contentAssets.id, assetId),
        ne(contentAssets.status, "REJECTED"),
        or(eq(contentVersions.version, contentAssets.currentVersion), eq(contentVersions.id, contentAssets.publishedVersionId)),
      ),
    )
    .orderBy(desc(contentAssets.updatedAt))
    .limit(400);
  return rows.map((r) => ({ label: `${r.title} v${r.version}`, body: r.body }));
}

/** Runs the fact check, SEO/GEO check and quality gate on a version against the current graph, and stores them. */
async function evaluateVersion(tx: Tx, asset: Asset, v: Version, g?: ProductGraph | null) {
  if (!asset.productId) throw new Error("Asset has no product");
  const graph = g ?? (await loadProductGraph(tx, asset.organizationId, asset.productId));
  if (!graph) throw new Error("Product not found");
  const policy = await contentPolicy(tx, asset.organizationId);
  const opts = await checkOptions(tx, asset, policy.freshnessDays);
  const fact = factCheckDraft(v.body, graph, { ...opts, metaTitle: v.metaTitle, metaDescription: v.metaDescription });
  const target = asset.targetQueryId ? await tx.query.queries.findFirst({ where: eq(queries.id, asset.targetQueryId) }) : null;
  const seo = seoCheck({ type: asset.type, body: v.body, metaTitle: v.metaTitle, metaDescription: v.metaDescription, targetQuery: target?.query, structuredData: v.structuredData, brandTerms: [graph.product.name] });
  const quality = assessContentQuality({ type: asset.type, body: v.body, targetQuery: target?.query, brandTerms: [graph.product.name], claims: fact.claims, others: await qualityPeers(tx, asset.organizationId, asset.id) });
  await tx.update(contentVersions).set({ factCheck: fact, seoCheck: seo, qualityCheck: quality }).where(eq(contentVersions.id, v.id));
  return { fact, seo, quality };
}

/** Run fact, SEO and quality checks on a version and move the asset to the resulting stage. */
async function runChecks(tx: Tx, asset: Asset, versionId: string) {
  const v = await versionById(tx, asset.organizationId, versionId);
  if (!v) throw new Error("Version not found");
  const checks = await evaluateVersion(tx, asset, v);
  // GENERATED → FACT_CHECK → SEO_CHECK → HUMAN_APPROVAL, stopping at the first failing gate.
  const status = statusAfterChecks(checks.fact, checks.seo);
  await setStatus(tx, asset, status);
  return { ...checks, status };
}

// ─── Generation ─────────────────────────────────────────────────────────────

/** Everything the LLM step needs, read in the first transaction (no transaction is open during the LLM call). */
export type GenerationPlan = {
  organizationId: string;
  assetId: string;
  graph: ProductGraph;
  req: DraftRequest;
  draft: Draft;
  checkOpts: Omit<FactCheckOptions, "metaTitle" | "metaDescription">;
  baseVersion: number;
  baseStatus: ContentStatus;
};

export async function prepareGeneration(tx: Tx, actor: Actor, assetId: string, publisher?: string | null): Promise<GenerationPlan> {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  if (!asset.productId) throw new Error("Asset has no product");
  if (asset.status !== "IDEA") assertTransition(asset.status, "GENERATED");
  const g = await loadProductGraph(tx, actor.organizationId, asset.productId);
  if (!g) throw new Error("Product not found");
  const policy = await contentPolicy(tx, actor.organizationId);
  const pub = publisher ?? policy.publisher;
  const checkOpts = await checkOptions(tx, asset, policy.freshnessDays);
  const source = asset.sourceVersionId ? await versionById(tx, actor.organizationId, asset.sourceVersionId) : null;
  let req: DraftRequest;
  let draft: Draft;
  if (source && (REPURPOSE_TYPES as readonly string[]).includes(asset.type)) {
    // Derivatives are regenerated from the same source facts only.
    const sourceAsset = asset.sourceAssetId ? await tx.query.contentAssets.findFirst({ where: eq(contentAssets.id, asset.sourceAssetId) }) : null;
    req = { type: asset.type, publisher: pub };
    draft = buildDerivative(g, { title: sourceAsset?.title ?? asset.title, factRefs: source.factRefs }, asset.type as RepurposeType, pub);
  } else {
    const page = asset.pageId ? await tx.query.pages.findFirst({ where: eq(pages.id, asset.pageId) }) : null;
    const target = asset.targetQueryId ? await tx.query.queries.findFirst({ where: eq(queries.id, asset.targetQueryId) }) : null;
    req = { type: asset.type, pageType: page?.type, facetId: page?.facetId, competitorId: page?.competitorId, targetQuery: target?.query ?? (asset.type === "ARTICLE" || asset.type === "TUTORIAL" ? asset.title : null), publisher: pub };
    draft = generateDraft(g, req);
  }
  return { organizationId: actor.organizationId, assetId, graph: g, req, draft, checkOpts, baseVersion: asset.currentVersion, baseStatus: asset.status };
}

export type GenerationOutcome =
  | { aborted: false; version: Version; fact: FactCheckResult; seo: ReturnType<typeof seoCheck>; quality: Awaited<ReturnType<typeof evaluateVersion>>["quality"]; status: ContentStatus; generatedBy: string }
  | { aborted: true; note: string; generatedBy: string };

/**
 * Stores a generated draft as a new version (second transaction of a queued
 * generation). Aborts with a note instead of regressing an asset that a
 * human edited, approved or published since the generation was requested.
 */
export async function persistGeneration(tx: Tx, actor: Actor, plan: GenerationPlan, result: GenerationResult, base: { version: number; status: ContentStatus } = { version: plan.baseVersion, status: plan.baseStatus }): Promise<GenerationOutcome> {
  const [locked] = await tx
    .select()
    .from(contentAssets)
    .where(and(eq(contentAssets.id, plan.assetId), eq(contentAssets.organizationId, actor.organizationId)))
    .for("update");
  if (!locked) throw new Error("Content asset not found");
  const aiRunId = await recordRun(tx, result.run);
  const becameHumanDecided = (locked.status === "APPROVED" || locked.status === "PUBLISHED") && locked.status !== base.status;
  if (becameHumanDecided || locked.currentVersion !== base.version) {
    const note = becameHumanDecided
      ? `The asset was ${locked.status === "APPROVED" ? "approved" : "published"} while this draft was being generated; the queued draft was discarded so the human decision stands.`
      : `The asset changed (now version ${locked.currentVersion}) while this draft was being generated; the queued draft was discarded.`;
    await audit(tx, actor, "content.generate_aborted", "content_asset", plan.assetId, { note, aiRunId, baseVersion: base.version, currentVersion: locked.currentVersion, status: locked.status });
    return { aborted: true, note, generatedBy: result.generatedBy };
  }
  if (locked.status !== "IDEA") assertTransition(locked.status, "GENERATED");
  const { draft } = result;
  const version = locked.currentVersion + 1;
  const [v] = await tx
    .insert(contentVersions)
    .values({
      organizationId: actor.organizationId,
      assetId: plan.assetId,
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
  await tx.update(contentAssets).set({ currentVersion: version, title: draft.title, status: "GENERATED", rejectionReason: null }).where(eq(contentAssets.id, plan.assetId));
  const checks = await runChecks(tx, { ...locked, status: "GENERATED", currentVersion: version }, v.id);
  await audit(tx, actor, "content.generate", "content_asset", plan.assetId, { version, generatedBy: result.generatedBy, status: checks.status, ...(result.guard && !result.guard.ok ? { rewriteRejected: result.guard.reasons } : {}) });
  return { aborted: false, version: v, ...checks, generatedBy: result.generatedBy };
}

/** Deterministic generation in one transaction (no network I/O). */
export async function generateVersion(tx: Tx, actor: Actor, assetId: string, publisher?: string | null) {
  const t0 = Date.now();
  const plan = await prepareGeneration(tx, actor, assetId, publisher);
  const out = await persistGeneration(tx, actor, plan, templateGeneration(actor.organizationId, plan.req, plan.draft, t0));
  if (out.aborted) throw new Error(out.note);
  return out;
}

/**
 * Queued generation (content.generate job): read in a first transaction, call
 * the LLM with no transaction open, persist in a second transaction. `base`
 * is the asset state when the job was requested: a draft never overwrites an
 * asset approved, published or edited since then.
 */
export async function generateQueued(
  run: Runner,
  actor: Actor,
  assetId: string,
  opts: { resolveLlm?: (tx: Tx) => Promise<LlmProvider | null>; base?: { version: number; status: ContentStatus } | null },
): Promise<GenerationOutcome> {
  const t0 = Date.now();
  const { plan, llm } = await run(async (tx) => ({ plan: await prepareGeneration(tx, actor, assetId), llm: opts.resolveLlm ? await opts.resolveLlm(tx) : null }));
  const base = opts.base ?? { version: plan.baseVersion, status: plan.baseStatus };
  const result = llm ? await rewriteDraft(llm, actor.organizationId, plan.graph, plan.req, plan.draft, plan.checkOpts) : templateGeneration(actor.organizationId, plan.req, plan.draft, t0);
  return run((tx) => persistGeneration(tx, actor, plan, result, base));
}

// ─── Editing, approval, publication ─────────────────────────────────────────

/**
 * Saves an edited version. Editing APPROVED or PUBLISHED content never
 * changes those versions: it opens a new draft (a branch) that needs a new
 * approval, while the published version keeps being served.
 */
export async function saveEditedVersion(tx: Tx, actor: Actor, assetId: string, input: { body: string; metaTitle?: string | null; metaDescription?: string | null }) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  if (asset.status !== "IDEA" && asset.status !== "GENERATED" && asset.status !== "FACT_CHECK" && asset.status !== "SEO_CHECK") assertTransition(asset.status, "GENERATED");
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
  const checks = await runChecks(tx, { ...asset, status: "GENERATED", currentVersion: version }, v.id);
  const branchedFrom = asset.status === "APPROVED" || asset.status === "PUBLISHED" ? { branchedFrom: asset.status, liveVersionId: asset.publishedVersionId } : {};
  await audit(tx, actor, "content.edit", "content_asset", assetId, { version, status: checks.status, ...branchedFrom });
  return { version: v, ...checks };
}

/** Why a version cannot be approved or published (empty when it can). Re-runs the checks against the current graph first. */
async function gateBlockers(tx: Tx, asset: Asset, v: Version, stage: "approval" | "publication") {
  const { fact, quality } = await evaluateVersion(tx, asset, v);
  const counts = severityCounts(fact.claims);
  const blockers: string[] = [];
  if (counts.HIGH) blockers.push(`${counts.HIGH} high-severity claim(s) block ${stage}.`);
  if (!quality.passed) blockers.push(`The quality gate fails: ${quality.checks.filter((c) => !c.ok).map((c) => c.rule).join(", ")}.`);
  return { blockers, counts };
}

/**
 * Human approval of the latest version: only once it passes the fact check
 * (no HIGH claim), the SEO/GEO check and the quality gate; MEDIUM claims
 * need `acknowledge`. When the organisation requires it, the approver must
 * not be the version's author.
 */
export async function approveAsset(tx: Tx, actor: Actor, assetId: string, opts: { acknowledge?: boolean } = {}) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  assertTransition(asset.status, "APPROVED");
  const v = await latestVersion(tx, assetId);
  if (!v?.factCheck?.passed || !v.seoCheck?.passed) throw new Error("Latest version has not passed fact and SEO checks");
  const policy = await contentPolicy(tx, actor.organizationId);
  if (policy.requireDistinctApprover && v.createdBy && v.createdBy === actor.userId) throw new Error("Another member must approve this version: the organisation requires the approver to differ from the author.");
  const { blockers, counts } = await gateBlockers(tx, asset, v, "approval");
  // One message at a time: each is a complete, translatable sentence.
  if (blockers.length) throw new Error(blockers[0]);
  if (counts.MEDIUM && !opts.acknowledge) throw new Error(`${counts.MEDIUM} claim(s) need your explicit acknowledgment before approval.`);
  await setStatus(tx, asset, "APPROVED", { approvedBy: actor.userId ?? null, approvedAt: new Date(), approvedVersionId: v.id });
  await audit(tx, actor, "content.approve", "content_asset", assetId, { version: v.version, ...(counts.MEDIUM ? { acknowledgedClaims: counts.MEDIUM } : {}) });
}

export async function rejectAsset(tx: Tx, actor: Actor, assetId: string, reason: string) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  assertTransition(asset.status, "REJECTED");
  await setStatus(tx, asset, "REJECTED", { rejectionReason: reason.slice(0, 1000) });
  // A published version stays live: only the rejected draft goes back.
  if (asset.pageId && !asset.publishedVersionId) await tx.update(pages).set({ status: "DRAFT" }).where(eq(pages.id, asset.pageId));
  await audit(tx, actor, "content.reject", "content_asset", assetId, { reason });
}

/**
 * Publishes the approved version. It must still pass the fact check (no HIGH
 * claim against the current graph) and the quality gate; web pages must also
 * pass the discovery publication gate. Derivatives built from an older
 * version of this asset are flagged stale.
 */
export async function publishAsset(tx: Tx, actor: Actor, assetId: string) {
  const asset = await getAsset(tx, actor.organizationId, assetId);
  assertTransition(asset.status, "PUBLISHED");
  const v = (await versionById(tx, actor.organizationId, asset.approvedVersionId)) ?? (await latestVersion(tx, assetId));
  if (!v) throw new Error("Version not found");
  if (asset.pageId) {
    const page = await tx.query.pages.findFirst({ where: eq(pages.id, asset.pageId) });
    if (page && page.quality.publishable === false) throw new Error(`Page fails the publication quality gate: ${String(page.quality.blockers ?? "")}`);
  }
  const { blockers } = await gateBlockers(tx, asset, v, "publication");
  if (blockers.length) throw new Error(blockers[0]);
  const now = new Date();
  await setStatus(tx, asset, "PUBLISHED", { publishedAt: now, publishedVersionId: v.id });
  const stale = await tx
    .update(contentAssets)
    .set({ sourceStaleAt: now })
    .where(and(eq(contentAssets.organizationId, actor.organizationId), eq(contentAssets.sourceAssetId, asset.id), ne(contentAssets.sourceVersionId, v.id), isNull(contentAssets.sourceStaleAt)))
    .returning({ id: contentAssets.id });
  if (asset.productId) await recomputeCoverage(tx, actor.organizationId, asset.productId);
  await audit(tx, actor, "content.publish", "content_asset", assetId, { version: v.version, ...(stale.length ? { staleDerivatives: stale.length } : {}) });
}

/** Create a content idea from an opportunity (targeting its query, briefed with its problem) and mark the opportunity in progress. */
export async function createAssetFromOpportunity(tx: Tx, actor: Actor, opportunityId: string, type: ContentType) {
  const o = await tx.query.opportunities.findFirst({ where: and(eq(opportunities.id, opportunityId), eq(opportunities.organizationId, actor.organizationId)) });
  if (!o?.productId) throw new Error("Opportunity has no product");
  const asset = await createAsset(tx, actor, { productId: o.productId, type, targetQueryId: o.queryId, brief: `${o.title}\n${o.problem}` });
  await tx.update(opportunities).set({ status: "IN_PROGRESS" }).where(eq(opportunities.id, o.id));
  return asset;
}

// ─── Repurposing ────────────────────────────────────────────────────────────

/**
 * Builds derivative drafts (X post, LinkedIn post, TikTok script, short video
 * script, newsletter block, FAQ additions, product update) from an APPROVED
 * or PUBLISHED asset. Each derivative uses only the facts of the source
 * version, is fact checked against the graph and the source body, and goes
 * through human approval like any other asset.
 */
export async function repurposeAsset(tx: Tx, actor: Actor, assetId: string, types: RepurposeType[], publisher?: string | null) {
  const source = await getAsset(tx, actor.organizationId, assetId);
  if (source.status !== "APPROVED" && source.status !== "PUBLISHED" && !source.publishedVersionId) throw new Error("Only approved or published content can be repurposed.");
  if (!source.productId) throw new Error("Asset has no product");
  const wanted = [...new Set(types)].filter((t) => (REPURPOSE_TYPES as readonly string[]).includes(t));
  if (!wanted.length) throw new Error("Choose at least one format to repurpose into.");
  const sv =
    (await versionById(tx, actor.organizationId, source.status === "APPROVED" ? source.approvedVersionId : source.publishedVersionId)) ??
    (await versionById(tx, actor.organizationId, source.publishedVersionId ?? source.approvedVersionId)) ??
    (await latestVersion(tx, source.id));
  if (!sv) throw new Error("Version not found");
  const g = await loadProductGraph(tx, actor.organizationId, source.productId);
  if (!g) throw new Error("Product not found");
  const pub = publisher ?? (await contentPolicy(tx, actor.organizationId)).publisher;
  const created: { id: string; type: RepurposeType; status: ContentStatus; title: string }[] = [];
  for (const type of wanted) {
    const asset = await createAsset(tx, actor, {
      productId: source.productId,
      type,
      title: `${source.title} (${REPURPOSE_LABELS[type]})`,
      brief: `Repurposed from “${source.title}” version ${sv.version}.`,
      sourceAssetId: source.id,
      sourceVersionId: sv.id,
    });
    const t0 = Date.now();
    const draft = buildDerivative(g, { title: source.title, factRefs: sv.factRefs }, type, pub);
    const plan: GenerationPlan = { organizationId: actor.organizationId, assetId: asset.id, graph: g, req: { type, publisher: pub }, draft, checkOpts: {}, baseVersion: 0, baseStatus: "IDEA" };
    const out = await persistGeneration(tx, actor, plan, templateGeneration(actor.organizationId, plan.req, draft, t0));
    if (out.aborted) throw new Error(out.note);
    created.push({ id: asset.id, type, status: out.status, title: draft.title });
  }
  await audit(tx, actor, "content.repurpose", "content_asset", source.id, { version: sv.version, derivatives: created.map((c) => c.id), types: wanted });
  return { sourceVersion: sv.version, derivatives: created };
}

/** Derivatives of an asset, each flagged stale once the source published a newer version than the one it was built from. */
export async function derivativesOf(tx: Tx, asset: Asset) {
  const rows = await tx.select().from(contentAssets).where(and(eq(contentAssets.organizationId, asset.organizationId), eq(contentAssets.sourceAssetId, asset.id))).orderBy(desc(contentAssets.createdAt));
  return rows.map((d) => ({ ...d, stale: Boolean(d.sourceStaleAt) }));
}
