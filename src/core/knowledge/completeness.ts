import type { Verification } from "./confidence";
import { isFailingSource } from "./confidence";
import { claimVerification, facetsOf, type ProductGraph } from "./types";
import { claimValue, type ClaimField } from "./provenance";

/**
 * Entity completeness of the knowledge graph, per section.
 *
 * - Each section (identity, features, pricing, use cases, proof,
 *   documentation) has a weight (SECTION_WEIGHTS, sum 100) and items with
 *   relative weights inside the section.
 * - A fact earns credit by verification: VERIFIED counts fully, UNVERIFIED and
 *   NEEDS_REVIEW count half, OUTDATED, CONFLICTING and REJECTED count zero
 *   (VERIFICATION_CREDIT).
 * - An item's ratio is its credited facts over its target (e.g. 5 features),
 *   capped at 1. A section's percentage is its earned points over its weight.
 * - Overall = sum of section earned points / 100, i.e. the weighted average of
 *   the section percentages with SECTION_WEIGHTS.
 */
export const VERIFICATION_CREDIT: Record<Verification, number> = { VERIFIED: 1, UNVERIFIED: 0.5, NEEDS_REVIEW: 0.5, OUTDATED: 0, CONFLICTING: 0, REJECTED: 0 };

export const SECTION_WEIGHTS = { identity: 30, features: 20, pricing: 15, use_cases: 10, proof: 10, documentation: 15 } as const;
export type SectionKey = keyof typeof SECTION_WEIGHTS;
export const SECTION_LABELS: Record<SectionKey, string> = { identity: "Identity", features: "Features", pricing: "Pricing", use_cases: "Use cases", proof: "Proof", documentation: "Documentation" };

export type CompletenessItem = {
  key: string;
  label: string;
  section: SectionKey;
  /** Points this item is worth in the overall 0..100 scale. */
  weight: number;
  earned: number;
  status: "complete" | "partial" | "missing";
  hint: string;
  /** All contributing facts are VERIFIED (null: no verification applies, e.g. conversion URLs). */
  verified: boolean | null;
  facts: number;
  verifiedFacts: number;
};

export type CompletenessSection = { key: SectionKey; label: string; weight: number; earned: number; max: number; pct: number; verifiedRatio: number | null; items: CompletenessItem[] };

export type Completeness = { score: number; sections: CompletenessSection[]; items: CompletenessItem[]; missing: CompletenessItem[] };

type Draft = { key: string; label: string; section: SectionKey; w: number; ratio: number; hint: string; statuses: Verification[] | null };

const credit = (xs: Verification[]) => xs.reduce((s, v) => s + VERIFICATION_CREDIT[v], 0);
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function computeCompleteness(g: ProductGraph): Completeness {
  const p = g.product;
  const drafts: Draft[] = [];
  const add = (section: SectionKey, key: string, label: string, w: number, ratio: number, hint: string, statuses: Verification[] | null) => drafts.push({ section, key, label, w, ratio: clamp(ratio), hint, statuses });

  /** Statuses of the present scalar fields. */
  const present = (...fields: ClaimField[]) => fields.filter((f) => claimPresent(g, f)).map((f) => claimVerification(g, f));
  const scalar = (f: ClaimField) => (claimPresent(g, f) ? VERIFICATION_CREDIT[claimVerification(g, f)] : 0);
  const listOf = <T extends { verification: Verification }>(xs: T[]) => xs.filter((x) => x.verification !== "REJECTED");
  const listRatio = (xs: { verification: Verification }[], target: number) => credit(xs.map((x) => x.verification)) / target;
  const statusesOf = (xs: { verification: Verification }[]) => xs.map((x) => x.verification);

  // Identity
  add("identity", "identity", "Name, domain & category", 6, (1 + scalar("domain") + scalar("category")) / 3, "Set the canonical domain and category.", present("domain", "category"));
  add("identity", "short_description", "Short description", 5, scalar("short_description"), "One precise sentence: what it is and who it is for.", present("short_description"));
  add("identity", "full_description", "Full description", 5, scalar("full_description") * ((p.fullDescription?.length ?? 0) >= 280 ? 1 : 0.5), "At least a paragraph describing the product.", present("full_description"));
  add("identity", "how_it_works", "How it works", 4, scalar("how_it_works"), "Explain the mechanism: this powers GEO 'HOW' answers.", present("how_it_works"));
  add("identity", "status", "Product status & release", 3, 0.6 * scalar("status") + 0.4 * scalar("release_date"), "Set lifecycle status and release date.", present("status", "release_date"));
  add("identity", "languages", "Languages & countries", 2, 0.5 * scalar("languages") + 0.5 * scalar("supported_countries"), "Declare supported languages and countries.", present("languages", "supported_countries"));
  const audiences = listOf(facetsOf(g, "AUDIENCE"));
  const problems = listOf(facetsOf(g, "PROBLEM"));
  add("identity", "audiences", "Target audiences", 4, listRatio(audiences, 2), "Add at least two concrete audiences.", statusesOf(audiences));
  add("identity", "problems", "Problems solved", 4, listRatio(problems, 3), "Add at least three problems the product solves.", statusesOf(problems));

  // Features
  const features = listOf(facetsOf(g, "FEATURE"));
  const integrations = listOf(facetsOf(g, "INTEGRATION"));
  const diffs = listOf(facetsOf(g, "DIFFERENTIATOR"));
  add("features", "features", "Features", 10, listRatio(features, 5), "Add at least five features with descriptions.", statusesOf(features));
  add(
    "features",
    "integrations",
    "Integrations",
    4,
    integrations.length ? listRatio(integrations, 1) : scalar("api_available"),
    "List integrations or confirm there are none.",
    integrations.length ? statusesOf(integrations) : present("api_available"),
  );
  add("features", "differentiators", "Differentiators", 6, listRatio(diffs, 2), "Add factual differentiators backed by sources.", statusesOf(diffs));

  // Pricing
  const plans = g.pricing.filter((x) => x.verification !== "REJECTED");
  const planRatio = plans.length ? plans.reduce((s, x) => s + VERIFICATION_CREDIT[x.verification] * (x.priceCents !== null && x.currency && x.interval ? 1 : 0.5), 0) / plans.length : 0;
  add("pricing", "pricing", "Pricing plans", 8, planRatio, "Add plans with price, currency and billing interval; mark prices as unknown if not public.", statusesOf(plans));
  add("pricing", "free_trial", "Free trial known", 2, scalar("free_trial"), "Say whether a free trial exists.", present("free_trial"));
  add("pricing", "pricing_url", "Pricing page", 2, scalar("pricing_url"), "Add the public pricing page URL.", present("pricing_url"));
  add("pricing", "conversion", "Conversion URLs", 3, p.conversionUrls.length ? 1 : 0, "Add at least one conversion URL (trial, demo, signup).", null);

  // Use cases
  const useCases = listOf(facetsOf(g, "USE_CASE"));
  const industries = listOf(facetsOf(g, "INDUSTRY"));
  add("use_cases", "use_cases", "Use cases", 6, listRatio(useCases, 3), "Add at least three use cases.", statusesOf(useCases));
  add("use_cases", "industries", "Industries", 3, listRatio(industries, 1), "Add the industries served.", statusesOf(industries));

  // Proof
  const proofs = g.proofs.filter((x) => x.verification !== "REJECTED");
  add("proof", "proofs", "Proof (testimonials, case studies, metrics)", 6, listRatio(proofs, 2), "Add verified proof with permission to publish.", statusesOf(proofs));
  if (g.competitors.length) {
    const facts = g.competitors.flatMap((c) => c.comparisonFacts.filter((f) => f.sourceUrl)).map((f): Verification => (f.verifiedAt ? "VERIFIED" : "UNVERIFIED"));
    add("proof", "comparisons", "Sourced comparison facts", 4, credit(facts) / 3, "Add at least three sourced comparison facts.", facts);
  }

  // Documentation
  const liveSources = g.sources.filter((s) => !isFailingSource(s));
  add("documentation", "sources", "Canonical sources", 5, liveSources.length / 3, "Link at least three reachable canonical sources (site, docs, pricing).", null);
  add("documentation", "documentation_url", "Documentation URL", 3, scalar("documentation_url"), "Add the documentation URL.", present("documentation_url"));
  const faqs = g.faqs.filter((x) => x.verification !== "REJECTED" && !(x.suggestedFrom && !x.answer.trim()));
  add("documentation", "faq", "FAQ", 5, listRatio(faqs, 5), "Add at least five factual FAQ entries.", statusesOf(faqs));
  const changelog = g.changelog.filter((x) => x.verification !== "REJECTED");
  add("documentation", "changelog", "Changelog", 2, listRatio(changelog, 1), "Record at least one release with a source.", statusesOf(changelog));

  const sections: CompletenessSection[] = [];
  const items: CompletenessItem[] = [];
  for (const key of Object.keys(SECTION_WEIGHTS) as SectionKey[]) {
    const ds = drafts.filter((d) => d.section === key);
    const wsum = ds.reduce((s, d) => s + d.w, 0);
    const weight = SECTION_WEIGHTS[key];
    const its = ds.map((d): CompletenessItem => {
      const w = (weight * d.w) / wsum;
      const facts = d.statuses?.length ?? 0;
      const verifiedFacts = d.statuses?.filter((v) => v === "VERIFIED").length ?? 0;
      return {
        key: d.key,
        label: d.label,
        section: key,
        weight: w,
        earned: w * d.ratio,
        status: d.ratio >= 0.999 ? "complete" : d.ratio > 0 ? "partial" : "missing",
        hint: d.hint,
        verified: d.statuses === null ? null : facts > 0 && verifiedFacts === facts,
        facts,
        verifiedFacts,
      };
    });
    const earned = its.reduce((s, i) => s + i.earned, 0);
    const facts = its.reduce((s, i) => s + i.facts, 0);
    sections.push({ key, label: SECTION_LABELS[key], weight, earned, max: weight, pct: earned / weight, verifiedRatio: facts ? its.reduce((s, i) => s + i.verifiedFacts, 0) / facts : null, items: its });
    items.push(...its);
  }
  const total = sections.reduce((s, x) => s + x.max, 0);
  const earned = sections.reduce((s, x) => s + x.earned, 0);
  return { score: earned / total, sections, items, missing: items.filter((i) => i.status !== "complete").sort((a, b) => b.weight - b.earned - (a.weight - a.earned)) };
}

function claimPresent(g: ProductGraph, f: ClaimField): boolean {
  return claimValue(g.product, f) !== null;
}
