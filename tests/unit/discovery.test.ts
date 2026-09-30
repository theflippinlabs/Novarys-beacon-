import { describe, expect, it } from "vitest";
import { canonicalUrl, pagePath, withTracking } from "@/core/discovery/urls";
import { planPages, type PagePlan } from "@/core/discovery/plan";
import { assessPage, planFingerprint, QUALITY_THRESHOLDS } from "@/core/discovery/quality";
import { makeChangelog, makeCompetitor, makeFacet, makeFaq, makeGraph, makeSource, sourcedFacts } from "./fixtures/graph";

const LONG = "A sufficiently long facet description that easily exceeds the sixty character minimum.";

describe("pagePath", () => {
  it("builds stable lowercase hyphenated paths for every page type", () => {
    expect(pagePath("PRODUCT", "Acme Live")).toBe("/acme-live");
    expect(pagePath("FEATURE", "acme", "Keyword Filters")).toBe("/acme/features/keyword-filters");
    expect(pagePath("USE_CASE", "acme", "Giveaways")).toBe("/acme/use-cases/giveaways");
    expect(pagePath("INDUSTRY", "acme", "Gaming")).toBe("/acme/industries/gaming");
    expect(pagePath("AUDIENCE", "acme", "TikTok Agencies")).toBe("/acme/for/tiktok-agencies");
    expect(pagePath("INTEGRATION", "acme", "Slack")).toBe("/acme/integrations/slack");
    expect(pagePath("COMPARISON", "acme", "Rival")).toBe("/acme/compare/rival");
    expect(pagePath("ALTERNATIVE", "acme", "Rival")).toBe("/acme/alternatives/rival");
    expect(pagePath("GUIDE", "acme", "How to stop spam?")).toBe("/guides/how-to-stop-spam");
    expect(pagePath("ANSWER", "acme", "Is it free?")).toBe("/answers/is-it-free");
    expect(pagePath("DOCS", "acme")).toBe("/docs/acme");
    expect(pagePath("DOCS", "acme", "Setup")).toBe("/docs/acme/setup");
    expect(pagePath("CHANGELOG", "acme")).toBe("/changelog/acme");
    expect(pagePath("CHANGELOG", "acme", "v1.2")).toBe("/changelog/acme/v1-2");
    expect(pagePath("OTHER", "acme", "Press")).toBe("/acme/press");
  });

  it("throws when a segment page has no item", () => {
    expect(() => pagePath("FEATURE", "acme")).toThrow(/FEATURE pages require an item slug/);
    expect(() => pagePath("COMPARISON", "acme", "")).toThrow();
    expect(() => pagePath("ALTERNATIVE", "acme", "!!!")).toThrow();
  });
});

describe("canonicalUrl / withTracking", () => {
  it("builds absolute https URLs from a bare or schemed domain", () => {
    expect(canonicalUrl("acme.example", "/acme")).toBe("https://acme.example/acme");
    expect(canonicalUrl("http://acme.example///", "/x")).toBe("https://acme.example/x");
    expect(canonicalUrl("acme.example", "/")).toBe("https://acme.example");
    expect(canonicalUrl(null, "/x")).toBeNull();
    expect(canonicalUrl(undefined, "/x")).toBeNull();
    expect(canonicalUrl("", "/x")).toBeNull();
  });

  it("adds tracking params without overriding existing ones or adding empty values", () => {
    const u = new URL(withTracking("https://acme.example/signup?utm_source=newsletter", { utm_source: "beacon", utm_medium: "discovery", utm_campaign: "" }));
    expect(u.searchParams.get("utm_source")).toBe("newsletter");
    expect(u.searchParams.get("utm_medium")).toBe("discovery");
    expect(u.searchParams.has("utm_campaign")).toBe(false);
    expect(u.pathname).toBe("/signup");
  });
});

describe("planPages", () => {
  it("always plans the product page with requirements reflecting the graph", () => {
    const { planned } = planPages(makeGraph());
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ type: "PRODUCT", path: "/acme", title: "Acme" });
    expect(planned[0].requirements.every((r) => !r.met)).toBe(true);
  });

  it("skips facets whose description is shorter than 60 characters", () => {
    const g = makeGraph({
      facets: [makeFacet("FEATURE", "Short", { description: "Too short." }), makeFacet("FEATURE", "Long enough", { description: LONG }), makeFacet("USE_CASE", "No description")],
    });
    const { planned, skipped } = planPages(g);
    expect(planned.map((p) => p.path)).toContain("/acme/features/long-enough");
    expect(planned.map((p) => p.path)).not.toContain("/acme/features/short");
    expect(skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "FEATURE", item: "Short" }), expect.objectContaining({ type: "USE_CASE", item: "No description" })]),
    );
    expect(skipped.find((s) => s.item === "Short")?.reason).toMatch(/60 characters/);
  });

  it("ignores rejected facets entirely", () => {
    const g = makeGraph({ facets: [makeFacet("FEATURE", "Rejected", { description: LONG, verification: "REJECTED" })] });
    const { planned, skipped } = planPages(g);
    expect(planned).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("requires ≥3 sourced facts for a comparison, ≥2 + description for an alternative page", () => {
    const g = makeGraph({
      product: { shortDescription: "Live moderation." },
      competitors: [
        makeCompetitor("Three", sourcedFacts(3)),
        makeCompetitor("Two", sourcedFacts(2)),
        makeCompetitor("Unsourced", [...sourcedFacts(1), ...sourcedFacts(5, false)]),
      ],
    });
    const { planned, skipped } = planPages(g);
    const paths = planned.map((p) => p.path);
    expect(paths).toContain("/acme/compare/three");
    expect(paths).toContain("/acme/alternatives/three");
    expect(paths).not.toContain("/acme/compare/two");
    expect(paths).toContain("/acme/alternatives/two");
    expect(paths.filter((p) => p.includes("unsourced"))).toEqual([]);
    expect(skipped.filter((s) => s.type === "COMPARISON").map((s) => s.item)).toEqual(["Two", "Unsourced"]);
    expect(skipped.find((s) => s.item === "Unsourced")?.reason).toMatch(/Only 1 sourced/);
    const cmp = planned.find((p) => p.path === "/acme/compare/three")!;
    expect(cmp.title).toBe("Acme vs Three");
    expect(cmp.facts.filter((f) => f.ref.startsWith("comparison:"))).toHaveLength(3);
  });

  it("does not plan alternative pages without a product description", () => {
    const { planned } = planPages(makeGraph({ competitors: [makeCompetitor("Rival", sourcedFacts(3))] }));
    expect(planned.some((p) => p.type === "ALTERNATIVE")).toBe(false);
  });

  it("plans answer pages for FAQs with ≥40 char answers, skipping rejected ones", () => {
    const src = makeSource();
    const g = makeGraph({
      sources: [src],
      faqs: [
        makeFaq("Is Acme free?", "No."),
        makeFaq("Does Acme work with TikTok live?", "Yes, Acme moderates TikTok live chats in real time.", { sourceId: src.id }),
        makeFaq("Rejected?", "This answer is long enough but it was rejected by a reviewer.", { verification: "REJECTED" }),
      ],
      changelog: [makeChangelog()],
    });
    const { planned, skipped } = planPages(g);
    const answers = planned.filter((p) => p.type === "ANSWER");
    expect(answers).toHaveLength(1);
    expect(answers[0].path).toBe("/answers/does-acme-work-with-tiktok-live");
    expect(answers[0].requirements).toEqual([{ label: "Answer linked to a source", met: true }]);
    expect(answers[0].facts[0].sourceUrl).toBe(src.url);
    expect(skipped).toEqual([expect.objectContaining({ type: "ANSWER", item: "Is Acme free?" })]);
    expect(planned.some((p) => p.type === "CHANGELOG" && p.path === "/changelog/acme")).toBe(true);
  });
});

function plan(overrides: Partial<PagePlan> = {}): PagePlan {
  return {
    type: "FEATURE",
    path: "/acme/features/keyword-filters",
    title: "Keyword filters — Acme",
    facts: [
      { ref: "facet:1", text: "Keyword filters. Hide live comments that contain blocked keywords or phrases in real time during streams.", verification: "VERIFIED", sourceUrl: "https://acme.example/docs" },
      { ref: "product:short_description", text: "Acme is real-time moderation for TikTok live streams, built for agencies and creators.", verification: "VERIFIED", sourceUrl: "https://acme.example" },
    ],
    requirements: [
      { label: "a", met: true },
      { label: "b", met: true },
    ],
    ...overrides,
  };
}

describe("assessPage", () => {
  it("publishes a complete, verified, unique page", () => {
    const r = assessPage(plan(), [], "COMMERCIAL");
    expect(r.informationCompleteness).toBe(1);
    expect(r.factualConfidence).toBe(1);
    expect(r.intentMatch).toBe(0.9);
    expect(r.duplicateSimilarity).toBe(0);
    expect(r.duplicateOf).toBeNull();
    expect(r.usefulness).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.usefulness);
    expect(r.publishable).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("blocks on unmet requirements and low completeness", () => {
    const r = assessPage(plan({ requirements: [{ label: "Source", met: false }, { label: "x", met: true }] }), []);
    expect(r.informationCompleteness).toBe(0.5);
    expect(r.blockers).toContain("Missing: Source");
    expect(r.blockers).toContain("Information completeness below threshold");
    expect(r.publishable).toBe(false);
  });

  it("scores factual confidence from verification and sourcing", () => {
    const unsourced = plan({ facts: plan().facts.map((f) => ({ ...f, verification: "UNVERIFIED" as const, sourceUrl: undefined })) });
    const r = assessPage(unsourced, []);
    expect(r.factualConfidence).toBe(0.39); // 0.55 × 0.7 rounded
    expect(r.blockers.some((b) => b.startsWith("Factual confidence below threshold"))).toBe(true);
    expect(assessPage(plan({ facts: [] }), []).factualConfidence).toBe(0);
    // Rejected facts are excluded from the average.
    const withRejected = plan({ facts: [...plan().facts, { ref: "x", text: "bad", verification: "REJECTED" }] });
    expect(assessPage(withRejected, []).factualConfidence).toBe(1);
  });

  it("detects near-identical plans as duplicates and ignores its own path", () => {
    const a = plan();
    const b = plan({ path: "/acme/features/keyword-filter", title: "Keyword filter — Acme" });
    const r = assessPage(a, [{ path: b.path, fingerprint: planFingerprint(b) }, { path: a.path, fingerprint: planFingerprint(a) }]);
    expect(r.duplicateSimilarity).toBeGreaterThan(QUALITY_THRESHOLDS.maxDuplicateSimilarity);
    expect(r.duplicateOf).toBe(b.path);
    expect(r.blockers).toContain(`Too similar to ${b.path}`);
    expect(r.publishable).toBe(false);

    const self = assessPage(a, [{ path: a.path, fingerprint: planFingerprint(a) }]);
    expect(self.duplicateSimilarity).toBe(0);
  });

  it("uses the intent fit table, with a default for unknown pairs and no target", () => {
    expect(assessPage(plan({ type: "COMPARISON" }), [], "COMPARISON").intentMatch).toBe(1);
    expect(assessPage(plan({ type: "COMPARISON" }), [], "NAVIGATIONAL").intentMatch).toBe(0.3);
    expect(assessPage(plan(), [], null).intentMatch).toBe(0.7);
    expect(assessPage(plan(), []).intentMatch).toBe(0.7);
  });
});
