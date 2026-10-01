import { describe, expect, it } from "vitest";
import { buildAnswerBlocks, buildEntityProfile, buildLlmsTxt } from "@/core/geo/entity";
import { completeGraph, FIXED_DATE, makeCompetitor, makeFacet, makeGraph, makePricing, makeProof, makeSource, sourcedFacts } from "./fixtures/graph";

describe("buildEntityProfile", () => {
  it("lists every unknown for an empty graph", () => {
    const p = buildEntityProfile(makeGraph(), "Novarys");
    expect(p.unknowns).toEqual(["summary", "how it works", "category", "pricing", "target audiences", "problems solved", "API availability", "free trial", "languages"]);
    expect(p.who).toEqual({ organization: "Novarys", product: "Acme", url: null, sameAs: [] });
    expect(p.what.summary).toBeNull();
    expect(p.how).toBeNull();
    expect(p.lastVerified).toBeNull();
  });

  it("has no unknowns for a complete graph and carries sources", () => {
    const g = completeGraph();
    const p = buildEntityProfile(g, "Novarys");
    expect(p.unknowns).toEqual([]);
    expect(p.who.url).toBe("https://beaconlive.example");
    expect(p.what.summary).toEqual({ text: "Real-time moderation for TikTok live streams.", sources: ["https://beaconlive.example"], verified: true });
    expect(p.how?.sources).toEqual(["https://beaconlive.example/docs"]);
    expect(p.features[0].sources).toEqual(["https://beaconlive.example/docs"]);
    expect(p.price[0]).toMatchObject({ plan: "Pro", price: "€29", interval: "MONTH", trialDays: 14, sources: ["https://beaconlive.example/pricing"], verified: true });
    expect(p.lastVerified).toBe(FIXED_DATE.toISOString());
  });

  it("only includes proofs that are both publishable and verified", () => {
    const g = makeGraph({
      proofs: [
        makeProof({ title: "ok", content: "verified & publishable" }),
        makeProof({ title: "private", publishable: false }),
        makeProof({ title: "unverified", verification: "UNVERIFIED" }),
      ],
    });
    const p = buildEntityProfile(g, "Org");
    expect(p.proof).toHaveLength(1);
    expect(p.proof[0]).toMatchObject({ kind: "TESTIMONIAL", text: "ok: verified & publishable", verified: true });
  });

  it("marks unknown prices as null (never guessed) and falls back to the pricing URL as source", () => {
    const g = makeGraph({ product: { pricingUrl: "https://acme.example/pricing" }, pricing: [makePricing({ priceCents: null, verification: "UNVERIFIED" })] });
    expect(buildEntityProfile(g, "Org").price[0]).toMatchObject({ price: null, sources: ["https://acme.example/pricing"], verified: false });
  });
});

describe("buildAnswerBlocks", () => {
  it("returns only gaps for an empty graph", () => {
    const { answers, gaps } = buildAnswerBlocks(makeGraph());
    expect(answers).toEqual([]);
    expect(gaps).toEqual([
      "What is Acme? (needs a short description)",
      "Who is Acme for? (needs target audiences)",
      "What does Acme do? (needs features or problems solved)",
      "How much does Acme cost? (no public prices recorded)",
    ]);
  });

  it("only answers pricing when at least one plan has a price", () => {
    const unknown = buildAnswerBlocks(makeGraph({ pricing: [makePricing({ priceCents: null })] }));
    expect(unknown.answers.find((a) => a.id === "cost")).toBeUndefined();
    expect(unknown.gaps.some((g) => g.startsWith("How much"))).toBe(true);

    const src = makeSource({ url: "https://acme.example/pricing" });
    const priced = buildAnswerBlocks(
      makeGraph({ sources: [src], pricing: [makePricing({ planName: "Pro", priceCents: 4950, interval: "YEAR", trialDays: 7, sourceId: src.id }), makePricing({ planName: "Custom", priceCents: null })] }),
    );
    const cost = priced.answers.find((a) => a.id === "cost")!;
    expect(cost.answer).toBe("Acme pricing: Pro: €49.50 per year. A 7-day trial is available on Pro.");
    expect(cost.sources).toEqual(["https://acme.example/pricing"]);
    expect(cost.confidence).toBe(0.9);
    expect(cost.basedOn).toHaveLength(1);
  });

  it("requires ≥2 sourced comparison facts for an alternative answer", () => {
    const g = makeGraph({ competitors: [makeCompetitor("One", sourcedFacts(1)), makeCompetitor("Unsourced", sourcedFacts(4, false)), makeCompetitor("Two", sourcedFacts(2))] });
    const { answers, gaps } = buildAnswerBlocks(g);
    const alts = answers.filter((a) => a.id.startsWith("alternative-"));
    expect(alts.map((a) => a.id)).toEqual(["alternative-two"]);
    expect(alts[0].sources).toEqual(["https://rival.example/pricing#1", "https://rival.example/pricing#2"]);
    expect(gaps).toContain("Alternatives to One? (needs ≥ 2 sourced comparison facts)");
    expect(gaps).toContain("Alternatives to Unsourced? (needs ≥ 2 sourced comparison facts)");
  });

  it("builds audience, capability and integration answers with confidence from verification", () => {
    const g = makeGraph({
      product: { shortDescription: "Live moderation.", category: "Moderation", domain: "acme.example" },
      facets: [
        makeFacet("AUDIENCE", "Agencies"),
        makeFacet("AUDIENCE", "Creators", { verification: "UNVERIFIED" }),
        makeFacet("FEATURE", "Keyword filters"),
        makeFacet("PROBLEM", "Chat spam"),
        makeFacet("INTEGRATION", "Slack", { description: "Posts alerts to Slack." }),
      ],
    });
    const { answers } = buildAnswerBlocks(g);
    const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
    expect(byId["what-is"].answer).toBe("Acme is a moderation product: Live moderation.");
    expect(byId["what-is"].confidence).toBe(0.6);
    expect(byId["who-for"].answer).toBe("Acme is designed for agencies and creators.");
    expect(byId["who-for"].confidence).toBe(0.6);
    expect(byId["supports-agencies"].confidence).toBe(0.9);
    expect(byId["what-does"].answer).toBe("It helps with chat spam. Key capabilities include keyword filters.");
    expect(byId["integrates-slack"].answer).toBe("Yes. Acme integrates with Slack. Posts alerts to Slack.");
    expect(byId["who-for"].sources).toEqual(["https://acme.example"]);
  });
});

describe("buildLlmsTxt", () => {
  it("formats an llms.txt index", () => {
    const txt = buildLlmsTxt({ name: "Novarys", summary: "Tools for creators." }, [
      { name: "Beacon", url: "https://beacon.example", summary: "Discovery engine", pages: [{ title: "Beacon vs Rival", url: "https://beacon.example/compare/rival" }] },
      { name: "Hidden", url: null, summary: null, pages: [] },
    ]);
    expect(txt).toBe(
      [
        "# Novarys",
        "",
        "> Tools for creators.",
        "",
        "## Products",
        "",
        "- [Beacon](https://beacon.example): Discovery engine",
        "- [Hidden](#)",
        "",
        "## Beacon",
        "",
        "- [Beacon vs Rival](https://beacon.example/compare/rival)",
        "",
      ].join("\n"),
    );
    expect(buildLlmsTxt({ name: "X" }, [])).toBe("# X\n\n## Products\n\n");
  });
});
