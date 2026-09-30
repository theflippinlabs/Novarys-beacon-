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
  { re: /\b(rated|ratings?|\d(\.\d)?\s*(stars?|\/\s*5)|reviews? (on|from)|star reviews?)\b/i, why: "Rating / review claim — requires a verified source" },
];


/**
 * Words the generator uses to connect facts ("Key capabilities include …",
 * "It helps with …"). They carry no factual content of their own.
 */
const CONNECTIVES = new Set(
  "key capabilities capability include includes including helps help designed lists listed target audience audiences integrates integration yes available pricing plan plans costs cost month monthly year yearly annual per price request released alternative also provides offers lets allows supports support using used via problem solves solve recurring teams here handle show screen vo on-screen film real footage beats more information hi best regards trial day days".split(" "),
);

/** Extracts checkable claims; structural lines (headings, CTAs, sources, editorial notes, field labels) are not claims. */
function splitClaims(body: string, knownUrls: string[]): string[] {
  const stripUrls = (s: string) => {
    let out = s;
    for (const u of knownUrls) out = out.split(u).join(" ").split(u.replace(/\/+$/, "")).join(" ");
    return out;
  };
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("|---") && !/^- <[^>]+>$/.test(l) && !l.startsWith(EDITOR_TODO) && !/^_.*_$/.test(l) && !l.includes("{cta:"))
    .map((l) => l.replace(/^\*\*[^*]{1,40}:\*\*\s*/, "").replace(/\*\*/g, ""))
    .flatMap((l) => l.replace(/^[-*→>\d.)\s]+/, "").split(/(?<=[.!?])\s+(?=[A-Z"])/))
    .map((s) => stripUrls(s.replace(/\{\{[^}]*\}\}/g, " ").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2").replace(/<(https?:[^>]+)>/g, "$1")).trim())
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
  const p = g.product;
  const knownUrls = [
    ...(p.domain ? [`https://${p.domain}`] : []),
    ...[p.documentationUrl, p.pricingUrl, p.logoUrl].filter((u): u is string => Boolean(u)),
    ...p.conversionUrls.map((c) => c.url),
    ...g.sources.map((s) => s.url),
    ...g.competitors.flatMap((c) => c.comparisonFacts.map((f) => f.sourceUrl)),
  ].sort((a, b) => b.length - a.length);
  const productTokens = new Set(tokens(p.name));
  const ctaTokens = new Set(p.conversionUrls.flatMap((c) => tokens(c.label)));
  const claims: ClaimCheck[] = [];

  for (const claim of splitClaims(body, knownUrls)) {
    const ct = tokens(claim).filter((t) => !productTokens.has(t) && !CONNECTIVES.has(t) && !ctaTokens.has(t) && !/^\d/.test(t));
    const risky = RISKY.find((r) => r.re.test(claim));
    // Best single supporting fact …
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
    // … and greedy multi-fact coverage for sentences that combine several facts ("X, Y and Z").
    const uncovered = new Set(ct);
    const used: (typeof facts)[number][] = [];
    while (uncovered.size && used.length < 6) {
      let pick: (typeof facts)[number] | null = null;
      let gain = 0;
      for (const f of facts) {
        if (used.includes(f)) continue;
        const gnew = [...uncovered].filter((t) => f.toks.has(t)).length;
        if (gnew > gain) {
          gain = gnew;
          pick = f;
        }
      }
      if (!pick || gain < 2) break;
      used.push(pick);
      for (const t of [...uncovered]) if (pick.toks.has(t)) uncovered.delete(t);
    }
    const unionScore = ct.length ? 1 - uncovered.size / ct.length : 1;
    const numbers = (claim.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, ""));
    const numbersOk = numbers.every((n) => facts.some((f) => f.lower.includes(n)));
    const mentionsCompetitor = competitorNames.some((c) => claim.toLowerCase().includes(c.toLowerCase()));
    const competitorSupported = best?.ref.startsWith("comparison:") && bestScore >= 0.5;

    let status: ClaimCheck["status"];
    if (!numbersOk) status = "UNSUPPORTED";
    else if (risky && !(best && bestScore >= 0.8 && best.verified)) status = "NEEDS_REVIEW";
    else if (mentionsCompetitor && !competitorSupported) status = "UNSUPPORTED";
    else if (ct.length === 0 || bestScore >= 0.6 || unionScore >= 0.8) status = "SUPPORTED";
    else if (bestScore >= 0.4 || unionScore >= 0.6) status = "NEEDS_REVIEW";
    else status = "UNSUPPORTED";

    const ref = bestScore >= 0.4 ? best : used[0];
    claims.push({ claim: claim.slice(0, 400), status, factRef: ref?.ref, sourceUrl: ref?.sourceUrl ?? (risky ? risky.why : !numbersOk ? "Number not found in any recorded fact" : undefined) });
  }
  const passed = claims.every((c) => c.status === "SUPPORTED");
  return { passed, claims, checkedAt: new Date().toISOString() };
}
