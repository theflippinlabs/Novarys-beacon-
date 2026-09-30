import { normalizeQuery, tokens } from "@/core/util/text";

export type Intent = "INFORMATIONAL" | "COMMERCIAL" | "TRANSACTIONAL" | "NAVIGATIONAL" | "COMPARISON" | "PROBLEM" | "ALTERNATIVE";
export type FunnelStage = "AWARENESS" | "CONSIDERATION" | "DECISION" | "RETENTION";

export type Classification = { intent: Intent; confidence: number; funnelStage: FunnelStage; signals: string[] };

type Rule = { intent: Intent; weight: number; patterns: RegExp[] };

/**
 * Deterministic, explainable intent classifier. Returns the matched signals
 * so a human can see why a query was classified a certain way. An LLM
 * provider may refine low-confidence results (see ai/tasks.ts).
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
