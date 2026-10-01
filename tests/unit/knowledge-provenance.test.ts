import { describe, expect, it } from "vitest";
import { parsePrice, parsePricing } from "@/core/knowledge/parse";
import { ageFactor, computeConfidence, isFailingSource } from "@/core/knowledge/confidence";
import { claimValue, detectConflicts, outdatedStatus, pricingConflictCandidate, verificationAfterEdit, verificationError } from "@/core/knowledge/provenance";
import { computeCompleteness, SECTION_WEIGHTS } from "@/core/knowledge/completeness";
import { claimVerification, verifiedOnly, type Claim } from "@/core/knowledge/types";
import { completeGraph, FIXED_DATE, makeFacet, makeGraph, makePricing, makeProduct } from "./fixtures/graph";

const DAY = 86_400_000;

describe("parsePricing: never fabricates a price, currency or interval", () => {
  it("parses numeric prices only", () => {
    expect(parsePrice("29")).toBe(2900);
    expect(parsePrice("29.90")).toBe(2990);
    expect(parsePrice("29,90")).toBe(2990);
    expect(parsePrice("1,299.50")).toBe(129950);
    expect(parsePrice("€ 1 299")).toBe(129900);
    for (const t of ["Contact sales", "Custom", "On request", "", "free?", "29/mo"]) expect(parsePrice(t)).toBeNull();
  });

  it("keeps unknown currency and interval null, and maps non-numeric prices to CUSTOM", () => {
    const [starter, sales, bare, euro, explicit] = parsePricing(["Starter | 29 | eur | month | 14 | One seat", "Enterprise | Contact sales", "Team | 49", "Pro | €99 |  | YEAR", "Agency | On request | | USAGE"].join("\n"));
    expect(starter).toMatchObject({ planName: "Starter", priceCents: 2900, currency: "EUR", interval: "MONTH", trialDays: 14, description: "One seat" });
    expect(sales).toMatchObject({ planName: "Enterprise", priceCents: null, currency: null, interval: "CUSTOM" });
    expect(bare).toMatchObject({ planName: "Team", priceCents: 4900, currency: null, interval: null });
    expect(euro).toMatchObject({ priceCents: 9900, currency: "EUR", interval: "YEAR" });
    expect(explicit).toMatchObject({ priceCents: null, interval: "USAGE" });
    expect(parsePricing("Free | 0 | USD | MONTH")[0]).toMatchObject({ priceCents: 0, currency: "USD" });
    expect(parsePricing("Weird | 10 | dollars | weekly")[0]).toMatchObject({ currency: null, interval: null });
  });
});

describe("computeConfidence", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("multiplies status, source and age factors", () => {
    expect(computeConfidence({ verification: "VERIFIED", source: { kind: "PRICING" }, verifiedAt: now, now })).toBe(1);
    expect(computeConfidence({ verification: "VERIFIED", source: { kind: "WEBSITE" }, verifiedAt: now, now })).toBe(0.9);
    expect(computeConfidence({ verification: "VERIFIED", source: null, verifiedAt: now, now })).toBe(0.5);
    expect(computeConfidence({ verification: "UNVERIFIED", source: { kind: "DOCUMENTATION" }, verifiedAt: null, now })).toBe(0.4);
    expect(computeConfidence({ verification: "NEEDS_REVIEW", source: null, verifiedAt: null, now })).toBe(0.25);
    expect(computeConfidence({ verification: "OUTDATED", source: { kind: "PRICING" }, verifiedAt: now, now })).toBe(0.2);
    expect(computeConfidence({ verification: "CONFLICTING", source: { kind: "PRICING" }, verifiedAt: now, now })).toBe(0.1);
    expect(computeConfidence({ verification: "REJECTED", source: { kind: "PRICING" }, verifiedAt: now, now })).toBe(0);
    expect(computeConfidence({ verification: "VERIFIED", source: { kind: "PRICING", failing: true }, verifiedAt: now, now })).toBe(0.5);
  });

  it("decays verified facts with age down to the floor at the stale threshold", () => {
    expect(ageFactor(new Date(now.getTime() - 10 * DAY), now)).toBe(1);
    expect(ageFactor(new Date(now.getTime() - 105 * DAY), now)).toBeCloseTo(0.75, 5);
    expect(ageFactor(new Date(now.getTime() - 180 * DAY), now)).toBe(0.5);
    expect(ageFactor(new Date(now.getTime() - 900 * DAY), now)).toBe(0.5);
    expect(ageFactor(null, now)).toBe(0.5);
    expect(ageFactor(new Date(now.getTime() - 60 * DAY), now, 90)).toBeCloseTo(0.75, 5);
    expect(ageFactor(new Date(now.getTime() - 90 * DAY), now, 90)).toBe(0.5);
    // Age only applies to verified facts.
    expect(computeConfidence({ verification: "UNVERIFIED", source: { kind: "PRICING" }, verifiedAt: new Date(0), now })).toBe(0.4);
  });

  it("treats a source as failing after two consecutive failed checks", () => {
    expect(isFailingSource({ consecutiveFailures: 1 })).toBe(false);
    expect(isFailingSource({ consecutiveFailures: 2 })).toBe(true);
  });
});

describe("provenance rules", () => {
  it("any change to a judged value needs a new review", () => {
    expect(verificationAfterEdit("VERIFIED", true)).toBe("NEEDS_REVIEW");
    expect(verificationAfterEdit("OUTDATED", true)).toBe("NEEDS_REVIEW");
    expect(verificationAfterEdit("CONFLICTING", true)).toBe("NEEDS_REVIEW");
    expect(verificationAfterEdit("UNVERIFIED", true)).toBe("UNVERIFIED");
    expect(verificationAfterEdit("REJECTED", true)).toBe("REJECTED");
    expect(verificationAfterEdit("VERIFIED", false)).toBe("VERIFIED");
  });

  it("verification requires a source", () => {
    expect(verificationError("VERIFIED", {})).toMatch(/source/);
    expect(verificationError("VERIFIED", { sourceUrl: "http://insecure.example" })).toMatch(/source/);
    expect(verificationError("VERIFIED", { sourceId: "s1" })).toBeNull();
    expect(verificationError("VERIFIED", { sourceUrl: "https://a.example/x" })).toBeNull();
    expect(verificationError("REJECTED", {})).toBeNull();
  });

  it("serialises claim values like the migration backfill", () => {
    const p = makeProduct({ languages: ["en", "fr"], apiAvailable: false, status: "UNKNOWN", releaseDate: "2026-01-02", category: "  Moderation " });
    expect(claimValue(p, "languages")).toBe("en, fr");
    expect(claimValue(p, "api_available")).toBe("false");
    expect(claimValue(p, "status")).toBeNull();
    expect(claimValue(p, "release_date")).toBe("2026-01-02");
    expect(claimValue(p, "category")).toBe("Moderation");
    expect(claimValue(p, "supported_countries")).toBeNull();
  });

  it("detects conflicts only between different sources that disagree", () => {
    const c = (id: string, key: string, value: string, sourceId: string | null) => ({ id, key, value, sourceId, verification: "UNVERIFIED" as const });
    const out = detectConflicts([c("a", "category", "Moderation", "s1"), c("b", "category", "moderation ", "s2"), c("c", "domain", "a.example", "s1"), c("d", "domain", "b.example", "s2"), c("e", "domain", "c.example", null), c("f", "status", "LIVE", "s1"), c("g", "status", "BETA", "s1")]);
    expect([...out].sort()).toEqual(["c", "d"]);
    const p1 = pricingConflictCandidate({ id: "p1", planName: "Pro", priceCents: 2900, currency: "EUR", interval: "MONTH", sourceId: "s1", verification: "VERIFIED" });
    const p2 = pricingConflictCandidate({ id: "p2", planName: "pro", priceCents: 3900, currency: "EUR", interval: "MONTH", sourceId: "s2", verification: "UNVERIFIED" });
    expect([...detectConflicts([p1, p2])].sort()).toEqual(["p1", "p2"]);
    expect(detectConflicts([p1, { ...p2, verification: "REJECTED" }]).size).toBe(0);
  });

  it("marks failing-source and stale verified claims OUTDATED", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(outdatedStatus({ verification: "VERIFIED", verifiedAt: new Date(now.getTime() - 200 * DAY), sourceFailing: false }, now, 180)).toBe("OUTDATED");
    expect(outdatedStatus({ verification: "VERIFIED", verifiedAt: new Date(now.getTime() - 10 * DAY), sourceFailing: false }, now, 180)).toBeNull();
    expect(outdatedStatus({ verification: "UNVERIFIED", verifiedAt: null, sourceFailing: true }, now, 180)).toBe("OUTDATED");
    expect(outdatedStatus({ verification: "REJECTED", verifiedAt: null, sourceFailing: true }, now, 180)).toBeNull();
    // Unknown verification date (legacy): not marked stale.
    expect(outdatedStatus({ verification: "VERIFIED", verifiedAt: null, sourceFailing: false }, now, 180)).toBeNull();
  });
});

const claim = (field: string, value: string, verification: Claim["verification"], over: Partial<Claim> = {}): Claim => ({
  id: `claim-${field}-${value}`,
  organizationId: "o",
  productId: "p",
  field,
  value,
  sourceId: "s1",
  verification,
  verifiedAt: verification === "VERIFIED" ? FIXED_DATE : null,
  verifiedBy: null,
  confidence: null,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  ...over,
});

describe("per-claim verification (verifiedOnly)", () => {
  it("uses per-field claims, and the legacy lastVerifiedAt only without claims", () => {
    const product = { shortDescription: "Live moderation.", category: "Moderation", domain: "acme.example", status: "LIVE" as const, lastVerifiedAt: FIXED_DATE };
    const legacy = makeGraph({ product });
    expect(claimVerification(legacy, "short_description")).toBe("VERIFIED");
    expect(verifiedOnly(legacy).product.shortDescription).toBe("Live moderation.");

    const g = makeGraph({ product, claims: [claim("short_description", "Live moderation.", "VERIFIED"), claim("category", "Moderation", "NEEDS_REVIEW"), claim("domain", "acme.example", "VERIFIED"), claim("status", "LIVE", "OUTDATED")] });
    const v = verifiedOnly(g).product;
    expect(v.shortDescription).toBe("Live moderation.");
    expect(v.category).toBeNull();
    expect(v.domain).toBe("acme.example");
    expect(v.status).toBe("UNKNOWN");
    // A claim for an older value does not verify the current one.
    const stale = makeGraph({ product, claims: [claim("short_description", "Old text.", "VERIFIED")] });
    expect(claimVerification(stale, "short_description")).toBe("UNVERIFIED");
    expect(verifiedOnly(stale).product.shortDescription).toBeNull();
  });

  it("drops unverified changelog entries from the public graph", () => {
    const g = completeGraph();
    g.changelog = g.changelog.map((c) => ({ ...c, verification: "UNVERIFIED" }));
    expect(verifiedOnly(g).changelog).toEqual([]);
  });
});

describe("computeCompleteness (sections, verification-weighted)", () => {
  it("returns the six sections with weights summing to 100 and an overall weighted average", () => {
    const c = computeCompleteness(completeGraph());
    expect(c.sections.map((s) => s.key)).toEqual(["identity", "features", "pricing", "use_cases", "proof", "documentation"]);
    expect(Object.values(SECTION_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const weighted = c.sections.reduce((a, s) => a + s.pct * s.weight, 0) / 100;
    expect(c.score).toBeCloseTo(weighted, 6);
    for (const s of c.sections) {
      expect(s.max).toBe(s.weight);
      expect(s.earned).toBeCloseTo(s.items.reduce((a, i) => a + i.earned, 0), 6);
    }
  });

  it("counts unverified facts half and outdated / conflicting facts zero", () => {
    const five = (verification: Claim["verification"]) => ["A", "B", "C", "D", "E"].map((n) => makeFacet("FEATURE", n, { verification }));
    const item = (facets: ReturnType<typeof five>) => computeCompleteness(makeGraph({ facets })).sections.find((s) => s.key === "features")!.items.find((i) => i.key === "features")!;
    const verified = item(five("VERIFIED"));
    expect(verified.earned).toBeCloseTo(verified.weight, 6);
    expect(verified).toMatchObject({ verified: true, facts: 5, verifiedFacts: 5, status: "complete" });
    const unverified = item(five("UNVERIFIED"));
    expect(unverified.earned).toBeCloseTo(verified.weight / 2, 6);
    expect(unverified).toMatchObject({ verified: false, status: "partial" });
    expect(item(five("OUTDATED")).earned).toBe(0);
    expect(item(five("CONFLICTING")).earned).toBe(0);
  });

  it("scores an empty graph near zero with every section listed and verification ratios", () => {
    const c = computeCompleteness(makeGraph());
    expect(c.score).toBeGreaterThan(0); // the name is always known
    expect(c.score).toBeLessThan(0.05);
    expect(c.sections.find((s) => s.key === "pricing")!.verifiedRatio).toBeNull();
    const priced = computeCompleteness(makeGraph({ pricing: [makePricing({ currency: null })] }));
    const plans = priced.sections.find((s) => s.key === "pricing")!.items.find((i) => i.key === "pricing")!;
    // A verified plan with an unknown currency counts half.
    expect(plans.earned).toBeCloseTo(plans.weight / 2, 6);
  });
});
