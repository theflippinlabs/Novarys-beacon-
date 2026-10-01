import { MISSING, THRESHOLDS, fmt, notEstimable, round, scopeKey, type EstimationContext } from "./context";
import { memo } from "./memo";
import { bootstrapMeans, interval } from "./stats";
import type { Estimate, EstimateConfidence, EstimateInput } from "./types";

export const VALUE_KEY = "value_per_conversion";
export const VALUE_LABEL = "Value per conversion";
export const VALUE_METHOD =
  "Revenue to date per converting identity (signup in the window), net of refunds, in one currency; converters without revenue count as 0. Interval: bootstrap of the mean (2,000 seeded resamples).";

/** Confidence from paying conversions: LOW under 20, MEDIUM under 100, HIGH from 100. */
export function valueConfidence(payers: number): EstimateConfidence {
  return payers < 20 ? "LOW" : payers < 100 ? "MEDIUM" : "HIGH";
}

export type ValueModel = { currency: string | null; estimate: Estimate; draws: Float64Array | null };

/**
 * Value per conversion for a product (organisation when null), one model per
 * currency (currencies are never mixed or converted). Without revenue data,
 * one NOT_ESTIMABLE model with `currency: null`.
 */
export function valueModels(ctx: EstimationContext, productId: string | null): ValueModel[] {
  const scope = ctx.value.byScope[scopeKey(productId)];
  const days = ctx.value.windowDays;
  if (!ctx.value.connected)
    return [{ currency: null, estimate: notEstimable(VALUE_KEY, VALUE_LABEL, "money_minor", "No revenue events: connect Stripe or send revenue through the API.", [MISSING.revenue]), draws: null }];
  const converters = scope?.converters ?? 0;
  const currencies = Object.keys(scope?.byCurrency ?? {}).sort();
  const convInput: EstimateInput = { name: "Converting identities", value: converters, unit: "conversions", source: "MEASURED", detail: fmt("Identities with a signup in the last {days} days.", { days }), sampleSize: converters };
  if (!converters || !currencies.length)
    return [
      {
        currency: null,
        estimate: notEstimable(VALUE_KEY, VALUE_LABEL, "money_minor", fmt("No paying conversions among identities that signed up in the last {days} days.", { days }), [MISSING.payers], [convInput]),
        draws: null,
      },
    ];
  return currencies.map((currency) => {
    const paid = scope!.byCurrency[currency];
    const payers = paid.length;
    const inputs: EstimateInput[] = [
      convInput,
      { name: "Paying conversions", value: payers, unit: "conversions", source: "MEASURED", detail: fmt("Converting identities with net revenue in {currency}.", { currency }), sampleSize: payers },
      { name: "Revenue of converting identities", value: paid.reduce((s, v) => s + v, 0), unit: "money_minor", currency, source: "MEASURED", detail: "Net of refunds, to date." },
    ];
    if (payers < THRESHOLDS.payers)
      return {
        currency,
        estimate: { ...notEstimable(VALUE_KEY, VALUE_LABEL, "money_minor", fmt("Fewer than 5 paying conversions in {currency} ({n} measured).", { currency, n: payers }), [MISSING.payers], inputs), currency },
        draws: null,
      };
    const sample = [...paid, ...Array<number>(Math.max(0, converters - payers)).fill(0)];
    const key = `${ctx.organizationId}|value|${scopeKey(productId)}|${currency}|${converters}|${payers}`;
    const draws = memo(ctx, key, () => bootstrapMeans(sample, key));
    const iv = interval(draws);
    return {
      currency,
      estimate: {
        key: VALUE_KEY,
        label: VALUE_LABEL,
        unit: "money_minor" as const,
        currency,
        state: "ESTIMATED" as const,
        p10: round(iv.p10, 2),
        p50: round(iv.p50, 2),
        p90: round(iv.p90, 2),
        horizonDays: days,
        confidence: valueConfidence(payers),
        method: VALUE_METHOD,
        inputs,
      },
      draws,
    };
  });
}

/** Revenue per converting identity, one estimate per currency (docs/BEACON_BRAIN.md §3). */
export function estimateValuePerConversion(ctx: EstimationContext, productId: string | null): Estimate[] {
  return valueModels(ctx, productId).map((m) => m.estimate);
}
