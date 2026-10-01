/**
 * Claim confidence (0..1), derived, never typed in by hand.
 *
 *   confidence = statusFactor(verification) x sourceFactor(source) x ageFactor(verifiedAt)
 *
 * statusFactor: VERIFIED 1, NEEDS_REVIEW 0.5, UNVERIFIED 0.4, OUTDATED 0.2,
 *   CONFLICTING 0.1, REJECTED 0 (a human's verdict is the strongest signal).
 * sourceFactor: no source 0.5; first-party reference pages (PRICING,
 *   DOCUMENTATION, CHANGELOG, LEGAL) 1; WEBSITE and REPOSITORY 0.9; CASE_STUDY
 *   and PRESS 0.8; OTHER 0.7. A source whose last liveness checks failed
 *   (4xx/5xx/unreachable) halves it.
 * ageFactor: only for VERIFIED claims. 1 up to FRESH_DAYS after verification,
 *   then linear down to 0.5 at `staleAfterDays` (and 0.5 beyond). A verified
 *   claim without a recorded verification date (legacy data) gets 0.5.
 *
 * The result is rounded to two decimals. All factors are exported so the UI
 * can show the formula with the same numbers.
 */
export type Verification = "UNVERIFIED" | "NEEDS_REVIEW" | "VERIFIED" | "REJECTED" | "OUTDATED" | "CONFLICTING";
export type SourceKind = "WEBSITE" | "DOCUMENTATION" | "PRICING" | "CHANGELOG" | "CASE_STUDY" | "PRESS" | "REPOSITORY" | "LEGAL" | "OTHER";

export const STATUS_FACTOR: Record<Verification, number> = { VERIFIED: 1, NEEDS_REVIEW: 0.5, UNVERIFIED: 0.4, OUTDATED: 0.2, CONFLICTING: 0.1, REJECTED: 0 };
export const NO_SOURCE_FACTOR = 0.5;
export const SOURCE_KIND_FACTOR: Record<SourceKind, number> = {
  PRICING: 1,
  DOCUMENTATION: 1,
  CHANGELOG: 1,
  LEGAL: 1,
  WEBSITE: 0.9,
  REPOSITORY: 0.9,
  CASE_STUDY: 0.8,
  PRESS: 0.8,
  OTHER: 0.7,
};
export const FAILING_SOURCE_PENALTY = 0.5;
export const FRESH_DAYS = 30;
export const MIN_AGE_FACTOR = 0.5;
export const DEFAULT_STALE_AFTER_DAYS = 180;
/** Consecutive failed liveness checks after which a source counts as failing. */
export const FAILING_AFTER_CHECKS = 2;

export type ConfidenceInput = {
  verification: Verification;
  source: { kind: SourceKind; failing?: boolean } | null;
  verifiedAt: Date | null;
  now?: Date;
  staleAfterDays?: number;
};

export function ageFactor(verifiedAt: Date | null, now: Date, staleAfterDays = DEFAULT_STALE_AFTER_DAYS): number {
  if (!verifiedAt) return MIN_AGE_FACTOR;
  const age = Math.max(0, (now.getTime() - verifiedAt.getTime()) / 86_400_000);
  if (age <= FRESH_DAYS) return 1;
  const span = Math.max(1, staleAfterDays - FRESH_DAYS);
  return Math.max(MIN_AGE_FACTOR, 1 - ((age - FRESH_DAYS) / span) * (1 - MIN_AGE_FACTOR));
}

export function sourceFactor(source: ConfidenceInput["source"]): number {
  if (!source) return NO_SOURCE_FACTOR;
  return SOURCE_KIND_FACTOR[source.kind] * (source.failing ? FAILING_SOURCE_PENALTY : 1);
}

export function computeConfidence(i: ConfidenceInput): number {
  const now = i.now ?? new Date();
  const age = i.verification === "VERIFIED" ? ageFactor(i.verifiedAt, now, i.staleAfterDays) : 1;
  return Math.round(STATUS_FACTOR[i.verification] * sourceFactor(i.source) * age * 100) / 100;
}

/** A source is failing after FAILING_AFTER_CHECKS consecutive failed checks. */
export const isFailingSource = (s: { consecutiveFailures?: number | null }) => (s.consecutiveFailures ?? 0) >= FAILING_AFTER_CHECKS;
