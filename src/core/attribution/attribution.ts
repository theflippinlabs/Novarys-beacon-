export type Channel = "ORGANIC_SEARCH" | "AI_REFERRAL" | "REFERRAL" | "AFFILIATE" | "SOCIAL" | "EMAIL" | "PAID" | "DIRECT" | "CROSS_SELL" | "OTHER";

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
export type AttributionRules = { model: "LAST_TOUCH" | "FIRST_TOUCH"; lookbackDays: number; referralPrecedence: boolean };
export const DEFAULT_ATTRIBUTION: AttributionRules = { model: "LAST_TOUCH", lookbackDays: 30, referralPrecedence: true };

export type Attribution = { channel: Channel; touchId: string | null; referralCodeId: string | null; campaignId: string | null; rule: string };

/**
 * Single-touch attribution with explicit rules:
 * - only touches within `lookbackDays` before the conversion count
 * - if `referralPrecedence`, the most recent referral/affiliate touch wins
 * - otherwise FIRST_TOUCH or LAST_TOUCH over the remaining touches
 * - DIRECT touches never override a non-direct touch under LAST_TOUCH
 * - no qualifying touch → DIRECT
 */
export function attribute(touches: Touch[], conversionAt: Date, rules: AttributionRules = DEFAULT_ATTRIBUTION): Attribution {
  const from = conversionAt.getTime() - rules.lookbackDays * 86_400_000;
  const window = touches.filter((t) => t.occurredAt.getTime() <= conversionAt.getTime() && t.occurredAt.getTime() >= from).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (!window.length) return { channel: "DIRECT", touchId: null, referralCodeId: null, campaignId: null, rule: "no-touch-in-window" };
  if (rules.referralPrecedence) {
    const ref = [...window].reverse().find((t) => t.referralCodeId);
    if (ref) return { channel: ref.channel, touchId: ref.id, referralCodeId: ref.referralCodeId ?? null, campaignId: ref.campaignId ?? null, rule: "referral-precedence" };
  }
  let chosen: Touch;
  if (rules.model === "FIRST_TOUCH") chosen = window[0];
  else chosen = [...window].reverse().find((t) => t.channel !== "DIRECT") ?? window[window.length - 1];
  return { channel: chosen.channel, touchId: chosen.id, referralCodeId: chosen.referralCodeId ?? null, campaignId: chosen.campaignId ?? null, rule: rules.model === "FIRST_TOUCH" ? "first-touch" : "last-non-direct-touch" };
}

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
