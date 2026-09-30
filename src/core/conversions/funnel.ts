export const FUNNEL_STEPS = ["PAGE_VIEW", "CTA_CLICK", "SIGNUP", "TRIAL_STARTED", "ACTIVATED", "CHECKOUT_STARTED", "SUBSCRIBED"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export type FunnelRow = { step: FunnelStep; visitors: number; conversionFromPrev: number | null; conversionFromStart: number | null };

/**
 * Funnel from distinct-visitor counts per step. Rates are null when the
 * denominator is zero (never shown as 0% or 100% without data).
 */
export function buildFunnel(counts: Partial<Record<FunnelStep, number>>): FunnelRow[] {
  const start = counts.PAGE_VIEW ?? 0;
  return FUNNEL_STEPS.map((step, i) => {
    const v = counts[step] ?? 0;
    const prev = i === 0 ? null : counts[FUNNEL_STEPS[i - 1]] ?? 0;
    return {
      step,
      visitors: v,
      conversionFromPrev: prev === null || prev === 0 ? null : v / prev,
      conversionFromStart: i === 0 || start === 0 ? null : v / start,
    };
  });
}

export function pctChange(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;
  return (now - prev) / prev;
}
