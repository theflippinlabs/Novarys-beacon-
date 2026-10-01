import { normalizeQuery, tokens } from "@/core/util/text";

export type Intent = "INFORMATIONAL" | "COMMERCIAL" | "TRANSACTIONAL" | "NAVIGATIONAL" | "COMPARISON" | "PROBLEM" | "ALTERNATIVE";
export type FunnelStage = "AWARENESS" | "CONSIDERATION" | "DECISION" | "RETENTION";

export type Classification = { intent: Intent; confidence: number; funnelStage: FunnelStage; signals: string[] };

type Rule = { intent: Intent; weight: number; patterns: RegExp[] };

/**
 * Deterministic, explainable intent classifier. Returns the matched signals
 * so a human can see why a query was classified a certain way. There is no
 * LLM refinement: low-confidence results (fallback signal, confidence below
 * 0.5) are shown as such in the UI for a human to correct.
 */
const RULES: Rule[] = [
  { intent: "ALTERNATIVE", weight: 5, patterns: [/\balternatives?\b/, /\binstead of\b/, /\breplace(ment)? for\b/, /\bsimilar to\b/, /\blike [a-z0-9]+ but\b/] },
  { intent: "COMPARISON", weight: 5, patterns: [/\bvs\.?\b/, /\bversus\b/, /\bcompar(e|ed|ison)\b/, /\bdifference between\b/, /\bor\b.+\bwhich\b/, /\bbetter than\b/] },
  {
    intent: "TRANSACTIONAL",
    weight: 4,
    patterns: [/\bpric(e|es|ing)\b/, /\bcost(s)?\b/, /\bbuy\b/, /\bfree trial\b/, /\bsign ?up\b/, /\bdownload\b/, /\bsubscribe\b/, /\bdiscount\b/, /\bcoupon\b/, /\bdemo\b/, /\bplans?\b/],
  },
  {
    intent: "PROBLEM",
    weight: 3,
    patterns: [
      /\bhow (to|do i|can i) (stop|fix|prevent|avoid|reduce|handle|deal)\b/,
      /\b(problem|issue|error|not working|can'?t|cannot|struggl\w*|spam|abuse|toxic|risk)\b/,
      /\bwhy (is|does|do|are) .*(slow|fail|broken|wrong)/,
    ],
  },
  {
    intent: "COMMERCIAL",
    weight: 3,
    patterns: [/\bbest\b/, /\btop \d*\b/, /\b(software|tool|tools|platform|app|apps|solution|service|dashboard|system)\b/, /\breviews?\b/, /\bfor (agencies|teams|business|creators|lawyers|companies|startups)\b/],
  },
  {
    intent: "INFORMATIONAL",
    weight: 2,
    patterns: [/^(what|who|when|where|why|how)\b/, /\bguide\b/, /\btutorial\b/, /\bexplained\b/, /\bmeaning\b/, /\bexamples?\b/, /\bdefinition\b/, /\blearn\b/],
  },
];

export const INTENT_TO_FUNNEL: Record<Intent, FunnelStage> = {
  INFORMATIONAL: "AWARENESS",
  PROBLEM: "AWARENESS",
  COMMERCIAL: "CONSIDERATION",
  COMPARISON: "CONSIDERATION",
  ALTERNATIVE: "CONSIDERATION",
  TRANSACTIONAL: "DECISION",
  NAVIGATIONAL: "DECISION",
};

export function classifyQuery(query: string, brandTerms: string[] = []): Classification {
  const q = normalizeQuery(query);
  const scores = new Map<Intent, number>();
  const signals: string[] = [];

  const brands = brandTerms.map(normalizeQuery).filter(Boolean);
  const brandHit = brands.find((b) => new RegExp(`(^|\\s)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(q));
  if (brandHit) {
    const rest = tokens(q.replace(brandHit, " "), { keepStop: true });
    // A brand query with nothing (or only login/app-type words) around it is navigational.
    if (rest.length === 0 || rest.every((t) => /^(login|app|website|official|site|account|sign|in|download)$/.test(t))) {
      return { intent: "NAVIGATIONAL", confidence: 0.9, funnelStage: "DECISION", signals: [`brand:${brandHit}`] };
    }
    signals.push(`brand:${brandHit}`);
  }

  for (const rule of RULES) {
    for (const re of rule.patterns) {
      if (re.test(q)) {
        scores.set(rule.intent, (scores.get(rule.intent) ?? 0) + rule.weight);
        signals.push(`${rule.intent.toLowerCase()}:${re.source}`);
      }
    }
  }

  if (scores.size === 0) {
    // Short noun phrases ("tiktok live moderation") are usually commercial investigation for software topics.
    const intent: Intent = tokens(q).length <= 4 ? "COMMERCIAL" : "INFORMATIONAL";
    return { intent, confidence: 0.35, funnelStage: INTENT_TO_FUNNEL[intent], signals: ["fallback:no-pattern"] };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const confidence = Math.min(0.95, 0.45 + 0.5 * ((topScore - second) / total) + 0.05 * Math.min(topScore, 5) / 5);
  return { intent: top, confidence: Math.round(confidence * 100) / 100, funnelStage: INTENT_TO_FUNNEL[top], signals };
}

// ─── Branded flag and topic type ────────────────────────────────────────
export type TopicType = "FEATURE" | "INDUSTRY" | "AUDIENCE" | "USE_CASE" | "INTEGRATION" | "CATEGORY" | "BRAND" | "COMPETITOR" | "PROBLEM";
export const TOPIC_TYPES: TopicType[] = ["FEATURE", "INDUSTRY", "AUDIENCE", "USE_CASE", "INTEGRATION", "CATEGORY", "BRAND", "COMPETITOR", "PROBLEM"];

export type TopicContext = {
  /** Product name, aliases and organisation name. */
  brandTerms: string[];
  competitors: string[];
  facets: { kind: "FEATURE" | "USE_CASE" | "AUDIENCE" | "INDUSTRY" | "PROBLEM" | "INTEGRATION" | "DIFFERENTIATOR"; name: string }[];
};

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasPhrase = (q: string, phrase: string) => {
  const p = normalizeQuery(phrase);
  return p.length > 1 && new RegExp(`(^|\\s)${escRe(p)}(\\s|$)`).test(q);
};

/** The brand term contained in the query, if any (whole-word match). */
export function brandTermIn(query: string, brandTerms: string[]): string | null {
  const q = normalizeQuery(query);
  return brandTerms.map((b) => b.trim()).filter(Boolean).find((b) => hasPhrase(q, b)) ?? null;
}

const FACET_TOPIC: Record<TopicContext["facets"][number]["kind"], TopicType> = {
  FEATURE: "FEATURE",
  DIFFERENTIATOR: "FEATURE",
  USE_CASE: "USE_CASE",
  AUDIENCE: "AUDIENCE",
  INDUSTRY: "INDUSTRY",
  PROBLEM: "PROBLEM",
  INTEGRATION: "INTEGRATION",
};

/**
 * Topic type, explainable: competitor names win (the query is about the
 * competitor), then brand terms, then the knowledge-graph facet whose words
 * the query contains most completely, then wording patterns, else CATEGORY.
 */
export function classifyTopic(query: string, ctx: TopicContext, intent?: Intent): { topicType: TopicType; signals: string[] } {
  const q = normalizeQuery(query);
  const comp = ctx.competitors.find((c) => hasPhrase(q, c));
  if (comp) return { topicType: "COMPETITOR", signals: [`competitor:${normalizeQuery(comp)}`] };
  const brand = brandTermIn(q, ctx.brandTerms);
  if (brand) return { topicType: "BRAND", signals: [`brand:${normalizeQuery(brand)}`] };
  const qt = new Set(tokens(q));
  let best: { kind: TopicType; name: string; score: number } | null = null;
  for (const f of ctx.facets) {
    const ft = tokens(f.name);
    if (!ft.length) continue;
    const hit = ft.filter((t) => qt.has(t)).length;
    // Every facet word must be present (multi-word facets) or the facet is the query's main word.
    if (hit < ft.length) continue;
    if (!best || hit > best.score) best = { kind: FACET_TOPIC[f.kind], name: f.name, score: hit };
  }
  if (best) return { topicType: best.kind, signals: [`facet:${best.kind.toLowerCase()}:${normalizeQuery(best.name)}`] };
  if (/\b(integrat\w*|plugin|add-?on|connect(or|s)?\b|api\b|zapier|webhook)/.test(q)) return { topicType: "INTEGRATION", signals: ["pattern:integration"] };
  if (intent === "PROBLEM" || /\b(problem|issue|error|fix|stop|prevent|avoid|not working)\b/.test(q)) return { topicType: "PROBLEM", signals: ["pattern:problem"] };
  if (/\bfor (small business|smb|enterprise|teams?|agencies|agency|startups?|creators?|freelancers?|developers?|lawyers?|marketers?|schools?|nonprofits?)\b/.test(q)) return { topicType: "AUDIENCE", signals: ["pattern:audience"] };
  if (/\b(for|in) (healthcare|finance|banking|legal|retail|ecommerce|e-commerce|education|real estate|manufacturing|gaming|media)\b/.test(q)) return { topicType: "INDUSTRY", signals: ["pattern:industry"] };
  if (/\bhow to\b|\buse case\b|\bworkflow\b/.test(q)) return { topicType: "USE_CASE", signals: ["pattern:use-case"] };
  return { topicType: "CATEGORY", signals: ["fallback:category"] };
}

export type FullClassification = Classification & { branded: boolean; brandTerm: string | null; topicType: TopicType; topicSignals: string[] };

/** Intent, funnel, branded flag and topic type in one explainable pass. */
export function classifyQueryFull(query: string, ctx: TopicContext): FullClassification {
  const c = classifyQuery(query, ctx.brandTerms);
  const brandTerm = brandTermIn(query, ctx.brandTerms);
  const topic = classifyTopic(query, ctx, c.intent);
  return { ...c, branded: brandTerm !== null, brandTerm, topicType: topic.topicType, topicSignals: topic.signals };
}
