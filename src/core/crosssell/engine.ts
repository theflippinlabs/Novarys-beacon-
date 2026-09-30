import type { CrossSellConditions } from "@/db/schema";

export type CrossSellRule = {
  id: string;
  sourceProductId: string;
  destinationProductId: string;
  conditions: CrossSellConditions;
  message: string;
  ctaLabel: string;
  ctaUrl: string;
  frequencyCapDays: number;
  maxImpressions: number;
  active: boolean;
};

export type IdentityState = {
  consentCrossProduct: boolean;
  products: { productId: string; status: string | null; sharedTraits: string[]; firstSeenAt: Date }[];
  /** Past cross-sell events for this identity. */
  history: { ruleId: string; type: "IMPRESSION" | "CLICK" | "CONVERSION" | "DISMISS"; occurredAt: Date }[];
};

export type CrossSellDecision = { eligible: CrossSellRule[]; reasons: Record<string, string> };

/**
 * Decides which cross-sell messages an identity may see from `fromProductId`.
 * Guarantees: explicit cross-product consent is required; never recommend a
 * product the identity already uses; per-rule frequency caps and lifetime
 * impression caps; a dismissal suppresses the rule; a global daily cap limits
 * how many recommendations are shown across all rules.
 */
export function evaluateCrossSell(rules: CrossSellRule[], identity: IdentityState, fromProductId: string, now = new Date(), globalDailyCap = 1): CrossSellDecision {
  const reasons: Record<string, string> = {};
  if (!identity.consentCrossProduct) {
    for (const r of rules) reasons[r.id] = "no-consent";
    return { eligible: [], reasons };
  }
  const shownToday = identity.history.filter((h) => h.type === "IMPRESSION" && now.getTime() - h.occurredAt.getTime() < 86_400_000).length;
  const source = identity.products.find((p) => p.productId === fromProductId);
  const eligible: CrossSellRule[] = [];
  for (const r of rules) {
    const reject = (why: string) => (reasons[r.id] = why);
    if (!r.active) {
      reject("inactive");
      continue;
    }
    if (r.sourceProductId !== fromProductId) {
      reject("different-source");
      continue;
    }
    if (!source) {
      reject("not-using-source");
      continue;
    }
    if (identity.products.some((p) => p.productId === r.destinationProductId && p.status !== "CANCELLED")) {
      reject("already-uses-destination");
      continue;
    }
    const c = r.conditions;
    if (c.requiredTraits?.length && !c.requiredTraits.every((t) => source.sharedTraits.includes(t))) {
      reject("traits-not-met");
      continue;
    }
    if (c.minDaysOnSource && (now.getTime() - source.firstSeenAt.getTime()) / 86_400_000 < c.minDaysOnSource) {
      reject("too-early");
      continue;
    }
    if (c.sourceStatuses?.length && !c.sourceStatuses.includes((source.status ?? "") as never)) {
      reject("source-status");
      continue;
    }
    const mine = identity.history.filter((h) => h.ruleId === r.id);
    if (mine.some((h) => h.type === "DISMISS" || h.type === "CONVERSION")) {
      reject("dismissed-or-converted");
      continue;
    }
    if (mine.filter((h) => h.type === "IMPRESSION").length >= r.maxImpressions) {
      reject("lifetime-cap");
      continue;
    }
    const last = mine.filter((h) => h.type === "IMPRESSION").sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    if (last && now.getTime() - last.occurredAt.getTime() < r.frequencyCapDays * 86_400_000) {
      reject("frequency-cap");
      continue;
    }
    reasons[r.id] = "eligible";
    eligible.push(r);
  }
  const remaining = Math.max(0, globalDailyCap - shownToday);
  for (const r of eligible.slice(remaining)) reasons[r.id] = "global-daily-cap";
  return { eligible: eligible.slice(0, remaining), reasons };
}
