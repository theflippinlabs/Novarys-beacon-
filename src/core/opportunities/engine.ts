import type { Intent } from "@/core/queries/classify";
import type { PageType } from "@/core/discovery/urls";
import type { OpportunityAction } from "@/db/schema";

export type Potential = "LOW" | "MEDIUM" | "HIGH";

export type OpportunityDraft = {
  productId: string;
  queryId?: string;
  type: string;
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
  fingerprint: string;
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
    search?: { impressions: number; clicks: number; position: number | null } | null;
  }[];
  aiGaps: { prompt: string; promptId: string; testsRun: number; productMentions: number; competitorsMentioned: string[] }[];
  seoIssues: { rule: string; severity: "CRITICAL" | "HIGH"; count: number; exampleUrl: string }[];
  missingEntity: { key: string; label: string; weight: number; earned: number }[];
  competitorsWithoutComparison: { name: string; sourcedFacts: number }[];
  orphanPages: string[];
  lowConversionPages: { path: string; views: number; ctaClicks: number }[];
  searchTrend?: { clicksNow: number; clicksPrev: number } | null;
};

/** Priority = impact × confidence × urgency ÷ effort (each 1–5). Transparent and sortable. */
export const priority = (impact: number, confidence: number, effort: number, urgency: number) => Math.round(((impact * confidence * urgency) / effort) * 10) / 10;

const INTENT_PAGE: Record<Intent, PageType> = {
  INFORMATIONAL: "GUIDE",
  PROBLEM: "USE_CASE",
  COMMERCIAL: "AUDIENCE",
  TRANSACTIONAL: "PRODUCT",
  NAVIGATIONAL: "PRODUCT",
  COMPARISON: "COMPARISON",
  ALTERNATIVE: "ALTERNATIVE",
};

const potentialFrom = (impact: number, confidence: number): Potential => (impact * confidence >= 16 ? "HIGH" : impact * confidence >= 8 ? "MEDIUM" : "LOW");

function make(d: Omit<OpportunityDraft, "priorityScore" | "potential"> & { potential?: Potential }): OpportunityDraft {
  return { ...d, potential: d.potential ?? potentialFrom(d.impact, d.confidence), priorityScore: priority(d.impact, d.confidence, d.effort, d.urgency) };
}

const actions = (...xs: [string, string][]): OpportunityAction[] => xs.map(([kind, action], i) => ({ order: i + 1, kind, action }));

/**
 * Rules-based opportunity generation. Every opportunity names the evidence
 * it is based on. Impact is expressed as LOW / MEDIUM / HIGH potential only —
 * no fabricated traffic or revenue forecasts.
 */
export function generateOpportunities(s: OpportunitySignals): OpportunityDraft[] {
  const out: OpportunityDraft[] = [];
  const P = s.product;

  for (const q of s.queries) {
    const aiGap = s.aiGaps.find((g) => g.prompt.toLowerCase().includes(q.query.toLowerCase()) || q.query.toLowerCase().includes(g.prompt.toLowerCase()));
    const comps = aiGap?.competitorsMentioned ?? [];
    if (q.coverage === "NONE" && q.importance >= 3) {
      const pageType = INTENT_PAGE[q.intent];
      out.push(
        make({
          productId: P.id,
          queryId: q.id,
          type: "CONTENT_GAP",
          title: `Cover "${q.query}"`,
          problem: `High-relevance ${q.intent.toLowerCase()} query with no content coverage.`,
          evidence: [
            { label: "Importance", value: `${q.importance}/5` },
            { label: "Coverage", value: "None" },
            ...(q.search ? [{ label: "Search impressions (28d)", value: String(q.search.impressions) }] : []),
            ...(comps.length ? [{ label: "Competitors in sampled AI answers", value: comps.join(", ") }] : []),
          ],
          competitors: comps,
          actions: actions(
            ["CREATE_PAGE", `Create a ${pageType.toLowerCase().replace("_", "-")} page targeting "${q.query}".`],
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
          title: `Improve ranking for "${q.query}" (avg. position ${q.search.position.toFixed(1)})`,
          problem: "Query ranks just outside the first page; improvements to relevance and internal linking may move it.",
          evidence: [
            { label: "Average position", value: q.search.position.toFixed(1) },
            { label: "Impressions (28d)", value: String(q.search.impressions) },
            { label: "Clicks (28d)", value: String(q.search.clicks) },
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
          title: `Low click-through for "${q.query}"`,
          problem: "Page ranks on the first page but earns few clicks — title and description may not match intent.",
          evidence: [
            { label: "CTR", value: `${((q.search.clicks / q.search.impressions) * 100).toFixed(2)}%` },
            { label: "Impressions (28d)", value: String(q.search.impressions) },
          ],
          competitors: [],
          actions: actions(["REWRITE_META", "Rewrite the title and meta description to answer the query precisely."], ["STRUCTURED_DATA", "Add applicable structured data (FAQ, breadcrumbs)."]),
          impact: 3,
          confidence: 3,
          effort: 1,
          urgency: 2,
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
        fingerprint: `ai_gap:${g.promptId}`,
      }),
    );
  }

  for (const issue of s.seoIssues) {
    out.push(
      make({
        productId: P.id,
        type: "TECHNICAL",
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
        type: "ENTITY_COMPLETENESS",
        title: `Complete ${P.name}'s knowledge graph`,
        problem: "Missing facts limit what Beacon can safely generate and what answer engines can cite.",
        evidence: bigGaps.slice(0, 6).map((m) => ({ label: m.label, value: `${Math.round((m.earned / m.weight) * 100)}% complete` })),
        competitors: [],
        actions: actions(...bigGaps.slice(0, 5).map((m) => ["ADD_FACTS", `Add: ${m.label}.`] as [string, string])),
        impact: lost >= 20 ? 5 : lost >= 10 ? 4 : 3,
        confidence: 5,
        effort: 1,
        urgency: 3,
        fingerprint: `entity:${P.id}`,
      }),
    );
  }

  for (const c of s.competitorsWithoutComparison) {
    out.push(
      make({
        productId: P.id,
        type: "COMPARISON_FACTS",
        title: `Gather sourced facts to compare ${P.name} with ${c.name}`,
        problem: `Only ${c.sourcedFacts} sourced comparison fact(s); at least 3 are required before a comparison page can be published.`,
        evidence: [{ label: "Sourced facts", value: `${c.sourcedFacts}/3` }],
        competitors: [c.name],
        actions: actions(["RESEARCH", `Collect factual, sourced comparison points for ${c.name} (pricing page, docs).`], ["CREATE_PAGE", "Generate the comparison page once facts are sourced."]),
        impact: 3,
        confidence: 3,
        effort: 2,
        urgency: 2,
        fingerprint: `comparison:${P.id}:${c.name.toLowerCase()}`,
      }),
    );
  }

  if (s.orphanPages.length)
    out.push(
      make({
        productId: P.id,
        type: "INTERNAL_LINKING",
        title: `Link ${s.orphanPages.length} orphan page(s)`,
        problem: "Pages without internal links are harder for crawlers and users to discover.",
        evidence: s.orphanPages.slice(0, 5).map((u) => ({ label: "Orphan", value: u })),
        competitors: [],
        actions: actions(["INTERNAL_LINKS", "Add contextual internal links from related pages and navigation."]),
        impact: 2,
        confidence: 4,
        effort: 1,
        urgency: 2,
        fingerprint: `orphans:${P.id}`,
      }),
    );

  for (const pg of s.lowConversionPages)
    out.push(
      make({
        productId: P.id,
        type: "CONVERSION",
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
        fingerprint: `cta:${P.id}:${pg.path}`,
      }),
    );

  if (s.searchTrend && s.searchTrend.clicksPrev >= 50 && s.searchTrend.clicksNow < s.searchTrend.clicksPrev * 0.8) {
    const drop = Math.round((1 - s.searchTrend.clicksNow / s.searchTrend.clicksPrev) * 100);
    out.push(
      make({
        productId: P.id,
        type: "VISIBILITY_DROP",
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
        fingerprint: `drop:${P.id}`,
      }),
    );
  }

  return out.sort((a, b) => b.priorityScore - a.priorityScore);
}
