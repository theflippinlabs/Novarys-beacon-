import { and, eq, ne } from "drizzle-orm";
import type { Tx } from "@/db";
import { opportunities, productFacets, products, queries, queryClusters } from "@/db/schema";
import { deriveContentGaps, type ContentGap } from "@/core/content/gaps";
import { assetContentType, recommendAsset, type AssetType } from "@/core/queries/cluster";
import { generateOpportunities } from "@/core/opportunities/engine";
import { audit, type Actor } from "@/lib/audit";
import { promptSummaries } from "./ai-visibility";
import { searchDemand, type SearchDemand } from "./queries";
import { createAssetFromOpportunity } from "./content";

/** Content gaps of a product, one per query cluster, with coverage evidence, relevance, demand (or UNKNOWN) and sources. */
export async function contentGapsForProduct(tx: Tx, organizationId: string, productId: string, demand?: SearchDemand): Promise<ContentGap[]> {
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!product) throw new Error("Product not found");
  const clusters = await tx.select().from(queryClusters).where(and(eq(queryClusters.organizationId, organizationId), eq(queryClusters.productId, productId)));
  const qs = await tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId), ne(queries.status, "ARCHIVED")));
  const facets = await tx.select({ kind: productFacets.kind, name: productFacets.name }).from(productFacets).where(and(eq(productFacets.organizationId, organizationId), eq(productFacets.productId, productId)));
  const d = demand ?? (await searchDemand(tx, organizationId, productId));
  const prompts = await promptSummaries(tx, organizationId, productId);
  return deriveContentGaps({
    product: { id: product.id, name: product.name },
    searchConnected: d.connected,
    searchProvider: d.provider,
    facts: facets.filter((f) => f.kind !== "DIFFERENTIATOR"),
    prompts: prompts.map((p) => ({ promptId: p.prompt.id, prompt: p.prompt.prompt, testIds: p.testIds, samples: p.testsRun, productMentions: p.mentions, competitorsMentioned: p.competitors, competitorCitedUrls: p.competitorCitedUrls })),
    clusters: clusters.map((c) => {
      // ACTIVE queries drive gaps; candidates await human curation, except imported ones with measured demand.
      const members = qs.filter((q) => q.clusterId === c.id && (q.status === "ACTIVE" || (q.source === "SEARCH_CONSOLE" && d.byQuery.has(q.normalized))));
      const intent = c.intent ?? members[0]?.intent ?? "COMMERCIAL";
      const topicType = c.topicType ?? "CATEGORY";
      return {
        id: c.id,
        name: c.name,
        intent,
        topicType,
        branded: c.branded,
        coverage: c.coverage,
        coverageReason: c.coverageReason,
        coveredByUrl: c.coveredByUrl,
        pillarPageId: c.pillarPageId,
        recommendedAsset: (c.recommendedAsset as AssetType | null) ?? recommendAsset(intent, topicType, c.branded),
        queries: members.map((q) => {
          const s = d.byQuery.get(q.normalized);
          return { id: q.id, query: q.query, importance: q.importance, search: s ? { impressions: s.impressions, clicks: s.clicks, position: s.position, page: s.pages[0]?.page ?? null } : null };
        }),
      };
    }),
  });
}

/** Upsert the CONTENT_GAP opportunity of one gap cluster (idempotent on its fingerprint). */
export async function opportunityFromGap(tx: Tx, actor: Actor, productId: string, clusterId: string) {
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) });
  if (!product) throw new Error("Product not found");
  const gap = (await contentGapsForProduct(tx, actor.organizationId, productId)).find((g) => g.clusterId === clusterId);
  if (!gap) throw new Error("This cluster is no longer a content gap.");
  const [draft] = generateOpportunities({ product: { id: product.id, name: product.name, slug: product.slug }, contentGaps: [gap], queries: [], aiGaps: [], seoIssues: [], missingEntity: [], competitorsWithoutComparison: [], orphanPages: [], lowConversionPages: [] });
  const [row] = await tx
    .insert(opportunities)
    .values({ organizationId: actor.organizationId, ...draft })
    .onConflictDoUpdate({
      target: [opportunities.organizationId, opportunities.fingerprint],
      set: { title: draft.title, problem: draft.problem, evidence: draft.evidence, sources: draft.sources, scoringRationale: draft.scoringRationale, nextAction: draft.nextAction, updatedAt: new Date() },
    })
    .returning();
  // A human asked for it: an obsolete or dismissed one is reopened.
  if (row.status === "OBSOLETE" || row.status === "DISMISSED") await tx.update(opportunities).set({ status: "OPEN", obsoletedAt: null }).where(eq(opportunities.id, row.id));
  await audit(tx, actor, "opportunity.from_gap", "opportunity", row.id, { clusterId });
  return { opportunity: row, gap };
}

/** Create a content draft (content studio) for a gap: the opportunity first, then the asset of the recommended format. */
export async function draftFromGap(tx: Tx, actor: Actor, productId: string, clusterId: string) {
  const { opportunity, gap } = await opportunityFromGap(tx, actor, productId, clusterId);
  const asset = await createAssetFromOpportunity(tx, actor, opportunity.id, assetContentType(gap.recommendedAsset));
  return { opportunity, asset };
}
