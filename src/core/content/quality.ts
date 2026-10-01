import type { ClaimCheck, QualityCheck } from "@/db/schema";
import { classifyQuery, type Intent } from "@/core/queries/classify";
import { round, shingles, jaccard, tokens } from "@/core/util/text";
import { WEB_CONTENT_TYPES, type ContentType } from "./types";

/**
 * Body-based content quality gate (every content type), stored per version
 * and enforced at approval and publication. It measures the text that will
 * actually be published, not the plan it came from.
 */
export const CONTENT_QUALITY_THRESHOLDS = {
  /** 3-word shingle Jaccard similarity with another current or published asset. */
  maxDuplicateSimilarity: 0.7,
  /** Share of all words taken by the most frequent non-brand content term (bodies of 150+ words). */
  maxTermDensity: 0.08,
  /** Generic AI filler phrases tolerated. */
  maxFillerPhrases: 1,
  /** Share of 4-word sequences that repeat an earlier one (bodies of 60+ words). */
  maxRepetition: 0.2,
  /** Share of claims that are not SUPPORTED. */
  maxUnsupportedRatio: 0.25,
  /** Intent fit of the format for the target query's intent. */
  minIntentFit: 0.5,
  /** Unique verified facts used per 100 words (web formats of 100+ words). */
  minFactsPer100Words: 1,
} as const;

/** Generic, low-information phrases typical of unedited AI text (English and French). */
export const FILLER_PHRASES = [
  "in today's fast-paced world",
  "in today's digital age",
  "in the ever-evolving",
  "it's important to note",
  "it is important to note",
  "it's worth noting",
  "in conclusion",
  "game-changer",
  "game changer",
  "unlock the power",
  "unlock the full potential",
  "harness the power",
  "unleash",
  "seamlessly",
  "cutting-edge",
  "to the next level",
  "look no further",
  "delve into",
  "dive into",
  "elevate your",
  "revolutionize",
  "whether you're a",
  "a testament to",
  "plays a crucial role",
  "navigate the complexities",
  "embark on",
  "dans le monde d'aujourd'hui",
  "à l'ère du numérique",
  "il est important de noter",
  "il convient de noter",
  "en conclusion",
  "véritable game changer",
  "libérez le potentiel",
  "exploitez la puissance",
  "révolutionner",
  "sans effort",
  "de pointe",
  "au niveau supérieur",
  "ne cherchez plus",
  "plongeons dans",
  "en constante évolution",
  "joue un rôle crucial",
] as const;

const INTENT_FIT: Partial<Record<ContentType, Partial<Record<Intent, number>>>> = {
  LANDING_PAGE: { NAVIGATIONAL: 1, COMMERCIAL: 1, TRANSACTIONAL: 0.9, PROBLEM: 0.7, INFORMATIONAL: 0.6, ALTERNATIVE: 0.5, COMPARISON: 0.4 },
  ARTICLE: { INFORMATIONAL: 1, PROBLEM: 1, COMMERCIAL: 0.7, COMPARISON: 0.6, ALTERNATIVE: 0.6, TRANSACTIONAL: 0.4, NAVIGATIONAL: 0.4 },
  TUTORIAL: { INFORMATIONAL: 1, PROBLEM: 1, NAVIGATIONAL: 0.6, COMMERCIAL: 0.5, TRANSACTIONAL: 0.4 },
  FAQ: { INFORMATIONAL: 1, PROBLEM: 0.9, TRANSACTIONAL: 0.8, NAVIGATIONAL: 0.7, COMMERCIAL: 0.7, COMPARISON: 0.5, ALTERNATIVE: 0.5 },
  COMPARISON: { COMPARISON: 1, ALTERNATIVE: 0.9, COMMERCIAL: 0.7, INFORMATIONAL: 0.4 },
  RELEASE_ANNOUNCEMENT: { NAVIGATIONAL: 0.8, INFORMATIONAL: 0.8, COMMERCIAL: 0.5 },
};

export type QualityInput = {
  type: ContentType;
  body: string;
  targetQuery?: string | null;
  brandTerms?: string[];
  /** Fact check of this very body. */
  claims: ClaimCheck[];
  /** The organisation's other current versions and published pages. */
  others: { label: string; body: string }[];
  now?: Date;
};

/** Visible prose only: no markdown syntax, URLs, CTA markers or editor notes. */
export function proseOf(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*(\|---|- <https?:|> TODO\(editor\):)/.test(l))
    .join("\n")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\{cta:[^}]*\}|\{\{[^}]*\}\}/g, " ")
    .replace(/[#*_>|`[\]()]/g, " ");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function fillerHits(text: string): string[] {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return FILLER_PHRASES.filter((p) => t.includes(p));
}

/** Share of 4-word sequences that repeat an earlier one. */
export function repetitionRatio(text: string, n = 4): number {
  const t = tokens(text, { keepStop: true });
  if (t.length < n + 1) return 0;
  const seen = new Set<string>();
  let repeated = 0;
  const total = t.length - n + 1;
  for (let i = 0; i < total; i++) {
    const g = t.slice(i, i + n).join(" ");
    if (seen.has(g)) repeated++;
    else seen.add(g);
  }
  return repeated / total;
}

/** Most frequent non-brand content term and its share of all words. */
export function topTermDensity(text: string, brandTerms: string[] = []): { term: string | null; density: number } {
  const all = tokens(text, { keepStop: true });
  if (!all.length) return { term: null, density: 0 };
  const brand = new Set(brandTerms.flatMap((b) => tokens(b)));
  const counts = new Map<string, number>();
  for (const t of tokens(text)) if (!brand.has(t) && !/^\d/.test(t) && t.length > 2) counts.set(t, (counts.get(t) ?? 0) + 1);
  let term: string | null = null;
  let max = 0;
  for (const [k, v] of counts)
    if (v > max) {
      max = v;
      term = k;
    }
  return { term, density: max / all.length };
}

export function intentFit(type: ContentType, targetQuery: string | null | undefined, brandTerms: string[] = []): { intent: Intent | null; fit: number | null } {
  if (!targetQuery?.trim() || !INTENT_FIT[type]) return { intent: null, fit: null };
  const { intent } = classifyQuery(targetQuery, brandTerms);
  return { intent, fit: INTENT_FIT[type]![intent] ?? 0.3 };
}

export function assessContentQuality(input: QualityInput): QualityCheck {
  const T = CONTENT_QUALITY_THRESHOLDS;
  const prose = proseOf(input.body);
  const words = wordCount(prose);
  const checks: QualityCheck["checks"] = [];
  const add = (rule: string, ok: boolean, message: string) => checks.push({ rule, ok, message });
  const web = WEB_CONTENT_TYPES.has(input.type);

  // Near-duplicate against the organisation's other current versions and published pages.
  const mine = shingles(prose, 3);
  let duplicateSimilarity = 0;
  let duplicateOf: string | null = null;
  for (const o of input.others) {
    const s = jaccard(mine, shingles(proseOf(o.body), 3));
    if (s > duplicateSimilarity) {
      duplicateSimilarity = s;
      duplicateOf = o.label;
    }
  }
  add("near_duplicate", duplicateSimilarity <= T.maxDuplicateSimilarity, duplicateOf && duplicateSimilarity > T.maxDuplicateSimilarity ? `Near-duplicate of “${duplicateOf}” (${Math.round(duplicateSimilarity * 100)}% similar).` : `Highest similarity with other content ${Math.round(duplicateSimilarity * 100)}% (maximum ${Math.round(T.maxDuplicateSimilarity * 100)}%).`);

  const { term, density } = topTermDensity(prose, input.brandTerms);
  const densityApplies = words >= 150;
  add("keyword_stuffing", !densityApplies || density <= T.maxTermDensity, densityApplies ? `Most repeated term “${term ?? ""}” is ${(density * 100).toFixed(1)}% of words (maximum ${T.maxTermDensity * 100}%).` : "Too short to measure keyword stuffing.");

  const filler = fillerHits(prose);
  add("generic_filler", filler.length <= T.maxFillerPhrases, filler.length ? `Generic filler phrases: ${filler.join(", ")}.` : "No generic filler phrases.");

  const repetition = repetitionRatio(prose);
  const repetitionApplies = tokens(prose, { keepStop: true }).length >= 60;
  add("repetition", !repetitionApplies || repetition <= T.maxRepetition, repetitionApplies ? `${Math.round(repetition * 100)}% of 4-word sequences repeat (maximum ${Math.round(T.maxRepetition * 100)}%).` : "Too short to measure repetition.");

  const claims = input.claims;
  const unsupported = claims.filter((c) => c.status !== "SUPPORTED").length;
  const unsupportedRatio = claims.length ? unsupported / claims.length : 0;
  add("unsupported_claims", unsupportedRatio <= T.maxUnsupportedRatio, `${unsupported} of ${claims.length} claims not supported by verified facts (maximum ${Math.round(T.maxUnsupportedRatio * 100)}%).`);

  const { intent, fit } = intentFit(input.type, input.targetQuery, input.brandTerms);
  add("intent_fit", fit === null || fit >= T.minIntentFit, fit === null ? "No target query, or intent fit does not apply to this format." : `Target query intent ${intent}: fit ${Math.round(fit * 100)}% for this format (minimum ${Math.round(T.minIntentFit * 100)}%).`);

  const verifiedRefs = new Set(claims.filter((c) => c.status === "SUPPORTED" && c.factRef).map((c) => c.factRef!));
  const per100 = words ? (verifiedRefs.size / words) * 100 : 0;
  const originalApplies = web && words >= 100;
  add(
    "original_information",
    originalApplies ? per100 >= T.minFactsPer100Words : verifiedRefs.size >= 1,
    originalApplies ? `${verifiedRefs.size} unique verified facts, ${per100.toFixed(1)} per 100 words (minimum ${T.minFactsPer100Words}).` : `${verifiedRefs.size} unique verified fact(s) used (minimum 1).`,
  );

  return {
    passed: checks.every((c) => c.ok),
    checks,
    metrics: {
      words,
      duplicateSimilarity: round(duplicateSimilarity, 2),
      termDensity: round(density, 3),
      fillerPhrases: filler.length,
      repetition: round(repetition, 2),
      unsupportedRatio: round(unsupportedRatio, 2),
      intentFit: fit === null ? null : round(fit, 2),
      factsPer100Words: round(per100, 2),
      uniqueVerifiedFacts: verifiedRefs.size,
    },
    duplicateOf: duplicateSimilarity > T.maxDuplicateSimilarity ? duplicateOf : null,
    checkedAt: (input.now ?? new Date()).toISOString(),
  };
}
