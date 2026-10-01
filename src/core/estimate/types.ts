/**
 * Estimator contract (see docs/BEACON_BRAIN.md). Estimates use only this
 * organisation's measured data or its own history: no benchmark, no default
 * rate. When data is insufficient an estimator says so (NOT_ESTIMABLE) and
 * names what is missing.
 */

export type EstimateUnit = "visits" | "clicks" | "signups" | "conversions" | "money_minor" | "ratio" | "probability" | "mentions";

export type InputSource = "MEASURED" | "ORG_HISTORY";

export type EstimateInput = {
  name: string;
  value: number | string;
  source: InputSource;
  detail: string;
  sampleSize?: number;
  /** How to display a numeric `value` (e.g. "ratio" renders as a percentage). */
  unit?: EstimateUnit;
  /** Money inputs only (ISO 4217). */
  currency?: string;
};

export type EstimateConfidence = "LOW" | "MEDIUM" | "HIGH";

export type EstimatedValue = {
  key: string;
  label: string;
  unit: EstimateUnit;
  /** Money only (ISO 4217); currencies are never mixed. */
  currency?: string;
  state: "ESTIMATED";
  /** 80% interval and median. */
  p10: number;
  p50: number;
  p90: number;
  horizonDays: number;
  confidence: EstimateConfidence;
  /** Plain-language formula, English (translated at render). */
  method: string;
  inputs: EstimateInput[];
};

export type NotEstimable = {
  key: string;
  label: string;
  unit: EstimateUnit;
  state: "NOT_ESTIMABLE";
  /** Money only: the currency this estimate would be in. */
  currency?: string;
  /** What is missing, English. */
  reason: string;
  /** Connections or data needed, e.g. "Search Console", "50 tracked visitors". */
  missing: string[];
  /** What was available. */
  inputs: EstimateInput[];
};

export type Estimate = EstimatedValue | NotEstimable;

/** What an action targets, for the master estimator. */
export type ImpactTarget = {
  productId: string | null;
  /** Queries the action would improve (search traffic chain). */
  queryIds?: string[];
  /** Target average position for those queries (default 3). */
  targetPosition?: number;
  /** Opportunity type, for the success probability. */
  opportunityType?: string;
  /** Horizon in days (default 90). */
  horizonDays?: number;
};

/** The master estimator's result: the chain it could compute plus what would unlock the rest. */
export type ImpactEstimate = {
  /** Expected extra signups (or conversions) over the horizon. */
  signups: Estimate;
  /** Expected extra revenue per currency (empty when no revenue data). */
  revenue: Estimate[];
  /** Every intermediate estimate (traffic potential, conversion rate, success probability, value per conversion). */
  parts: Estimate[];
  /** The deepest quantity estimated: "clicks", "signups", "revenue" or "none". */
  reached: "none" | "clicks" | "signups" | "revenue";
  missing: string[];
};

/** Which inputs this organisation can estimate with, and the connection that would unlock the most. */
export type EstimationPower = {
  measured: string[];
  missing: string[];
  /**
   * e.g. { connect: "Search Console", unlocks: 14 }: `unlocks` counts the
   * targets whose expected impact chain is blocked by this item (it is in
   * their missing list), `completes` those for which it is the only item
   * missing (connecting it alone makes the chain estimable).
   */
  bestNextConnection: { connect: string; unlocks: number; completes?: number } | null;
  /** Every missing item with its counts, best first. */
  ranking?: { connect: string; unlocks: number; completes: number }[];
};
