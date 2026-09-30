import { describe, expect, it } from "vitest";
import { recommendProducts } from "@/core/sales/recommend";
import { evaluateCrossSell, type CrossSellRule, type IdentityState } from "@/core/crosssell/engine";
import { makeFacet, makeGraph, makePricing } from "./fixtures/graph";

const tiktok = () =>
  makeGraph({
    product: {
      id: "prod-tiktok",
      name: "LiveGuard",
      slug: "liveguard",
      category: "TikTok live moderation",
      shortDescription: "Moderation for TikTok live streams.",
      status: "LIVE",
      conversionUrls: [{ label: "Try free", url: "https://liveguard.example/signup", kind: "TRY_FREE" }],
    },
    facets: [
      makeFacet("AUDIENCE", "TikTok agencies", { description: "Agencies managing TikTok live creators." }),
      makeFacet("PROBLEM", "Spam in live chat", { description: "Spam and toxic comments during TikTok live streams." }),
      makeFacet("FEATURE", "Keyword filters", { description: "Hide comments with blocked words." }),
    ],
    pricing: [makePricing({ planName: "Agency", priceCents: 9900 }), makePricing({ planName: "Hidden", verification: "UNVERIFIED" })],
  });

const legal = () =>
  makeGraph({
    product: { id: "prod-legal", name: "ClauseBot", slug: "clausebot", category: "Legal contract review", shortDescription: "Contract analysis for lawyers.", status: "LIVE" },
    facets: [makeFacet("AUDIENCE", "Law firms", { description: "Lawyers reviewing contracts." }), makeFacet("FEATURE", "Clause extraction", { description: "Extract clauses from contracts." })],
  });

describe("recommendProducts", () => {
  it("recommends the TikTok product for a TikTok agency need and explains why", () => {
    const r = recommendProducts("I run a TikTok agency with 30 creators", [legal(), tiktok()]);
    expect(r.primary?.productId).toBe("prod-tiktok");
    expect(r.primary?.fit).toBe("STRONG");
    expect(r.primary?.why.length).toBeGreaterThan(0);
    expect(r.primary?.why[0].kind).toBe("AUDIENCE");
    expect(r.primary?.why[0].matchedTerms.length).toBeGreaterThan(0);
    expect(r.primary?.cta).toEqual({ label: "Try free", url: "https://liveguard.example/signup" });
    expect(r.primary?.pricing).toEqual(["Agency: €99/month"]);
    expect(r.complementary.map((c) => c.productId)).not.toContain("prod-tiktok");
    expect(r.complementary.map((c) => c.productId)).not.toContain("prod-legal");
    expect(r.considered).toBe(2);
    expect(r.explanation).toMatch(/^LiveGuard matches on audience "TikTok agencies"/);
  });

  it("recommends the legal product for a contract need", () => {
    expect(recommendProducts("We are lawyers and need help reviewing contracts", [tiktok(), legal()]).primary?.productId).toBe("prod-legal");
  });

  it("returns no primary with an explanation when nothing matches", () => {
    const r = recommendProducts("I need a recipe app", [tiktok(), legal()]);
    expect(r.primary).toBeNull();
    expect(r.complementary).toEqual([]);
    expect(r.explanation).toMatch(/^No product/);
    expect(r.considered).toBe(2);
  });

  it("never recommends deprecated products", () => {
    const dep = tiktok();
    dep.product.status = "DEPRECATED";
    const r = recommendProducts("I run a TikTok agency with 30 creators", [dep, legal()]);
    expect(r.primary).toBeNull();
  });
});

const NOW = new Date("2026-03-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const rule = (over: Partial<CrossSellRule> = {}): CrossSellRule => ({
  id: "r1",
  sourceProductId: "A",
  destinationProductId: "B",
  conditions: {},
  message: "Try B",
  ctaLabel: "Try",
  ctaUrl: "https://b.example",
  frequencyCapDays: 7,
  maxImpressions: 3,
  active: true,
  ...over,
});
const identity = (over: Partial<IdentityState> = {}): IdentityState => ({
  consentCrossProduct: true,
  products: [{ productId: "A", status: "ACTIVE", sharedTraits: ["agency"], firstSeenAt: daysAgo(30) }],
  history: [],
  ...over,
});

describe("evaluateCrossSell", () => {
  it("is eligible when all guarantees hold", () => {
    const d = evaluateCrossSell([rule()], identity(), "A", NOW);
    expect(d.eligible.map((r) => r.id)).toEqual(["r1"]);
    expect(d.reasons).toEqual({ r1: "eligible" });
  });

  it("requires explicit consent", () => {
    const d = evaluateCrossSell([rule(), rule({ id: "r2" })], identity({ consentCrossProduct: false }), "A", NOW);
    expect(d.eligible).toEqual([]);
    expect(d.reasons).toEqual({ r1: "no-consent", r2: "no-consent" });
  });

  it("rejects inactive, other-source and not-using-source rules", () => {
    expect(evaluateCrossSell([rule({ active: false })], identity(), "A", NOW).reasons.r1).toBe("inactive");
    expect(evaluateCrossSell([rule({ sourceProductId: "Z" })], identity(), "A", NOW).reasons.r1).toBe("different-source");
    expect(evaluateCrossSell([rule()], identity({ products: [] }), "A", NOW).reasons.r1).toBe("not-using-source");
  });

  it("never recommends a product the identity already uses (unless cancelled)", () => {
    const uses = identity({ products: [...identity().products, { productId: "B", status: "TRIALING", sharedTraits: [], firstSeenAt: daysAgo(1) }] });
    expect(evaluateCrossSell([rule()], uses, "A", NOW).reasons.r1).toBe("already-uses-destination");
    const cancelled = identity({ products: [...identity().products, { productId: "B", status: "CANCELLED", sharedTraits: [], firstSeenAt: daysAgo(1) }] });
    expect(evaluateCrossSell([rule()], cancelled, "A", NOW).reasons.r1).toBe("eligible");
  });

  it("enforces required traits, minimum days and source statuses", () => {
    expect(evaluateCrossSell([rule({ conditions: { requiredTraits: ["agency", "tiktok"] } })], identity(), "A", NOW).reasons.r1).toBe("traits-not-met");
    expect(evaluateCrossSell([rule({ conditions: { requiredTraits: ["agency"] } })], identity(), "A", NOW).reasons.r1).toBe("eligible");
    expect(evaluateCrossSell([rule({ conditions: { minDaysOnSource: 31 } })], identity(), "A", NOW).reasons.r1).toBe("too-early");
    expect(evaluateCrossSell([rule({ conditions: { minDaysOnSource: 30 } })], identity(), "A", NOW).reasons.r1).toBe("eligible");
    expect(evaluateCrossSell([rule({ conditions: { sourceStatuses: ["TRIALING"] } })], identity(), "A", NOW).reasons.r1).toBe("source-status");
  });

  it("suppresses after dismissal or conversion", () => {
    expect(evaluateCrossSell([rule()], identity({ history: [{ ruleId: "r1", type: "DISMISS", occurredAt: daysAgo(100) }] }), "A", NOW).reasons.r1).toBe("dismissed-or-converted");
    expect(evaluateCrossSell([rule()], identity({ history: [{ ruleId: "r1", type: "CONVERSION", occurredAt: daysAgo(100) }] }), "A", NOW).reasons.r1).toBe("dismissed-or-converted");
    // Another rule's dismissal does not affect this one.
    expect(evaluateCrossSell([rule()], identity({ history: [{ ruleId: "other", type: "DISMISS", occurredAt: daysAgo(100) }] }), "A", NOW).reasons.r1).toBe("eligible");
  });

  it("applies the lifetime impression cap and the per-rule frequency cap", () => {
    const three = [10, 20, 30].map((d) => ({ ruleId: "r1", type: "IMPRESSION" as const, occurredAt: daysAgo(d) }));
    expect(evaluateCrossSell([rule()], identity({ history: three }), "A", NOW).reasons.r1).toBe("lifetime-cap");
    expect(evaluateCrossSell([rule()], identity({ history: [{ ruleId: "r1", type: "IMPRESSION", occurredAt: daysAgo(6) }] }), "A", NOW).reasons.r1).toBe("frequency-cap");
    expect(evaluateCrossSell([rule()], identity({ history: [{ ruleId: "r1", type: "IMPRESSION", occurredAt: daysAgo(8) }] }), "A", NOW).reasons.r1).toBe("eligible");
  });

  it("applies the global daily cap across rules", () => {
    const rules = [rule(), rule({ id: "r2", destinationProductId: "C" }), rule({ id: "r3", destinationProductId: "D" })];
    const d = evaluateCrossSell(rules, identity(), "A", NOW, 2);
    expect(d.eligible.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(d.reasons.r3).toBe("global-daily-cap");
    const shownToday = identity({ history: [{ ruleId: "x", type: "IMPRESSION", occurredAt: new Date(NOW.getTime() - 3_600_000) }] });
    const capped = evaluateCrossSell(rules, shownToday, "A", NOW);
    expect(capped.eligible).toEqual([]);
    expect(Object.values(capped.reasons)).toEqual(["global-daily-cap", "global-daily-cap", "global-daily-cap"]);
  });
});
