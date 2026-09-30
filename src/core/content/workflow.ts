export type ContentStatus = "IDEA" | "GENERATED" | "FACT_CHECK" | "SEO_CHECK" | "HUMAN_APPROVAL" | "APPROVED" | "PUBLISHED" | "REJECTED";

/**
 * IDEA → GENERATED → FACT_CHECK → SEO_CHECK → HUMAN_APPROVAL → APPROVED → PUBLISHED
 * Editing any version sends the asset back to GENERATED so checks re-run.
 * Only a human with `content:approve` can move HUMAN_APPROVAL → APPROVED and APPROVED → PUBLISHED.
 */
const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  IDEA: ["GENERATED", "REJECTED"],
  GENERATED: ["FACT_CHECK", "REJECTED"],
  FACT_CHECK: ["SEO_CHECK", "GENERATED", "REJECTED"],
  SEO_CHECK: ["HUMAN_APPROVAL", "GENERATED", "REJECTED"],
  HUMAN_APPROVAL: ["APPROVED", "GENERATED", "REJECTED"],
  APPROVED: ["PUBLISHED", "GENERATED", "REJECTED"],
  PUBLISHED: ["GENERATED"],
  REJECTED: ["GENERATED"],
};

export const HUMAN_ONLY: ReadonlySet<ContentStatus> = new Set(["APPROVED", "PUBLISHED"]);

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ContentStatus, to: ContentStatus) {
  if (!canTransition(from, to)) throw new Error(`Invalid content transition ${from} → ${to}`);
}

/** Where automated checks leave an asset. */
export function statusAfterChecks(fact: { passed: boolean }, seo: { passed: boolean }): ContentStatus {
  if (!fact.passed) return "FACT_CHECK";
  if (!seo.passed) return "SEO_CHECK";
  return "HUMAN_APPROVAL";
}

export const PIPELINE: ContentStatus[] = ["IDEA", "GENERATED", "FACT_CHECK", "SEO_CHECK", "HUMAN_APPROVAL", "APPROVED", "PUBLISHED"];
