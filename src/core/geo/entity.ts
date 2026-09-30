import { facetsOf, isVerified, type ProductGraph } from "@/core/knowledge/types";
import { formatMoney } from "@/core/util/text";

/**
 * GEO / AEO knowledge layer. Produces a machine-readable entity profile and
 * concise, citation-ready answer blocks. Everything is derived from the
 * knowledge graph; each claim carries the canonical URL that supports it,
 * and anything unknown is listed explicitly under `unknowns` rather than
 * guessed.
 */
export type SourcedClaim = { text: string; sources: string[]; verified: boolean };

export type EntityProfile = {
  schema: "beacon.entity/v1";
  who: { organization: string; product: string; url: string | null; sameAs: string[] };
  what: { summary: SourcedClaim | null; description: SourcedClaim | null; category: string | null; status: string };
  whoFor: { audiences: SourcedClaim[]; industries: SourcedClaim[] };
  problem: SourcedClaim[];
  how: SourcedClaim | null;
  features: SourcedClaim[];
  integrations: SourcedClaim[];
  proof: (SourcedClaim & { kind: string; attribution: string | null })[];
  price: { plan: string; price: string | null; interval: string; trialDays: number | null; sources: string[]; verified: boolean }[];
  differentiation: SourcedClaim[];
  languages: string[];
  countries: string[];
  sources: { title: string; url: string; kind: string }[];
  lastVerified: string | null;
  unknowns: string[];
};

export type AnswerBlock = { id: string; question: string; answer: string; sources: string[]; confidence: number; basedOn: string[] };

const productUrl = (g: ProductGraph) => (g.product.domain ? `https://${g.product.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : null);

function sourcesFor(g: ProductGraph, sourceId: string | null | undefined): string[] {
  const s = sourceId ? g.sources.find((x) => x.id === sourceId) : undefined;
  if (s) return [s.url];
  const home = productUrl(g);
  return home ? [home] : [];
}

export function buildEntityProfile(g: ProductGraph, orgName: string): EntityProfile {
  const p = g.product;
  const home = productUrl(g);
  const homeSources = home ? [home] : [];
  const verifiedProduct = Boolean(p.lastVerifiedAt);
  const facetClaims = (kind: Parameters<typeof facetsOf>[1]) =>
    facetsOf(g, kind).map((f) => ({ text: f.description ? `${f.name}: ${f.description}` : f.name, sources: sourcesFor(g, f.sourceId), verified: isVerified(f) }));

  const unknowns: string[] = [];
  if (!p.shortDescription) unknowns.push("summary");
  if (!p.howItWorks) unknowns.push("how it works");
  if (!p.category) unknowns.push("category");
  if (!g.pricing.length) unknowns.push("pricing");
  if (!facetsOf(g, "AUDIENCE").length) unknowns.push("target audiences");
  if (!facetsOf(g, "PROBLEM").length) unknowns.push("problems solved");
  if (p.apiAvailable === null) unknowns.push("API availability");
  if (p.freeTrial === null) unknowns.push("free trial");
  if (!p.languages.length) unknowns.push("languages");

  return {
    schema: "beacon.entity/v1",
    who: { organization: orgName, product: p.name, url: home, sameAs: p.socialAccounts.map((s) => s.url) },
    what: {
      summary: p.shortDescription ? { text: p.shortDescription, sources: homeSources, verified: verifiedProduct } : null,
      description: p.fullDescription ? { text: p.fullDescription, sources: homeSources, verified: verifiedProduct } : null,
      category: p.category,
      status: p.status,
    },
    whoFor: { audiences: facetClaims("AUDIENCE"), industries: facetClaims("INDUSTRY") },
    problem: facetClaims("PROBLEM"),
    how: p.howItWorks ? { text: p.howItWorks, sources: p.documentationUrl ? [p.documentationUrl] : homeSources, verified: verifiedProduct } : null,
    features: facetClaims("FEATURE"),
    integrations: facetClaims("INTEGRATION"),
    proof: g.proofs
      .filter((pr) => pr.publishable && isVerified(pr))
      .map((pr) => ({ kind: pr.kind, text: `${pr.title}: ${pr.content}`, attribution: pr.attribution, sources: sourcesFor(g, pr.sourceId), verified: true })),
    price: g.pricing.map((pl) => ({
      plan: pl.planName,
      price: pl.priceCents === null ? null : formatMoney(pl.priceCents, pl.currency),
      interval: pl.interval,
      trialDays: pl.trialDays,
      sources: pl.sourceId ? sourcesFor(g, pl.sourceId) : p.pricingUrl ? [p.pricingUrl] : homeSources,
      verified: isVerified(pl),
    })),
    differentiation: facetClaims("DIFFERENTIATOR"),
    languages: p.languages,
    countries: p.supportedCountries,
    sources: g.sources.map((s) => ({ title: s.title, url: s.url, kind: s.kind })),
    lastVerified: p.lastVerifiedAt?.toISOString() ?? null,
    unknowns,
  };
}

function listSentence(items: string[], max = 5): string {
  const xs = items.slice(0, max);
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Concise factual answers for common questions. Questions without enough facts are returned as gaps. */
export function buildAnswerBlocks(g: ProductGraph): { answers: AnswerBlock[]; gaps: string[] } {
  const p = g.product;
  const answers: AnswerBlock[] = [];
  const gaps: string[] = [];
  const home = productUrl(g);
  const conf = (verified: boolean) => (verified ? 0.9 : 0.6);

  if (p.shortDescription) {
    answers.push({
      id: "what-is",
      question: `What is ${p.name}?`,
      answer: `${p.name} is ${p.category ? `a ${p.category.toLowerCase()} product` : "a product"}${p.shortDescription ? `: ${p.shortDescription.replace(/\.$/, "")}.` : "."}`,
      sources: home ? [home] : [],
      confidence: conf(Boolean(p.lastVerifiedAt)),
      basedOn: ["product.short_description", "product.category"],
    });
  } else gaps.push(`What is ${p.name}? — needs a short description`);

  const audiences = facetsOf(g, "AUDIENCE");
  if (audiences.length) {
    answers.push({
      id: "who-for",
      question: `Who is ${p.name} for?`,
      answer: `${p.name} is designed for ${listSentence(audiences.map((a) => a.name.toLowerCase()))}.`,
      sources: [...new Set(audiences.flatMap((a) => sourcesFor(g, a.sourceId)))],
      confidence: conf(audiences.every(isVerified)),
      basedOn: audiences.map((a) => `facet:${a.id}`),
    });
    for (const a of audiences)
      answers.push({
        id: `supports-${a.slug}`,
        question: `Does ${p.name} support ${a.name.toLowerCase()}?`,
        answer: `Yes. ${p.name} lists ${a.name.toLowerCase()} as a target audience.${a.description ? ` ${a.description}` : ""}`,
        sources: sourcesFor(g, a.sourceId),
        confidence: conf(isVerified(a)),
        basedOn: [`facet:${a.id}`],
      });
  } else gaps.push(`Who is ${p.name} for? — needs target audiences`);

  const features = facetsOf(g, "FEATURE");
  const problems = facetsOf(g, "PROBLEM");
  if (features.length || problems.length) {
    const parts: string[] = [];
    if (problems.length) parts.push(`It helps with ${listSentence(problems.map((x) => x.name.toLowerCase()))}.`);
    if (features.length) parts.push(`Key capabilities include ${listSentence(features.map((x) => x.name.toLowerCase()))}.`);
    answers.push({
      id: "what-does",
      question: `What does ${p.name} do?`,
      answer: parts.join(" "),
      sources: [...new Set([...features, ...problems].flatMap((f) => sourcesFor(g, f.sourceId)))],
      confidence: conf([...features, ...problems].every(isVerified)),
      basedOn: [...features, ...problems].map((f) => `facet:${f.id}`),
    });
  } else gaps.push(`What does ${p.name} do? — needs features or problems solved`);

  const priced = g.pricing.filter((pl) => pl.priceCents !== null);
  if (priced.length) {
    const desc = priced.map((pl) => `${pl.planName}: ${formatMoney(pl.priceCents!, pl.currency)}${pl.interval === "MONTH" ? " per month" : pl.interval === "YEAR" ? " per year" : ""}`);
    const trial = g.pricing.find((pl) => pl.trialDays);
    answers.push({
      id: "cost",
      question: `How much does ${p.name} cost?`,
      answer: `${p.name} pricing: ${desc.join("; ")}.${trial ? ` A ${trial.trialDays}-day trial is available on ${trial.planName}.` : ""}`,
      sources: [...new Set(priced.flatMap((pl) => (pl.sourceId ? sourcesFor(g, pl.sourceId) : p.pricingUrl ? [p.pricingUrl] : [])))],
      confidence: conf(priced.every(isVerified)),
      basedOn: priced.map((pl) => `pricing:${pl.id}`),
    });
  } else gaps.push(`How much does ${p.name} cost? — no public prices recorded`);

  for (const integ of facetsOf(g, "INTEGRATION"))
    answers.push({
      id: `integrates-${integ.slug}`,
      question: `Does ${p.name} integrate with ${integ.name}?`,
      answer: `Yes. ${p.name} integrates with ${integ.name}.${integ.description ? ` ${integ.description}` : ""}`,
      sources: sourcesFor(g, integ.sourceId),
      confidence: conf(isVerified(integ)),
      basedOn: [`facet:${integ.id}`],
    });

  for (const pc of g.competitors) {
    const sourced = pc.comparisonFacts.filter((f) => f.sourceUrl);
    if (sourced.length < 2) {
      gaps.push(`Alternatives to ${pc.competitor.name}? — needs ≥ 2 sourced comparison facts`);
      continue;
    }
    answers.push({
      id: `alternative-${pc.competitor.slug}`,
      question: `What is an alternative to ${pc.competitor.name}?`,
      answer: `${p.name} is an alternative to ${pc.competitor.name}. ${sourced.map((f) => `${f.dimension}: ${p.name} — ${f.product}; ${pc.competitor.name} — ${f.competitor}.`).join(" ")}`,
      sources: [...new Set(sourced.map((f) => f.sourceUrl))],
      confidence: conf(sourced.every((f) => f.verifiedAt)),
      basedOn: sourced.map((_, i) => `comparison:${pc.competitorId}:${i}`),
    });
  }

  for (const faq of g.faqs.filter((f) => f.verification !== "REJECTED"))
    answers.push({ id: `faq-${faq.id}`, question: faq.question, answer: faq.answer, sources: sourcesFor(g, faq.sourceId), confidence: conf(isVerified(faq)), basedOn: [`faq:${faq.id}`] });

  return { answers, gaps };
}

/** llms.txt (https://llmstxt.org) index for an organisation's published discovery content. */
export function buildLlmsTxt(org: { name: string; summary?: string }, products: { name: string; url: string | null; summary: string | null; pages: { title: string; url: string }[] }[]): string {
  const lines = [`# ${org.name}`, ""];
  if (org.summary) lines.push(`> ${org.summary}`, "");
  lines.push("## Products", "");
  for (const p of products) lines.push(`- [${p.name}](${p.url ?? "#"})${p.summary ? `: ${p.summary}` : ""}`);
  for (const p of products) {
    if (!p.pages.length) continue;
    lines.push("", `## ${p.name}`, "");
    for (const pg of p.pages) lines.push(`- [${pg.title}](${pg.url})`);
  }
  return lines.join("\n") + "\n";
}
