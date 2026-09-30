import { describe, expect, it } from "vitest";
import { attribute, classifyChannel, commissionFor, DEFAULT_ATTRIBUTION, fraudFlags, isAiReferrer, type Touch } from "@/core/attribution/attribution";
import { buildFunnel, pctChange, FUNNEL_STEPS } from "@/core/conversions/funnel";

describe("classifyChannel", () => {
  it("referral codes beat everything, including UTM tags", () => {
    expect(classifyChannel({ referralCode: { affiliate: true }, utm: { utm_medium: "cpc" }, referrerHost: "google.com" })).toBe("AFFILIATE");
    expect(classifyChannel({ referralCode: { affiliate: false }, utm: { utm_source: "beacon-cross-sell" } })).toBe("REFERRAL");
  });

  it("applies UTM rules in order: cross-sell, paid, email", () => {
    expect(classifyChannel({ utm: { utm_source: "beacon-cross-sell", utm_medium: "cpc" } })).toBe("CROSS_SELL");
    expect(classifyChannel({ utm: { utm_medium: "CPC" }, referrerHost: "chatgpt.com" })).toBe("PAID");
    expect(classifyChannel({ utm: { utm_medium: "email" } })).toBe("EMAIL");
    expect(classifyChannel({ utm: { utm_source: "newsletter" } })).toBe("EMAIL");
  });

  it("detects AI assistants by referrer host (incl. subdomains, www) or utm_source", () => {
    expect(classifyChannel({ referrerHost: "chatgpt.com" })).toBe("AI_REFERRAL");
    expect(classifyChannel({ referrerHost: "www.perplexity.ai" })).toBe("AI_REFERRAL");
    expect(classifyChannel({ referrerHost: "gemini.google.com" })).toBe("AI_REFERRAL");
    expect(classifyChannel({ utm: { utm_source: "chatgpt.com" } })).toBe("AI_REFERRAL");
    expect(classifyChannel({ utm: { utm_source: "perplexity" } })).toBe("AI_REFERRAL");
    expect(isAiReferrer("sub.claude.ai")).toBe(true);
    expect(isAiReferrer("notclaude.ai")).toBe(false);
    expect(isAiReferrer(null)).toBe(false);
  });

  it("classifies google.* and other engines as organic search", () => {
    expect(classifyChannel({ referrerHost: "www.google.com" })).toBe("ORGANIC_SEARCH");
    expect(classifyChannel({ referrerHost: "google.co.uk" })).toBe("ORGANIC_SEARCH");
    expect(classifyChannel({ referrerHost: "duckduckgo.com" })).toBe("ORGANIC_SEARCH");
    expect(classifyChannel({ referrerHost: "notgoogle.com" })).not.toBe("ORGANIC_SEARCH");
  });

  it("classifies social hosts and utm_medium=social", () => {
    expect(classifyChannel({ referrerHost: "t.co" })).toBe("SOCIAL");
    expect(classifyChannel({ referrerHost: "www.linkedin.com" })).toBe("SOCIAL");
    expect(classifyChannel({ referrerHost: "old.reddit.com" })).toBe("SOCIAL");
    expect(classifyChannel({ utm: { utm_medium: "social", utm_source: "x" } })).toBe("SOCIAL");
  });

  it("treats no signal and own hosts as DIRECT, unknown referrers as OTHER", () => {
    expect(classifyChannel({})).toBe("DIRECT");
    expect(classifyChannel({ referrerHost: "app.acme.example", ownHosts: ["acme.example"] })).toBe("DIRECT");
    expect(classifyChannel({ referrerHost: "blog.partner.example" })).toBe("OTHER");
    expect(classifyChannel({ utm: { utm_source: "producthunt" } })).toBe("OTHER");
  });
});

const day = (d: number) => new Date(Date.UTC(2026, 0, d));
const t = (id: string, channel: Touch["channel"], d: number, extra: Partial<Touch> = {}): Touch => ({ id, channel, occurredAt: day(d), ...extra });

describe("attribute", () => {
  it("returns DIRECT when there are no touches", () => {
    expect(attribute([], day(20))).toEqual({ channel: "DIRECT", touchId: null, referralCodeId: null, campaignId: null, rule: "no-touch-in-window" });
  });

  it("uses the last non-direct touch (unsorted input)", () => {
    const r = attribute([t("d", "DIRECT", 19), t("s", "ORGANIC_SEARCH", 10), t("ai", "AI_REFERRAL", 15, { campaignId: "c1" })], day(20));
    expect(r).toEqual({ channel: "AI_REFERRAL", touchId: "ai", referralCodeId: null, campaignId: "c1", rule: "last-non-direct-touch" });
  });

  it("falls back to the last direct touch when only direct touches exist", () => {
    expect(attribute([t("d1", "DIRECT", 5), t("d2", "DIRECT", 6)], day(20)).touchId).toBe("d2");
  });

  it("supports first-touch", () => {
    const r = attribute([t("b", "SOCIAL", 12), t("a", "DIRECT", 11)], day(20), { ...DEFAULT_ATTRIBUTION, model: "FIRST_TOUCH" });
    expect(r).toMatchObject({ touchId: "a", channel: "DIRECT", rule: "first-touch" });
  });

  it("excludes touches outside the lookback window or after the conversion", () => {
    const r = attribute([t("old", "SOCIAL", 1), t("future", "SOCIAL", 25), t("in", "EMAIL", 18)], day(20), { ...DEFAULT_ATTRIBUTION, lookbackDays: 7 });
    expect(r.touchId).toBe("in");
    expect(attribute([t("old", "SOCIAL", 1)], day(20), { ...DEFAULT_ATTRIBUTION, lookbackDays: 7 }).channel).toBe("DIRECT");
    // Boundary: exactly lookbackDays before is still inside.
    expect(attribute([t("edge", "SOCIAL", 13)], day(20), { ...DEFAULT_ATTRIBUTION, lookbackDays: 7 }).touchId).toBe("edge");
  });

  it("gives the most recent referral touch precedence when enabled", () => {
    const touches = [t("r1", "AFFILIATE", 5, { referralCodeId: "code1" }), t("r2", "REFERRAL", 8, { referralCodeId: "code2" }), t("s", "ORGANIC_SEARCH", 19)];
    expect(attribute(touches, day(20))).toMatchObject({ touchId: "r2", referralCodeId: "code2", rule: "referral-precedence" });
    expect(attribute(touches, day(20), { ...DEFAULT_ATTRIBUTION, referralPrecedence: false })).toMatchObject({ touchId: "s", rule: "last-non-direct-touch" });
  });
});

describe("commissionFor / fraudFlags", () => {
  const base = { amountCents: 10_000, commissionBps: 2_000, monthsSinceStart: 0, commissionMonths: 12, type: "NEW" };
  it("computes basis-point commission within the commission window", () => {
    expect(commissionFor(base)).toBe(2_000);
    expect(commissionFor({ ...base, monthsSinceStart: 11 })).toBe(2_000);
    expect(commissionFor({ ...base, monthsSinceStart: 12 })).toBe(0);
    expect(commissionFor({ ...base, amountCents: 999, commissionBps: 1_500 })).toBe(150);
  });
  it("pays nothing on churn/downgrade and claws back on refunds", () => {
    expect(commissionFor({ ...base, type: "CHURN" })).toBe(0);
    expect(commissionFor({ ...base, type: "DOWNGRADE" })).toBe(0);
    expect(commissionFor({ ...base, type: "REFUND", amountCents: -10_000 })).toBe(-2_000);
  });
  it("raises fraud flags", () => {
    expect(fraudFlags({})).toEqual([]);
    expect(fraudFlags({ referrerEmailHash: "h", customerEmailHash: "h", clickToConversionSeconds: 3, signupsFromSameIpLast24h: 5, refunded: true })).toEqual([
      "SELF_REFERRAL",
      "INSTANT_CONVERSION",
      "IP_VELOCITY",
      "REFUNDED",
    ]);
    expect(fraudFlags({ referrerEmailHash: "a", customerEmailHash: "b", clickToConversionSeconds: 10, signupsFromSameIpLast24h: 4 })).toEqual([]);
    expect(fraudFlags({ clickToConversionSeconds: 0 })).toEqual(["INSTANT_CONVERSION"]);
    expect(fraudFlags({ clickToConversionSeconds: null })).toEqual([]);
  });
});

describe("funnel", () => {
  it("computes step and start conversion rates", () => {
    const f = buildFunnel({ PAGE_VIEW: 1000, CTA_CLICK: 100, SIGNUP: 20 });
    expect(f.map((r) => r.step)).toEqual([...FUNNEL_STEPS]);
    expect(f[0]).toEqual({ step: "PAGE_VIEW", visitors: 1000, conversionFromPrev: null, conversionFromStart: null });
    expect(f[1]).toMatchObject({ visitors: 100, conversionFromPrev: 0.1, conversionFromStart: 0.1 });
    expect(f[2]).toMatchObject({ conversionFromPrev: 0.2, conversionFromStart: 0.02 });
    expect(f[3]).toMatchObject({ visitors: 0, conversionFromPrev: 0, conversionFromStart: 0 });
    // Zero denominator → null, never 0% or 100%.
    expect(f[4]).toMatchObject({ visitors: 0, conversionFromPrev: null });
  });

  it("returns null rates everywhere without page views", () => {
    const f = buildFunnel({ SIGNUP: 5 });
    expect(f.every((r) => r.conversionFromStart === null)).toBe(true);
    expect(f[2].conversionFromPrev).toBeNull();
    expect(f[3].conversionFromPrev).toBe(0);
  });

  it("pctChange", () => {
    expect(pctChange(150, 100)).toBe(0.5);
    expect(pctChange(50, 100)).toBe(-0.5);
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(5, 0)).toBeNull();
  });
});
