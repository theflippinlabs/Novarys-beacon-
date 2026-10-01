/** UNATTRIBUTED = no qualifying touch at all; DIRECT = a measured direct visit (no referrer, no UTM). */
export type Channel = "ORGANIC_SEARCH" | "AI_REFERRAL" | "REFERRAL" | "AFFILIATE" | "SOCIAL" | "EMAIL" | "PAID" | "DIRECT" | "CROSS_SELL" | "OTHER" | "UNATTRIBUTED";

export const AI_REFERRER_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "bard.google.com",
  "copilot.microsoft.com",
  "you.com",
  "phind.com",
  "poe.com",
  "meta.ai",
  "grok.com",
  "chat.deepseek.com",
  "chat.mistral.ai",
];
/** Exact utm_source values that identify an AI assistant (never prefix matching). */
const AI_SOURCES = new Set(["chatgpt", "chatgpt.com", "openai", "perplexity", "perplexity.ai", "claude", "claude.ai", "gemini", "copilot", "you.com", "phind", "poe", "meta.ai", "grok", "deepseek", "mistral"]);
const SEARCH_HOSTS = [/^(www\.)?google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)search\.yahoo\.com$/, /(^|\.)ecosia\.org$/, /(^|\.)yandex\.[a-z]+$/, /(^|\.)baidu\.com$/, /(^|\.)search\.brave\.com$/, /(^|\.)qwant\.com$/];
const SOCIAL_HOSTS = [/(^|\.)(x|twitter|t)\.(com|co)$/, /(^|\.)linkedin\.com$/, /(^|\.)lnkd\.in$/, /(^|\.)facebook\.com$/, /(^|\.)instagram\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)youtube\.com$/, /(^|\.)reddit\.com$/, /(^|\.)threads\.net$/, /(^|\.)bsky\.app$/, /(^|\.)news\.ycombinator\.com$/];

const matchesHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

export function isAiReferrer(host: string | null | undefined): boolean {
  return Boolean(host) && matchesHost(host!.toLowerCase(), AI_REFERRER_HOSTS);
}

/**
 * Explicit, documented channel classification (first match wins):
 * 1. referral code → AFFILIATE if owned by an affiliate, else REFERRAL
 * 2. utm_source=beacon-cross-sell → CROSS_SELL
 * 3. utm_medium in (cpc, ppc, paid, paid_social, display) → PAID
 * 4. utm_medium=email or utm_source=newsletter → EMAIL
 * 5. referrer is a known AI assistant (or utm_source names one) → AI_REFERRAL
 * 6. referrer is a known search engine → ORGANIC_SEARCH
 * 7. referrer/utm_medium is social → SOCIAL
 * 8. no referrer and no UTM → DIRECT; otherwise OTHER
 */
export function classifyChannel(input: { referrerHost?: string | null; utm?: Record<string, string>; referralCode?: { affiliate: boolean } | null; ownHosts?: string[] }): Channel {
  const utm = input.utm ?? {};
  const medium = (utm.utm_medium ?? "").toLowerCase();
  const source = (utm.utm_source ?? "").toLowerCase();
  const host = (input.referrerHost ?? "").toLowerCase().replace(/^www\./, "");
  if (input.referralCode) return input.referralCode.affiliate ? "AFFILIATE" : "REFERRAL";
  if (source === "beacon-cross-sell") return "CROSS_SELL";
  if (["cpc", "ppc", "paid", "paid_social", "paidsocial", "display", "cpm"].includes(medium)) return "PAID";
  if (medium === "email" || source === "newsletter") return "EMAIL";
  if (isAiReferrer(host) || AI_SOURCES.has(source)) return "AI_REFERRAL";
  if (host && SEARCH_HOSTS.some((r) => r.test(host))) return "ORGANIC_SEARCH";
  if (medium === "social" || (host && SOCIAL_HOSTS.some((r) => r.test(host)))) return "SOCIAL";
  if (host && input.ownHosts?.some((h) => host === h || host.endsWith(`.${h}`))) return "DIRECT";
  if (!host && !medium && !source) return "DIRECT";
  return "OTHER";
}

export type Touch = { id: string; channel: Channel; occurredAt: Date; referralCodeId?: string | null; campaignId?: string | null };
export const ATTRIBUTION_MODELS = ["FIRST_TOUCH", "LAST_TOUCH", "LINEAR", "POSITION_BASED"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];
export type AttributionRules = { model: AttributionModel; lookbackDays: number; referralPrecedence: boolean };
export const DEFAULT_ATTRIBUTION: AttributionRules = { model: "LAST_TOUCH", lookbackDays: 30, referralPrecedence: true };

export type Attribution = { channel: Channel; touchId: string | null; referralCodeId: string | null; campaignId: string | null; rule: string };

/** Touches inside the lookback window before the conversion, oldest first. */
export function touchesInWindow(touches: Touch[], conversionAt: Date, lookbackDays: number): Touch[] {
  const from = conversionAt.getTime() - lookbackDays * 86_400_000;
  return touches.filter((t) => t.occurredAt.getTime() <= conversionAt.getTime() && t.occurredAt.getTime() >= from).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/**
 * Single-touch attribution with explicit rules (the decision persisted on the
 * conversion and used for commissions):
 * - only touches within `lookbackDays` before the conversion count
 * - if `referralPrecedence`, the most recent referral/affiliate touch wins
 * - FIRST_TOUCH takes the oldest touch; every other model (LAST_TOUCH and,
 *   for the single persisted decision, LINEAR / POSITION_BASED) takes the
 *   last non-direct touch, falling back to the last (DIRECT) touch
 * - no qualifying touch → UNATTRIBUTED (never silently DIRECT)
 */
export function attribute(touches: Touch[], conversionAt: Date, rules: AttributionRules = DEFAULT_ATTRIBUTION): Attribution {
  const window = touchesInWindow(touches, conversionAt, rules.lookbackDays);
  if (!window.length) return { channel: "UNATTRIBUTED", touchId: null, referralCodeId: null, campaignId: null, rule: "no-touch-in-window" };
  if (rules.referralPrecedence) {
    const ref = [...window].reverse().find((t) => t.referralCodeId);
    if (ref) return { channel: ref.channel, touchId: ref.id, referralCodeId: ref.referralCodeId ?? null, campaignId: ref.campaignId ?? null, rule: "referral-precedence" };
  }
  let chosen: Touch;
  if (rules.model === "FIRST_TOUCH") chosen = window[0];
  else chosen = [...window].reverse().find((t) => t.channel !== "DIRECT") ?? window[window.length - 1];
  return { channel: chosen.channel, touchId: chosen.id, referralCodeId: chosen.referralCodeId ?? null, campaignId: chosen.campaignId ?? null, rule: rules.model === "FIRST_TOUCH" ? "first-touch" : "last-non-direct-touch" };
}

export type Credit = { touchId: string | null; channel: Channel; campaignId: string | null; weight: number };

/**
 * Credits for one conversion under one model. Weights always sum to 1.
 * - FIRST_TOUCH: 100% to the oldest touch in the window
 * - LAST_TOUCH: 100% to the last non-direct touch (last touch if all are direct)
 * - LINEAR: equal split across every touch in the window
 * - POSITION_BASED: 40% first, 40% last, 20% split across the middle touches
 *   (one touch: 100%; two touches: 50/50)
 * - no touch in the window: one credit to UNATTRIBUTED
 * Referral precedence applies to the persisted single-touch decision
 * (`attribute`), not to these model comparisons.
 */
export function creditsFor(touches: Touch[], conversionAt: Date, model: AttributionModel, lookbackDays: number): Credit[] {
  const w = touchesInWindow(touches, conversionAt, lookbackDays);
  const c = (t: Touch, weight: number): Credit => ({ touchId: t.id, channel: t.channel, campaignId: t.campaignId ?? null, weight });
  if (!w.length) return [{ touchId: null, channel: "UNATTRIBUTED", campaignId: null, weight: 1 }];
  if (model === "FIRST_TOUCH") return [c(w[0], 1)];
  if (model === "LAST_TOUCH") return [c([...w].reverse().find((t) => t.channel !== "DIRECT") ?? w[w.length - 1], 1)];
  if (model === "LINEAR") return w.map((t) => c(t, 1 / w.length));
  if (w.length === 1) return [c(w[0], 1)];
  if (w.length === 2) return [c(w[0], 0.5), c(w[1], 0.5)];
  const mid = 0.2 / (w.length - 2);
  return w.map((t, i) => c(t, i === 0 || i === w.length - 1 ? 0.4 : mid));
}

/**
 * Split an amount in minor units by weights so the parts add up exactly to
 * the amount (largest remainder method; sign preserved for refunds).
 */
export function allocateCents(amount: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const raw = weights.map((w) => (abs * w) / total);
  const floor = raw.map(Math.floor);
  let rest = abs - floor.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - floor[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floor[i] += 1;
    rest -= 1;
  }
  return floor.map((v) => v * sign);
}

/** Human explanation of a model (shown next to every credited number). */
export const MODEL_RULES: Record<AttributionModel, string> = {
  FIRST_TOUCH: "100% of the credit goes to the first touch in the lookback window.",
  LAST_TOUCH: "100% of the credit goes to the last non-direct touch in the lookback window (the last touch if every touch was direct).",
  LINEAR: "The credit is split equally across every touch in the lookback window.",
  POSITION_BASED: "40% to the first touch, 40% to the last touch, 20% split across the touches in between.",
};

/** Commission for one revenue event. Refunds/churn produce negative or zero amounts. */
export function commissionFor(input: { amountCents: number; commissionBps: number; monthsSinceStart: number; commissionMonths: number; type: string }): number {
  if (input.monthsSinceStart >= input.commissionMonths) return 0;
  if (input.type === "CHURN" || input.type === "DOWNGRADE") return 0;
  return Math.round((input.amountCents * input.commissionBps) / 10_000);
}

/** Heuristic fraud flags; flagged commissions are put ON_HOLD for human review, never auto-voided. */
export function fraudFlags(input: {
  referrerEmailHash?: string | null;
  customerEmailHash?: string | null;
  clickToConversionSeconds?: number | null;
  signupsFromSameIpLast24h?: number;
  refunded?: boolean;
}): string[] {
  const flags: string[] = [];
  if (input.referrerEmailHash && input.customerEmailHash && input.referrerEmailHash === input.customerEmailHash) flags.push("SELF_REFERRAL");
  if (input.clickToConversionSeconds !== null && input.clickToConversionSeconds !== undefined && input.clickToConversionSeconds < 10) flags.push("INSTANT_CONVERSION");
  if ((input.signupsFromSameIpLast24h ?? 0) >= 5) flags.push("IP_VELOCITY");
  if (input.refunded) flags.push("REFUNDED");
  return flags;
}
