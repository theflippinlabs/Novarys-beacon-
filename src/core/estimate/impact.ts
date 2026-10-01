import { MISSING, THRESHOLDS, fmt, minConfidence, notEstimable, round, type EstimationContext } from "./context";
import { estimateAiMentionRate } from "./ai";
import { conversionModel, searchConversionModel } from "./conversion";
import { DRAWS, hashSeed, interval } from "./stats";
import { successModel } from "./success";
import { measuredBuckets, trafficModel } from "./traffic";
import { valueModels } from "./value";
import type { Estimate, EstimatedValue, EstimateInput, EstimationPower, ImpactEstimate, ImpactTarget } from "./types";

export type { EstimationContext } from "./context";
export { emptyContext, MISSING, THRESHOLDS, ORG_SCOPE } from "./context";

export const IMPACT_KEY = "expected_impact";
export const SIGNUPS_LABEL = "Expected extra signups";
export const REVENUE_LABEL = "Expected extra revenue";
export const DEFAULT_HORIZON_DAYS = 90;
export const IMPACT_METHOD =
  "Expected extra signups over the horizon = extra clicks per 30 days × (horizon ÷ 30) × conversion rate × success probability, propagated by Monte Carlo (2,000 seeded draws). Each extra click is counted as one visitor.";
export const REVENUE_METHOD = "Expected extra revenue = expected extra signups × value per conversion in this currency, propagated by Monte Carlo (2,000 seeded draws). Currencies are never converted or added.";
export const CHAIN_REASON = "Not every input of the chain (extra clicks × conversion rate × success probability) is measured yet.";

const uniq = (xs: string[]) => [...new Set(xs)];

const summary = (e: EstimatedValue, name: string, source: EstimateInput["source"]): EstimateInput => ({
  name,
  value: e.p50,
  unit: e.unit,
  currency: e.currency,
  source,
  detail: fmt("Median of the {label} estimate.", { label: e.label }),
});

/**
 * Master estimator (docs/BEACON_BRAIN.md §3): expected extra signups and
 * revenue (per currency) for one action. Combines traffic potential,
 * conversion rate, success probability and value per conversion by Monte
 * Carlo. When an input is not estimable it returns the partial chain it could
 * compute (`reached`) and every missing item.
 */
export function estimateImpact(ctx: EstimationContext, target: ImpactTarget): ImpactEstimate {
  const horizon = target.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const productId = target.productId ?? null;
  const traffic = trafficModel(ctx, { productId, queryIds: target.queryIds, targetPosition: target.targetPosition });
  const conv = searchConversionModel(ctx, productId);
  const success = successModel(ctx, target.opportunityType);
  const values = valueModels(ctx, productId);
  const parts: Estimate[] = [traffic.estimate, conv.estimate, success.estimate, ...values.map((v) => v.estimate)];
  const valueMissing = uniq(values.flatMap((v) => (v.estimate.state === "NOT_ESTIMABLE" ? v.estimate.missing : [])));
  const chain = [traffic.estimate, conv.estimate, success.estimate];
  const chainMissing = uniq(chain.flatMap((e) => (e.state === "NOT_ESTIMABLE" ? e.missing : [])));

  if (!traffic.draws || !conv.draws || !success.draws || traffic.estimate.state !== "ESTIMATED" || conv.estimate.state !== "ESTIMATED" || success.estimate.state !== "ESTIMATED") {
    const noTarget = !target.queryIds?.length;
    const available = chain.filter((e): e is EstimatedValue => e.state === "ESTIMATED").map((e) => summary(e, e.label, e.key === "success_probability" ? "ORG_HISTORY" : "MEASURED"));
    // Without target queries no connection can unlock the chain: nothing is listed as missing.
    if (noTarget) return { signups: notEstimable(IMPACT_KEY, SIGNUPS_LABEL, "signups", "This action has no search queries to estimate traffic from.", [], available), revenue: [], parts, reached: "none", missing: [] };
    return {
      signups: notEstimable(IMPACT_KEY, SIGNUPS_LABEL, "signups", CHAIN_REASON, chainMissing, available),
      revenue: [],
      parts,
      reached: traffic.estimate.state === "ESTIMATED" ? "clicks" : "none",
      missing: uniq([...chainMissing, ...valueMissing]),
    };
  }

  const scale = horizon / 30;
  const signupDraws = new Float64Array(DRAWS);
  for (let i = 0; i < DRAWS; i++) signupDraws[i] = traffic.draws[i] * scale * conv.draws[i] * success.draws[i];
  const iv = interval(signupDraws);
  const confidence = minConfidence(traffic.estimate.confidence, conv.estimate.confidence, success.estimate.confidence);
  const signupInputs = [
    summary(traffic.estimate, "Extra clicks per 30 days", "MEASURED"),
    summary(conv.estimate, "Conversion rate", "MEASURED"),
    summary(success.estimate, "Success probability", "ORG_HISTORY"),
    { name: "Horizon", value: horizon, source: "MEASURED" as const, detail: fmt("{days} days.", { days: horizon }) },
  ];
  const signups: EstimatedValue = {
    key: IMPACT_KEY,
    label: SIGNUPS_LABEL,
    unit: "signups",
    state: "ESTIMATED",
    p10: round(iv.p10, 3),
    p50: round(iv.p50, 3),
    p90: round(iv.p90, 3),
    horizonDays: horizon,
    confidence,
    method: IMPACT_METHOD,
    inputs: signupInputs,
  };

  const revenue: Estimate[] = [];
  for (const v of values) {
    if (!v.currency) continue;
    if (v.estimate.state !== "ESTIMATED" || !v.draws) {
      revenue.push({ ...notEstimable(IMPACT_KEY, REVENUE_LABEL, "money_minor", v.estimate.state === "NOT_ESTIMABLE" ? v.estimate.reason : CHAIN_REASON, v.estimate.state === "NOT_ESTIMABLE" ? v.estimate.missing : [], [summary(signups, SIGNUPS_LABEL, "MEASURED")]), currency: v.currency });
      continue;
    }
    const d = new Float64Array(DRAWS);
    for (let i = 0; i < DRAWS; i++) d[i] = signupDraws[i] * v.draws[i];
    const r = interval(d);
    revenue.push({
      key: IMPACT_KEY,
      label: REVENUE_LABEL,
      unit: "money_minor",
      currency: v.currency,
      state: "ESTIMATED",
      p10: round(r.p10, 2),
      p50: round(r.p50, 2),
      p90: round(r.p90, 2),
      horizonDays: horizon,
      confidence: minConfidence(confidence, v.estimate.confidence),
      method: REVENUE_METHOD,
      inputs: [summary(signups, SIGNUPS_LABEL, "MEASURED"), summary(v.estimate, "Value per conversion", "MEASURED")],
    });
  }
  return {
    signups,
    revenue,
    parts,
    reached: revenue.some((r) => r.state === "ESTIMATED") ? "revenue" : "signups",
    missing: valueMissing,
  };
}

/** Stable seed for a target (exposed for callers that need their own draws). */
export function targetSeed(target: ImpactTarget): number {
  return hashSeed(JSON.stringify([target.productId, [...(target.queryIds ?? [])].sort(), target.targetPosition ?? null, target.opportunityType ?? null, target.horizonDays ?? null]));
}

/** What blocks the deepest missing link of a target's chain: signups first, then revenue. */
export function blockers(e: ImpactEstimate): string[] {
  if (e.signups.state === "NOT_ESTIMABLE") return e.signups.missing;
  if (e.reached !== "revenue") return e.missing;
  return [];
}

/**
 * Which inputs this organisation can estimate with, and the connection or
 * data that would unlock the most expected impact chains among `targets`.
 * `unlocks`: targets whose chain is blocked by the item (it is among the
 * missing items of their deepest missing link); `completes`: targets for
 * which it is the only missing item.
 */
export function estimationPower(ctx: EstimationContext, targets: ImpactTarget[]): EstimationPower {
  const measured: string[] = [];
  const missing: string[] = [];
  const curveOk = measuredBuckets(ctx.search.curve).length >= THRESHOLDS.curveBuckets;
  if (curveOk) measured.push("Traffic potential");
  else missing.push(...(ctx.search.connected || ctx.search.curve.some((b) => b.impressions > 0) ? [MISSING.curve] : [MISSING.search]));
  const cr = conversionModel(ctx, null).estimate;
  if (cr.state === "ESTIMATED") measured.push("Conversion rate");
  else missing.push(...cr.missing);
  const vals = valueModels(ctx, null);
  if (vals.some((v) => v.estimate.state === "ESTIMATED")) measured.push("Value per conversion");
  else missing.push(...vals.flatMap((v) => (v.estimate.state === "NOT_ESTIMABLE" ? v.estimate.missing : [])));
  const types = Object.values(ctx.learning).some((t) => t.improved + t.noChange + t.declined >= THRESHOLDS.outcomes);
  if (types) measured.push("Success probability");
  else missing.push(MISSING.outcomes);
  const ai = estimateAiMentionRate(ctx, null);
  if (ai.state === "ESTIMATED") measured.push("AI mention rate");
  else missing.push(...ai.missing);

  const counts = new Map<string, { unlocks: number; completes: number }>();
  for (const t of targets) {
    const b = uniq(blockers(estimateImpact(ctx, t)));
    for (const item of b) {
      const c = counts.get(item) ?? { unlocks: 0, completes: 0 };
      c.unlocks += 1;
      if (b.length === 1) c.completes += 1;
      counts.set(item, c);
    }
  }
  const ranking = [...counts.entries()]
    .map(([connect, c]) => ({ connect, ...c }))
    .sort((a, b) => b.unlocks - a.unlocks || b.completes - a.completes || a.connect.localeCompare(b.connect));
  const best = ranking[0];
  return {
    measured,
    missing: uniq([...missing, ...ranking.map((r) => r.connect)]),
    bestNextConnection: best ? { connect: best.connect, unlocks: best.unlocks, completes: best.completes } : null,
    ranking,
  };
}
