import { describe, expect, it } from "vitest";
import { classifyQuery, INTENT_TO_FUNNEL } from "@/core/queries/classify";
import { expandQueryUniverse } from "@/core/queries/expand";
import { makeCompetitor, makeFacet, makeGraph, makePricing } from "./fixtures/graph";

describe("classifyQuery", () => {
  it.each([
    ["acme vs rival", "COMPARISON"],
    ["acme versus rival", "COMPARISON"],
    ["difference between acme and rival", "COMPARISON"],
    ["alternatives to hootsuite", "ALTERNATIVE"],
    ["hootsuite alternative", "ALTERNATIVE"],
    ["hootsuite pricing", "TRANSACTIONAL"],
    ["moderation free trial", "TRANSACTIONAL"],
    ["how to stop spam in tiktok live", "PROBLEM"],
    ["best tiktok moderation software", "COMMERCIAL"],
    ["what is live chat moderation", "INFORMATIONAL"],
  ] as const)("%s → %s", (q, intent) => {
    expect(classifyQuery(q).intent).toBe(intent);
  });

  it("maps intents to funnel stages", () => {
    expect(classifyQuery("hootsuite pricing").funnelStage).toBe("DECISION");
    expect(classifyQuery("acme vs rival").funnelStage).toBe("CONSIDERATION");
    expect(classifyQuery("how to stop spam in tiktok live").funnelStage).toBe("AWARENESS");
    expect(classifyQuery("what is live chat moderation").funnelStage).toBe("AWARENESS");
    expect(INTENT_TO_FUNNEL).toEqual({
      INFORMATIONAL: "AWARENESS",
      PROBLEM: "AWARENESS",
      COMMERCIAL: "CONSIDERATION",
      COMPARISON: "CONSIDERATION",
      ALTERNATIVE: "CONSIDERATION",
      TRANSACTIONAL: "DECISION",
      NAVIGATIONAL: "DECISION",
    });
  });

  it("classifies brand-only and brand + login queries as navigational", () => {
    const a = classifyQuery("Acme", ["Acme"]);
    expect(a).toMatchObject({ intent: "NAVIGATIONAL", confidence: 0.9, funnelStage: "DECISION" });
    expect(a.signals).toEqual(["brand:acme"]);
    expect(classifyQuery("acme login", ["Acme"]).intent).toBe("NAVIGATIONAL");
    expect(classifyQuery("acme app sign in", ["Acme"]).intent).toBe("NAVIGATIONAL");
  });

  it("brand + other intent words is not navigational but keeps the brand signal", () => {
    const r = classifyQuery("acme pricing", ["Acme"]);
    expect(r.intent).toBe("TRANSACTIONAL");
    expect(r.signals).toContain("brand:acme");
  });

  it("brand match requires word boundaries", () => {
    expect(classifyQuery("acmeish", ["Acme"]).intent).not.toBe("NAVIGATIONAL");
  });

  // BUG: stop words ("what", "is") are dropped before the brand-only check, so an
  // entity-definition question is classified as NAVIGATIONAL/DECISION.
  it("'what is <brand>' is an informational question, not navigational", () => {
    expect(classifyQuery("what is acme", ["Acme"]).intent).toBe("INFORMATIONAL");
  });

  it("falls back to COMMERCIAL for short unmatched phrases and INFORMATIONAL for long ones", () => {
    const short = classifyQuery("tiktok live moderation");
    expect(short).toMatchObject({ intent: "COMMERCIAL", confidence: 0.35, funnelStage: "CONSIDERATION", signals: ["fallback:no-pattern"] });
    const long = classifyQuery("tiktok live chat moderation for streamers");
    expect(long.intent).toBe("INFORMATIONAL");
    expect(long.confidence).toBe(0.35);
  });

  it("keeps confidence within [0.45, 0.95] for pattern matches and exposes signals", () => {
    for (const q of ["acme vs rival", "best tiktok moderation software", "how to stop spam in tiktok live", "hootsuite pricing plans discount"]) {
      const r = classifyQuery(q);
      expect(r.confidence).toBeGreaterThanOrEqual(0.45);
      expect(r.confidence).toBeLessThanOrEqual(0.95);
      expect(r.signals.length).toBeGreaterThan(0);
    }
    // An unambiguous single-intent query is more confident than a mixed one.
    expect(classifyQuery("acme vs rival").confidence).toBeGreaterThan(classifyQuery("best software pricing vs rival").confidence);
  });
});

describe("expandQueryUniverse", () => {
  it("only produces brand queries when nothing but the name is known", () => {
    const out = expandQueryUniverse(makeGraph());
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((q) => q.clusterName === "Brand")).toBe(true);
    expect(out[0].query).toBe("acme");
  });

  // BUG: the dedup key drops stop words, so "what is acme" has the same key as
  // "acme" and the entity-definition query is never emitted (dead code).
  it("includes the entity-definition question 'what is <name>'", () => {
    expect(expandQueryUniverse(makeGraph()).map((q) => q.query)).toContain("what is acme");
  });

  it("derives queries from pricing, competitors, category, facets and seeds", () => {
    const g = makeGraph({
      product: { category: "Live moderation", keywords: ["chat filter"] },
      pricing: [makePricing()],
      facets: [
        makeFacet("AUDIENCE", "agencies"),
        makeFacet("INDUSTRY", "gaming"),
        makeFacet("PROBLEM", "stop spam in live chat"),
        makeFacet("FEATURE", "keyword blocking"),
        makeFacet("INTEGRATION", "Slack"),
        makeFacet("USE_CASE", "moderating giveaways"),
        makeFacet("FEATURE", "rejected thing", { verification: "REJECTED" }),
      ],
      competitors: [makeCompetitor("Rival")],
    });
    const out = expandQueryUniverse(g);
    const qs = out.map((q) => q.query);
    expect(qs).toContain("acme pricing");
    expect(qs).toContain("acme vs rival");
    expect(qs).toContain("rival alternatives");
    expect(qs).toContain("live moderation software");
    expect(qs).toContain("best live moderation tools");
    expect(qs).toContain("live moderation for agencies");
    expect(qs).toContain("live moderation for gaming");
    expect(qs).toContain("live moderation slack integration");
    expect(qs).toContain("chat filter");
    expect(qs).toContain("how to stop spam in live chat");
    expect(qs).toContain("live moderation keyword blocking");
    expect(qs).toContain("moderating giveaways");
    expect(qs.some((q) => q.includes("rejected"))).toBe(false);
    expect(out.find((q) => q.query === "acme vs rival")?.intent).toBe("COMPARISON");
    expect(out.find((q) => q.query === "rival alternatives")?.intent).toBe("ALTERNATIVE");
    expect(out.find((q) => q.query === "acme")?.intent).toBe("NAVIGATIONAL");
    for (const q of out) expect(q.rationale.length).toBeGreaterThan(0);
  });

  it("de-duplicates on token sets (order, stop words, repeated words)", () => {
    const g = makeGraph({ product: { category: "Moderation software" }, facets: [makeFacet("PROBLEM", "how to stop spam")] });
    const qs = expandQueryUniverse(g, { seedTopics: ["software moderation", "moderation software"] }).map((q) => q.query);
    // "software moderation" seed, category and "<topic> software" all share one token set.
    expect(qs.filter((q) => ["moderation software", "software moderation", "moderation software software"].includes(q))).toHaveLength(1);
    // "how to how to stop spam" is avoided and the problem is not duplicated.
    expect(qs.filter((q) => q.includes("stop spam"))).toEqual(["how to stop spam"]);
    expect(new Set(qs).size).toBe(qs.length);
  });

  it("respects the max cap", () => {
    const g = makeGraph({
      product: { category: "Live moderation" },
      facets: Array.from({ length: 30 }, (_, i) => makeFacet("AUDIENCE", `audience ${String.fromCharCode(97 + (i % 26))}${i}`)),
    });
    expect(expandQueryUniverse(g, { max: 7 })).toHaveLength(7);
    expect(expandQueryUniverse(g).length).toBeLessThanOrEqual(150);
  });
});
