import type { AssetType } from "@/core/queries/cluster";
import type { Intent, TopicType } from "@/core/queries/classify";
import type { Coverage } from "@/core/queries/coverage";
import { termCoverage, topicTerms } from "@/core/queries/terms";

/**
 * Content gap engine (pure). One gap per query cluster, never per keyword.
 * A cluster is a gap when at least one of these measured conditions holds:
 * - DEMAND_WITHOUT_RANKING: queries have search impressions but no product
 *   page ranks in the top 20 for them (search data only, never estimated);
 * - UNCOVERED_RELEVANT: the cluster is NOT COVERED or PARTIAL and is
 *   business-relevant (HIGH: importance 4 or 5; MEDIUM: importance 3, its
 *   words match a knowledge-graph fact, or measured impressions);
 * - AI_COMPETITOR_ONLY: sampled AI answers to a matching prompt mentioned or
 *   cited competitors but not the product;
 * - NO_PILLAR: the cluster has 3 or more queries, no pillar page and is not covered.
 * Search demand is reported only from a connected provider; otherwise UNKNOWN.
 */
export type GapReason = "DEMAND_WITHOUT_RANKING" | "UNCOVERED_RELEVANT" | "AI_COMPETITOR_ONLY" | "NO_PILLAR";

export type GapClusterInput = {
  id: string;
  name: string;
  intent: Intent;
  topicType: TopicType;
  branded: boolean;
  coverage: Coverage;
  coverageReason: string | null;
  coveredByUrl: string | null;
  pillarPageId: string | null;
  recommendedAsset: AssetType;
  queries: {
    id: string;
    query: string;
    importance: number;
    /** Measured search data for this query (null when the provider has no row for it). */
    search: { impressions: number; clicks: number; position: number | null; page: string | null } | null;
  }[];
};

export type GapPromptInput = {
  promptId: string;
  prompt: string;
  testIds: string[];
  samples: number;
  productMentions: number;
  competitorsMentioned: string[];
  competitorCitedUrls: string[];
};

export type GapInput = {
  product: { id: string; name: string };
  clusters: GapClusterInput[];
  /** Knowledge-graph facts (feature, use case, audience, problem, integration, industry names). */
  facts: { kind: string; name: string }[];
  prompts: GapPromptInput[];
  /** Whether a search provider has delivered query data for the product. */
  searchConnected: boolean;
  searchProvider: string | null;
};

export type ContentGap = {
  clusterId: string;
  clusterName: string;
  intent: Intent;
  topicType: TopicType;
  reasons: GapReason[];
  coverage: { status: Coverage; evidence: string | null; url: string | null };
  existingPage: string | null;
  relevance: { level: "HIGH" | "MEDIUM" | "LOW"; reason: string };
  recommendedAsset: AssetType;
  supportingAssets: AssetType[];
  sources: { queryIds: string[]; testIds: string[]; urls: string[] };
  demand: { status: "MEASURED" | "UNKNOWN"; impressions: number | null; clicks: number | null; provider: string | null };
  competitors: string[];
  topQueryId: string;
  score: number;
};

const SUPPORTING: Record<AssetType, AssetType[]> = {
  PRODUCT_PAGE: ["FAQ"],
  PRICING_PAGE: ["FAQ"],
  LANDING_PAGE: ["FAQ", "GUIDE"],
  FEATURE_PAGE: ["GUIDE", "FAQ"],
  USE_CASE_PAGE: ["GUIDE", "FAQ"],
  INTEGRATION_PAGE: ["GUIDE", "FAQ"],
  COMPARISON_PAGE: ["ALTERNATIVES_PAGE", "FAQ"],
  ALTERNATIVES_PAGE: ["COMPARISON_PAGE", "FAQ"],
  GUIDE: ["FAQ", "LANDING_PAGE"],
  FAQ: ["GUIDE"],
};

/** A prompt matches a cluster when it contains at least 60% of the cluster's head words (from its name). */
export function promptMatchesCluster(prompt: string, cluster: { name: string; queries: { query: string }[] }): boolean {
  const pt = new Set(topicTerms(prompt));
  const head = topicTerms(cluster.name);
  if (head.length && termCoverage(head, pt) >= 0.6) return true;
  return cluster.queries.some((q) => {
    const qt = topicTerms(q.query);
    return qt.length >= 2 && termCoverage(qt, pt) >= 0.75;
  });
}

export function deriveContentGaps(input: GapInput): ContentGap[] {
  const factTerms = input.facts.map((f) => ({ ...f, terms: topicTerms(f.name) })).filter((f) => f.terms.length);
  const out: ContentGap[] = [];
  for (const c of input.clusters) {
    if (!c.queries.length) continue;
    const reasons: GapReason[] = [];
    const withData = c.queries.filter((q) => q.search && q.search.impressions > 0);
    const impressions = withData.reduce((s, q) => s + q.search!.impressions, 0);
    const clicks = withData.reduce((s, q) => s + q.search!.clicks, 0);
    const notRanking = withData.filter((q) => q.search!.position === null || q.search!.position > 20);
    if (notRanking.length) reasons.push("DEMAND_WITHOUT_RANKING");

    const maxImportance = Math.max(...c.queries.map((q) => q.importance));
    const clusterTerms = new Set(c.queries.flatMap((q) => topicTerms(q.query)));
    const fact = factTerms.find((f) => termCoverage(f.terms, clusterTerms) === 1);
    const relevance: ContentGap["relevance"] =
      maxImportance >= 4 && fact
        ? { level: "HIGH", reason: `Importance ${maxImportance}/5 and matches ${fact.kind.toLowerCase().replace("_", " ")} "${fact.name}"` }
        : maxImportance >= 4
          ? { level: "HIGH", reason: `Importance ${maxImportance}/5` }
          : fact
            ? { level: "MEDIUM", reason: `Matches ${fact.kind.toLowerCase().replace("_", " ")} "${fact.name}" in the knowledge graph` }
            : impressions > 0
              ? { level: "MEDIUM", reason: `${impressions} measured search impressions` }
              : maxImportance >= 3
                ? { level: "MEDIUM", reason: `Importance ${maxImportance}/5` }
                : { level: "LOW", reason: `Importance ${maxImportance}/5, no matching knowledge-graph fact` };
    if (c.coverage !== "COVERED" && relevance.level !== "LOW") reasons.push("UNCOVERED_RELEVANT");

    const prompts = input.prompts.filter((p) => p.samples > 0 && p.productMentions === 0 && (p.competitorsMentioned.length > 0 || p.competitorCitedUrls.length > 0) && promptMatchesCluster(p.prompt, c));
    if (prompts.length) reasons.push("AI_COMPETITOR_ONLY");

    if (c.queries.length >= 3 && !c.pillarPageId && c.coverage !== "COVERED") reasons.push("NO_PILLAR");
    if (!reasons.length) continue;

    const top = [...c.queries].sort((a, b) => b.importance - a.importance || (b.search?.impressions ?? 0) - (a.search?.impressions ?? 0))[0];
    const competitors = [...new Set(prompts.flatMap((p) => p.competitorsMentioned))];
    const score =
      (relevance.level === "HIGH" ? 3 : relevance.level === "MEDIUM" ? 2 : 1) +
      (reasons.includes("DEMAND_WITHOUT_RANKING") ? 2 : 0) +
      (reasons.includes("AI_COMPETITOR_ONLY") ? 2 : 0) +
      (c.coverage === "NONE" ? 1 : 0) +
      (reasons.includes("NO_PILLAR") ? 1 : 0);
    out.push({
      clusterId: c.id,
      clusterName: c.name,
      intent: c.intent,
      topicType: c.topicType,
      reasons,
      coverage: { status: c.coverage, evidence: c.coverageReason, url: c.coveredByUrl },
      existingPage: c.coverage === "NONE" ? null : c.coveredByUrl,
      relevance,
      recommendedAsset: c.recommendedAsset,
      supportingAssets: SUPPORTING[c.recommendedAsset].filter((a) => a !== c.recommendedAsset),
      sources: {
        queryIds: c.queries.map((q) => q.id),
        testIds: [...new Set(prompts.flatMap((p) => p.testIds))],
        urls: [...new Set([...withData.map((q) => q.search!.page).filter((u): u is string => Boolean(u)), ...(c.coveredByUrl ? [c.coveredByUrl] : []), ...prompts.flatMap((p) => p.competitorCitedUrls)])].slice(0, 20),
      },
      demand: input.searchConnected ? { status: "MEASURED", impressions, clicks, provider: input.searchProvider } : { status: "UNKNOWN", impressions: null, clicks: null, provider: null },
      competitors,
      topQueryId: top.id,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.clusterName.localeCompare(b.clusterName));
}
