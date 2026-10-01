import type { LearningTally } from "@/core/autopilot/loop";
import type { EstimateConfidence, EstimateUnit, NotEstimable, EstimateInput } from "./types";

/**
 * Everything the estimators need for one organisation, loaded once by
 * `loadEstimationContext` (src/services/estimates.ts). Plain JSON data: the
 * estimators are pure functions of it.
 *
 * Scopes: per-product data is keyed by product id; `ORG_SCOPE` holds the
 * organisation-wide figures (used when an estimate's productId is null).
 */
export const ORG_SCOPE = "org";
export const scopeKey = (productId: string | null | undefined) => productId ?? ORG_SCOPE;

/** Clicks and impressions of query rows whose daily position fell in one position bucket. */
export type BucketTally = { bucket: string; clicks: number; impressions: number };

/** One tracked query's search metrics over the last `search.windowDays` days of its product's data. */
export type QuerySearch = { productId: string | null; query: string; clicks: number; impressions: number; position: number | null };

/** Tracked people: those with a page view (visitors) and those of them with a signup (converters). */
export type RateTally = { visitors: number; converters: number };

export type ConversionScope = { all: RateTally; byChannel: Record<string, RateTally> };

/**
 * Converting identities (signup in the window) and, per currency, the net
 * revenue to date of each of them who paid (refunds deducted, positive only).
 * Converters without revenue in a currency count as 0 for that currency.
 */
export type ValueScope = { converters: number; byCurrency: Record<string, number[]> };

export type AiScope = { samples: number; mentioned: number; competitors: { id: string; name: string; mentioned: number }[] };

export type EstimationContext = {
  organizationId: string;
  /** ISO day the context was loaded. */
  asOf: string;
  search: {
    /** A Search Console or Bing Webmaster integration is connected (any scope). */
    connected: boolean;
    /** The organisation's CTR by position bucket (all products), over `curveDays` days. */
    curve: BucketTally[];
    curveDays: number;
    /** Window of the per-query metrics (30 days). */
    windowDays: number;
    /** Per tracked query id. Queries without search rows are absent. */
    queries: Record<string, QuerySearch>;
  };
  conversion: {
    /** At least one first-party tracker event exists for the organisation. */
    tracked: boolean;
    windowDays: number;
    byScope: Record<string, ConversionScope>;
  };
  value: {
    /** At least one revenue event exists (Stripe or the revenue API). */
    connected: boolean;
    windowDays: number;
    byScope: Record<string, ValueScope>;
  };
  /** autopilot_learning tallies per opportunity type (organisation-wide). */
  learning: Record<string, LearningTally>;
  ai: {
    /** At least one AI visibility test exists. */
    tested: boolean;
    windowDays: number;
    byScope: Record<string, AiScope>;
  };
};

/** An empty context (nothing connected): every estimator says what is missing. */
export function emptyContext(organizationId: string, asOf = new Date().toISOString().slice(0, 10)): EstimationContext {
  return {
    organizationId,
    asOf,
    search: { connected: false, curve: [], curveDays: 90, windowDays: 30, queries: {} },
    conversion: { tracked: false, windowDays: 90, byScope: {} },
    value: { connected: false, windowDays: 365, byScope: {} },
    learning: {},
    ai: { tested: false, windowDays: 90, byScope: {} },
  };
}

/** Missing items (stable English strings, translated at render). */
export const MISSING = {
  search: "Search Console or Bing Webmaster Tools",
  curve: "Search data: 5 position buckets with 100+ impressions",
  targetBucket: "Search data: 100+ impressions at the target position",
  queryData: "Search impressions for the target queries",
  tracker: "Beacon tracker events",
  visitors: "50+ tracked visitors",
  revenue: "Revenue source (Stripe or the revenue API)",
  payers: "5+ paying conversions",
  outcomes: "3+ measured outcomes for this opportunity type",
  aiTests: "AI visibility tests",
  aiSamples: "10+ sampled AI answers",
} as const;

/** Thresholds below which an estimator is NOT_ESTIMABLE (docs/BEACON_BRAIN.md §3). */
export const THRESHOLDS = {
  /** Impressions a position bucket needs to count as measured. */
  bucketImpressions: 100,
  /** Measured position buckets needed to fit the CTR curve. */
  curveBuckets: 5,
  visitors: 50,
  payers: 5,
  outcomes: 3,
  aiSamples: 10,
} as const;

export function notEstimable(key: string, label: string, unit: EstimateUnit, reason: string, missing: string[], inputs: EstimateInput[] = []): NotEstimable {
  return { key, label, unit, state: "NOT_ESTIMABLE", reason, missing, inputs };
}

const RANK: Record<EstimateConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Lowest of several confidences (a chain is only as reliable as its weakest link). */
export function minConfidence(...cs: EstimateConfidence[]): EstimateConfidence {
  return cs.reduce<EstimateConfidence>((a, c) => (RANK[c] < RANK[a] ? c : a), "HIGH");
}

/** Replace `{name}` placeholders (English templates that also exist in the French dictionary). */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Round for display inside stored strings and inputs (no false precision). */
export function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
