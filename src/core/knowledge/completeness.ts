import { facetsOf, isVerified, type ProductGraph } from "./types";

export type CompletenessItem = {
  key: string;
  label: string;
  weight: number;
  earned: number;
  status: "complete" | "partial" | "missing";
  hint: string;
};

export type Completeness = { score: number; items: CompletenessItem[]; missing: CompletenessItem[] };

/**
 * Entity completeness of the knowledge graph (0..1). Each item's weight is
 * explicit so the UI can show exactly which facts are missing.
 */
export function computeCompleteness(g: ProductGraph): Completeness {
  const p = g.product;
  const items: CompletenessItem[] = [];
  const add = (key: string, label: string, weight: number, ratio: number, hint: string) =>
    items.push({ key, label, weight, earned: weight * Math.max(0, Math.min(1, ratio)), status: ratio >= 1 ? "complete" : ratio > 0 ? "partial" : "missing", hint });

  const has = (v: unknown) => (typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined);
  const countRatio = (n: number, target: number) => Math.min(1, n / target);
  const verifiedRatio = (xs: { verification: string }[]) => (xs.length ? xs.filter(isVerified).length / xs.length : 0);

  add("identity", "Name, domain & category", 8, [has(p.name), has(p.domain), has(p.category)].filter(Boolean).length / 3, "Set the canonical domain and category.");
  add("short_description", "Short description", 6, has(p.shortDescription) ? 1 : 0, "One precise sentence: what it is and who it is for.");
  add("full_description", "Full description", 6, has(p.fullDescription) ? (p.fullDescription!.length >= 280 ? 1 : 0.5) : 0, "At least a paragraph describing the product.");
  add("how_it_works", "How it works", 5, has(p.howItWorks) ? 1 : 0, "Explain the mechanism: this powers GEO 'HOW' answers.");
  add("status", "Product status & release", 3, (p.status !== "UNKNOWN" ? 0.6 : 0) + (p.releaseDate ? 0.4 : 0), "Set lifecycle status and release date.");
  add("audiences", "Target audiences", 8, countRatio(facetsOf(g, "AUDIENCE").length, 2), "Add at least two concrete audiences.");
  add("problems", "Problems solved", 8, countRatio(facetsOf(g, "PROBLEM").length, 3), "Add at least three problems the product solves.");
  add("features", "Features", 10, countRatio(facetsOf(g, "FEATURE").length, 5), "Add at least five features with descriptions.");
  add("use_cases", "Use cases", 6, countRatio(facetsOf(g, "USE_CASE").length, 3), "Add at least three use cases.");
  add("industries", "Industries", 3, countRatio(facetsOf(g, "INDUSTRY").length, 1), "Add the industries served.");
  add("differentiators", "Differentiators", 5, countRatio(facetsOf(g, "DIFFERENTIATOR").length, 2), "Add factual differentiators backed by sources.");
  add("integrations", "Integrations", 3, facetsOf(g, "INTEGRATION").length > 0 || p.apiAvailable !== null ? 1 : 0, "List integrations or confirm there are none.");
  add("pricing", "Pricing plans", 8, g.pricing.length ? (g.pricing.some((x) => x.priceCents !== null) ? 1 : 0.5) : 0, "Add plans; mark prices as unknown if not public.");
  add("faq", "FAQ", 5, countRatio(g.faqs.length, 5), "Add at least five factual FAQ entries.");
  add("sources", "Canonical sources", 6, countRatio(g.sources.length, 3), "Link at least three canonical sources (site, docs, pricing).");
  add("verification", "Human-verified facts", 5, verifiedRatio([...g.facets, ...g.pricing, ...g.faqs]), "Review and verify facts so they can be published confidently.");
  add("languages", "Languages & countries", 2, (p.languages.length ? 0.5 : 0) + (p.supportedCountries.length ? 0.5 : 0), "Declare supported languages and countries.");
  add("conversion", "Conversion URLs", 3, p.conversionUrls.length ? 1 : 0, "Add at least one conversion URL (trial, demo, signup).");

  const total = items.reduce((s, i) => s + i.weight, 0);
  const earned = items.reduce((s, i) => s + i.earned, 0);
  return { score: earned / total, items, missing: items.filter((i) => i.status !== "complete").sort((a, b) => b.weight - b.earned - (a.weight - a.earned)) };
}
