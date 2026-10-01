import type { CanonicalEvent } from "./events";

/** Acquisition funnel, in order. Optional steps are shown only when the product sends them. */
export const FUNNEL_STEPS = [
  "PAGE_VIEW",
  "CTA_CLICK",
  "PRODUCT_VIEWED",
  "SIGNUP_STARTED",
  "SIGNUP_COMPLETED",
  "TRIAL_STARTED",
  "ACTIVATION_COMPLETED",
  "CHECKOUT_STARTED",
  "SUBSCRIPTION_STARTED",
] as const satisfies readonly CanonicalEvent[];
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const OPTIONAL_FUNNEL_STEPS: ReadonlySet<FunnelStep> = new Set(["PRODUCT_VIEWED", "SIGNUP_STARTED"]);

export type FunnelRow = { step: FunnelStep; visitors: number; conversionFromPrev: number | null; conversionFromStart: number | null };

/**
 * Funnel from distinct-person counts per step (a cohort: see
 * `funnelCounts`). Optional steps with no event are left out, so a product
 * that never sends them keeps meaningful step-to-step rates. Rates are null
 * when the denominator is zero (never shown as 0% or 100% without data).
 * Steps are counted independently (a person can sign up without a tracked
 * CTA click), so a step with more people than its base is not a subset of
 * it: its rate is null ("n/a") rather than a confusing rate above 100%.
 */
export function buildFunnel(counts: Partial<Record<FunnelStep, number>>): FunnelRow[] {
  const steps = FUNNEL_STEPS.filter((s) => !OPTIONAL_FUNNEL_STEPS.has(s) || (counts[s] ?? 0) > 0);
  const start = counts.PAGE_VIEW ?? 0;
  return steps.map((step, i) => {
    const v = counts[step] ?? 0;
    const prev = i === 0 ? null : (counts[steps[i - 1]] ?? 0);
    return {
      step,
      visitors: v,
      conversionFromPrev: prev === null || prev === 0 || v > prev ? null : v / prev,
      conversionFromStart: i === 0 || start === 0 || v > start ? null : v / start,
    };
  });
}

export function pctChange(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;
  return (now - prev) / prev;
}
