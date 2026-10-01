import type { ClaimCheck, ClaimKind, ClaimSeverity, ClaimStatus, FactCheckResult } from "@/db/schema";
import { graphFacts, type GraphFact } from "@/core/knowledge/facts";
import type { ProductGraph } from "@/core/knowledge/types";
import { tokens } from "@/core/util/text";
import { EDITOR_TODO } from "./markers";

export { graphFacts } from "@/core/knowledge/facts";

export type FactCheckOptions = {
  competitorNames?: string[];
  metaTitle?: string | null;
  metaDescription?: string | null;
  /** Only VERIFIED facts support claims (default true: everything Beacon checks can be published). */
  verifiedOnly?: boolean;
  /** Repurposing: only these fact refs (the source version's) may support claims. */
  allowedRefs?: Iterable<string> | null;
  /** Repurposing: numbers must also appear in the source body. */
  sourceBody?: string | null;
  now?: Date;
  /** Verified pricing older than this many days is OUTDATED_PRICING (the org's knowledge freshness threshold). */
  freshnessDays?: number;
};

export const DEFAULT_FRESHNESS_DAYS = 180;

type Fact = GraphFact & { toks: Set<string>; nums: Set<string>; usable: boolean };
type Location = NonNullable<ClaimCheck["location"]>;
/** full: a sentence that must be supported; headline: headings, meta titles, short lines (risky, numbers, pricing, integrations); risky: notes and CTA labels (risky patterns only). */
type Mode = "full" | "headline" | "risky";
type Line = { text: string; raw: string; location: Location; mode: Mode; quote: boolean };

// ─── Risky-claim patterns ──────────────────────────────────────────────────
const SUPERLATIVE = /(^|[^\w])#1\b|\b(best(?! regards| wishes)|number one|no\.? ?1|leading|industry[- ]leading|market[- ]leading|world'?s first|first ever|only (solution|platform|tool|app)|unmatched|unrivall?ed|guaranteed?|revolutionary|fastest|cheapest|easiest|most (popular|trusted|advanced|powerful|accurate)|meilleure?s?|numéro 1|garanti(e|es|s)?|révolutionnaire)\b/i;
const CUSTOMER = /\b(trusted by|used by|loved by|chosen by|relied on by|customers? (include|like)|clients include|join(ed)? (over |more than )?\d|thousands of|millions of|hundreds of|\d[\d,.]*\s?(k|m)?\+?\s+(happy |active |paying )?(customers|users|teams|companies|businesses|agencies|clients|creators|brands|organi[sz]ations|downloads|installs))\b/i;
const AWARD = /\b(award|awards|awarded|award-winning|winner|certified|certification|compliant|iso ?\d{4,5}|soc ?2|gdpr[- ]compliant|hipaa)\b/i;
const RATING = /\b(rated|ratings?|\d(\.\d)?\s*(stars?|\/\s*5)|reviews? (on|from)|star reviews?|g2|capterra|trustpilot)\b/i;
const STATISTIC = /\d+(?:[.,]\d+)?\s?(%|percent\b|pour cent\b|x\b|×)|\b\d+(?:[.,]\d+)?\s*(times|fois)\b|\b(increase[sd]?|reduce[sd]?|cuts?|boosts?|saves?|grows?|improves?|doubles?|triples?)\b[^.]*\d/i;
const TESTIMONIAL = /\b(said|says|testimonial from|according to)\b|["“][^"”]{15,}["”]\s*(?:[-,(]|by)\s*[A-Z]/;
const INTEGRATION = /\b(integrates? (?:natively )?with|integration (?:with|for)|connects? (?:to|with)|works? with|plugs? into|compatible with|syncs? with)\s+(.+)/i;

const RISK_REASON: Partial<Record<ClaimKind, string>> = {
  SUPERLATIVE: "Superlative or guarantee: needs evidence or rewording",
  CUSTOMER: "Customer claim: requires a verified, publishable proof",
  TESTIMONIAL: "Testimonial: requires a verified, publishable proof",
  AWARD: "Award / certification claim: requires a verified source",
  RATING: "Rating / review claim: requires a verified source",
  STATISTIC: "Statistic: the number must come from a verified fact",
};

/**
 * Words the generator uses to connect facts ("Key capabilities include …",
 * "It helps with …"). They carry no factual content of their own.
 */
const CONNECTIVES = new Set(
  "key capabilities capability include includes including helps help designed lists listed target audience audiences integrates integration yes available pricing plan plans costs cost month monthly year yearly annual per price request released alternative also provides offers lets allows supports support using used via problem solves solve recurring teams here handle show screen vo on-screen film real footage beats more information hi best regards trial day days factual answers about integrations sourced comparison".split(" "),
);

/** Structural headings the generator writes (section titles, not claims). */
const STRUCTURAL = /^(who it is for|who .+ is for|problems it solves|key features|related capabilities|how it works|integrations|evidence|pricing|frequently asked questions|get started|sources|what it is|the problem|how .+ helps|steps|what'?s new|hook|beats|call to action|relevant capabilities)\b/i;

// ─── Numbers on token boundaries ───────────────────────────────────────────
const normNum = (n: string) => {
  let x = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(n) ? n.replace(/,/g, "") : n.replace(/,(?=\d{1,2}$)/, ".");
  if (/^\d+\.\d+$/.test(x)) x = x.replace(/\.?0+$/, "");
  return x;
};
export function numbersIn(s: string): string[] {
  const clean = s.replace(/https?:\/\/\S+/g, " ").replace(/\{\{[^}]*\}\}/g, " ");
  return [...clean.matchAll(/(?<![\w.])\d+(?:[.,]\d+)*(?![\w])|(?<![\w.])\d+(?:[.,]\d+)*(?=[a-z%])/gi)].map((m) => normNum(m[0]));
}

// ─── Pricing ───────────────────────────────────────────────────────────────
const CURRENCY_SYMBOL: Record<string, string> = { "€": "EUR", $: "USD", "US$": "USD", "£": "GBP", "CA$": "CAD", A$: "AUD", "¥": "JPY", "JP¥": "JPY" };
const CUR = String.raw`(CA\$|A\$|US\$|JP¥|€|\$|£|¥|\b(?:EUR|USD|GBP|CHF|CAD|AUD|JPY|SEK|NOK|DKK)\b)`;
const AMOUNT = String.raw`(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const PRICE_RE = new RegExp(`${CUR}\\s?${AMOUNT}|${AMOUNT}\\s?${CUR}`, "gi");

export type PricingClaim = { amounts: { cents: number; currency: string }[]; interval: "MONTH" | "YEAR" | "ONE_TIME" | null; trialDays: number | null };

export function parsePricingClaim(text: string): PricingClaim | null {
  const amounts: PricingClaim["amounts"] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const sym = m[1] ?? m[4];
    const raw = m[2] ?? m[3];
    const currency = CURRENCY_SYMBOL[sym] ?? sym.toUpperCase();
    const value = Number(raw.replace(/[,\s](?=\d{3}\b)/g, "").replace(",", "."));
    if (Number.isFinite(value)) amounts.push({ cents: Math.round(value * 100), currency });
  }
  const t = text.toLowerCase();
  const interval = /(\/\s*(month|mo|mois)\b|per month|a month|monthly|par mois|mensuel)/.test(t)
    ? "MONTH"
    : /(\/\s*(year|yr|an)\b|per year|a year|annual(ly)?|yearly|par an|annuel)/.test(t)
      ? "YEAR"
      : /\b(one[- ]time|lifetime|paiement unique)\b/.test(t)
        ? "ONE_TIME"
        : null;
  const trial = t.match(/(\d+)[- ]day (free )?trial|essai (gratuit )?de (\d+) jours/);
  const trialDays = trial ? Number(trial[1] ?? trial[3]) : null;
  if (!amounts.length && trialDays === null) return null;
  return { amounts, interval, trialDays };
}

type Verdict = { status: ClaimStatus; severity: ClaimSeverity; reason?: string; fact?: Fact | null };

function validatePricing(text: string, pc: PricingClaim, facts: Fact[], now: Date, freshnessDays: number): Verdict {
  const rows = facts.filter((f) => f.kind === "pricing" && f.pricing);
  const claimToks = new Set(tokens(text));
  // A plan named in the claim restricts the candidates to that plan.
  const named = rows.filter((f) => {
    const pt = tokens(f.pricing!.planName);
    return pt.length > 0 && pt.every((x) => claimToks.has(x));
  });
  const pool = named.length ? named : rows;
  let matched: Fact[] = pool;
  for (const a of pc.amounts) {
    const same = matched.filter((f) => f.pricing!.priceCents === a.cents && f.pricing!.currency === a.currency);
    if (!same.length) {
      const otherCurrency = pool.some((f) => f.pricing!.priceCents === a.cents);
      return { status: "WRONG_PRICING", severity: "HIGH", reason: otherCurrency ? "Currency does not match the recorded plan" : "Price not found in any recorded plan", fact: named[0] ?? null };
    }
    matched = same;
  }
  if (pc.interval) {
    const same = matched.filter((f) => f.pricing!.interval === pc.interval);
    if (!same.length) return { status: "WRONG_PRICING", severity: "HIGH", reason: "Billing interval does not match the recorded plan", fact: matched[0] ?? null };
    matched = same;
  }
  if (pc.trialDays !== null) {
    const same = matched.filter((f) => f.pricing!.trialDays === pc.trialDays);
    if (!same.length) return { status: "WRONG_PRICING", severity: "HIGH", reason: "Trial length does not match the recorded plan", fact: matched[0] ?? null };
    matched = same;
  }
  const verified = matched.find((f) => f.usable);
  if (!verified) {
    if (matched.some((f) => f.verification === "OUTDATED")) return { status: "OUTDATED_PRICING", severity: "HIGH", reason: "The matching plan is marked OUTDATED", fact: matched[0] };
    return { status: "NEEDS_REVIEW", severity: "HIGH", reason: "The matching plan is not verified", fact: matched[0] };
  }
  const at = verified.verifiedAt ? Date.parse(verified.verifiedAt) : NaN;
  if (!Number.isFinite(at) || (now.getTime() - at) / 86_400_000 > freshnessDays)
    return { status: "OUTDATED_PRICING", severity: "MEDIUM", reason: `Pricing verification is older than ${freshnessDays} days`, fact: verified };
  return { status: "SUPPORTED", severity: "LOW", fact: verified };
}

// ─── Line extraction ───────────────────────────────────────────────────────
function clean(s: string, knownUrls: string[]) {
  let out = s.replace(/\{\{[^}]*\}\}/g, " ").replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2").replace(/<(https?:[^>]+)>/g, "$1").replace(/\{cta:[^}]*\}/g, " ");
  for (const u of knownUrls) out = out.split(u).join(" ").split(u.replace(/\/+$/, "")).join(" ");
  return out.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

const sentences = (s: string) => s.split(/(?<=[.!?])\s+(?=[A-Z"“])/);

/** Every line of the body plus the meta fields, each with how it must be checked. */
function extractLines(body: string, knownUrls: string[], meta: { metaTitle?: string | null; metaDescription?: string | null }): Line[] {
  const out: Line[] = [];
  const push = (raw: string, text: string, location: Location, mode: Mode, quote = false) => {
    const t = clean(text, knownUrls);
    if (t) out.push({ raw, text: t, location, mode, quote });
  };
  for (const rawLine of body.split("\n")) {
    const l = rawLine.trim();
    if (!l || l.startsWith("|---") || /^- <[^>]+>$/.test(l) || l.startsWith(EDITOR_TODO)) continue;
    if (/^#{1,6}\s/.test(l)) {
      const h = l.replace(/^#+\s*/, "").replace(/\(\d+\s*-\s*\d+\s*s\)/g, " ");
      if (STRUCTURAL.test(h.trim())) continue;
      push(l, h, "heading", "headline");
      continue;
    }
    if (/^_.*_$/.test(l) || l.includes("{cta:")) {
      push(l, l.replace(/^_|_$/g, ""), "body", "risky");
      continue;
    }
    const quote = /^>/.test(l);
    const stripped = l.replace(/^\*\*[^*]{1,40}:\*\*\s*/, "").replace(/\*\*/g, "").replace(/^[-*→>\d.)\s]+/, "");
    if (!stripped.trim()) continue;
    for (const s of sentences(stripped)) push(l, s, "body", "full", quote);
  }
  if (meta.metaTitle?.trim()) push(meta.metaTitle, meta.metaTitle, "meta_title", "headline");
  if (meta.metaDescription?.trim()) for (const s of sentences(meta.metaDescription.trim())) push(meta.metaDescription, s, "meta_description", "full");
  // Short lines are never skipped any more: they get the headline checks (risky patterns, numbers, pricing).
  return out.map((x) => (x.mode === "full" && tokens(x.text).length < 3 ? { ...x, mode: "headline" as const } : x));
}

function kindOf(line: Line, competitorNames: string[]): ClaimKind {
  const t = line.text;
  if (parsePricingClaim(t)?.amounts.length || (parsePricingClaim(t)?.trialDays ?? null) !== null) return "PRICING";
  if ((line.quote && line.location === "body") || TESTIMONIAL.test(t)) return "TESTIMONIAL";
  if (CUSTOMER.test(t)) return "CUSTOMER";
  if (AWARD.test(t)) return "AWARD";
  if (RATING.test(t)) return "RATING";
  if (STATISTIC.test(t)) return "STATISTIC";
  if (SUPERLATIVE.test(t)) return "SUPERLATIVE";
  if (INTEGRATION.test(t)) return "INTEGRATION";
  if (competitorNames.some((c) => c && t.toLowerCase().includes(c.toLowerCase()))) return "COMPETITOR";
  return "FACT";
}

const RISKY_KINDS: ReadonlySet<ClaimKind> = new Set(["SUPERLATIVE", "CUSTOMER", "TESTIMONIAL", "AWARD", "RATING", "STATISTIC"]);

/** Named integrations a sentence claims ("works with Slack and Zapier"). */
function integrationNames(text: string, productTokens: Set<string>): string[] {
  const m = text.match(INTEGRATION);
  if (!m) return [];
  return m[2]
    .split(/[.;:!?]/)[0]
    .split(/,|\band\b|\bor\b|&|\//)
    .map((seg) => seg.trim().match(/^(?:the\s+)?((?:[A-Z][\w.+-]*)(?:\s+[A-Z][\w.+-]*)*)/)?.[1] ?? "")
    .filter((n) => n && !tokens(n).every((x) => productTokens.has(x)));
}

// ─── Support scoring ───────────────────────────────────────────────────────
type Support = { status: "SUPPORTED" | "NEEDS_REVIEW" | "UNSUPPORTED"; best: Fact | null; bestScore: number; used: Fact[]; numbersOk: boolean; numberFact: Fact | null };

function support(ct: string[], nums: string[], pool: Fact[]): Support {
  let best: Fact | null = null;
  let bestScore = 0;
  const hits = new Map<Fact, number>();
  for (const f of pool) {
    if (!ct.length) break;
    const hit = ct.filter((t) => f.toks.has(t)).length / ct.length;
    hits.set(f, hit);
    if (hit > bestScore) {
      bestScore = hit;
      best = f;
    }
  }
  // Greedy multi-fact coverage for sentences that combine several facts ("X, Y and Z").
  const uncovered = new Set(ct);
  const used: Fact[] = [];
  while (uncovered.size && used.length < 6) {
    let pick: Fact | null = null;
    let gain = 0;
    for (const f of pool) {
      if (used.includes(f)) continue;
      const g = [...uncovered].filter((t) => f.toks.has(t)).length;
      if (g > gain) {
        gain = g;
        pick = f;
      }
    }
    if (!pick || gain < 2) break;
    used.push(pick);
    for (const t of [...uncovered]) if (pick.toks.has(t)) uncovered.delete(t);
  }
  const unionScore = ct.length ? 1 - uncovered.size / ct.length : 1;
  // Numbers must all appear, on token boundaries, in one fact that supports the sentence.
  const candidates = ct.length ? [...new Set([...(best ? [best] : []), ...used, ...pool.filter((f) => (hits.get(f) ?? 0) >= Math.min(0.5, bestScore) && (hits.get(f) ?? 0) > 0)])] : pool;
  const numberFact = nums.length ? candidates.find((f) => nums.every((n) => f.nums.has(n))) ?? null : null;
  const numbersOk = !nums.length || Boolean(numberFact);
  let status: Support["status"];
  if (!numbersOk) status = "UNSUPPORTED";
  else if (ct.length === 0 || bestScore >= 0.6 || unionScore >= 0.8) status = "SUPPORTED";
  else if (bestScore >= 0.4 || unionScore >= 0.6) status = "NEEDS_REVIEW";
  else status = "UNSUPPORTED";
  return { status, best, bestScore, used, numbersOk, numberFact };
}

const UNVERIFIED_ONLY = "Supported only by unverified, outdated or conflicting facts: verify them first";
const OUTSIDE_SOURCE = "Supported only by facts the source content does not use";

/**
 * Claim-level fact check against the knowledge graph. Every body line,
 * heading, meta title and meta description is checked; each claim gets a
 * status, a kind and a severity:
 * - HIGH blocks approval and publication (invented or unverified claims,
 *   wrong pricing, invented integrations, testimonials, statistics,
 *   customers, awards, ratings, unsupported competitor claims);
 * - MEDIUM needs an explicit acknowledgment by the approver (partly
 *   supported sentences, superlatives taken from verified facts, pricing
 *   whose verification is older than the freshness threshold);
 * - LOW is informational (supported).
 * Only VERIFIED facts support claims; a claim that only unverified, outdated
 * or conflicting facts support is NEEDS_REVIEW (HIGH).
 */
export function factCheck(body: string, g: ProductGraph, optsOrCompetitors: FactCheckOptions | string[] = {}): FactCheckResult {
  const opts: FactCheckOptions = Array.isArray(optsOrCompetitors) ? { competitorNames: optsOrCompetitors } : optsOrCompetitors;
  const verifiedOnly = opts.verifiedOnly ?? true;
  const now = opts.now ?? new Date();
  const freshnessDays = opts.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const competitorNames = opts.competitorNames ?? g.competitors.map((c) => c.competitor.name);
  const allowed = opts.allowedRefs ? new Set(opts.allowedRefs) : null;
  const sourceNums = opts.sourceBody ? new Set(numbersIn(opts.sourceBody)) : null;

  const all: Fact[] = graphFacts(g).map((f) => ({ ...f, toks: new Set(tokens(f.text)), nums: new Set(numbersIn(f.text)), usable: (!verifiedOnly || f.verified) && (!allowed || allowed.has(f.ref)) }));
  const usable = all.filter((f) => f.usable);
  const p = g.product;
  const knownUrls = [
    ...(p.domain ? [`https://${p.domain}`] : []),
    ...[p.documentationUrl, p.pricingUrl, p.logoUrl].filter((u): u is string => Boolean(u)),
    ...p.conversionUrls.map((c) => c.url),
    ...g.sources.map((s) => s.url),
    ...g.competitors.flatMap((c) => c.comparisonFacts.map((f) => f.sourceUrl)).filter(Boolean),
  ].sort((a, b) => b.length - a.length);
  const productTokens = new Set(tokens(p.name));
  const ctaTokens = new Set(p.conversionUrls.flatMap((c) => tokens(c.label)));
  const integrationFacets = all.filter((f) => f.kind === "facet" && f.facetKind === "INTEGRATION");
  const claims: ClaimCheck[] = [];

  for (const line of extractLines(body, knownUrls, opts)) {
    const claim = line.text;
    const kind = kindOf(line, competitorNames);
    if (line.mode === "risky" && !RISKY_KINDS.has(kind)) continue;
    const ct = tokens(claim).filter((t) => !productTokens.has(t) && !CONNECTIVES.has(t) && !ctaTokens.has(t) && !/^\d/.test(t));
    const nums = kind === "PRICING" ? [] : numbersIn(claim);
    if (line.mode === "headline" && kind === "FACT" && !nums.length) continue;

    const v = support(ct, nums, usable);
    const a = verifiedOnly || allowed ? support(ct, nums, all) : v;
    const viaOther = (s: Support) => (allowed && s.best && !allowed.has(s.best.ref) ? OUTSIDE_SOURCE : UNVERIFIED_ONLY);
    let verdict: Verdict;

    if (kind === "PRICING") {
      verdict = validatePricing(claim, parsePricingClaim(claim)!, all, now, freshnessDays);
    } else if (RISKY_KINDS.has(kind)) {
      // Customer counts need a proof; a quantity that restates a verified plan limit ("Up to 30 creators") is a pricing fact, not a customer claim.
      const provenBy = (k: string | undefined) => (kind === "TESTIMONIAL" ? k === "proof" : kind === "CUSTOMER" ? k === "proof" || k === "pricing" : true);
      const strong = (s: Support) => s.best && s.bestScore >= 0.8 && s.numbersOk && provenBy(s.best.kind);
      if (strong(v)) verdict = kind === "SUPERLATIVE" ? { status: "NEEDS_REVIEW", severity: "MEDIUM", reason: "Superlative taken from a verified fact: confirm the evidence", fact: v.best } : { status: "SUPPORTED", severity: "LOW", fact: v.best };
      else if (strong(a)) verdict = { status: "NEEDS_REVIEW", severity: "HIGH", reason: viaOther(a), fact: a.best };
      else verdict = { status: v.numbersOk ? "NEEDS_REVIEW" : "UNSUPPORTED", severity: "HIGH", reason: v.numbersOk ? RISK_REASON[kind] : `${RISK_REASON[kind]}. Number not found in any verified fact`, fact: null };
    } else if (kind === "INTEGRATION") {
      const names = integrationNames(claim, productTokens);
      const facetFor = (n: string, pool: Fact[]) => pool.find((f) => tokens(n).length > 0 && tokens(f.name ?? "").length > 0 && (tokens(f.name ?? "").every((x) => tokens(n).includes(x)) || tokens(n).every((x) => tokens(f.name ?? "").includes(x))));
      const missing = names.filter((n) => !facetFor(n, integrationFacets.filter((f) => f.usable)));
      if (missing.length) {
        const unverified = missing.every((n) => facetFor(n, integrationFacets));
        verdict = unverified
          ? { status: "NEEDS_REVIEW", severity: "HIGH", reason: `Integration not verified: ${missing.join(", ")}`, fact: facetFor(missing[0], integrationFacets) ?? null }
          : { status: "UNSUPPORTED", severity: "HIGH", reason: `Integration not in the knowledge graph: ${missing.join(", ")}`, fact: null };
      } else verdict = generalVerdict(v, a, line, viaOther);
    } else if (kind === "COMPETITOR" && line.mode === "full") {
      const ok = (s: Support) => s.best?.kind === "comparison" && s.bestScore >= 0.5 && s.numbersOk;
      if (ok(v)) verdict = { status: "SUPPORTED", severity: "LOW", fact: v.best };
      else if (ok(a)) verdict = { status: "NEEDS_REVIEW", severity: "HIGH", reason: viaOther(a), fact: a.best };
      else verdict = { status: "UNSUPPORTED", severity: "HIGH", reason: "Competitor claim without a sourced, verified comparison fact", fact: null };
    } else verdict = generalVerdict(v, a, line, viaOther);

    // Repurposed derivatives may not introduce numbers the source content does not contain.
    if (sourceNums && verdict.status === "SUPPORTED") {
      const extra = numbersIn(claim).filter((n) => !sourceNums.has(n));
      if (extra.length) verdict = { status: "NEEDS_REVIEW", severity: "MEDIUM", reason: `Number not in the source content: ${extra.join(", ")}`, fact: verdict.fact };
    }

    const ref = verdict.fact ?? (v.bestScore >= 0.4 ? v.best : v.used[0]) ?? null;
    claims.push({
      claim: claim.slice(0, 400),
      status: verdict.status,
      kind,
      severity: verdict.severity,
      location: line.location,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      factRef: ref?.ref,
      // Legacy readers show sourceUrl under the claim: keep the reason there when there is no source.
      sourceUrl: ref?.sourceUrl ?? verdict.reason,
    });
  }
  const counts: Record<ClaimSeverity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of claims) counts[c.severity!]++;
  return { passed: counts.HIGH === 0, claims, checkedAt: now.toISOString(), counts };
}

function generalVerdict(v: Support, a: Support, line: Line, viaOther: (s: Support) => string): Verdict {
  if (line.mode === "headline") {
    // Headings and short lines only need their numbers to come from a verified fact.
    if (v.numbersOk) return { status: "SUPPORTED", severity: "LOW", fact: v.numberFact };
    if (a.numbersOk) return { status: "NEEDS_REVIEW", severity: "HIGH", reason: viaOther(a), fact: a.numberFact };
    return { status: "UNSUPPORTED", severity: "HIGH", reason: "Number not found in any verified fact", fact: null };
  }
  if (v.status === "SUPPORTED") return { status: "SUPPORTED", severity: "LOW", fact: v.numberFact ?? (v.bestScore >= 0.4 ? v.best : v.used[0]) ?? null };
  if (a.status === "SUPPORTED") return { status: "NEEDS_REVIEW", severity: "HIGH", reason: viaOther(a), fact: a.best };
  if (!v.numbersOk) return { status: "UNSUPPORTED", severity: "HIGH", reason: "Number not found in any verified fact", fact: null };
  if (v.status === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", severity: "MEDIUM", reason: "Only partly supported by verified facts", fact: v.best };
  return { status: "UNSUPPORTED", severity: "HIGH", reason: "Not supported by any verified fact", fact: null };
}

/** Severity of a stored claim (checks stored before Phase 2 have none: anything not SUPPORTED blocks). */
export const claimSeverity = (c: ClaimCheck): ClaimSeverity => c.severity ?? (c.status === "SUPPORTED" ? "LOW" : "HIGH");

export function severityCounts(claims: ClaimCheck[]): Record<ClaimSeverity, number> {
  const out: Record<ClaimSeverity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of claims) out[claimSeverity(c)]++;
  return out;
}
