import { facetsOf, type ProductGraph } from "@/core/knowledge/types";
import { normalizeQuery, tokens } from "@/core/util/text";
import { classifyQuery, type Intent } from "./classify";

export type QueryCandidate = { query: string; intent: Intent; clusterName: string; rationale: string };

/**
 * Builds a structured query universe from the knowledge graph. Every
 * candidate is derived from a fact in the graph (category, audience, problem,
 * feature, integration, competitor) — never from invented claims — and
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
  const push = (query: string, clusterName: string, rationale: string) => {
    const norm = normalizeQuery(query);
    const key = [...new Set(tokens(norm, { keepStop: true }))].sort().join(" ");
    if (!key || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ query: norm, intent: classifyQuery(norm, [p.name]).intent, clusterName, rationale });
  };

  // Brand / navigational & transactional
  push(p.name, "Brand", "Product name");
  push(`what is ${p.name}`, "Brand", "Entity definition question");
  if (g.pricing.length) push(`${p.name} pricing`, "Brand", "Pricing plans exist in the graph");
  for (const c of competitors) {
    push(`${p.name} vs ${c}`, "Comparisons", `Competitor ${c} is linked to the product`);
    push(`${c} alternatives`, "Alternatives", `Competitor ${c} is linked to the product`);
  }

  for (const topic of topics) {
    push(topic, topic, "Category / declared keyword");
    push(`${topic} software`, topic, "Category / declared keyword");
    push(`best ${topic} tools`, topic, "Category / declared keyword");
    for (const a of audiences) push(`${topic} for ${a}`, `${topic} for audiences`, `Audience "${a}" in the graph`);
    for (const i of industries) push(`${topic} for ${i}`, `${topic} by industry`, `Industry "${i}" in the graph`);
    for (const integ of integrations) push(`${topic} ${integ} integration`, "Integrations", `Integration "${integ}" in the graph`);
  }
  for (const pr of problems) {
    push(`how to ${pr.replace(/^(how to\s+)/i, "")}`, "Problems", `Problem "${pr}" in the graph`);
    push(pr, "Problems", `Problem "${pr}" in the graph`);
  }
  for (const f of features) push(category ? `${category} ${f}` : f, "Features", `Feature "${f}" in the graph`);
  for (const u of useCases) push(u, "Use cases", `Use case "${u}" in the graph`);

  return out;
}
