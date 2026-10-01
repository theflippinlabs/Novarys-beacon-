import type { Intent } from "@/core/queries/classify";
import type { PageType } from "@/core/discovery/urls";
import type { ContentGap } from "@/core/content/gaps";
import type { OpportunityAction, OpportunityNextAction, OpportunitySources, ScoringRationale } from "@/db/schema";

export type Potential = "LOW" | "MEDIUM" | "HIGH";

/** Opportunity taxonomy (the `category` column); `type` keeps the specific rule. */
export type OpportunityCategory = "CONTENT" | "QUERY" | "AI_VISIBILITY" | "CITATION" | "TECHNICAL" | "PRODUCT_KNOWLEDGE" | "DISTRIBUTION" | "CROSS_SELL" | "REFERRAL" | "CONVERSION";
export const OPPORTUNITY_CATEGORIES: OpportunityCategory[] = ["CONTENT", "QUERY", "AI_VISIBILITY", "CITATION", "TECHNICAL", "PRODUCT_KNOWLEDGE", "DISTRIBUTION", "CROSS_SELL", "REFERRAL", "CONVERSION"];
export const OPPORTUNITY_TYPES = [
  "CONTENT_GAP",
  "STRIKING_DISTANCE",
  "LOW_CTR",
  "VISIBILITY_DROP",
  "AI_VISIBILITY_GAP",
  "CITATION",
  "TECHNICAL",
  "INTERNAL_LINKING",
  "PRODUCT_KNOWLEDGE",
  "COMPARISON_FACTS",
  "DISTRIBUTION",
  "CROSS_SELL",
  "REFERRAL",
  "CONVERSION",
] as const;

export type OpportunityDraft = {
  productId: string;
  queryId?: string;
  type: string;
  category: OpportunityCategory;
  title: string;
  problem: string;
  evidence: { label: string; value: string }[];
  competitors: string[];
  actions: OpportunityAction[];
  potential: Potential;
  impact: number;
  confidence: number;
  effort: number;
  urgency: number;
  priorityScore: number;
  scoringRationale: ScoringRationale;
  nextAction: OpportunityNextAction;
  sources: OpportunitySources;
  fingerprint: string;
};

export type CitationDomainSignal = {
  domain: string;
  category: string;
  samplesCiting: number;
  samplesTotal: number;
  productAppears: boolean;
  prompts: string[];
  testIds: string[];
  urls: string[];
  competitors: string[];
};

export type OpportunitySignals = {
  product: { id: string; name: string; slug: string };
  queries: {
    id: string;
    query: string;
    intent: Intent;
    importance: number;
    coverage: "NONE" | "PARTIAL" | "COVERED";
    pageStatus?: string | null;
    /** Queries in a cluster are handled by cluster-level content gaps (never one page per keyword). */
    clusterId?: string | null;
    search?: { impressions: number; clicks: number; position: number | null } | null;
  }[];
  /** Window of the search figures, for labels (default 28 days). */
  searchDays?: number;
  contentGaps?: ContentGap[];
  aiGaps: { prompt: string; promptId: string; testsRun: number; productMentions: number; competitorsMentioned: string[] }[];
  citationDomains?: CitationDomainSignal[];
  seoIssues: { rule: string; severity: "CRITICAL" | "HIGH"; count: number; exampleUrl: string }[];
  missingEntity: { key: string; label: string; weight: number; earned: number }[];
  competitorsWithoutComparison: { name: string; sourcedFacts: number }[];
  orphanPages: string[];
  lowConversionPages: { path: string; views: number; ctaClicks: number }[];
  searchTrend?: { clicksNow: number; clicksPrev: number } | null;
  /** Distribution kinds suggested by the categories of sources AI answers cite, with whether a target is already prepared. */
  distributionNeeds?: { kind: string; citedCategory: string; citedSamples: number; exampleDomains: string[]; preparedTargets: number }[];
  /** Products sharing users or a declared relationship with this one, without a cross-sell rule yet. */
  crossSell?: { productId: string; productName: string; sharedIdentities: number; relationship: string | null; hasRule: boolean }[];
  /** Conversions recorded for the product, and whether a referral program exists. */
  referral?: { conversions90d: number; activeReferralCodes: number; affiliates: number } | null;
};

/**
 * Priority = impact × confidence × urgency ÷ effort (each factor 1 to 5,
 * effort 5 = most work). Transparent and sortable; every factor carries a
 * stored rationale (scoring_rationale) shown on the detail page.
 */
export const priority = (impact: number, confidence: number, effort: number, urgency: number) => Math.round(((impact * confidence * urgency) / effort) * 10) / 10;
export const PRIORITY_FORMULA = "priority = impact × confidence × urgency ÷ effort";

const INTENT_PAGE: Record<Intent, PageType> = {
  INFORMATIONAL: "GUIDE",
  PROBLEM: "USE_CASE",
  COMMERCIAL: "AUDIENCE",
  TRANSACTIONAL: "PRODUCT",
  NAVIGATIONAL: "PRODUCT",
  COMPARISON: "COMPARISON",
  ALTERNATIVE: "ALTERNATIVE",
};

const ASSET_LABEL: Record<string, string> = {
  PRODUCT_PAGE: "product page",
  PRICING_PAGE: "pricing page",
  LANDING_PAGE: "landing page",
  FEATURE_PAGE: "feature page",
  USE_CASE_PAGE: "use-case page",
  INTEGRATION_PAGE: "integration page",
  COMPARISON_PAGE: "comparison page",
  ALTERNATIVES_PAGE: "alternatives page",
  GUIDE: "guide",
  FAQ: "FAQ",
};

const clamp5 = (n: number) => Math.min(5, Math.max(1, Math.round(n)));
const potentialFrom = (impact: number, confidence: number): Potential => (impact * confidence >= 16 ? "HIGH" : impact * confidence >= 9 ? "MEDIUM" : "LOW");

function make(d: Omit<OpportunityDraft, "priorityScore" | "potential" | "sources"> & { potential?: Potential; sources?: OpportunitySources }): OpportunityDraft {
  const impact = clamp5(d.impact);
  const confidence = clamp5(d.confidence);
  const effort = clamp5(d.effort);
  const urgency = clamp5(d.urgency);
  return { ...d, impact, confidence, effort, urgency, sources: d.sources ?? {}, potential: d.potential ?? potentialFrom(impact, confidence), priorityScore: priority(impact, confidence, effort, urgency) };
}

const actions = (...xs: [string, string][]): OpportunityAction[] => xs.map(([kind, action], i) => ({ order: i + 1, kind, action }));
const qs = (p: { slug: string }, query?: string) => `/queries?product=${encodeURIComponent(p.slug)}${query ? `&status=ALL&q=${encodeURIComponent(query)}` : ""}`;

/**
 * Rules-based opportunity generation. Every opportunity names the evidence
 * it is based on, a rationale for each scoring factor and one concrete next
 * action with a link. Impact is expressed as LOW / MEDIUM / HIGH potential
 * only: no fabricated traffic or revenue forecasts.
 */
export function generateOpportunities(s: OpportunitySignals): OpportunityDraft[] {
  const out: OpportunityDraft[] = [];
  const P = s.product;
  const days = s.searchDays ?? 28;

  // ── Content: one opportunity per gap cluster (never one page per keyword).
  for (const g of s.contentGaps ?? []) {
    const asset = ASSET_LABEL[g.recommendedAsset] ?? "page";
    const measured = g.demand.status === "MEASURED" && (g.demand.impressions ?? 0) > 0;
    out.push(
      make({
        productId: P.id,
        queryId: g.topQueryId,
        type: "CONTENT_GAP",
        category: "CONTENT",
        title: `Create a ${asset} for the "${g.clusterName}" topic`,
        problem: `Content gap for a cluster of ${g.sources.queryIds.length} quer${g.sources.queryIds.length === 1 ? "y" : "ies"}: ${g.reasons.map((r) => r.toLowerCase().replace(/_/g, " ")).join(", ")}.`,
        evidence: [
          { label: "Coverage", value: g.coverage.status },
          ...(g.coverage.evidence ? [{ label: "Coverage evidence", value: g.coverage.evidence }] : []),
          { label: "Existing page", value: g.existingPage ?? "None" },
          { label: "Business relevance", value: `${g.relevance.level}: ${g.relevance.reason}` },
          { label: "Search demand", value: g.demand.status === "MEASURED" ? `${g.demand.impressions} impressions, ${g.demand.clicks} clicks (${g.demand.provider ?? "search provider"})` : "Unknown (no search provider data)" },
          ...(g.competitors.length ? [{ label: "Competitors in sampled AI answers", value: g.competitors.join(", ") }] : []),
        ],
        competitors: g.competitors,
        actions: actions(
          ["CREATE_PAGE", `Create one ${asset} covering the whole "${g.clusterName}" cluster.`],
          ...g.supportingAssets.map((a) => ["SUPPORT", `Support it with a ${ASSET_LABEL[a] ?? a.toLowerCase()}.`] as [string, string]),
          ["INTERNAL_LINKS", "Link to it from related published pages."],
          ["STRUCTURED_DATA", "Add structured data matching the page type."],
        ),
        impact: g.relevance.level === "HIGH" ? 4 + (measured ? 1 : 0) : g.relevance.level === "MEDIUM" ? 3 + (measured ? 1 : 0) : 2,
        confidence: measured ? 4 : g.reasons.includes("AI_COMPETITOR_ONLY") ? 3 : 3,
        effort: g.recommendedAsset === "FAQ" ? 2 : 3,
        urgency: g.competitors.length ? 4 : g.coverage.status === "NONE" ? 3 : 2,
        scoringRationale: {
          impact: `Business relevance ${g.relevance.level.toLowerCase()} (${g.relevance.reason})${measured ? ", plus measured search demand" : ""}.`,
          confidence: measured ? "Backed by measured search data." : g.reasons.includes("AI_COMPETITOR_ONLY") ? "Backed by sampled AI answers; search demand unknown." : "Based on coverage and knowledge-graph relevance; search demand unknown.",
          effort: g.recommendedAsset === "FAQ" ? "An FAQ is a small, fact-based asset." : `One new ${asset} built from verified facts.`,
          urgency: g.competitors.length ? "Competitors already appear in sampled AI answers for this topic." : g.coverage.status === "NONE" ? "Nothing covers this topic yet." : "Partial coverage exists.",
        },
        nextAction: { label: "Create a draft from the content gap", href: `${qs(P)}#gap-${g.clusterId}` },
        sources: { queryIds: g.sources.queryIds, testIds: g.sources.testIds, urls: g.sources.urls, clusterId: g.clusterId },
        fingerprint: `content_gap:cluster:${g.clusterId}`,
      }),
    );
  }

  for (const q of s.queries) {
    const aiGap = s.aiGaps.find((g) => g.prompt.toLowerCase().includes(q.query.toLowerCase()) || q.query.toLowerCase().includes(g.prompt.toLowerCase()));
    const comps = aiGap?.competitorsMentioned ?? [];
    if (!q.clusterId && q.coverage === "NONE" && q.importance >= 3) {
      const pageType = INTENT_PAGE[q.intent];
      out.push(
        make({
          productId: P.id,
          queryId: q.id,
          type: "CONTENT_GAP",
          category: "CONTENT",
          title: `Cover "${q.query}"`,
          problem: `High-relevance ${q.intent.toLowerCase()} query with no content coverage.`,
          evidence: [
            { label: "Importance", value: `${q.importance}/5` },
            { label: "Coverage", value: "None" },
            ...(q.search ? [{ label: `Search impressions (${days}d)`, value: String(q.search.impressions) }] : []),
            ...(comps.length ? [{ label: "Competitors in sampled AI answers", value: comps.join(", ") }] : []),
          ],
          competitors: comps,
          actions: actions(
            ["CREATE_PAGE", `Create ${/^[aeiou]/i.test(pageType) ? "an" : "a"} ${pageType.toLowerCase().replace("_", "-")} page targeting "${q.query}".`],
            ["ADD_FAQ", "Add factual FAQ entries answering the query directly."],
            ...(q.intent === "PROBLEM" || q.intent === "INFORMATIONAL" ? ([["CREATE_GUIDE", `Publish a workflow guide for "${q.query}".`]] as [string, string][]) : []),
            ["INTERNAL_LINKS", "Add internal links from related published pages."],
            ["CASE_STUDY", "Create a supporting case study when verified evidence exists."],
            ["STRUCTURED_DATA", "Update structured data on the new page."],
          ),
          impact: Math.min(5, q.importance + (q.search && q.search.impressions > 100 ? 1 : 0)),
          confidence: q.search ? 4 : 3,
          effort: 3,
          urgency: comps.length ? 4 : 3,
          scoringRationale: {
            impact: `Query importance ${q.importance}/5${q.search && q.search.impressions > 100 ? ", plus more than 100 measured impressions" : ""}.`,
            confidence: q.search ? "Backed by measured search data." : "No search data; based on the curated importance.",
            effort: "One new page built from verified facts.",
            urgency: comps.length ? "Competitors appear in sampled AI answers for this question." : "No page covers this query yet.",
          },
          nextAction: { label: "Review the query and create a draft", href: qs(P, q.query) },
          sources: { queryIds: [q.id] },
          fingerprint: `content_gap:${q.id}`,
        }),
      );
    }
    if (q.search && q.search.position !== null && q.search.position > 8 && q.search.position <= 20 && q.search.impressions >= 50) {
      out.push(
        make({
          productId: P.id,
          queryId: q.id,
          type: "STRIKING_DISTANCE",
          category: "QUERY",
          title: `Improve ranking for "${q.query}" (avg. position ${q.search.position.toFixed(1)})`,
          problem: "Query ranks just outside the first page; improvements to relevance and internal linking may move it.",
          evidence: [
            { label: "Average position", value: q.search.position.toFixed(1) },
            { label: `Impressions (${days}d)`, value: String(q.search.impressions) },
            { label: `Clicks (${days}d)`, value: String(q.search.clicks) },
          ],
          competitors: comps,
          actions: actions(
            ["EXPAND_CONTENT", "Expand the ranking page with factual sections answering related questions."],
            ["INTERNAL_LINKS", "Add internal links with descriptive anchors from relevant pages."],
            ["TITLE", "Align title and H1 with the query intent."],
          ),
          impact: 4,
          confidence: 3,
          effort: 2,
          urgency: 3,
          scoringRationale: {
            impact: "Moving from page two to page one usually changes click volume the most.",
            confidence: `Impressions-weighted average position ${q.search.position.toFixed(1)} over ${days} days; rankings fluctuate.`,
            effort: "Improves an existing page; no new page needed.",
            urgency: "No external deadline; steady opportunity.",
          },
          nextAction: { label: "Open the query and its ranking page", href: qs(P, q.query) },
          sources: { queryIds: [q.id] },
          fingerprint: `striking:${q.id}`,
        }),
      );
    }
    if (q.search && q.search.impressions >= 200 && q.search.clicks / Math.max(1, q.search.impressions) < 0.01 && (q.search.position ?? 99) <= 10) {
      out.push(
        make({
          productId: P.id,
          queryId: q.id,
          type: "LOW_CTR",
          category: "QUERY",
          title: `Low click-through for "${q.query}"`,
          problem: "Page ranks on the first page but earns few clicks; title and description may not match intent.",
          evidence: [
            { label: "CTR", value: `${((q.search.clicks / q.search.impressions) * 100).toFixed(2)}%` },
            { label: `Impressions (${days}d)`, value: String(q.search.impressions) },
          ],
          competitors: [],
          actions: actions(["REWRITE_META", "Rewrite the title and meta description to answer the query precisely."], ["STRUCTURED_DATA", "Add applicable structured data (FAQ, breadcrumbs)."]),
          impact: 3,
          confidence: 3,
          effort: 1,
          urgency: 2,
          scoringRationale: {
            impact: "More clicks from impressions the page already earns.",
            confidence: "CTR below 1% on page one over at least 200 impressions.",
            effort: "Title and meta description changes only.",
            urgency: "Low: no ranking loss involved.",
          },
          nextAction: { label: "Open the query and rewrite the snippet", href: qs(P, q.query) },
          sources: { queryIds: [q.id] },
          fingerprint: `low_ctr:${q.id}`,
        }),
      );
    }
  }

  for (const g of s.aiGaps) {
    if (g.testsRun === 0 || g.productMentions > 0 || g.competitorsMentioned.length === 0) continue;
    out.push(
      make({
        productId: P.id,
        type: "AI_VISIBILITY_GAP",
        category: "AI_VISIBILITY",
        title: `${P.name} absent from sampled AI answers: "${g.prompt}"`,
        problem: `In ${g.testsRun} sampled observation(s), competitors were mentioned but ${P.name} was not. Samples do not represent every user's AI response.`,
        evidence: [
          { label: "Sampled tests", value: String(g.testsRun) },
          { label: "Competitors mentioned", value: g.competitorsMentioned.join(", ") },
        ],
        competitors: g.competitorsMentioned,
        actions: actions(
          ["ENTITY_PROFILE", "Complete the entity profile (WHO / WHAT / WHO FOR / PROOF / PRICE) with sources."],
          ["ANSWER_PAGE", "Publish a concise, citation-ready answer page for this question."],
          ["DISTRIBUTION", "Get listed on relevant directories and communities that answer engines cite."],
          ["COMPARISON", "Publish sourced comparisons with the competitors mentioned."],
        ),
        impact: 4,
        confidence: g.testsRun >= 3 ? 3 : 2,
        effort: 3,
        urgency: 3,
        scoringRationale: {
          impact: "Answer engines name competitors for this question but not the product.",
          confidence: g.testsRun >= 3 ? `Observed in ${g.testsRun} sampled responses.` : `Only ${g.testsRun} sampled response(s): weak signal.`,
          effort: "Needs an answer page and sourced facts.",
          urgency: "Competitors are present in the sampled answers.",
        },
        nextAction: { label: "Open the prompt's sampled responses", href: `/ai-visibility#prompt-${g.promptId}` },
        fingerprint: `ai_gap:${g.promptId}`,
      }),
    );
  }

  // ── Citation sources: frequently cited third parties that do not mention the product.
  for (const c of s.citationDomains ?? []) {
    if (c.productAppears || c.samplesCiting < 2 || c.samplesTotal === 0) continue;
    const share = c.samplesCiting / c.samplesTotal;
    out.push(
      make({
        productId: P.id,
        type: "CITATION",
        category: "CITATION",
        title: `${c.domain} is cited for this topic without ${P.name}`,
        problem: `This source is frequently cited for this topic but was not associated with ${P.name} in the sampled responses (cited in ${c.samplesCiting} of ${c.samplesTotal}). Beacon never contacts third parties automatically.`,
        evidence: [
          { label: "Cited in", value: `${c.samplesCiting} of ${c.samplesTotal} sampled responses` },
          { label: "Source category", value: c.category },
          { label: "Prompts", value: c.prompts.slice(0, 3).join(" / ") },
          ...(c.competitors.length ? [{ label: "Competitors associated", value: c.competitors.join(", ") }] : []),
        ],
        competitors: c.competitors,
        actions: actions(
          ["REVIEW_SOURCE", `Review the cited pages on ${c.domain} and check whether ${P.name} is relevant there.`],
          ["PREPARE_LISTING", "If relevant, prepare factual, sourced material (listing, correction or contribution) for a human to submit."],
          ["TRACK", "Add the source as a distribution target to track the outcome."],
        ),
        impact: c.category === "REVIEW_SITE" || c.category === "DIRECTORY" || c.category === "COMPARISON" ? 4 : 3,
        confidence: c.samplesCiting >= 5 ? 4 : share >= 0.3 ? 3 : 2,
        effort: c.category === "DIRECTORY" || c.category === "REVIEW_SITE" ? 2 : 3,
        urgency: c.competitors.length ? 4 : 3,
        scoringRationale: {
          impact: `Answer engines cite this ${c.category.toLowerCase().replace(/_/g, " ")} for the topic.`,
          confidence: `Cited in ${c.samplesCiting} of ${c.samplesTotal} sampled responses.`,
          effort: c.category === "DIRECTORY" || c.category === "REVIEW_SITE" ? "Listings are usually quick to prepare." : "Requires a relevant, factual contribution.",
          urgency: c.competitors.length ? "Competitors are associated with this source." : "No competitor association observed.",
        },
        nextAction: { label: "Add the source as a distribution target", href: "/distribution" },
        sources: { testIds: c.testIds.slice(0, 20), urls: c.urls.slice(0, 10) },
        fingerprint: `citation:${P.id}:${c.domain}`,
      }),
    );
  }

  for (const issue of s.seoIssues) {
    out.push(
      make({
        productId: P.id,
        type: "TECHNICAL",
        category: "TECHNICAL",
        title: `Fix ${issue.severity.toLowerCase()} technical issue: ${issue.rule}`,
        problem: `${issue.count} page(s) affected, e.g. ${issue.exampleUrl}.`,
        evidence: [
          { label: "Rule", value: issue.rule },
          { label: "Affected pages", value: String(issue.count) },
        ],
        competitors: [],
        actions: actions(["FIX", "Fix the issue on affected pages (see the audit for details)."], ["REAUDIT", "Re-run the audit to confirm the fix."]),
        impact: issue.severity === "CRITICAL" ? 5 : 3,
        confidence: 5,
        effort: 2,
        urgency: issue.severity === "CRITICAL" ? 5 : 3,
        scoringRationale: {
          impact: issue.severity === "CRITICAL" ? "Critical issues can block indexing or rendering." : "High-severity issue affecting discoverability.",
          confidence: "Measured by the latest crawl.",
          effort: "Usually a template or configuration fix.",
          urgency: issue.severity === "CRITICAL" ? "Critical severity." : "High severity.",
        },
        nextAction: { label: "Open the latest audit", href: `/discovery?product=${encodeURIComponent(P.slug)}` },
        sources: { urls: [issue.exampleUrl] },
        fingerprint: `tech:${P.id}:${issue.rule}`,
      }),
    );
  }

  const bigGaps = s.missingEntity.filter((m) => m.weight - m.earned >= 3);
  if (bigGaps.length) {
    const lost = bigGaps.reduce((a, m) => a + (m.weight - m.earned), 0);
    out.push(
      make({
        productId: P.id,
        type: "PRODUCT_KNOWLEDGE",
        category: "PRODUCT_KNOWLEDGE",
        title: `Complete ${P.name}'s knowledge graph`,
        problem: "Missing facts limit what Beacon can safely generate and what answer engines can cite.",
        evidence: bigGaps.slice(0, 6).map((m) => ({ label: m.label, value: `${Math.round((m.earned / m.weight) * 100)}% complete` })),
        competitors: [],
        actions: actions(...bigGaps.slice(0, 5).map((m) => ["ADD_FACTS", `Add: ${m.label}.`] as [string, string])),
        impact: lost >= 20 ? 5 : lost >= 10 ? 4 : 3,
        confidence: 5,
        effort: 1,
        urgency: 3,
        scoringRationale: {
          impact: `${lost} completeness points missing.`,
          confidence: "Measured from the knowledge graph.",
          effort: "Facts are entered by a person who knows the product.",
          urgency: "Every generated asset depends on these facts.",
        },
        nextAction: { label: "Open the knowledge graph", href: `/products/${encodeURIComponent(P.slug)}/knowledge` },
        fingerprint: `entity:${P.id}`,
      }),
    );
  }

  for (const c of s.competitorsWithoutComparison) {
    out.push(
      make({
        productId: P.id,
        type: "COMPARISON_FACTS",
        category: "PRODUCT_KNOWLEDGE",
        title: `Gather sourced facts to compare ${P.name} with ${c.name}`,
        problem: `Only ${c.sourcedFacts} sourced comparison fact(s); at least 3 are required before a comparison page can be published.`,
        evidence: [{ label: "Sourced facts", value: `${c.sourcedFacts}/3` }],
        competitors: [c.name],
        actions: actions(["RESEARCH", `Collect factual, sourced comparison points for ${c.name} (pricing page, docs).`], ["CREATE_PAGE", "Generate the comparison page once facts are sourced."]),
        impact: 3,
        confidence: 3,
        effort: 2,
        urgency: 2,
        scoringRationale: {
          impact: "Unlocks a comparison page.",
          confidence: `${c.sourcedFacts} of 3 required sourced facts.`,
          effort: "Research on public pricing and documentation pages.",
          urgency: "No deadline.",
        },
        nextAction: { label: "Add comparison facts", href: `/products/${encodeURIComponent(P.slug)}/knowledge` },
        fingerprint: `comparison:${P.id}:${c.name.toLowerCase()}`,
      }),
    );
  }

  if (s.orphanPages.length)
    out.push(
      make({
        productId: P.id,
        type: "INTERNAL_LINKING",
        category: "TECHNICAL",
        title: `Link ${s.orphanPages.length} orphan page(s)`,
        problem: "Pages without internal links are harder for crawlers and users to discover.",
        evidence: s.orphanPages.slice(0, 5).map((u) => ({ label: "Orphan", value: u })),
        competitors: [],
        actions: actions(["INTERNAL_LINKS", "Add contextual internal links from related pages and navigation."]),
        impact: 2,
        confidence: 4,
        effort: 1,
        urgency: 2,
        scoringRationale: {
          impact: "Helps crawlers reach these pages.",
          confidence: "Measured by the latest crawl.",
          effort: "A few links in existing pages.",
          urgency: "Low.",
        },
        nextAction: { label: "Open the latest audit", href: `/discovery?product=${encodeURIComponent(P.slug)}` },
        sources: { urls: s.orphanPages.slice(0, 10) },
        fingerprint: `orphans:${P.id}`,
      }),
    );

  for (const pg of s.lowConversionPages)
    out.push(
      make({
        productId: P.id,
        type: "CONVERSION",
        category: "CONVERSION",
        title: `Improve CTA on ${pg.path}`,
        problem: `${pg.views} views and ${pg.ctaClicks} CTA clicks in 28 days.`,
        evidence: [
          { label: "Views", value: String(pg.views) },
          { label: "CTA clicks", value: String(pg.ctaClicks) },
        ],
        competitors: [],
        actions: actions(["CTA", "Add a clear, relevant CTA above the fold."], ["EXPERIMENT", "Run a CTA experiment and monitor CTA click rate."]),
        impact: 3,
        confidence: 3,
        effort: 1,
        urgency: 2,
        scoringRationale: {
          impact: "Traffic already reaches the page.",
          confidence: `${pg.views} first-party page views with a CTA click rate under 0.5%.`,
          effort: "A CTA change.",
          urgency: "Low.",
        },
        nextAction: { label: "Open conversion funnels", href: `/conversions?product=${encodeURIComponent(P.slug)}` },
        fingerprint: `cta:${P.id}:${pg.path}`,
      }),
    );

  if (s.searchTrend && s.searchTrend.clicksPrev >= 50 && s.searchTrend.clicksNow < s.searchTrend.clicksPrev * 0.8) {
    const drop = Math.round((1 - s.searchTrend.clicksNow / s.searchTrend.clicksPrev) * 100);
    out.push(
      make({
        productId: P.id,
        type: "VISIBILITY_DROP",
        category: "QUERY",
        title: `Organic clicks down ${drop}% for ${P.name}`,
        problem: "Organic clicks fell versus the previous period. Investigate technical changes, lost rankings and seasonality before acting.",
        evidence: [
          { label: "Clicks (current 28d)", value: String(s.searchTrend.clicksNow) },
          { label: "Clicks (previous 28d)", value: String(s.searchTrend.clicksPrev) },
        ],
        competitors: [],
        actions: actions(["INVESTIGATE", "Compare top queries and pages between periods."], ["REAUDIT", "Run a technical audit to rule out indexing problems."]),
        impact: 4,
        confidence: 4,
        effort: 2,
        urgency: 5,
        scoringRationale: {
          impact: `${drop}% fewer organic clicks.`,
          confidence: "Measured by the search provider over two equal periods.",
          effort: "Investigation first.",
          urgency: "Losses compound while unexplained.",
        },
        nextAction: { label: "Open the product's search data", href: `/products/${encodeURIComponent(P.slug)}` },
        fingerprint: `drop:${P.id}`,
      }),
    );
  }

  // ── Distribution: source categories AI answers cite, without a prepared target of the matching kind.
  for (const d of s.distributionNeeds ?? []) {
    if (d.preparedTargets > 0 || d.citedSamples < 2) continue;
    out.push(
      make({
        productId: P.id,
        type: "DISTRIBUTION",
        category: "DISTRIBUTION",
        title: `Prepare ${d.kind.toLowerCase().replace(/_/g, " ")} listings for ${P.name}`,
        problem: `Sampled AI answers cite ${d.citedCategory.toLowerCase().replace(/_/g, " ")} sources, and no ${d.kind.toLowerCase().replace(/_/g, " ")} target is prepared for ${P.name}.`,
        evidence: [
          { label: "Sampled responses citing this source type", value: String(d.citedSamples) },
          { label: "Examples", value: d.exampleDomains.slice(0, 5).join(", ") },
          { label: "Prepared targets", value: "0" },
        ],
        competitors: [],
        actions: actions(["ADD_TARGETS", "Add the relevant sources as distribution targets."], ["PREPARE", "Prepare factual listing material; submission stays a human decision."]),
        impact: 3,
        confidence: d.citedSamples >= 5 ? 4 : 3,
        effort: 2,
        urgency: 2,
        scoringRationale: {
          impact: "Answer engines use these sources for the product's topics.",
          confidence: `${d.citedSamples} sampled responses cited this source type.`,
          effort: "Listing material reuses verified facts.",
          urgency: "No deadline.",
        },
        nextAction: { label: "Open the distribution center", href: "/distribution" },
        fingerprint: `distribution:${P.id}:${d.kind}`,
      }),
    );
  }

  // ── Cross-sell: declared relationships or shared users without a rule.
  for (const c of s.crossSell ?? []) {
    if (c.hasRule || (c.sharedIdentities < 5 && !c.relationship)) continue;
    out.push(
      make({
        productId: P.id,
        type: "CROSS_SELL",
        category: "CROSS_SELL",
        title: `Set up a cross-sell from ${P.name} to ${c.productName}`,
        problem: `${c.relationship ? `A ${c.relationship.toLowerCase().replace(/_/g, " ")} relationship is declared` : "Users already use both products"} but no cross-sell rule exists.`,
        evidence: [
          ...(c.relationship ? [{ label: "Relationship", value: c.relationship }] : []),
          { label: "Identities using both products", value: String(c.sharedIdentities) },
        ],
        competitors: [],
        actions: actions(["CREATE_RULE", "Create a consent-gated, capped cross-sell rule."], ["MEASURE", "Track impressions, clicks and conversions per rule."]),
        impact: 3,
        confidence: c.sharedIdentities >= 20 ? 4 : 3,
        effort: 2,
        urgency: 2,
        scoringRationale: {
          impact: "Existing users are the cheapest acquisition source.",
          confidence: c.relationship ? "Declared relationship in the ecosystem graph." : `${c.sharedIdentities} identities use both products.`,
          effort: "A rule, a message and a CTA.",
          urgency: "No deadline.",
        },
        nextAction: { label: "Open the product", href: `/products/${encodeURIComponent(P.slug)}` },
        fingerprint: `cross_sell:${P.id}:${c.productId}`,
      }),
    );
  }

  // ── Referral: conversions but no referral program.
  if (s.referral && s.referral.conversions90d >= 10 && s.referral.activeReferralCodes === 0) {
    out.push(
      make({
        productId: P.id,
        type: "REFERRAL",
        category: "REFERRAL",
        title: `Start a referral program for ${P.name}`,
        problem: `${s.referral.conversions90d} conversions in 90 days and no active referral code.`,
        evidence: [
          { label: "Conversions (90d)", value: String(s.referral.conversions90d) },
          { label: "Active referral codes", value: "0" },
          { label: "Affiliates", value: String(s.referral.affiliates) },
        ],
        competitors: [],
        actions: actions(["CREATE_CODES", "Create referral codes for existing customers or affiliates."], ["TRACK", "Track referral conversions and commissions."]),
        impact: 3,
        confidence: 3,
        effort: 2,
        urgency: 2,
        scoringRationale: {
          impact: "Converting customers can refer others.",
          confidence: `${s.referral.conversions90d} recorded conversions.`,
          effort: "Codes and terms already supported by Beacon.",
          urgency: "No deadline.",
        },
        nextAction: { label: "Open referrals", href: "/referrals" },
        fingerprint: `referral:${P.id}`,
      }),
    );
  }

  return out.sort((a, b) => b.priorityScore - a.priorityScore || a.fingerprint.localeCompare(b.fingerprint));
}
