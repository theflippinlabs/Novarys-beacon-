import { facetsOf, type Facet, type ProductGraph } from "@/core/knowledge/types";
import { pagePath, type PageType } from "./urls";

export type FactRef = { ref: string; text: string; verification: "VERIFIED" | "UNVERIFIED" | "NEEDS_REVIEW" | "REJECTED"; sourceUrl?: string };

export type PagePlan = {
  type: PageType;
  path: string;
  title: string;
  facetId?: string;
  competitorId?: string;
  /** Facts this page would be built from (used for completeness, confidence and duplicate checks). */
  facts: FactRef[];
  requirements: { label: string; met: boolean }[];
};

export type SkippedPlan = { type: PageType; item: string; reason: string };

const sourceUrl = (g: ProductGraph, id: string | null) => (id ? g.sources.find((s) => s.id === id)?.url : undefined);

function facetFact(g: ProductGraph, f: Facet): FactRef {
  return { ref: `facet:${f.id}`, text: `${f.name}. ${f.description ?? ""}`.trim(), verification: f.verification, sourceUrl: sourceUrl(g, f.sourceId) };
}

function coreFacts(g: ProductGraph): FactRef[] {
  const p = g.product;
  const facts: FactRef[] = [];
  if (p.shortDescription) facts.push({ ref: "product:short_description", text: p.shortDescription, verification: p.lastVerifiedAt ? "VERIFIED" : "UNVERIFIED", sourceUrl: p.domain ? `https://${p.domain}` : undefined });
  if (p.fullDescription) facts.push({ ref: "product:full_description", text: p.fullDescription, verification: p.lastVerifiedAt ? "VERIFIED" : "UNVERIFIED", sourceUrl: p.domain ? `https://${p.domain}` : undefined });
  return facts;
}

const MIN_DESC = 60;

/**
 * Plans the discovery page set for a product. A page is only planned when the
 * graph holds enough factual material for it; otherwise it is reported as
 * skipped with the reason, so gaps are visible instead of papered over with
 * thin content.
 */
export function planPages(g: ProductGraph): { planned: PagePlan[]; skipped: SkippedPlan[] } {
  const p = g.product;
  const planned: PagePlan[] = [];
  const skipped: SkippedPlan[] = [];
  const features = facetsOf(g, "FEATURE");
  const problems = facetsOf(g, "PROBLEM");
  const audiences = facetsOf(g, "AUDIENCE");

  // Product page
  planned.push({
    type: "PRODUCT",
    path: pagePath("PRODUCT", p.slug),
    title: p.shortDescription ? `${p.name} — ${p.shortDescription}` : p.name,
    facts: [...coreFacts(g), ...features.slice(0, 8).map((f) => facetFact(g, f)), ...audiences.map((f) => facetFact(g, f))],
    requirements: [
      { label: "Short description", met: Boolean(p.shortDescription) },
      { label: "Full description", met: Boolean(p.fullDescription) },
      { label: "≥ 3 features", met: features.length >= 3 },
      { label: "≥ 1 audience", met: audiences.length >= 1 },
      { label: "≥ 1 canonical source", met: g.sources.length >= 1 },
    ],
  });

  const facetPages: [PageType, Facet[]][] = [
    ["FEATURE", features],
    ["USE_CASE", facetsOf(g, "USE_CASE")],
    ["INDUSTRY", facetsOf(g, "INDUSTRY")],
    ["AUDIENCE", audiences],
    ["INTEGRATION", facetsOf(g, "INTEGRATION")],
  ];
  for (const [type, list] of facetPages) {
    for (const f of list) {
      const descOk = (f.description?.length ?? 0) >= MIN_DESC;
      if (!descOk) {
        skipped.push({ type, item: f.name, reason: `Description shorter than ${MIN_DESC} characters — not enough material for a standalone page.` });
        continue;
      }
      const supporting = type === "FEATURE" || type === "INTEGRATION" ? [] : [...features.slice(0, 4), ...problems.slice(0, 3)].map((x) => facetFact(g, x));
      planned.push({
        type,
        path: pagePath(type, p.slug, f.slug),
        title: titleFor(type, p.name, f.name),
        facetId: f.id,
        facts: [facetFact(g, f), ...coreFacts(g).slice(0, 1), ...supporting],
        requirements: [
          { label: "Facet description ≥ 60 chars", met: descOk },
          { label: "Facet linked to a source", met: Boolean(f.sourceId) },
          ...(type === "FEATURE" || type === "INTEGRATION" ? [] : [{ label: "≥ 2 features & ≥ 1 problem for context", met: features.length >= 2 && problems.length >= 1 }]),
        ],
      });
    }
  }

  for (const pc of g.competitors) {
    const sourced = pc.comparisonFacts.filter((c) => c.sourceUrl);
    const facts: FactRef[] = sourced.map((c, i) => ({
      ref: `comparison:${pc.competitorId}:${i}`,
      text: `${c.dimension}: ${c.product} / ${c.competitor}`,
      verification: c.verifiedAt ? "VERIFIED" : "UNVERIFIED",
      sourceUrl: c.sourceUrl,
    }));
    if (sourced.length >= 3) {
      planned.push({
        type: "COMPARISON",
        path: pagePath("COMPARISON", p.slug, pc.competitor.slug),
        title: `${p.name} vs ${pc.competitor.name}`,
        competitorId: pc.competitorId,
        facts: [...coreFacts(g).slice(0, 1), ...facts],
        requirements: [{ label: "≥ 3 sourced comparison facts", met: true }],
      });
    } else {
      skipped.push({ type: "COMPARISON", item: pc.competitor.name, reason: `Only ${sourced.length} sourced comparison facts (3 required). Comparisons must never rely on unsourced competitor claims.` });
    }
    if (sourced.length >= 2 && p.shortDescription) {
      planned.push({
        type: "ALTERNATIVE",
        path: pagePath("ALTERNATIVE", p.slug, pc.competitor.slug),
        title: `${pc.competitor.name} alternatives: ${p.name}`,
        competitorId: pc.competitorId,
        facts: [...coreFacts(g), ...facts],
        requirements: [{ label: "≥ 2 sourced comparison facts & product description", met: true }],
      });
    }
  }

  for (const faq of g.faqs) {
    if (faq.verification === "REJECTED") continue;
    if (faq.answer.length < 40) {
      skipped.push({ type: "ANSWER", item: faq.question, reason: "Answer shorter than 40 characters." });
      continue;
    }
    planned.push({
      type: "ANSWER",
      path: pagePath("ANSWER", p.slug, faq.question),
      title: faq.question,
      facts: [{ ref: `faq:${faq.id}`, text: `${faq.question} ${faq.answer}`, verification: faq.verification, sourceUrl: sourceUrl(g, faq.sourceId) }],
      requirements: [{ label: "Answer linked to a source", met: Boolean(faq.sourceId) }],
    });
  }

  if (g.changelog.length) {
    planned.push({
      type: "CHANGELOG",
      path: pagePath("CHANGELOG", p.slug),
      title: `${p.name} changelog`,
      facts: g.changelog.slice(0, 20).map((c) => ({ ref: `changelog:${c.id}`, text: `${c.releasedOn} ${c.title} ${c.body ?? ""}`, verification: "VERIFIED" as const, sourceUrl: sourceUrl(g, c.sourceId) })),
      requirements: [{ label: "≥ 1 changelog entry", met: true }],
    });
  }

  return { planned, skipped };
}

function titleFor(type: PageType, product: string, item: string): string {
  switch (type) {
    case "FEATURE":
      return `${item} — ${product}`;
    case "USE_CASE":
      return `${product} for ${item.charAt(0).toLowerCase()}${item.slice(1)}`;
    case "INDUSTRY":
      return `${product} for the ${item} industry`;
    case "AUDIENCE":
      return `${product} for ${item}`;
    case "INTEGRATION":
      return `${product} + ${item} integration`;
    default:
      return `${product}: ${item}`;
  }
}
