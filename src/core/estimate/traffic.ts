import { POSITION_BUCKETS, positionBucket } from "@/core/search/insights";
import { MISSING, THRESHOLDS, fmt, notEstimable, round, type BucketTally, type EstimationContext, type QuerySearch } from "./context";
import { memo } from "./memo";
import { betaDraws, DRAWS, interval, isotonicDecreasing } from "./stats";
import type { Estimate, EstimateConfidence, EstimateInput } from "./types";

export const TRAFFIC_KEY = "traffic_potential";
export const TRAFFIC_LABEL = "Extra clicks per 30 days";
export const TRAFFIC_METHOD =
  "Extra clicks per 30 days = sum over the target queries ranked below the target position of max(0, impressions × CTR at the target position − current clicks). The CTR by position curve is fitted on this organisation's own search data (Beta posterior per position bucket, monotone fit, 2,000 draws); impressions are held at their current level.";

/** Default target position when an action does not set one. */
export const DEFAULT_TARGET_POSITION = 3;

const BUCKET_ORDER = POSITION_BUCKETS.map((b) => b.key);
const bucketIndex = (key: string) => BUCKET_ORDER.indexOf(key as (typeof BUCKET_ORDER)[number]);

export type CtrCurve = {
  /** Measured buckets (100+ impressions), best position first. */
  buckets: (BucketTally & { fitted: number })[];
  /** Monotone curve draws: draws[i][j] is the CTR of buckets[j] in draw i. */
  draws: Float64Array[];
};

/** Buckets with enough impressions to be used, in position order. */
export function measuredBuckets(curve: BucketTally[]): BucketTally[] {
  return BUCKET_ORDER.map((k) => curve.find((b) => b.bucket === k)).filter((b): b is BucketTally => Boolean(b && b.impressions >= THRESHOLDS.bucketImpressions));
}

/**
 * Fit the organisation's CTR by position curve: per measured bucket a Beta
 * posterior (uniform prior) on its CTR, made non-increasing in position by
 * weighted isotonic regression (weights: impressions). The point curve uses
 * posterior means; each Monte Carlo draw is fitted the same way.
 * Returns null when fewer than 5 buckets are measured.
 */
export function fitCtrCurve(curve: BucketTally[], seedKey = "curve"): CtrCurve | null {
  const buckets = measuredBuckets(curve);
  if (buckets.length < THRESHOLDS.curveBuckets) return null;
  const weights = buckets.map((b) => b.impressions);
  const means = buckets.map((b) => (Math.min(b.clicks, b.impressions) + 1) / (b.impressions + 2));
  const fitted = isotonicDecreasing(means, weights);
  const perBucket = buckets.map((b) => {
    const c = Math.min(b.clicks, b.impressions);
    return betaDraws(`${seedKey}|ctr|${b.bucket}|${c}|${b.impressions}`, c + 1, b.impressions - c + 1);
  });
  const draws: Float64Array[] = [];
  for (let i = 0; i < DRAWS; i++) draws.push(Float64Array.from(isotonicDecreasing(perBucket.map((d) => d[i]), weights)));
  return { buckets: buckets.map((b, j) => ({ ...b, fitted: fitted[j] })), draws };
}

function curveFor(ctx: EstimationContext): CtrCurve | null {
  return memo(ctx, "ctr-curve", () => fitCtrCurve(ctx.search.curve, `${ctx.organizationId}|${ctx.search.curveDays}`));
}

export type TrafficTarget = { productId: string | null; queryIds?: string[]; targetPosition?: number };

export type TrafficModel = { estimate: Estimate; draws: Float64Array | null };

function confidence(targetImpressions: number, buckets: number, queryImpressions: number): EstimateConfidence {
  if (targetImpressions < 1000 || queryImpressions < 100) return "LOW";
  if (targetImpressions >= 10_000 && buckets >= 6 && queryImpressions >= 1000) return "HIGH";
  return "MEDIUM";
}

/** Traffic potential with its Monte Carlo draws (extra clicks per 30 days), for the master estimator. */
export function trafficModel(ctx: EstimationContext, target: TrafficTarget): TrafficModel {
  const unit = "clicks" as const;
  const ne = (reason: string, missing: string[], inputs: EstimateInput[] = []): TrafficModel => ({ estimate: notEstimable(TRAFFIC_KEY, TRAFFIC_LABEL, unit, reason, missing, inputs), draws: null });
  const ids = [...new Set(target.queryIds ?? [])];
  if (!ids.length) return ne("This action has no search queries to estimate traffic from.", []);
  const hasData = ctx.search.curve.some((b) => b.impressions > 0) || Object.keys(ctx.search.queries).length > 0;
  if (!ctx.search.connected && !hasData) return ne("No search provider is connected, so there are no impressions or CTR to estimate from.", [MISSING.search]);

  const measured = measuredBuckets(ctx.search.curve);
  const curveInput: EstimateInput = {
    name: "Measured position buckets",
    value: measured.length,
    source: "ORG_HISTORY",
    detail: fmt("{n} of 7 position buckets have 100+ impressions over the last {days} days (all products).", { n: measured.length, days: ctx.search.curveDays }),
  };
  const curve = curveFor(ctx);
  if (!curve) return ne(fmt("The CTR curve needs 5 position buckets with 100+ impressions; {n} are measured.", { n: measured.length }), [MISSING.curve], [curveInput]);

  const targetPosition = target.targetPosition ?? DEFAULT_TARGET_POSITION;
  const tKey = positionBucket(targetPosition);
  const tIdx = curve.buckets.findIndex((b) => b.bucket === tKey);
  const tAll = ctx.search.curve.find((b) => b.bucket === tKey);
  if (tIdx < 0)
    return ne(fmt("Position bucket {bucket} has fewer than 100 impressions ({count} measured), so the CTR at the target position is unknown.", { bucket: tKey, count: tAll?.impressions ?? 0 }), [MISSING.targetBucket], [curveInput]);

  const rows: QuerySearch[] = ids
    .map((id) => ctx.search.queries[id])
    .filter((q): q is QuerySearch => Boolean(q && q.impressions > 0 && (target.productId === null || q.productId === target.productId)));
  if (!rows.length) return ne(fmt("No search impressions were recorded for the target queries in the last {days} days.", { days: ctx.search.windowDays }), [MISSING.queryData], [curveInput]);

  const below = rows.filter((q) => q.position !== null && bucketIndex(positionBucket(q.position)) > bucketIndex(tKey));
  const draws = new Float64Array(DRAWS);
  for (let i = 0; i < DRAWS; i++) {
    const ctr = curve.draws[i][tIdx];
    let sum = 0;
    for (const q of below) sum += Math.max(0, q.impressions * ctr - q.clicks);
    draws[i] = sum;
  }
  const iv = interval(draws);
  const tb = curve.buckets[tIdx];
  const impressions = rows.reduce((s, q) => s + q.impressions, 0);
  const clicks = rows.reduce((s, q) => s + q.clicks, 0);
  const posW = rows.filter((q) => q.position !== null).reduce((s, q) => s + q.impressions, 0);
  const pos = posW > 0 ? rows.filter((q) => q.position !== null).reduce((s, q) => s + q.position! * q.impressions, 0) / posW : null;
  const inputs: EstimateInput[] = [
    curveInput,
    {
      name: "CTR at the target position",
      value: round(tb.fitted, 5),
      unit: "ratio",
      source: "ORG_HISTORY",
      detail: fmt("Position bucket {bucket}: {clicks} clicks out of {count} impressions (monotone fit).", { bucket: tb.bucket, clicks: tb.clicks, count: tb.impressions }),
      sampleSize: tb.impressions,
    },
    { name: "Target position", value: targetPosition, source: "MEASURED", detail: fmt("Position bucket {bucket}.", { bucket: tKey }) },
    { name: "Impressions of the target queries", value: impressions, unit: "visits", source: "MEASURED", detail: fmt("{n} queries with impressions over the last {days} days.", { n: rows.length, days: ctx.search.windowDays }), sampleSize: impressions },
    { name: "Current clicks of the target queries", value: clicks, unit: "clicks", source: "MEASURED", detail: fmt("Over the last {days} days.", { days: ctx.search.windowDays }) },
    { name: "Queries ranked below the target position", value: below.length, source: "MEASURED", detail: "Only these queries can gain clicks by reaching the target position." },
  ];
  if (pos !== null) inputs.push({ name: "Current average position", value: round(pos, 1), source: "MEASURED", detail: "Impressions-weighted." });
  return {
    estimate: {
      key: TRAFFIC_KEY,
      label: TRAFFIC_LABEL,
      unit,
      state: "ESTIMATED",
      p10: round(iv.p10, 2),
      p50: round(iv.p50, 2),
      p90: round(iv.p90, 2),
      horizonDays: 30,
      confidence: confidence(tb.impressions, curve.buckets.length, impressions),
      method: TRAFFIC_METHOD,
      inputs,
    },
    draws,
  };
}

/** Extra clicks per 30 days if the target queries reach the target position (docs/BEACON_BRAIN.md §3). */
export function estimateTrafficPotential(ctx: EstimationContext, target: TrafficTarget): Estimate {
  return trafficModel(ctx, target).estimate;
}
