import type { EstimationPower, ImpactEstimate, ImpactTarget } from "@/core/estimate/types";

/**
 * Beacon Brain shared types (see docs/BEACON_BRAIN.md §4). Everything here is
 * plain JSON so reports can be stored (jsonb), sent to the model as data and
 * returned by agent tools.
 */

export const SPECIALISTS = ["technical_seo", "content_knowledge", "ai_visibility", "competitors", "conversion_revenue", "distribution_growth"] as const;
export type SpecialistKey = (typeof SPECIALISTS)[number];
export const isSpecialistKey = (v: unknown): v is SpecialistKey => typeof v === "string" && (SPECIALISTS as readonly string[]).includes(v);

/** English labels (translated at render). */
export const SPECIALIST_LABELS: Record<SpecialistKey, string> = {
  technical_seo: "Technical SEO",
  content_knowledge: "Content and knowledge",
  ai_visibility: "AI visibility and GEO",
  competitors: "Competitors",
  conversion_revenue: "Conversion and revenue",
  distribution_growth: "Distribution and growth",
};

export type Coverage = "MEASURED" | "PARTIAL" | "NOT_CONNECTED";
export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export const SEVERITY_ORDER: FindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const severityRank = (s: FindingSeverity) => SEVERITY_ORDER.indexOf(s);

/** One piece of evidence. Every number a finding shows comes from here (or its estimate). */
export type Evidence = { label: string; value: string; href?: string };

export type FindingAction = { label: string; href: string; kind: "OPEN" | "PROPOSE_RECOMMENDATION" };

export type Finding = {
  /** Stable within a run (specialist key + dedupe key); the LLM refers to findings by id. */
  id: string;
  /** Deduplication key across specialists and runs (e.g. "opp:<uuid>", "seo:audit_missing:<product>"). */
  key: string;
  specialist: SpecialistKey;
  /** English template (entity names and numbers as {vars}), or an opportunity title (runtime English). */
  title: string;
  summary: string;
  vars?: Record<string, string | number>;
  severity: FindingSeverity;
  /** 1 (small) to 5 (large): the last ranking tie-breaker. */
  effort: number;
  evidence: Evidence[];
  action: FindingAction;
  opportunityId?: string;
  productId?: string | null;
  /** What the action targets, for the master estimator (absent: not estimable by construction). */
  target?: ImpactTarget;
  /** Set by the estimation phase. */
  estimate?: ImpactEstimate;
  /** Specialists whose findings were merged into this one. */
  alsoFrom?: SpecialistKey[];
};

export type LlmUsage = { model: string; inputTokens: number; outputTokens: number };

/** A narrative in both interface languages (LLM output, validated). */
export type Narrative = { en: string; fr: string };

export type SpecialistReport = {
  specialist: SpecialistKey;
  coverage: Coverage;
  /** Connections or data that would raise coverage (English). */
  missing: string[];
  findings: Finding[];
  narrative?: Narrative;
  llm?: LlmUsage;
};

export type CoverageMap = Record<SpecialistKey, { coverage: Coverage; missing: string[]; findings: number }>;

export type LlmRunUsage = {
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Why the LLM phase did not run (no key, budget), when it did not. */
  skipped?: string;
  /** Outputs rejected by validation or the number guard (the deterministic version was kept). */
  rejected: { scope: SpecialistKey | "synthesis"; reason: string }[];
};

export type BrainResult = {
  coverage: CoverageMap;
  ranked: Finding[];
  unestimated: Finding[];
  estimationPower: EstimationPower;
  narratives: Partial<Record<SpecialistKey, Narrative>>;
  summary: Narrative | null;
  llm: LlmRunUsage;
};
