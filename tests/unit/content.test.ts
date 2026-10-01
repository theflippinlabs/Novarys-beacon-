import { describe, expect, it } from "vitest";
import { EDITOR_TODO, generateDraft, type ContentType } from "@/core/content/generate";
import { factCheck, graphFacts } from "@/core/content/fact-check";
import { seoCheck } from "@/core/content/seo-check";
import { canTransition, assertTransition, statusAfterChecks, PIPELINE, HUMAN_ONLY } from "@/core/content/workflow";
import { completeGraph, makeFacet, makeGraph } from "./fixtures/graph";

const unsupported = (type: ContentType) => {
  const g = completeGraph();
  const comp = g.competitors[0];
  const d = generateDraft(g, { type, publisher: "Novarys", competitorId: comp.competitorId });
  return factCheck(d.body, g, [comp.competitor.name]).claims.filter((c) => c.status === "UNSUPPORTED").map((c) => c.claim);
};

describe("generateDraft", () => {
  it("LANDING_PAGE from a complete graph is structured, sourced and TODO-free", () => {
    const g = completeGraph();
    const d = generateDraft(g, { type: "LANDING_PAGE", publisher: "Novarys" });
    expect(d.title).toBe("Beacon Live: Real-time moderation for TikTok live streams.");
    expect(d.body).not.toContain(EDITOR_TODO);
    expect(d.body.match(/^# /gm)).toHaveLength(1);
    for (const h of ["## Who it is for", "## Problems it solves", "## Key features", "## How it works", "## Integrations", "## Evidence", "## Pricing", "## Frequently asked questions", "## Get started", "## Sources"])
      expect(d.body).toContain(h);
    expect(d.body).toContain("- **Pro**: €29 / month (14-day trial)");
    expect(d.body).toContain("[Start free trial](https://beaconlive.example/signup) {cta:TRY_FREE}");
    expect(d.factRefs.map((r) => r.ref)).toEqual(expect.arrayContaining(["product:short_description", "product:full_description", "product:how_it_works"]));
    expect(d.structuredData.map((s) => s["@type"])).toEqual(["WebApplication", "FAQPage", "BreadcrumbList"]);
    expect(d.metaTitle!.length).toBeLessThanOrEqual(65);
    expect(d.metaDescription).toBe("Real-time moderation for TikTok live streams.");
  });

  it("LANDING_PAGE for a facet targets the facet page and excludes it from related capabilities", () => {
    const g = completeGraph();
    const facet = g.facets.find((f) => f.name === "Keyword filters")!;
    const d = generateDraft(g, { type: "LANDING_PAGE", publisher: "N", facetId: facet.id });
    expect(d.title).toBe("Keyword filters | Beacon Live");
    expect(d.body).toContain("## Related capabilities");
    expect(d.body.split("## Related capabilities")[1].split("##")[0]).not.toContain("Keyword filters");
    const crumbs = d.structuredData.find((s) => s["@type"] === "BreadcrumbList")!.itemListElement as { item: string }[];
    expect(crumbs.map((c) => c.item)).toEqual(["https://beaconlive.example/beacon-live", "https://beaconlive.example/beacon-live/features/keyword-filters"]);
  });

  it("emits EDITOR_TODO markers instead of inventing missing facts", () => {
    const d = generateDraft(makeGraph(), { type: "LANDING_PAGE", publisher: "N" });
    expect(d.body).toContain(`${EDITOR_TODO} Add a short description of Acme`);
    expect(d.body).toContain(`${EDITOR_TODO} No pricing recorded`);
    expect(d.body).toContain(`${EDITOR_TODO} Add a conversion URL`);
    expect(d.body).not.toContain("## Sources");
    expect(d.metaDescription).toBeNull();
    const rival = completeGraph().competitors[0];
    const cmp = generateDraft(makeGraph({ competitors: [{ ...rival, comparisonFacts: [] }] }), { type: "COMPARISON", publisher: "N", competitorId: rival.competitorId });
    expect(cmp.body).toContain(`${EDITOR_TODO} Add sourced comparison facts for Rival`);
  });

  it("links to the pricing page rather than a TODO when plans are unknown but a pricing URL exists", () => {
    const d = generateDraft(makeGraph({ product: { pricingUrl: "https://acme.example/pricing" } }), { type: "LANDING_PAGE", publisher: "N" });
    expect(d.body).toContain("Current plans are listed on the [pricing page](https://acme.example/pricing).");
    expect(d.body).not.toContain(`${EDITOR_TODO} No pricing`);
  });

  it("COMPARISON requires a competitor and renders a sourced table", () => {
    const g = completeGraph();
    expect(() => generateDraft(g, { type: "COMPARISON", publisher: "N" })).toThrow(/requires a competitor/);
    const comp = g.competitors[0];
    const d = generateDraft(g, { type: "COMPARISON", publisher: "N", competitorId: comp.competitorId });
    expect(d.title).toBe("Beacon Live vs Rival");
    expect(d.body).toContain("| Dimension | Beacon Live | Rival | Source |");
    expect(d.body).toContain("| Dimension 1 | Acme value 1 | Rival value 1 | <https://rival.example/pricing#1> |");
    expect(d.factRefs.filter((r) => r.ref.startsWith("comparison:"))).toHaveLength(3);
    expect(d.structuredData[0]["@type"]).toBe("Article");
  });

  it("FAQ uses answer blocks and lists gaps as TODOs", () => {
    const d = generateDraft(completeGraph(), { type: "FAQ", publisher: "N" });
    expect(d.body).toContain("## What is Beacon Live?");
    expect(d.body).toContain("## How much does Beacon Live cost?");
    expect(d.body).not.toContain(EDITOR_TODO);
    expect(d.structuredData[0]["@type"]).toBe("FAQPage");
    const empty = generateDraft(makeGraph(), { type: "FAQ", publisher: "N" });
    expect(empty.body).toContain(`${EDITOR_TODO} Unanswered: What is Acme? (needs a short description)`);
    expect(empty.structuredData).toEqual([]);
  });

  it("X_POST stays within 280 characters including the CTA URL", () => {
    const g = completeGraph();
    const d = generateDraft(g, { type: "X_POST", publisher: "N" });
    expect(d.body.trim().length).toBeLessThanOrEqual(280);
    expect(d.body.trim().endsWith("https://beaconlive.example/signup")).toBe(true);
    const long = completeGraph();
    long.product.shortDescription = "Real-time moderation ".repeat(30);
    long.facets[0].description = "Very long description ".repeat(30);
    const ld = generateDraft(long, { type: "X_POST", publisher: "N" });
    expect(ld.body.trim().length).toBeLessThanOrEqual(280);
    expect(ld.body).toContain("…");
    expect(ld.body.trim().endsWith("https://beaconlive.example/signup")).toBe(true);
  });

  it("DIRECTORY_DESCRIPTION reports unknowns and only verified known prices", () => {
    const d = generateDraft(completeGraph(), { type: "DIRECTORY_DESCRIPTION", publisher: "N" });
    expect(d.body).toContain("**Website:** https://beaconlive.example");
    expect(d.body).toContain("**Pricing:** Pro €29");
    const empty = generateDraft(makeGraph({ product: { freeTrial: true } }), { type: "DIRECTORY_DESCRIPTION", publisher: "N" });
    expect(empty.body).toContain("**Website:** unknown");
    expect(empty.body).toContain("**Category:** unknown");
    expect(empty.body).toContain("**Pricing:** Free trial available");
    expect(empty.body).toContain(EDITOR_TODO);
  });
});

describe("factCheck", () => {
  const g = completeGraph();

  it("flattens the graph into facts excluding rejected items", () => {
    const withRejected = completeGraph();
    withRejected.facets.push(makeFacet("FEATURE", "Rejected thing", { verification: "REJECTED" }));
    const refs = graphFacts(withRejected).map((f) => f.ref);
    expect(refs).toContain("product:short_description");
    expect(refs.some((r) => r.startsWith("pricing:"))).toBe(true);
    expect(refs).not.toContain(`facet:${withRejected.facets.at(-1)!.id}`);
  });

  it("marks grounded sentences SUPPORTED with a fact reference", () => {
    const r = factCheck("Beacon Live hides live comments that contain blocked keywords or phrases.", g);
    expect(r.passed).toBe(true);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].status).toBe("SUPPORTED");
    expect(r.claims[0].factRef).toBe(`facet:${g.facets[0].id}`);
    expect(r.claims[0].sourceUrl).toBe("https://beaconlive.example/docs");
  });

  it("accepts prices that exist in the graph", () => {
    expect(factCheck("Pro: €29 / month (14-day trial).", g).claims[0].status).toBe("SUPPORTED");
    // A price that is not in the graph is an unsupported numeric claim.
    expect(factCheck("Pro: €19 / month (14-day trial).", g).claims[0].status).toBe("UNSUPPORTED");
  });

  it("flags invented statistics as UNSUPPORTED", () => {
    // "used by" + a number found nowhere in the graph is flagged (never SUPPORTED).
    const r = factCheck("Beacon Live is used by 10,000 agencies worldwide.", g);
    expect(r.passed).toBe(false);
    expect(r.claims[0].status).not.toBe("SUPPORTED");
    expect(factCheck("Beacon Live has 12,000 users.", g).claims[0].status).toBe("UNSUPPORTED");
    expect(factCheck("Beacon Live cuts moderation time by 73% for agencies.", g).claims[0].status).toBe("UNSUPPORTED");
  });

  it("flags superlatives for review", () => {
    const r = factCheck("Beacon Live is the best platform for TikTok live moderation.", g);
    expect(r.claims[0].status).toBe("NEEDS_REVIEW");
    expect(factCheck("Revolutionary unmatched technology guaranteed forever.", g).claims[0]).toMatchObject({ status: "NEEDS_REVIEW", sourceUrl: expect.stringMatching(/Superlative/) });
    expect(r.passed).toBe(false);
  });

  it("flags unsupported competitor claims", () => {
    const r = factCheck("Rival crashes constantly and loses customer data.", g, ["Rival"]);
    expect(r.claims[0].status).toBe("UNSUPPORTED");
  });

  it("ignores headings, TODO lines, source lists and very short lines", () => {
    const body = ["# Heading with many words here", `${EDITOR_TODO} Something the editor must add later on`, "- <https://beaconlive.example/docs>", "Short one.", "|---|---|"].join("\n");
    const r = factCheck(body, g);
    expect(r.claims).toEqual([]);
    expect(r.passed).toBe(true);
    expect(() => new Date(r.checkedAt).toISOString()).not.toThrow();
  });

  it("a generated X_POST from a complete graph has no UNSUPPORTED claims", () => {
    expect(unsupported("X_POST")).toEqual([]);
  });

  // BUG (generator ↔ fact-checker mismatch): drafts generated purely from a complete
  // knowledge graph still contain UNSUPPORTED claims, so they can never pass the
  // fact check. See report for the offending sentences.
  it.each(["LANDING_PAGE", "COMPARISON", "FAQ", "DIRECTORY_DESCRIPTION", "OUTREACH"] as const)("generated %s from a complete graph has zero UNSUPPORTED claims", (type) => {
    expect(unsupported(type)).toEqual([]);
  });
});

describe("seoCheck", () => {
  const goodBody = ["# Beacon Live for TikTok agencies", "", "## One", "", "word ".repeat(300), "", "## Sources", "", "- <https://x.example>"].join("\n");
  const base = { type: "LANDING_PAGE" as const, body: goodBody, metaTitle: "Beacon Live for TikTok agencies", metaDescription: "A".repeat(80), structuredData: [{}] };
  const failed = (r: ReturnType<typeof seoCheck>) => r.checks.filter((c) => !c.ok).map((c) => c.rule);

  it("passes a well-formed landing page", () => {
    const r = seoCheck({ ...base, targetQuery: "tiktok agencies" });
    expect(failed(r)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("fails on TODOs, multiple H1s, few sections, meta lengths, depth, missing JSON-LD and sources", () => {
    const r = seoCheck({ type: "LANDING_PAGE", body: `# A\n# B\n${EDITOR_TODO} fill me\n## Only one`, metaTitle: "short", metaDescription: null, structuredData: [] });
    expect(failed(r).sort()).toEqual(["depth", "has_sections", "meta_description", "meta_title", "no_editor_todos", "single_h1", "sources_cited", "structured_data"].sort());
    expect(r.passed).toBe(false);
  });

  it("checks query coverage in the title and keyword stuffing", () => {
    expect(failed(seoCheck({ ...base, targetQuery: "osint investigation platform" }))).toContain("query_in_title");
    const stuffed = { ...base, body: goodBody + "\n" + "agencies ".repeat(50) };
    expect(failed(seoCheck({ ...stuffed, targetQuery: "tiktok agencies" }))).toContain("no_keyword_stuffing");
  });

  it("only applies length and TODO checks to social formats", () => {
    const ok = seoCheck({ type: "X_POST", body: "x".repeat(280), metaTitle: null, metaDescription: null, structuredData: [] });
    expect(ok.checks.map((c) => c.rule)).toEqual(["no_editor_todos", "length"]);
    expect(ok.passed).toBe(true);
    expect(seoCheck({ type: "X_POST", body: "x".repeat(281), metaTitle: null, metaDescription: null, structuredData: [] }).passed).toBe(false);
    expect(seoCheck({ type: "LINKEDIN_POST", body: "hello", metaTitle: null, metaDescription: null, structuredData: [] }).checks).toHaveLength(1);
  });

  it("does not require structured data for release announcements", () => {
    const r = seoCheck({ ...base, type: "RELEASE_ANNOUNCEMENT", structuredData: [] });
    expect(r.checks.find((c) => c.rule === "structured_data")?.ok).toBe(true);
  });
});

describe("content workflow", () => {
  it("allows the documented pipeline transitions", () => {
    for (let i = 0; i < PIPELINE.length - 1; i++) expect(canTransition(PIPELINE[i], PIPELINE[i + 1])).toBe(true);
    expect(canTransition("PUBLISHED", "GENERATED")).toBe(true);
    expect(canTransition("REJECTED", "GENERATED")).toBe(true);
  });

  it("rejects skipping checks or approval", () => {
    expect(canTransition("GENERATED", "PUBLISHED")).toBe(false);
    expect(canTransition("IDEA", "APPROVED")).toBe(false);
    expect(canTransition("SEO_CHECK", "APPROVED")).toBe(false);
    expect(canTransition("PUBLISHED", "REJECTED")).toBe(false);
    expect(() => assertTransition("GENERATED", "PUBLISHED")).toThrow("Invalid content transition GENERATED → PUBLISHED");
    expect(() => assertTransition("HUMAN_APPROVAL", "APPROVED")).not.toThrow();
    expect([...HUMAN_ONLY].sort()).toEqual(["APPROVED", "PUBLISHED"]);
  });

  it("statusAfterChecks stops at the first failing check", () => {
    expect(statusAfterChecks({ passed: false }, { passed: false })).toBe("FACT_CHECK");
    expect(statusAfterChecks({ passed: true }, { passed: false })).toBe("SEO_CHECK");
    expect(statusAfterChecks({ passed: true }, { passed: true })).toBe("HUMAN_APPROVAL");
  });
});
