import { MISSING, THRESHOLDS, fmt, notEstimable, round, scopeKey, type EstimationContext, type RateTally } from "./context";
import { memo } from "./memo";
import { betaDraws, betaPosterior } from "./stats";
import type { Estimate, EstimateConfidence, EstimateInput } from "./types";

export const CONVERSION_KEY = "conversion_rate";
export const CONVERSION_LABEL = "Conversion rate";
export const CONVERSION_METHOD =
  "Share of tracked visitors (people with a page view, first seen in the window) who completed a signup. Interval: Beta posterior with a uniform prior (10th to 90th percentile).";

/** Confidence from sample sizes: LOW under 200 visitors or 10 signups, HIGH from 1,000 visitors and 50 signups. */
export function conversionConfidence(t: RateTally): EstimateConfidence {
  if (t.visitors < 200 || t.converters < 10) return "LOW";
  if (t.visitors >= 1000 && t.converters >= 50) return "HIGH";
  return "MEDIUM";
}

export type RateModel = { estimate: Estimate; draws: Float64Array | null };

/**
 * Visitor to signup rate for a product (organisation when null), optionally
 * for one acquisition channel (the channel of each person's first event).
 */
export function conversionModel(ctx: EstimationContext, productId: string | null, channel?: string | null): RateModel {
  const scope = ctx.conversion.byScope[scopeKey(productId)];
  const tally: RateTally = (channel ? scope?.byChannel[channel] : scope?.all) ?? { visitors: 0, converters: 0 };
  const inputs: EstimateInput[] = [
    { name: "Tracked visitors", value: tally.visitors, unit: "visits", source: "MEASURED", detail: fmt("First seen in the last {days} days.", { days: ctx.conversion.windowDays }), sampleSize: tally.visitors },
    { name: "Visitors who signed up", value: tally.converters, unit: "signups", source: "MEASURED", detail: "Signup completed (or legacy signup) after a tracked page view." },
  ];
  if (channel) inputs.push({ name: "Channel", value: channel, source: "MEASURED", detail: "Channel of each person's first tracked event." });
  if (tally.visitors < THRESHOLDS.visitors) {
    const missing = ctx.conversion.tracked ? [MISSING.visitors] : [MISSING.tracker, MISSING.visitors];
    return {
      estimate: notEstimable(CONVERSION_KEY, CONVERSION_LABEL, "ratio", fmt("Fewer than 50 tracked visitors in the last {days} days ({n} measured).", { days: ctx.conversion.windowDays, n: tally.visitors }), missing, inputs),
      draws: null,
    };
  }
  const converters = Math.min(tally.converters, tally.visitors);
  const post = betaPosterior(converters, tally.visitors);
  const key = `${ctx.organizationId}|cr|${scopeKey(productId)}|${channel ?? "all"}|${converters}|${tally.visitors}`;
  return {
    estimate: {
      key: CONVERSION_KEY,
      label: CONVERSION_LABEL,
      unit: "ratio",
      state: "ESTIMATED",
      p10: round(post.p10, 6),
      p50: round(post.p50, 6),
      p90: round(post.p90, 6),
      horizonDays: ctx.conversion.windowDays,
      confidence: conversionConfidence(tally),
      method: CONVERSION_METHOD,
      inputs,
    },
    draws: memo(ctx, key, () => betaDraws(key, post.a, post.b)),
  };
}

export function estimateConversionRate(ctx: EstimationContext, productId: string | null, channel?: string | null): Estimate {
  return conversionModel(ctx, productId, channel).estimate;
}

/** Channel used for search traffic chains. */
export const SEARCH_CHANNEL = "ORGANIC_SEARCH";

/**
 * Conversion rate for search clicks: the organic search channel when it has
 * 50+ tracked visitors, else all channels of the same product (stated in the
 * inputs). NOT_ESTIMABLE when neither has enough visitors.
 */
export function searchConversionModel(ctx: EstimationContext, productId: string | null): RateModel {
  const organic = conversionModel(ctx, productId, SEARCH_CHANNEL);
  if (organic.estimate.state === "ESTIMATED") return organic;
  const all = conversionModel(ctx, productId, null);
  if (all.estimate.state !== "ESTIMATED") return all;
  return {
    ...all,
    estimate: {
      ...all.estimate,
      inputs: [
        ...all.estimate.inputs,
        { name: "Channel", value: "All channels", source: "MEASURED", detail: "Organic search alone has fewer than 50 tracked visitors, so the rate of all channels is used." },
      ],
    },
  };
}
