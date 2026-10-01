import type { Intent } from "@/core/queries/classify";
import { clamp, round, textSimilarity } from "@/core/util/text";
import type { FactRef, PagePlan } from "./plan";
import type { PageType } from "./urls";

export type QualityReport = {
  informationCompleteness: number;
  uniqueness: number;
  factualConfidence: number;
  intentMatch: number;
  duplicateSimilarity: number;
  duplicateOf: string | null;
  usefulness: number;
  publishable: boolean;
  blockers: string[];
};

export const QUALITY_THRESHOLDS = {
  informationCompleteness: 0.7,
  factualConfidence: 0.6,
  maxDuplicateSimilarity: 0.5,
  usefulness: 0.65,
} as const;

const VERIFICATION_WEIGHT: Record<FactRef["verification"], number> = { VERIFIED: 1, UNVERIFIED: 0.55, NEEDS_REVIEW: 0.3, REJECTED: 0 };

const INTENT_FIT: Record<PageType, Partial<Record<Intent, number>>> = {
  PRODUCT: { NAVIGATIONAL: 1, COMMERCIAL: 0.9, TRANSACTIONAL: 0.8, INFORMATIONAL: 0.6 },
  FEATURE: { COMMERCIAL: 0.9, INFORMATIONAL: 0.8, PROBLEM: 0.7 },
  USE_CASE: { PROBLEM: 1, COMMERCIAL: 0.9, INFORMATIONAL: 0.7 },
  INDUSTRY: { COMMERCIAL: 1, INFORMATIONAL: 0.6 },
  AUDIENCE: { COMMERCIAL: 1, INFORMATIONAL: 0.6 },
  INTEGRATION: { COMMERCIAL: 0.9, INFORMATIONAL: 0.8, TRANSACTIONAL: 0.6 },
  COMPARISON: { COMPARISON: 1, ALTERNATIVE: 0.7, COMMERCIAL: 0.6 },
  ALTERNATIVE: { ALTERNATIVE: 1, COMPARISON: 0.7, COMMERCIAL: 0.6 },
  GUIDE: { INFORMATIONAL: 1, PROBLEM: 1 },
  ANSWER: { INFORMATIONAL: 1, PROBLEM: 0.9, TRANSACTIONAL: 0.7, NAVIGATIONAL: 0.6 },
  DOCS: { INFORMATIONAL: 1, NAVIGATIONAL: 0.8 },
  CHANGELOG: { NAVIGATIONAL: 0.8, INFORMATIONAL: 0.8 },
  OTHER: {},
};

export const planFingerprint = (plan: Pick<PagePlan, "title" | "facts">) => [plan.title, ...plan.facts.map((f) => f.text)].join(" ");

/**
 * Publication gate for a planned page. Pages failing any threshold stay in
 * DRAFT with the blockers listed; nothing is auto-published.
 */
export function assessPage(
  plan: PagePlan,
  others: { path: string; fingerprint: string }[],
  targetIntent?: Intent | null,
  body?: string,
): QualityReport {
  const blockers: string[] = [];
  const reqs = plan.requirements;
  const informationCompleteness = reqs.length ? reqs.filter((r) => r.met).length / reqs.length : 0;
  for (const r of reqs) if (!r.met) blockers.push(`Missing: ${r.label}`);

  const usable = plan.facts.filter((f) => f.verification !== "REJECTED");
  const factualConfidence = usable.length
    ? usable.reduce((s, f) => s + VERIFICATION_WEIGHT[f.verification] * (f.sourceUrl ? 1 : 0.7), 0) / usable.length
    : 0;

  const intentMatch = targetIntent ? INTENT_FIT[plan.type][targetIntent] ?? 0.3 : 0.7;

  const mine = body ? `${planFingerprint(plan)} ${body}` : planFingerprint(plan);
  let duplicateSimilarity = 0;
  let duplicateOf: string | null = null;
  for (const o of others) {
    if (o.path === plan.path) continue;
    const s = textSimilarity(mine, o.fingerprint);
    if (s > duplicateSimilarity) {
      duplicateSimilarity = s;
      duplicateOf = o.path;
    }
  }
  const uniqueness = 1 - duplicateSimilarity;
  const depth = clamp(usable.reduce((s, f) => s + f.text.length, 0) / 1200);
  const usefulness = 0.35 * informationCompleteness + 0.25 * factualConfidence + 0.15 * intentMatch + 0.15 * uniqueness + 0.1 * depth;

  if (informationCompleteness < QUALITY_THRESHOLDS.informationCompleteness) blockers.push("Information completeness below threshold");
  if (factualConfidence < QUALITY_THRESHOLDS.factualConfidence) blockers.push("Factual confidence below threshold: verify the underlying facts");
  if (duplicateSimilarity > QUALITY_THRESHOLDS.maxDuplicateSimilarity) blockers.push(`Too similar to ${duplicateOf}`);
  if (usefulness < QUALITY_THRESHOLDS.usefulness) blockers.push("Usefulness score below threshold");

  return {
    informationCompleteness: round(informationCompleteness, 2),
    uniqueness: round(uniqueness, 2),
    factualConfidence: round(factualConfidence, 2),
    intentMatch: round(intentMatch, 2),
    duplicateSimilarity: round(duplicateSimilarity, 2),
    duplicateOf,
    usefulness: round(usefulness, 2),
    publishable: blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
}
