import type { ClaimCheck } from "@/db/schema";
import { facetsOf, type ProductGraph } from "@/core/knowledge/types";
import { formatMoney, tokens } from "@/core/util/text";
import { EDITOR_TODO } from "./generate";

type Fact = { ref: string; text: string; sourceUrl?: string; verified: boolean };

/** Flatten the knowledge graph into checkable facts. */
export function graphFacts(g: ProductGraph): Fact[] {
  const p = g.product;
  const home = p.domain ? `https://${p.domain}` : undefined;
  const srcUrl = (id: string | null) => (id ? g.sources.find((s) => s.id === id)?.url : undefined);
  const facts: Fact[] = [];
  const pv = Boolean(p.lastVerifiedAt);
  if (p.shortDescription) facts.push({ ref: "product:short_description", text: p.shortDescription, sourceUrl: home, verified: pv });
  if (p.fullDescription) facts.push({ ref: "product:full_description", text: p.fullDescription, sourceUrl: home, verified: pv });
  if (p.howItWorks) facts.push({ ref: "product:how_it_works", text: p.howItWorks, sourceUrl: p.documentationUrl ?? home, verified: pv });
  if (p.category) facts.push({ ref: "product:category", text: `${p.name} ${p.category}`, sourceUrl: home, verified: pv });
  for (const f of g.facets.filter((x) => x.verification !== "REJECTED")) facts.push({ ref: `facet:${f.id}`, text: `${f.name} ${f.description ?? ""}`, sourceUrl: srcUrl(f.sourceId), verified: f.verification === "VERIFIED" });
  for (const x of g.pricing.filter((x) => x.verification !== "REJECTED"))
    facts.push({
      ref: `pricing:${x.id}`,
      text: `${x.planName} ${x.priceCents !== null ? `${formatMoney(x.priceCents, x.currency)} ${(x.priceCents / 100).toFixed(2)} ${x.priceCents / 100}` : ""} ${x.trialDays ? `${x.trialDays}-day trial ${x.trialDays} day` : ""} ${x.description ?? ""}`,
      sourceUrl: srcUrl(x.sourceId) ?? p.pricingUrl ?? undefined,
      verified: x.verification === "VERIFIED",
    });
  for (const f of g.faqs.filter((x) => x.verification !== "REJECTED")) facts.push({ ref: `faq:${f.id}`, text: `${f.question} ${f.answer}`, sourceUrl: srcUrl(f.sourceId), verified: f.verification === "VERIFIED" });
  for (const pr of g.proofs.filter((x) => x.publishable && x.verification === "VERIFIED")) facts.push({ ref: `proof:${pr.id}`, text: `${pr.title} ${pr.content} ${pr.attribution ?? ""}`, sourceUrl: srcUrl(pr.sourceId), verified: true });
  for (const c of g.changelog) facts.push({ ref: `changelog:${c.id}`, text: `${c.version ?? ""} ${c.releasedOn} ${c.title} ${c.body ?? ""}`, sourceUrl: srcUrl(c.sourceId), verified: true });
  for (const pc of g.competitors)
    pc.comparisonFacts.forEach((cf, i) => facts.push({ ref: `comparison:${pc.competitorId}:${i}`, text: `${pc.competitor.name} ${cf.dimension} ${cf.product} ${cf.competitor}`, sourceUrl: cf.sourceUrl, verified: Boolean(cf.verifiedAt) }));
  for (const a of facetsOf(g, "AUDIENCE")) facts.push({ ref: `facet:${a.id}`, text: a.name, sourceUrl: srcUrl(a.sourceId), verified: a.verification === "VERIFIED" });
  return facts;
}

const RISKY = [
  { re: /\b(best|#1|number one|leading|world'?s first|only solution|unmatched|guaranteed?|revolutionary)\b/i, why: "Superlative or guarantee — needs evidence or rewording" },
  { re: /\b(trusted by|used by|customers? (include|like)|clients include)\b/i, why: "Customer claim — requires a verified, publishable proof" },
  { re: /\b(award|awarded|winner|certified|compliant|iso ?\d+|soc ?2|gdpr[- ]compliant|hipaa)\b/i, why: "Award / certification claim — requires a verified source" },
  { re: /\b(rating|rated|stars?|reviews?)\b/i, why: "Rating / review claim — requires a verified source" },
];

const NUMERIC = /(\d[\d,.]*\s?(%|percent|x\b|k\b|m\b|€|\$|£|eur|usd|users|customers|creators|hours|minutes))|([€$£]\s?\d)/i;

function splitClaims(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("|---") && !l.startsWith("- <") && !l.startsWith(EDITOR_TODO) && !/^_.*_$/.test(l) && !/^\*\*[^*]+:\*\*$/.test(l))
    .flatMap((l) => l.replace(/^[-*→>\d.)\s]+/, "").split(/(?<=[.!?])\s+(?=[A-Z"])/))
    .map((s) => s.replace(/\{cta:[A-Z_]+\}/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim())
    .filter((s) => tokens(s).length >= 3);
}

/**
 * Sentence-level fact check against the knowledge graph. A claim is
 * SUPPORTED when enough of its content words appear in one fact and any
 * numbers it contains appear in that fact; claims that look like invented
 * customers, statistics, awards, reviews or superlatives are flagged.
 */
export function factCheck(body: string, g: ProductGraph, competitorNames: string[] = []): { passed: boolean; claims: ClaimCheck[]; checkedAt: string } {
  const facts = graphFacts(g).map((f) => ({ ...f, toks: new Set(tokens(f.text)), lower: f.text.toLowerCase() }));
  const productTokens = new Set(tokens(g.product.name));
  const claims: ClaimCheck[] = [];

  for (const claim of splitClaims(body)) {
    const ct = tokens(claim).filter((t) => !productTokens.has(t) && !/^\{\{.*\}\}$/.test(t));
    const risky = RISKY.find((r) => r.re.test(claim));
    let best: (typeof facts)[number] | null = null;
    let bestScore = 0;
    for (const f of facts) {
      if (!ct.length) break;
      const hit = ct.filter((t) => f.toks.has(t)).length / ct.length;
      if (hit > bestScore) {
        bestScore = hit;
        best = f;
      }
    }
    const numbers = claim.match(/\d[\d,.]*/g) ?? [];
    const numbersOk = numbers.every((n) => facts.some((f) => f.lower.includes(n.replace(/,/g, "")) || f.lower.includes(n)));
    const mentionsCompetitor = competitorNames.some((c) => claim.toLowerCase().includes(c.toLowerCase()));

    let status: ClaimCheck["status"];
    if (ct.length === 0) status = "SUPPORTED";
    else if (bestScore >= 0.6 && numbersOk && !risky) status = "SUPPORTED";
    else if (NUMERIC.test(claim) && !numbersOk) status = "UNSUPPORTED";
    else if (risky && !(best && bestScore >= 0.8 && best.verified)) status = "NEEDS_REVIEW";
    else if (mentionsCompetitor && !(best && best.ref.startsWith("comparison:") && bestScore >= 0.5)) status = "UNSUPPORTED";
    else if (bestScore >= 0.4) status = "NEEDS_REVIEW";
    else status = "UNSUPPORTED";

    claims.push({ claim: claim.slice(0, 400), status, factRef: bestScore >= 0.4 ? best?.ref : undefined, sourceUrl: bestScore >= 0.4 ? best?.sourceUrl : risky?.why });
  }
  const passed = claims.every((c) => c.status === "SUPPORTED");
  return { passed, claims, checkedAt: new Date().toISOString() };
}
