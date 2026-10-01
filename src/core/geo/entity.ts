import { claimVerification, currentClaim, facetsOf, isVerified, type ProductGraph } from "@/core/knowledge/types";
import { computeConfidence, isFailingSource, type Verification } from "@/core/knowledge/confidence";
import type { ClaimField } from "@/core/knowledge/provenance";
import { formatMoney } from "@/core/util/text";

/**
 * GEO / AEO knowledge layer. Produces a machine-readable entity profile and
 * concise, citation-ready answer blocks. Everything is derived from the
 * knowledge graph. A claim cites only the source a human linked to it: the
 * homepage (or any other URL) is never substituted, so an unsourced fact has
 * `sources: []` and `sourced: false`. Anything unknown is listed explicitly
 * under `unknowns` rather than guessed.
 */
export type SourcedClaim = { text: string; sources: string[]; sourced: boolean; verified: boolean };

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
  price: { plan: string; price: string | null; currency: string | null; interval: string | null; trialDays: number | null; sources: string[]; sourced: boolean; verified: boolean }[];
  differentiation: SourcedClaim[];
  languages: string[];
  countries: string[];
  sources: { title: string; url: string; kind: string }[];
  lastVerified: string | null;
  unknowns: string[];
};

export type AnswerBlock = { id: string; question: string; answer: string; sources: string[]; confidence: number; basedOn: string[] };

const productUrl = (g: ProductGraph) => (g.product.domain ? `https://${g.product.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : null);

/** The URL of the source linked to a fact; never a substitute. */
function sourcesFor(g: ProductGraph, sourceId: string | null | undefined): string[] {
  const s = sourceId ? g.sources.find((x) => x.id === sourceId) : undefined;
  return s ? [s.url] : [];
}

type Provenanced = { verification: Verification; sourceId: string | null; verifiedAt?: Date | null };

/** Derived confidence of one fact (src/core/knowledge/confidence.ts). */
function factConfidence(g: ProductGraph, f: Provenanced, now: Date): number {
  const s = f.sourceId ? g.sources.find((x) => x.id === f.sourceId) : undefined;
  return computeConfidence({ verification: f.verification, source: s ? { kind: s.kind, failing: isFailingSource(s) } : null, verifiedAt: f.verifiedAt ?? null, now });
}

/** Provenance of a scalar product field (its claim, or the legacy product verification). */
function scalarFact(g: ProductGraph, field: ClaimField): Provenanced {
  const c = currentClaim(g, field);
  return { verification: claimVerification(g, field), sourceId: c?.sourceId ?? null, verifiedAt: c?.verifiedAt ?? (c ? null : g.product.lastVerifiedAt) };
}

/** Confidence of an answer built from several facts: the weakest fact bounds it. */
const minConfidence = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);

export function buildEntityProfile(g: ProductGraph, orgName: string): EntityProfile {
  const p = g.product;
  const home = productUrl(g);
  const claim = (field: ClaimField, text: string): SourcedClaim => {
    const f = scalarFact(g, field);
    const sources = sourcesFor(g, f.sourceId);
    return { text, sources, sourced: sources.length > 0, verified: f.verification === "VERIFIED" };
  };
  const facetClaims = (kind: Parameters<typeof facetsOf>[1]) =>
    facetsOf(g, kind).map((f) => {
      const sources = sourcesFor(g, f.sourceId);
      return { text: f.description ? `${f.name}: ${f.description}` : f.name, sources, sourced: sources.length > 0, verified: isVerified(f) };
    });

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

  const stamps = [p.lastVerifiedAt, ...(g.claims ?? []).filter(isVerified).map((c) => c.verifiedAt)].filter((d): d is Date => d instanceof Date);
  return {
    schema: "beacon.entity/v1",
    who: { organization: orgName, product: p.name, url: home, sameAs: p.socialAccounts.map((s) => s.url) },
    what: {
      summary: p.shortDescription ? claim("short_description", p.shortDescription) : null,
      description: p.fullDescription ? claim("full_description", p.fullDescription) : null,
      category: p.category,
      status: p.status,
    },
    whoFor: { audiences: facetClaims("AUDIENCE"), industries: facetClaims("INDUSTRY") },
    problem: facetClaims("PROBLEM"),
    how: p.howItWorks ? claim("how_it_works", p.howItWorks) : null,
    features: facetClaims("FEATURE"),
    integrations: facetClaims("INTEGRATION"),
    proof: g.proofs
      .filter((pr) => pr.publishable && isVerified(pr))
      .map((pr) => {
        const sources = sourcesFor(g, pr.sourceId);
        return { kind: pr.kind, text: `${pr.title}: ${pr.content}`, attribution: pr.attribution, sources, sourced: sources.length > 0, verified: true };
      }),
    price: g.pricing.map((pl) => {
      const sources = sourcesFor(g, pl.sourceId);
      return {
        plan: pl.planName,
        price: pl.priceCents === null ? null : formatMoney(pl.priceCents, pl.currency),
        currency: pl.currency,
        interval: pl.interval,
        trialDays: pl.trialDays,
        sources,
        sourced: sources.length > 0,
        verified: isVerified(pl),
      };
    }),
    differentiation: facetClaims("DIFFERENTIATOR"),
    languages: p.languages,
    countries: p.supportedCountries,
    sources: g.sources.map((s) => ({ title: s.title, url: s.url, kind: s.kind })),
    lastVerified: stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))).toISOString() : null,
    unknowns,
  };
}

function listSentence(items: string[], max = 5): string {
  const xs = items.slice(0, max);
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Concise factual answers for common questions. Questions without enough facts are returned as gaps. */
export function buildAnswerBlocks(g: ProductGraph, now = new Date()): { answers: AnswerBlock[]; gaps: string[] } {
  const p = g.product;
  const answers: AnswerBlock[] = [];
  const gaps: string[] = [];
  const conf = (...facts: Provenanced[]) => minConfidence(facts.map((f) => factConfidence(g, f, now)));

  if (p.shortDescription) {
    answers.push({
      id: "what-is",
      question: `What is ${p.name}?`,
      answer: `${p.name} is ${p.category ? `a ${p.category.toLowerCase()} product` : "a product"}${p.shortDescription ? `: ${p.shortDescription.replace(/\.$/, "")}.` : "."}`,
      sources: [...new Set([...sourcesFor(g, scalarFact(g, "short_description").sourceId), ...(p.category ? sourcesFor(g, scalarFact(g, "category").sourceId) : [])])],
      confidence: conf(scalarFact(g, "short_description"), ...(p.category ? [scalarFact(g, "category")] : [])),
      basedOn: ["product:short_description", "product:category"],
    });
  } else gaps.push(`What is ${p.name}? (needs a short description)`);

  const audiences = facetsOf(g, "AUDIENCE");
  if (audiences.length) {
    answers.push({
      id: "who-for",
      question: `Who is ${p.name} for?`,
      answer: `${p.name} is designed for ${listSentence(audiences.map((a) => a.name.toLowerCase()))}.`,
      sources: [...new Set(audiences.flatMap((a) => sourcesFor(g, a.sourceId)))],
      confidence: conf(...audiences),
      basedOn: audiences.map((a) => `facet:${a.id}`),
    });
    for (const a of audiences)
      answers.push({
        id: `supports-${a.slug}`,
        question: `Does ${p.name} support ${a.name.toLowerCase()}?`,
        answer: `Yes. ${p.name} lists ${a.name.toLowerCase()} as a target audience.${a.description ? ` ${a.description}` : ""}`,
        sources: sourcesFor(g, a.sourceId),
        confidence: conf(a),
        basedOn: [`facet:${a.id}`],
      });
  } else gaps.push(`Who is ${p.name} for? (needs target audiences)`);

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
      confidence: conf(...features, ...problems),
      basedOn: [...features, ...problems].map((f) => `facet:${f.id}`),
    });
  } else gaps.push(`What does ${p.name} do? (needs features or problems solved)`);

  const priced = g.pricing.filter((pl) => pl.priceCents !== null);
  if (priced.length) {
    const desc = priced.map((pl) => `${pl.planName}: ${formatMoney(pl.priceCents!, pl.currency)}${pl.interval === "MONTH" ? " per month" : pl.interval === "YEAR" ? " per year" : ""}`);
    const trial = g.pricing.find((pl) => pl.trialDays);
    answers.push({
      id: "cost",
      question: `How much does ${p.name} cost?`,
      answer: `${p.name} pricing: ${desc.join("; ")}.${trial ? ` A ${trial.trialDays}-day trial is available on ${trial.planName}.` : ""}`,
      sources: [...new Set(priced.flatMap((pl) => sourcesFor(g, pl.sourceId)))],
      confidence: conf(...priced),
      basedOn: priced.map((pl) => `pricing:${pl.id}`),
    });
  } else gaps.push(`How much does ${p.name} cost? (no public prices recorded)`);

  for (const integ of facetsOf(g, "INTEGRATION"))
    answers.push({
      id: `integrates-${integ.slug}`,
      question: `Does ${p.name} integrate with ${integ.name}?`,
      answer: `Yes. ${p.name} integrates with ${integ.name}.${integ.description ? ` ${integ.description}` : ""}`,
      sources: sourcesFor(g, integ.sourceId),
      confidence: conf(integ),
      basedOn: [`facet:${integ.id}`],
    });

  for (const pc of g.competitors) {
    const sourced = pc.comparisonFacts.filter((f) => f.sourceUrl);
    if (sourced.length < 2) {
      gaps.push(`Alternatives to ${pc.competitor.name}? (needs ≥ 2 sourced comparison facts)`);
      continue;
    }
    answers.push({
      id: `alternative-${pc.competitor.slug}`,
      question: `What is an alternative to ${pc.competitor.name}?`,
      answer: `${p.name} is an alternative to ${pc.competitor.name}. ${sourced.map((f) => `${f.dimension}: ${f.product} for ${p.name}; ${f.competitor} for ${pc.competitor.name}.`).join(" ")}`,
      sources: [...new Set(sourced.map((f) => f.sourceUrl))],
      // Comparison facts always carry their own source URL; verified ones count as first-party verified claims.
      confidence: minConfidence(sourced.map((f) => computeConfidence({ verification: f.verifiedAt ? "VERIFIED" : "UNVERIFIED", source: { kind: "OTHER" }, verifiedAt: f.verifiedAt ? new Date(f.verifiedAt) : null, now }))),
      basedOn: sourced.map((_, i) => `comparison:${pc.competitorId}:${i}`),
    });
  }

  for (const faq of g.faqs.filter((f) => f.verification !== "REJECTED" && f.answer.trim()))
    answers.push({ id: `faq-${faq.id}`, question: faq.question, answer: faq.answer, sources: sourcesFor(g, faq.sourceId), confidence: conf(faq), basedOn: [`faq:${faq.id}`] });

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

export type FaqSuggestion = { question: string; from: string };

/** "how to stop spam in tiktok live" → "How to stop spam in tiktok live?" */
export function toQuestion(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  if (!t) return "";
  const q = t.charAt(0).toUpperCase() + t.slice(1);
  return q.endsWith("?") ? q : `${q}?`;
}

const normQ = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * FAQ suggestions (drafts for humans to answer and verify): questions taken
 * from high-importance PROBLEM / INFORMATIONAL queries and active AI
 * visibility prompts that the FAQ does not already cover. No answer is
 * invented; Beacon only proposes the question and where it came from.
 */
export function suggestFaqQuestions(
  existing: string[],
  queries: { id: string; query: string; intent: string; importance: number; status: string }[],
  prompts: { id: string; prompt: string; active: boolean }[],
  max = 10,
): FaqSuggestion[] {
  const seen = new Set(existing.map(normQ));
  const out: FaqSuggestion[] = [];
  const push = (text: string, from: string) => {
    const question = toQuestion(text).slice(0, 300);
    const key = normQ(question);
    if (question.length < 5 || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ question, from });
  };
  for (const q of [...queries].filter((q) => q.status === "ACTIVE" && q.importance >= 4 && (q.intent === "PROBLEM" || q.intent === "INFORMATIONAL")).sort((a, b) => b.importance - a.importance)) push(q.query, `query:${q.id}`);
  for (const p of prompts.filter((p) => p.active)) push(p.prompt, `prompt:${p.id}`);
  return out;
}
