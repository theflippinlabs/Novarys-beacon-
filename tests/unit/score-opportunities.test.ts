import { describe, expect, it } from "vitest";
import { computeBeaconScore, type ScoreInput } from "@/core/score/beacon-score";
import { generateOpportunities, priority, type OpportunitySignals } from "@/core/opportunities/engine";

const EMPTY: ScoreInput = {
  completeness: 0,
  audit: null,
  pages: { planned: 0, published: 0, productPagePublished: false, answerPagesPublished: 0, comparisonPlanned: 0, comparisonPublished: 0 },
  authority: { verifiedProofs: 0, sources: 0, referringDomains: null, aiMentions90d: 0, aiTests90d: 0 },
  queries: { active: 0, weightedCovered: 0, weightedTotal: 0 },
  conversion: { conversionUrls: 0, ctaEvents30d: 0, pricingPlans: 0, hasTrialOrDemo: false },
  measurement: { searchConsole: false, analytics: false, eventsReceived30d: false, revenueSource: false },
};

const PERFECT: ScoreInput = {
  completeness: 1,
  audit: { openIssues: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }, pagesCrawled: 50, ageDays: 1 },
  pages: { planned: 10, published: 10, productPagePublished: true, answerPagesPublished: 5, comparisonPlanned: 2, comparisonPublished: 2 },
  authority: { verifiedProofs: 4, sources: 5, referringDomains: 10_000, aiMentions90d: 10, aiTests90d: 10 },
  queries: { active: 40, weightedCovered: 100, weightedTotal: 100 },
  conversion: { conversionUrls: 2, ctaEvents30d: 50, pricingPlans: 3, hasTrialOrDemo: true },
  measurement: { searchConsole: true, analytics: true, eventsReceived30d: true, revenueSource: true },
};

const allLines = (s: ReturnType<typeof computeBeaconScore>) => s.components.flatMap((c) => c.lines);

describe("computeBeaconScore", () => {
  it("has seven components, each summing its lines", () => {
    const s = computeBeaconScore(PERFECT);
    expect(s.components.map((c) => c.key)).toEqual(["technical", "content", "entity", "authority", "queries", "conversion", "measurement"]);
    for (const c of s.components) expect(c.max).toBe(c.lines.reduce((a, l) => a + l.max, 0));
    // Documented component maxima.
    expect(Object.fromEntries(s.components.map((c) => [c.key, c.max]))).toMatchObject({ technical: 20, content: 20, entity: 15, authority: 15, queries: 15, conversion: 10, measurement: 5 });
  });

  // BUG: documented as a 0 to 100 score, but the component maxima are
  // 20+20+20+15+15+10+5 = 105, so a perfect input scores 105.
  it("component maxima sum to 100", () => {
    const s = computeBeaconScore(PERFECT);
    expect(s.components.reduce((a, c) => a + c.max, 0)).toBe(100);
  });

  it("total never exceeds 100", () => {
    expect(computeBeaconScore(PERFECT).total).toBeLessThanOrEqual(100);
  });

  it("a perfect input earns every point available", () => {
    const s = computeBeaconScore(PERFECT);
    for (const l of allLines(s)) expect(l.earned).toBe(l.max);
    expect(s.total).toBe(s.components.reduce((a, c) => a + c.max, 0));
    expect(s.pathTo.tasks).toEqual([]);
    expect(s.pathTo.target).toBe(100);
    expect(allLines(s).every((l) => l.fix === undefined)).toBe(true);
  });

  it("an empty input scores low and explains why", () => {
    const s = computeBeaconScore(EMPTY);
    // Only "Comparisons" (nothing required) earns points.
    expect(s.total).toBe(3);
    const reasons = allLines(s).map((l) => l.reason);
    expect(reasons).toContain("No technical audit has been run.");
    expect(reasons).toContain("Backlink data not connected: cannot be scored.");
    expect(reasons).toContain("No AI visibility tests run.");
    expect(reasons.filter((r) => r === "Not connected.")).toHaveLength(2);
    for (const l of allLines(s)) {
      expect(l.earned).toBeGreaterThanOrEqual(0);
      expect(l.earned).toBeLessThanOrEqual(l.max);
    }
  });

  it("clamps penalties so heavy issue counts never go negative", () => {
    const s = computeBeaconScore({ ...PERFECT, audit: { openIssues: { CRITICAL: 50, HIGH: 50, MEDIUM: 500, LOW: 500, INFO: 0 }, pagesCrawled: 1, ageDays: 100 } });
    expect(s.components[0].earned).toBe(0);
    const medium = computeBeaconScore({ ...PERFECT, audit: { openIssues: { CRITICAL: 1, HIGH: 2, MEDIUM: 4, LOW: 8, INFO: 0 }, pagesCrawled: 1, ageDays: 30 } });
    // 12 - (4 + 3) = 5; 6 - (4 + 2)/2 = 3; freshness 1
    expect(medium.components[0].lines.map((l) => l.earned)).toEqual([5, 3, 1]);
  });

  it("pathTo tasks are sorted by points per effort and reach the next milestone", () => {
    const s = computeBeaconScore(EMPTY);
    expect(s.pathTo.target).toBe(10);
    const ratios = s.pathTo.tasks.map((t) => t.points / t.effort);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeLessThanOrEqual(ratios[i - 1]);
    expect(s.total + s.pathTo.tasks.reduce((a, t) => a + t.points, 0)).toBeGreaterThanOrEqual(s.pathTo.target);
    // Stops as soon as the target is reached: dropping the last task falls short.
    expect(s.total + s.pathTo.tasks.slice(0, -1).reduce((a, t) => a + t.points, 0)).toBeLessThan(s.pathTo.target);
    expect(s.pathTo.tasks[0]).toMatchObject({ task: "Run a technical SEO audit of the product website.", points: 20, component: "Technical Discovery", effort: 1 });

    const mid = computeBeaconScore({ ...EMPTY, completeness: 0.5, measurement: { ...EMPTY.measurement, searchConsole: true } });
    expect(mid.total).toBe(13);
    expect(mid.pathTo.target).toBe(20);
  });
});

const SIG: OpportunitySignals = {
  product: { id: "p1", name: "Acme", slug: "acme" },
  queries: [],
  aiGaps: [],
  seoIssues: [],
  missingEntity: [],
  competitorsWithoutComparison: [],
  orphanPages: [],
  lowConversionPages: [],
};
const q = (over: Partial<OpportunitySignals["queries"][number]> = {}): OpportunitySignals["queries"][number] => ({ id: "q1", query: "tiktok live moderation", intent: "COMMERCIAL", importance: 4, coverage: "NONE", ...over });

describe("generateOpportunities", () => {
  it("priority = impact × confidence × urgency ÷ effort", () => {
    expect(priority(4, 3, 3, 3)).toBe(12);
    expect(priority(5, 5, 3, 5)).toBe(41.7);
  });

  it("returns nothing for empty signals", () => {
    expect(generateOpportunities(SIG)).toEqual([]);
  });

  it("creates content gaps only for uncovered queries with importance ≥ 3", () => {
    const out = generateOpportunities({
      ...SIG,
      queries: [q({ id: "a" }), q({ id: "b", importance: 2 }), q({ id: "c", coverage: "PARTIAL" }), q({ id: "d", coverage: "COVERED", importance: 5 })],
    });
    expect(out.map((o) => o.fingerprint)).toEqual(["content_gap:a"]);
    expect(out[0]).toMatchObject({ type: "CONTENT_GAP", impact: 4, confidence: 3, effort: 3, urgency: 3, priorityScore: 12, potential: "MEDIUM" });
    expect(out[0].actions[0]).toEqual({ order: 1, kind: "CREATE_PAGE", action: 'Create an audience page targeting "tiktok live moderation".' });
  });

  it("adds a guide action for problem queries and competitor evidence from AI gaps", () => {
    const out = generateOpportunities({
      ...SIG,
      queries: [q({ intent: "PROBLEM", query: "stop tiktok spam", search: { impressions: 500, clicks: 50, position: 3 } })],
      aiGaps: [{ prompt: "how do I stop tiktok spam", promptId: "pr1", testsRun: 0, productMentions: 0, competitorsMentioned: ["Rival"] }],
    });
    const gap = out.find((o) => o.type === "CONTENT_GAP")!;
    expect(gap.actions.map((a) => a.kind)).toContain("CREATE_GUIDE");
    expect(gap.actions[0].action).toContain("use-case page");
    expect(gap.competitors).toEqual(["Rival"]);
    expect(gap).toMatchObject({ impact: 5, confidence: 4, urgency: 4, potential: "HIGH" });
    // testsRun = 0 → no AI gap opportunity.
    expect(out.some((o) => o.type === "AI_VISIBILITY_GAP")).toBe(false);
  });

  it("detects striking distance (position 8 to 20, ≥50 impressions) and low CTR on page one", () => {
    const out = generateOpportunities({
      ...SIG,
      queries: [
        q({ id: "s", coverage: "COVERED", search: { impressions: 80, clicks: 1, position: 12.345 } }),
        q({ id: "s-low", coverage: "COVERED", search: { impressions: 49, clicks: 1, position: 12 } }),
        q({ id: "s-top", coverage: "COVERED", search: { impressions: 80, clicks: 1, position: 8 } }),
        q({ id: "ctr", coverage: "COVERED", search: { impressions: 1000, clicks: 5, position: 4 } }),
        q({ id: "ctr-ok", coverage: "COVERED", search: { impressions: 1000, clicks: 10, position: 4 } }),
        q({ id: "ctr-deep", coverage: "COVERED", search: { impressions: 1000, clicks: 1, position: null } }),
      ],
    });
    expect(out.map((o) => o.fingerprint).sort()).toEqual(["low_ctr:ctr", "striking:s"]);
    expect(out.find((o) => o.type === "STRIKING_DISTANCE")!.title).toBe('Improve ranking for "tiktok live moderation" (avg. position 12.3)');
    expect(out.find((o) => o.type === "LOW_CTR")!.evidence[0]).toEqual({ label: "CTR", value: "0.50%" });
  });

  it("creates AI visibility gaps only when competitors are mentioned and the product is not", () => {
    const out = generateOpportunities({
      ...SIG,
      aiGaps: [
        { prompt: "a", promptId: "1", testsRun: 3, productMentions: 0, competitorsMentioned: ["Rival"] },
        { prompt: "b", promptId: "2", testsRun: 3, productMentions: 1, competitorsMentioned: ["Rival"] },
        { prompt: "c", promptId: "3", testsRun: 3, productMentions: 0, competitorsMentioned: [] },
        { prompt: "d", promptId: "4", testsRun: 1, productMentions: 0, competitorsMentioned: ["Other"] },
      ],
    });
    expect(out.map((o) => o.fingerprint)).toEqual(["ai_gap:1", "ai_gap:4"]);
    expect(out[0].confidence).toBe(3);
    expect(out[1].confidence).toBe(2);
    expect(out[0].problem).toMatch(/do not represent every user/);
  });

  it("maps technical severity and other signal types", () => {
    const out = generateOpportunities({
      ...SIG,
      seoIssues: [
        { rule: "http.error", severity: "CRITICAL", count: 3, exampleUrl: "https://a/x" },
        { rule: "meta.title_missing", severity: "HIGH", count: 1, exampleUrl: "https://a/y" },
      ],
      missingEntity: [
        { key: "a", label: "Pricing", weight: 10, earned: 0 },
        { key: "b", label: "Minor", weight: 2, earned: 0 },
      ],
      competitorsWithoutComparison: [{ name: "Rival Co", sourcedFacts: 1 }],
      orphanPages: ["https://a/o1", "https://a/o2"],
      lowConversionPages: [{ path: "/acme", views: 500, ctaClicks: 1 }],
      searchTrend: { clicksNow: 60, clicksPrev: 100 },
    });
    const byType = Object.fromEntries(out.map((o) => [o.fingerprint, o]));
    expect(byType["tech:p1:http.error"]).toMatchObject({ impact: 5, urgency: 5, potential: "HIGH", priorityScore: 62.5 });
    expect(byType["tech:p1:meta.title_missing"]).toMatchObject({ impact: 3, urgency: 3, potential: "MEDIUM" });
    expect(byType["entity:p1"].evidence).toEqual([{ label: "Pricing", value: "0% complete" }]);
    expect(byType["entity:p1"].impact).toBe(4);
    expect(byType["comparison:p1:rival co"].competitors).toEqual(["Rival Co"]);
    expect(byType["orphans:p1"].title).toBe("Link 2 orphan page(s)");
    expect(byType["cta:p1:/acme"].type).toBe("CONVERSION");
    expect(byType["drop:p1"].title).toBe("Organic clicks down 40% for Acme");
    // Sorted by priority descending.
    for (let i = 1; i < out.length; i++) expect(out[i].priorityScore).toBeLessThanOrEqual(out[i - 1].priorityScore);
    // Fingerprints are unique and stable across runs.
    expect(new Set(out.map((o) => o.fingerprint)).size).toBe(out.length);
    const again = generateOpportunities({ ...SIG, seoIssues: [{ rule: "http.error", severity: "CRITICAL", count: 9, exampleUrl: "https://a/z" }] });
    expect(again[0].fingerprint).toBe("tech:p1:http.error");
  });

  it("ignores small search drops and low-volume trends", () => {
    expect(generateOpportunities({ ...SIG, searchTrend: { clicksNow: 90, clicksPrev: 100 } })).toEqual([]);
    expect(generateOpportunities({ ...SIG, searchTrend: { clicksNow: 0, clicksPrev: 40 } })).toEqual([]);
  });

  it("maps potential from impact × confidence", () => {
    const low = generateOpportunities({ ...SIG, orphanPages: ["x"] })[0];
    expect(low.potential).toBe("LOW"); // 2 × 4 = 8 (< 9)
    const lowish = generateOpportunities({ ...SIG, aiGaps: [{ prompt: "p", promptId: "1", testsRun: 1, productMentions: 0, competitorsMentioned: ["R"] }] })[0];
    expect(lowish.potential).toBe("LOW"); // 4 × 2 = 8 (< 9)
    const tiny = generateOpportunities({ ...SIG, competitorsWithoutComparison: [{ name: "R", sourcedFacts: 0 }] })[0];
    expect(tiny.potential).toBe("MEDIUM"); // 3 × 3 = 9
  });
});
