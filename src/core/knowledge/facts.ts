import { formatMoney } from "@/core/util/text";
import { claimVerification, currentClaim, verifiedOnly, type FacetKind, type ProductGraph } from "./types";
import type { ClaimField } from "./provenance";

/**
 * Verification states a fact can carry. VERIFIED is the only state that can
 * reach publishable content; UNVERIFIED, NEEDS_REVIEW, OUTDATED and
 * CONFLICTING are all treated as "not verified"; REJECTED facts never appear.
 */
export type FactVerification = "VERIFIED" | "UNVERIFIED" | "NEEDS_REVIEW" | "OUTDATED" | "CONFLICTING" | "REJECTED";
export type FactKind = "product" | "facet" | "pricing" | "faq" | "proof" | "changelog" | "comparison";

export type GraphFact = {
  ref: string;
  kind: FactKind;
  text: string;
  sourceUrl?: string;
  verification: FactVerification;
  /** True only for VERIFIED facts. */
  verified: boolean;
  /** When a human last verified the fact (ISO), when known. */
  verifiedAt: string | null;
  facetKind?: FacetKind;
  name?: string;
  pricing?: { planName: string; priceCents: number | null; currency: string | null; interval: string | null; trialDays: number | null };
};

const KNOWN: ReadonlySet<string> = new Set(["VERIFIED", "UNVERIFIED", "NEEDS_REVIEW", "OUTDATED", "CONFLICTING", "REJECTED"]);

/** Reads a verification status, tolerating rows without the column (treated as UNVERIFIED) and unknown values. */
export function verificationOf(row: object): FactVerification {
  const v = (row as { verification?: unknown }).verification;
  return typeof v === "string" && KNOWN.has(v) ? (v as FactVerification) : "UNVERIFIED";
}

/** Best known verification timestamp of a row (explicit verification columns first, then the last update). */
function verifiedAtOf(row: object): string | null {
  const r = row as Record<string, unknown>;
  for (const k of ["verifiedAt", "lastVerifiedAt", "updatedAt", "createdAt"]) {
    const v = r[k];
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * The one fact flattener (used by the fact checker, the LLM prompt and the
 * page planner). Every fact carries its verification status; REJECTED facts
 * are always excluded. With `verifiedOnly`, only VERIFIED facts are returned.
 */
export function graphFacts(g: ProductGraph, opts: { verifiedOnly?: boolean } = {}): GraphFact[] {
  const p = g.product;
  // No implicit https://domain source: only a WEBSITE source row a human linked can back an unsourced product field.
  const home = g.sources.find((s) => s.kind === "WEBSITE")?.url;
  const srcUrl = (id: string | null) => (id ? g.sources.find((s) => s.id === id)?.url : undefined);
  const facts: GraphFact[] = [];
  const add = (f: Omit<GraphFact, "verified">) => {
    if (f.verification === "REJECTED") return;
    facts.push({ ...f, verified: f.verification === "VERIFIED" });
  };
  // Scalar product fields: per-field claims (product_claims), legacy products fall back to lastVerifiedAt.
  const product = (field: ClaimField, text: string, sourceUrl?: string) => {
    const claim = currentClaim(g, field);
    const verifiedAt = claim?.verifiedAt ?? (g.claims?.length ? null : p.lastVerifiedAt);
    add({ ref: `product:${field}`, kind: "product", text, sourceUrl: (claim?.sourceId ? srcUrl(claim.sourceId) : undefined) ?? sourceUrl, verification: verificationOf({ verification: claimVerification(g, field) }), verifiedAt: verifiedAt ? verifiedAt.toISOString() : null });
  };

  if (p.shortDescription) product("short_description", p.shortDescription, home);
  if (p.fullDescription) product("full_description", p.fullDescription, home);
  if (p.howItWorks) product("how_it_works", p.howItWorks, p.documentationUrl ?? home);
  if (p.category) product("category", `${p.name} ${p.category}`, home);
  for (const f of g.facets)
    add({ ref: `facet:${f.id}`, kind: "facet", facetKind: f.kind, name: f.name, text: `${f.name} ${f.description ?? ""}`.trim(), sourceUrl: srcUrl(f.sourceId), verification: verificationOf(f), verifiedAt: verifiedAtOf(f) });
  for (const x of g.pricing) {
    const price = x.priceCents !== null ? `${x.currency ? formatMoney(x.priceCents, x.currency) : ""} ${(x.priceCents / 100).toFixed(2)} ${x.priceCents / 100}` : "";
    const trial = x.trialDays ? `${x.trialDays}-day trial ${x.trialDays} day` : "";
    add({
      ref: `pricing:${x.id}`,
      kind: "pricing",
      name: x.planName,
      text: `${x.planName} ${price} ${trial} ${x.description ?? ""}`.replace(/\s+/g, " ").trim(),
      sourceUrl: srcUrl(x.sourceId) ?? p.pricingUrl ?? undefined,
      verification: verificationOf(x),
      verifiedAt: verifiedAtOf(x),
      pricing: { planName: x.planName, priceCents: x.priceCents, currency: x.currency, interval: x.interval, trialDays: x.trialDays },
    });
  }
  for (const f of g.faqs) add({ ref: `faq:${f.id}`, kind: "faq", text: `${f.question} ${f.answer}`, sourceUrl: srcUrl(f.sourceId), verification: verificationOf(f), verifiedAt: verifiedAtOf(f) });
  // Proofs need explicit permission to publish; unverified proofs are listed (so they show as "needs verification"), never as support.
  for (const pr of g.proofs.filter((x) => x.publishable))
    add({ ref: `proof:${pr.id}`, kind: "proof", text: `${pr.title} ${pr.content} ${pr.attribution ?? ""}`.trim(), sourceUrl: srcUrl(pr.sourceId), verification: verificationOf(pr), verifiedAt: verifiedAtOf(pr) });
  // Changelog entries are verified only when their row says so (rows without a verification column count as unverified).
  for (const c of g.changelog)
    add({ ref: `changelog:${c.id}`, kind: "changelog", text: `${c.version ?? ""} ${c.releasedOn} ${c.title} ${c.body ?? ""}`.trim(), sourceUrl: srcUrl(c.sourceId), verification: verificationOf(c), verifiedAt: verifiedAtOf(c) });
  for (const pc of g.competitors)
    pc.comparisonFacts.forEach((cf, i) =>
      add({
        ref: `comparison:${pc.competitorId}:${i}`,
        kind: "comparison",
        name: pc.competitor.name,
        text: `${pc.competitor.name} ${cf.dimension} ${cf.product} ${cf.competitor}`,
        sourceUrl: cf.sourceUrl || undefined,
        verification: cf.verifiedAt && cf.sourceUrl ? "VERIFIED" : "UNVERIFIED",
        verifiedAt: cf.verifiedAt || null,
      }),
    );
  return opts.verifiedOnly ? facts.filter((f) => f.verified) : facts;
}

/** First fact per ref (graphFacts never returns duplicates, but callers index by ref). */
export function factsByRef(facts: GraphFact[]): Map<string, GraphFact> {
  const m = new Map<string, GraphFact>();
  for (const f of facts) if (!m.has(f.ref)) m.set(f.ref, f);
  return m;
}

/**
 * The graph content generation may use for anything that can be published:
 * VERIFIED facts only (product descriptions need a product verification,
 * proofs need explicit permission, comparisons need a source and a
 * verification date, changelog entries need a VERIFIED status).
 */
export function publishableGraph(g: ProductGraph): ProductGraph {
  const v = verifiedOnly(g);
  // Defensive: rows without a verification column never count as verified.
  return { ...v, changelog: v.changelog.filter((c) => verificationOf(c) === "VERIFIED") };
}

/**
 * Restricts a graph to the facts a source asset was built from (repurposing):
 * anything whose ref is not in `refs` is removed. Product identity (name,
 * domain, conversion URLs) is kept because it is not a factual claim.
 */
export function restrictGraph(g: ProductGraph, refs: Iterable<string>): ProductGraph {
  const allowed = new Set(refs);
  const keep = (ref: string) => allowed.has(ref);
  const p = g.product;
  return {
    ...g,
    product: {
      ...p,
      shortDescription: keep("product:short_description") ? p.shortDescription : null,
      fullDescription: keep("product:full_description") ? p.fullDescription : null,
      howItWorks: keep("product:how_it_works") ? p.howItWorks : null,
      category: keep("product:category") ? p.category : null,
    },
    facets: g.facets.filter((f) => keep(`facet:${f.id}`)),
    pricing: g.pricing.filter((x) => keep(`pricing:${x.id}`)),
    faqs: g.faqs.filter((x) => keep(`faq:${x.id}`)),
    proofs: g.proofs.filter((x) => keep(`proof:${x.id}`)),
    changelog: g.changelog.filter((x) => keep(`changelog:${x.id}`)),
    competitors: g.competitors
      .map((c) => ({ ...c, comparisonFacts: c.comparisonFacts.map((f, i) => (keep(`comparison:${c.competitorId}:${i}`) ? f : null)).filter((f): f is NonNullable<typeof f> => f !== null) }))
      .filter((c) => c.comparisonFacts.length > 0),
  };
}
