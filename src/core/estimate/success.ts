import { MISSING, THRESHOLDS, fmt, notEstimable, round, type EstimationContext } from "./context";
import { memo } from "./memo";
import { betaDraws, betaPosterior } from "./stats";
import type { Estimate, EstimateConfidence, EstimateInput } from "./types";

export const SUCCESS_KEY = "success_probability";
export const SUCCESS_LABEL = "Success probability";
export const SUCCESS_METHOD =
  "Share of this organisation's measured autopilot outcomes for this opportunity type that improved the targeted metric. Outcomes with insufficient data are excluded. Interval: Beta posterior with a uniform prior.";

/** Confidence from measured outcomes: LOW under 10, MEDIUM under 30, HIGH from 30. */
export function successConfidence(outcomes: number): EstimateConfidence {
  return outcomes < 10 ? "LOW" : outcomes < 30 ? "MEDIUM" : "HIGH";
}

export type SuccessModel = { estimate: Estimate; draws: Float64Array | null };

/** Chance an action of this opportunity type produces a measured improvement (autopilot_learning tallies). */
export function successModel(ctx: EstimationContext, opportunityType: string | null | undefined): SuccessModel {
  if (!opportunityType) return { estimate: notEstimable(SUCCESS_KEY, SUCCESS_LABEL, "probability", "No opportunity type is given for this action.", [MISSING.outcomes]), draws: null };
  const t = ctx.learning[opportunityType] ?? { improved: 0, noChange: 0, declined: 0, insufficient: 0 };
  const n = t.improved + t.noChange + t.declined;
  const inputs: EstimateInput[] = [
    { name: "Opportunity type", value: opportunityType, source: "ORG_HISTORY", detail: "Outcomes are tallied per opportunity type." },
    { name: "Measured outcomes", value: n, source: "ORG_HISTORY", detail: fmt("{improved} improved, {unchanged} unchanged, {declined} declined.", { improved: t.improved, unchanged: t.noChange, declined: t.declined }), sampleSize: n },
    { name: "Outcomes with insufficient data", value: t.insufficient ?? 0, source: "ORG_HISTORY", detail: "Excluded from the rate." },
  ];
  if (n < THRESHOLDS.outcomes)
    return { estimate: notEstimable(SUCCESS_KEY, SUCCESS_LABEL, "probability", fmt("Fewer than 3 measured outcomes for this opportunity type ({n} so far).", { n }), [MISSING.outcomes], inputs), draws: null };
  const post = betaPosterior(t.improved, n);
  const key = `${ctx.organizationId}|success|${opportunityType}|${t.improved}|${n}`;
  return {
    estimate: {
      key: SUCCESS_KEY,
      label: SUCCESS_LABEL,
      unit: "probability",
      state: "ESTIMATED",
      p10: round(post.p10, 6),
      p50: round(post.p50, 6),
      p90: round(post.p90, 6),
      horizonDays: 0,
      confidence: successConfidence(n),
      method: SUCCESS_METHOD,
      inputs,
    },
    draws: memo(ctx, key, () => betaDraws(key, post.a, post.b)),
  };
}

export function estimateSuccessProbability(ctx: EstimationContext, opportunityType: string | null | undefined): Estimate {
  return successModel(ctx, opportunityType).estimate;
}
