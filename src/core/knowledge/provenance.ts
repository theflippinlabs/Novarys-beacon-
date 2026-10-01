import type { Verification } from "./confidence";

/**
 * Provenance rules for knowledge-graph claims (pure, unit tested).
 *
 * Scalar product fields are stored on `products` (current values) and as
 * per-field claims in `product_claims` (source, verification, verifier,
 * confidence). List facts (facets, pricing, FAQs, proofs, changelog) carry the
 * same provenance columns on their own rows.
 */
export const CLAIM_FIELDS = [
  "category",
  "short_description",
  "full_description",
  "how_it_works",
  "status",
  "release_date",
  "api_available",
  "free_trial",
  "languages",
  "supported_countries",
  "domain",
  "documentation_url",
  "pricing_url",
] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

/** Product property backing each claim field. */
export const CLAIM_PROPERTY = {
  category: "category",
  short_description: "shortDescription",
  full_description: "fullDescription",
  how_it_works: "howItWorks",
  status: "status",
  release_date: "releaseDate",
  api_available: "apiAvailable",
  free_trial: "freeTrial",
  languages: "languages",
  supported_countries: "supportedCountries",
  domain: "domain",
  documentation_url: "documentationUrl",
  pricing_url: "pricingUrl",
} as const satisfies Record<ClaimField, string>;

export const CLAIM_LABELS: Record<ClaimField, string> = {
  category: "Category",
  short_description: "Short description",
  full_description: "Full description",
  how_it_works: "How it works",
  status: "Status",
  release_date: "Release date",
  api_available: "API available",
  free_trial: "Free trial",
  languages: "Languages",
  supported_countries: "Countries",
  domain: "Domain",
  documentation_url: "Documentation",
  pricing_url: "Pricing URL",
};

type ClaimProduct = { [K in (typeof CLAIM_PROPERTY)[ClaimField]]?: unknown };

/**
 * Serialised claim value, or null when the field is empty/unknown (no claim).
 * Must match the SQL backfill in migrations/0008_knowledge_provenance.sql.
 */
export function claimValue(p: ClaimProduct, field: ClaimField): string | null {
  const v = p[CLAIM_PROPERTY[field]];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? v.join(", ") : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s || (field === "status" && s === "UNKNOWN")) return null;
  return s;
}

/** Statuses whose value a human (or the liveness job) has judged; an edit sends them back to review. */
const JUDGED: Verification[] = ["VERIFIED", "OUTDATED", "CONFLICTING"];

/**
 * Verification after an edit. Any change to a verified (or outdated /
 * conflicting) value needs a fresh human review; unverified stays unverified
 * and rejected stays rejected.
 */
export function verificationAfterEdit(current: Verification, changed: boolean): Verification {
  if (!changed) return current;
  return JUDGED.includes(current) ? "NEEDS_REVIEW" : current;
}

/** Whether a verification change also clears the verified stamp. */
export const clearsStamp = (next: Verification) => next !== "VERIFIED";

/**
 * Setting VERIFIED requires a source: either a linked source row or a source
 * URL carried by the claim itself. Returns an error message or null.
 */
export function verificationError(next: Verification, provenance: { sourceId?: string | null; sourceUrl?: string | null }): string | null {
  if (next !== "VERIFIED") return null;
  if (provenance.sourceId || (provenance.sourceUrl && /^https:\/\/\S+$/i.test(provenance.sourceUrl))) return null;
  return "Link a source before verifying: every verified fact must trace back to a source.";
}

export type ConflictCandidate = { id: string; key: string; value: string; sourceId: string | null; verification: Verification };

/**
 * CONFLICTING detection: two claims about the same thing (same key) that
 * disagree on value and come from different sources. Unsourced and rejected
 * claims never create a conflict (there is no second source to disagree with).
 * Returns the ids of every claim involved in a conflict.
 */
export function detectConflicts(claims: ConflictCandidate[]): Set<string> {
  const out = new Set<string>();
  const byKey = new Map<string, ConflictCandidate[]>();
  for (const c of claims) {
    if (!c.sourceId || c.verification === "REJECTED") continue;
    byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  }
  for (const group of byKey.values())
    for (const a of group)
      for (const b of group)
        if (a.id !== b.id && a.sourceId !== b.sourceId && normalizeValue(a.value) !== normalizeValue(b.value)) {
          out.add(a.id);
          out.add(b.id);
        }
  return out;
}

const normalizeValue = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

/** Pricing comparison key and value (plan name; price, currency and interval). */
export function pricingConflictCandidate(p: { id: string; planName: string; priceCents: number | null; currency: string | null; interval: string | null; sourceId: string | null; verification: Verification }): ConflictCandidate {
  return { id: p.id, key: p.planName.trim().toLowerCase(), value: `${p.priceCents ?? "?"}|${p.currency ?? "?"}|${p.interval ?? "?"}`, sourceId: p.sourceId, verification: p.verification };
}

/**
 * Liveness / freshness: the status a claim should move to after a sources
 * check, or null to keep it. Rejected claims are never touched; a claim sourced
 * by a failing source becomes OUTDATED; a VERIFIED claim verified longer than
 * `staleAfterDays` ago becomes OUTDATED. Conflicts take precedence and are
 * handled by `detectConflicts`.
 */
export function outdatedStatus(c: { verification: Verification; verifiedAt: Date | null; sourceFailing: boolean }, now: Date, staleAfterDays: number): Verification | null {
  if (c.verification === "REJECTED" || c.verification === "OUTDATED" || c.verification === "CONFLICTING") return null;
  if (c.sourceFailing) return "OUTDATED";
  if (c.verification === "VERIFIED" && c.verifiedAt && now.getTime() - c.verifiedAt.getTime() > staleAfterDays * 86_400_000) return "OUTDATED";
  return null;
}
