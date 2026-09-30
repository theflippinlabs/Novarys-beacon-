import { facetsOf, isVerified, type ProductGraph } from "@/core/knowledge/types";
import { formatMoney, tokens } from "@/core/util/text";

export type Match = { kind: string; fact: string; matchedTerms: string[] };
export type ProductRecommendation = {
  productId: string;
  productName: string;
  score: number;
  fit: "STRONG" | "PARTIAL";
  why: Match[];
  relevantFeatures: string[];
  pricing: string[];
  cta: { label: string; url: string } | null;
};
export type RecommendationResult = {
  primary: ProductRecommendation | null;
  complementary: ProductRecommendation[];
  considered: number;
  explanation: string;
  extractedNeeds: string[];
};

const SYNONYMS: Record<string, string[]> = {
  agency: ["agencies", "agency", "manage creators", "roster", "clients"],
  creator: ["creators", "creator", "streamer", "streamers", "influencer", "influencers"],
  moderation: ["moderate", "moderation", "moderator", "moderators", "spam", "toxic", "abuse", "comments"],
  analytics: ["analytics", "metrics", "stats", "statistics", "reporting", "dashboard", "insights"],
  legal: ["legal", "contract", "contracts", "lawyer", "lawyers", "law", "compliance", "clause", "clauses"],
  investigation: ["osint", "investigation", "investigate", "intelligence", "research"],
  automation: ["automate", "automation", "workflow", "workflows", "operator", "operations"],
};

function expand(need: string): Set<string> {
  const t = new Set(tokens(need).map(stem));
  const lower = need.toLowerCase();
  for (const [root, words] of Object.entries(SYNONYMS)) if (words.some((w) => lower.includes(w))) for (const w of [root, ...words]) for (const x of tokens(w)) t.add(stem(x));
  return t;
}

/** Tiny suffix stemmer so "agencies"/"agency" and "moderators"/"moderation" meet. */
function stem(w: string): string {
  return w.replace(/(ies)$/, "y").replace(/(ations?|ators?|ing|ers?|s)$/, "").slice(0, 12);
}

const WEIGHTS: Record<string, number> = { AUDIENCE: 3, PROBLEM: 3, USE_CASE: 2.5, INDUSTRY: 2, FEATURE: 1.5, INTEGRATION: 1, CATEGORY: 2, DESCRIPTION: 1 };

function scoreProduct(g: ProductGraph, needTerms: Set<string>): { score: number; matches: Match[] } {
  const matches: Match[] = [];
  let score = 0;
  const consider = (kind: string, fact: string, text: string) => {
    const ft = new Set(tokens(text).map(stem));
    const hit = [...needTerms].filter((t) => t.length > 2 && ft.has(t));
    if (hit.length) {
      matches.push({ kind, fact, matchedTerms: hit });
      score += WEIGHTS[kind] * Math.min(hit.length, 3);
    }
  };
  if (g.product.category) consider("CATEGORY", g.product.category, g.product.category);
  if (g.product.shortDescription) consider("DESCRIPTION", g.product.shortDescription, g.product.shortDescription);
  for (const f of g.facets) if (f.verification !== "REJECTED") consider(f.kind, f.name, `${f.name} ${f.description ?? ""}`);
  return { score, matches };
}

function toRecommendation(g: ProductGraph, score: number, matches: Match[]): ProductRecommendation {
  const matchedFeatures = matches.filter((m) => m.kind === "FEATURE").map((m) => m.fact);
  const features = matchedFeatures.length ? matchedFeatures : facetsOf(g, "FEATURE").slice(0, 3).map((f) => f.name);
  const cta = g.product.conversionUrls[0] ?? null;
  return {
    productId: g.product.id,
    productName: g.product.name,
    score: Math.round(score * 10) / 10,
    fit: score >= 8 && matches.some((m) => ["AUDIENCE", "PROBLEM", "USE_CASE", "INDUSTRY"].includes(m.kind)) ? "STRONG" : "PARTIAL",
    why: matches.sort((a, b) => WEIGHTS[b.kind] - WEIGHTS[a.kind]).slice(0, 6),
    relevantFeatures: features,
    pricing: g.pricing
      .filter((p) => isVerified(p))
      .map((p) => `${p.planName}: ${p.priceCents === null ? "price on request" : formatMoney(p.priceCents, p.currency)}${p.interval === "MONTH" ? "/month" : p.interval === "YEAR" ? "/year" : ""}`),
    cta: cta ? { label: cta.label, url: cta.url } : null,
  };
}

/**
 * Explainable product recommendation from structured product data. A product
 * is only recommended when its facts match the stated need above a threshold;
 * ownership never boosts a score. When nothing fits, the result says so.
 */
export function recommendProducts(need: string, graphs: ProductGraph[], opts: { minScore?: number; complementaryPairs?: Set<string> } = {}): RecommendationResult {
  const minScore = opts.minScore ?? 4;
  const needTerms = expand(need);
  const scored = graphs
    .filter((g) => g.product.status !== "DEPRECATED")
    .map((g) => ({ g, ...scoreProduct(g, needTerms) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);
  if (!scored.length)
    return {
      primary: null,
      complementary: [],
      considered: graphs.length,
      extractedNeeds: [...needTerms].slice(0, 20),
      explanation: "No product's documented audiences, problems, use cases or features match this need closely enough to recommend it.",
    };
  const [top, ...rest] = scored;
  const complementary = rest
    .filter((x) => x.score >= minScore && (!opts.complementaryPairs || opts.complementaryPairs.has(`${top.g.product.id}:${x.g.product.id}`) || x.score >= top.score * 0.6))
    .slice(0, 2)
    .map((x) => toRecommendation(x.g, x.score, x.matches));
  const primary = toRecommendation(top.g, top.score, top.matches);
  return {
    primary,
    complementary,
    considered: graphs.length,
    extractedNeeds: [...needTerms].slice(0, 20),
    explanation: `${primary.productName} matches on ${primary.why.map((w) => `${w.kind.toLowerCase().replace("_", " ")} "${w.fact}"`).join(", ")}.`,
  };
}
