import { facetsOf, type ProductGraph } from "@/core/knowledge/types";
import { normalizeQuery, tokens } from "@/core/util/text";
import { brandTermIn, classifyQuery, type Intent, type TopicType } from "./classify";

/** `topicType` comes from generation provenance (which graph fact produced the query). */
export type QueryCandidate = { query: string; intent: Intent; clusterName: string; rationale: string; topicType: TopicType; branded: boolean };

/**
 * Builds a structured query universe from the knowledge graph. Every
 * candidate is derived from a fact in the graph (category, audience, problem,
 * feature, integration, competitor), never from invented claims, and
 * candidates are de-duplicated on their token sets so long-tail variations
 * do not collapse into spam.
 */
export function expandQueryUniverse(g: ProductGraph, opts: { max?: number; seedTopics?: string[] } = {}): QueryCandidate[] {
  const max = opts.max ?? 150;
  const p = g.product;
  const category = p.category?.trim();
  const topics = [...new Set([...(opts.seedTopics ?? []), ...(category ? [category] : []), ...p.keywords].map((t) => t.trim()).filter(Boolean))];
  const audiences = facetsOf(g, "AUDIENCE").map((f) => f.name);
  const industries = facetsOf(g, "INDUSTRY").map((f) => f.name);
  const problems = facetsOf(g, "PROBLEM").map((f) => f.name);
  const features = facetsOf(g, "FEATURE").map((f) => f.name);
  const integrations = facetsOf(g, "INTEGRATION").map((f) => f.name);
  const useCases = facetsOf(g, "USE_CASE").map((f) => f.name);
  const competitors = g.competitors.map((c) => c.competitor.name);

  const out: QueryCandidate[] = [];
  const seen = new Set<string>();
  const push = (query: string, clusterName: string, rationale: string, topicType: TopicType) => {
    const norm = normalizeQuery(query);
    const key = [...new Set(tokens(norm, { keepStop: true }))].sort().join(" ");
    if (!key || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ query: norm, intent: classifyQuery(norm, [p.name]).intent, clusterName, rationale, topicType, branded: brandTermIn(norm, [p.name]) !== null });
  };

  // Brand / navigational & transactional
  push(p.name, "Brand", "Product name", "BRAND");
  push(`what is ${p.name}`, "Brand", "Entity definition question", "BRAND");
  if (g.pricing.length) push(`${p.name} pricing`, "Brand", "Pricing plans exist in the graph", "BRAND");
  for (const c of competitors) {
    push(`${p.name} vs ${c}`, "Comparisons", `Competitor ${c} is linked to the product`, "COMPETITOR");
    push(`${c} alternatives`, "Alternatives", `Competitor ${c} is linked to the product`, "COMPETITOR");
  }

  for (const topic of topics) {
    push(topic, topic, "Category / declared keyword", "CATEGORY");
    push(`${topic} software`, topic, "Category / declared keyword", "CATEGORY");
    push(`best ${topic} tools`, topic, "Category / declared keyword", "CATEGORY");
    for (const a of audiences) push(`${topic} for ${a}`, `${topic} for audiences`, `Audience "${a}" in the graph`, "AUDIENCE");
    for (const i of industries) push(`${topic} for ${i}`, `${topic} by industry`, `Industry "${i}" in the graph`, "INDUSTRY");
    for (const integ of integrations) push(`${topic} ${integ} integration`, "Integrations", `Integration "${integ}" in the graph`, "INTEGRATION");
  }
  for (const pr of problems) {
    const howTo = problemHowTo(pr);
    if (howTo) push(howTo, "Problems", `Problem "${pr}" in the graph`, "PROBLEM");
    push(pr, "Problems", `Problem "${pr}" in the graph`, "PROBLEM");
  }
  for (const f of features) push(category ? `${category} ${f}` : f, "Features", `Feature "${f}" in the graph`, "FEATURE");
  for (const u of useCases) push(u, "Use cases", `Use case "${u}" in the graph`, "USE_CASE");

  return out;
}

/** Verbs that read naturally after "how to" when a problem is stated as an action ("stop spam in live chat"). */
const ACTION_VERBS = new Set(
  "stop prevent fix reduce avoid remove block detect moderate manage filter handle protect keep find track automate scale hide limit cut save increase improve grow get make run measure monitor respond deal choose".split(" "),
);
/** Words that make a problem statement a clause rather than a noun phrase ("moderation is inconsistent"). */
const CLAUSE_WORDS = new Set(
  "is are was were be been being am isn't aren't wasn't weren't can can't cannot could couldn't will won't would wouldn't should shouldn't do does did don't doesn't didn't has have had hasn't haven't gets get got takes take lacks lack needs need fails fail breaks crashes lags happens occurs floods overwhelms disrupts ruins slows hurts costs misses ignores drowns becomes stays goes keeps makes".split(" "),
);
const PREPOSITIONS = new Set("in on of for with from at to by during across without about over under between into".split(" "));
/** Non-final words ending in "s" that are not verbs or plural subjects ("sales team", "analytics dashboard"). */
const S_MODIFIERS = /(ss|us|is|ics|'s|news|sales|series|ops)$/;

/**
 * The "how to" query of a problem stated in the knowledge graph, or null when
 * no grammatical phrasing exists. An action ("stop spam in live chat") gets
 * "how to …", a noun phrase ("spam in TikTok live chat") gets
 * "how to deal with …", and a sentence ("spam floods live chat",
 * "moderation is inconsistent") gets none: the statement itself is the query.
 * It only rephrases the graph's own words, never adds a claim.
 */
export function problemHowTo(problem: string): string | null {
  const text = problem.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!text) return null;
  if (/^how to\s/i.test(text)) return text;
  const words = text.toLowerCase().split(" ");
  if (ACTION_VERBS.has(words[0])) return `how to ${words[0]}${text.slice(words[0].length)}`;
  if (words.some((w) => CLAUSE_WORDS.has(w))) return null;
  // A clause hides a verb or a plural subject before its object ("spam floods live chat", "moderators miss messages").
  for (let i = 0; i < words.length - 1; i++) if (/s$/.test(words[i]) && !S_MODIFIERS.test(words[i]) && !PREPOSITIONS.has(words[i + 1])) return null;
  return `how to deal with ${text}`;
}
