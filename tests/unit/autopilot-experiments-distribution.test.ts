import { describe, expect, it } from "vitest";
import { chooseMethod, evaluateExperiment, fisherExact, minSampleSizePerArm, normalCdf, normalQuantile, twoProportionZTest } from "@/core/experiments/stats";
import { assertExperimentTransition, canTransitionExperiment, startBlockers } from "@/core/experiments/workflow";
import {
  approvalBlockers,
  approvalValid,
  assertDistributionTransition,
  buildTrackingLink,
  canMoveDistribution,
  DISTRIBUTION_NEXT,
  listingTypeFor,
  resetsApproval,
  utmCampaignFor,
  utmMediumFor,
} from "@/core/distribution/catalog";
import { audienceTags, seedableVenues, venueRelevance, type ProductFit } from "@/core/distribution/relevance";
import { VENUES, venueByKey } from "@/core/distribution/venues";
import {
  addOutcome,
  baselineWindow,
  contentTypeFor,
  dedupeKeyFor,
  labelOutcome,
  LEARNING_BOUND,
  learningAdjustment,
  loopStage,
  measuredWindow,
  pageStructurePlan,
  planExecution,
  windowOf,
  type MeasurementSnapshot,
} from "@/core/autopilot/loop";
import { analyzeGrowth, relatedEvents } from "@/core/autopilot/analyst";
import { applyLearning, generateOpportunities, type OpportunityDraft } from "@/core/opportunities/engine";
import { crc32, zipStore } from "@/core/util/zip";
import { exportFiles, exportJsonLd, exportMarkdown } from "@/core/content/export";

// ─── Experiments: statistics ───────────────────────────────────────────────
describe("experiment statistics", () => {
  it("normal CDF and quantile match tabulated values", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(-1.645)).toBeCloseTo(0.05, 3);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5);
  });

  it("two-proportion z-test: 20% of 1000 vs 25% of 1000 → z 2.677, p 0.0074", () => {
    const r = twoProportionZTest({ controlN: 1000, controlConversions: 200, variantN: 1000, variantConversions: 250 });
    expect(r.z).toBeCloseTo(2.6774, 3);
    expect(r.pValue).toBeCloseTo(0.00742, 4);
    expect(twoProportionZTest({ controlN: 100, controlConversions: 0, variantN: 100, variantConversions: 0 })).toEqual({ z: 0, pValue: 1 });
  });

  it("Fisher's exact test: the tea-tasting table (p 0.4857) and a classic 2x2 (p 0.002759)", () => {
    expect(fisherExact({ controlN: 4, controlConversions: 3, variantN: 4, variantConversions: 1 }).pValue).toBeCloseTo(0.4857, 4);
    expect(fisherExact({ controlN: 10, controlConversions: 1, variantN: 14, variantConversions: 11 }).pValue).toBeCloseTo(0.002759, 5);
    expect(fisherExact({ controlN: 5, controlConversions: 2, variantN: 5, variantConversions: 2 }).pValue).toBeCloseTo(1, 6);
  });

  it("minimum sample size per arm (alpha 0.05 two-sided, power 0.8)", () => {
    expect(minSampleSizePerArm(0.1, 0.2)).toBe(3841);
    expect(minSampleSizePerArm(0.05, 0.2)).toBe(8158);
    expect(minSampleSizePerArm(0.1, 0.5)).toBeLessThan(minSampleSizePerArm(0.1, 0.2));
    expect(() => minSampleSizePerArm(0, 0.2)).toThrow();
    expect(() => minSampleSizePerArm(0.6, 1)).toThrow();
    expect(() => minSampleSizePerArm(0.1, 0)).toThrow();
  });

  it("uses Fisher's exact test when an expected count is below 5", () => {
    expect(chooseMethod({ controlN: 30, controlConversions: 2, variantN: 30, variantConversions: 6 })).toBe("FISHER_EXACT");
    expect(chooseMethod({ controlN: 1000, controlConversions: 200, variantN: 1000, variantConversions: 250 })).toBe("Z_TEST");
  });

  it("refuses a winner below the minimum sample, even with a tiny p-value", () => {
    const r = evaluateExperiment({ controlN: 1000, controlConversions: 100, variantN: 1000, variantConversions: 300, minSampleSize: 3841 });
    expect(r.pValue!).toBeLessThan(1e-6);
    expect(r).toMatchObject({ winner: "INCONCLUSIVE", reason: "BELOW_MIN_SAMPLE" });
    expect(r.progress).toBeCloseTo(1000 / 3841, 6);
    expect(r.explanation).toMatch(/Below the minimum sample size \(1000 of 3841 per arm\)/);
  });

  it("refuses a winner without a minimum sample size, without counts, or with p >= 0.05", () => {
    expect(evaluateExperiment({ controlN: 5000, controlConversions: 500, variantN: 5000, variantConversions: 700 }).reason).toBe("NO_MIN_SAMPLE");
    expect(evaluateExperiment({ minSampleSize: 100 })).toMatchObject({ winner: "INCONCLUSIVE", reason: "NO_COUNTS", progress: 0 });
    const ns = evaluateExperiment({ controlN: 4000, controlConversions: 400, variantN: 4000, variantConversions: 420, minSampleSize: 3841 });
    expect(ns.pValue!).toBeGreaterThanOrEqual(0.05);
    expect(ns).toMatchObject({ winner: "INCONCLUSIVE", reason: "NOT_SIGNIFICANT", method: "Z_TEST" });
  });

  it("declares the better arm only above the minimum sample with p < 0.05", () => {
    const v = evaluateExperiment({ controlN: 4000, controlConversions: 400, variantN: 4000, variantConversions: 500, minSampleSize: 3841 });
    expect(v).toMatchObject({ winner: "VARIANT", reason: "SIGNIFICANT", method: "Z_TEST" });
    expect(v.lift).toBeCloseTo(0.25, 6);
    expect(v.confidence).toBeCloseTo(1 - v.pValue!, 9);
    const c = evaluateExperiment({ controlN: 4000, controlConversions: 500, variantN: 4000, variantConversions: 400, minSampleSize: 3841 });
    expect(c.winner).toBe("CONTROL");
    expect(() => evaluateExperiment({ controlN: 10, controlConversions: 11, variantN: 10, variantConversions: 1, minSampleSize: 5 })).toThrow();
  });
});

describe("experiment lifecycle", () => {
  it("allows DRAFT → RUNNING → READY_FOR_REVIEW → CONCLUDED and ABANDONED from open states only", () => {
    expect(canTransitionExperiment("DRAFT", "RUNNING")).toBe(true);
    expect(canTransitionExperiment("RUNNING", "READY_FOR_REVIEW")).toBe(true);
    expect(canTransitionExperiment("READY_FOR_REVIEW", "CONCLUDED")).toBe(true);
    expect(canTransitionExperiment("READY_FOR_REVIEW", "RUNNING")).toBe(true);
    expect(canTransitionExperiment("DRAFT", "CONCLUDED")).toBe(false);
    expect(canTransitionExperiment("RUNNING", "CONCLUDED")).toBe(false);
    expect(canTransitionExperiment("CONCLUDED", "RUNNING")).toBe(false);
    expect(canTransitionExperiment("ABANDONED", "DRAFT")).toBe(false);
    expect(() => assertExperimentTransition("DRAFT", "READY_FOR_REVIEW")).toThrow(/cannot move/);
  });

  it("needs a counted event and a minimum sample size to start", () => {
    expect(startBlockers({ metricKey: null, minSampleSize: null })).toHaveLength(2);
    expect(startBlockers({ metricKey: "CTA_CLICK", minSampleSize: 400 })).toEqual([]);
  });
});

// ─── Distribution ──────────────────────────────────────────────────────────
describe("distribution state machine and approval", () => {
  it("enforces the transitions (no skipping to submission)", () => {
    expect(canMoveDistribution("DISCOVERED", "QUALIFIED")).toBe(true);
    expect(canMoveDistribution("DISCOVERED", "PREPARED")).toBe(false);
    expect(canMoveDistribution("QUALIFIED", "SUBMITTED")).toBe(false);
    expect(canMoveDistribution("PREPARED", "SUBMITTED")).toBe(true);
    expect(canMoveDistribution("PERFORMING", "DISCOVERED")).toBe(false);
    expect(() => assertDistributionTransition("DISCOVERED", "PUBLISHED")).toThrow();
    for (const [from, tos] of Object.entries(DISTRIBUTION_NEXT)) for (const to of tos) expect(to).not.toBe(from);
  });

  it("resets the approval when the target goes back or is rejected", () => {
    expect(resetsApproval("QUALIFIED")).toBe(true);
    expect(resetsApproval("REJECTED")).toBe(true);
    expect(resetsApproval("SUBMITTED")).toBe(false);
  });

  it("an approval is valid only for the approved version of a listing asset", () => {
    const t = { submissionApprovedAt: new Date(), approvedAssetId: "a1", approvedVersionId: "v1" };
    const asset = { id: "a1", type: "DIRECTORY_DESCRIPTION", status: "APPROVED", approvedVersionId: "v1" };
    expect(approvalValid(t, asset)).toBe(true);
    expect(approvalValid(t, { ...asset, status: "GENERATED" })).toBe(false);
    expect(approvalValid(t, { ...asset, approvedVersionId: "v2" })).toBe(false);
    expect(approvalValid(t, { ...asset, type: "ARTICLE" })).toBe(false);
    expect(approvalValid({ ...t, submissionApprovedAt: null }, asset)).toBe(false);
    expect(approvalValid(t, null)).toBe(false);
    expect(approvalValid(t, { ...asset, status: "PUBLISHED" })).toBe(true);
  });

  it("approval blockers: PREPARED only, with an approved listing draft", () => {
    expect(approvalBlockers({ status: "QUALIFIED" }, null)).toHaveLength(2);
    expect(approvalBlockers({ status: "PREPARED" }, null)).toEqual(["Prepare the listing draft first."]);
    expect(approvalBlockers({ status: "PREPARED" }, { type: "OUTREACH", status: "HUMAN_APPROVAL", approvedVersionId: null })[0]).toMatch(/approved in the Content studio/);
    expect(approvalBlockers({ status: "PREPARED" }, { type: "OUTREACH", status: "APPROVED", approvedVersionId: "v" })).toEqual([]);
  });

  it("builds UTM campaigns and tracking links", () => {
    expect(utmCampaignFor("Product Hunt", "clip-studio", "Ab_9-xY2z")).toBe("dist-product-hunt-clip-studio-ab9xy2z");
    expect(utmMediumFor("REVIEW_PLATFORM")).toBe("review");
    expect(listingTypeFor("NEWSLETTER")).toBe("OUTREACH");
    expect(listingTypeFor("SOFTWARE_DIRECTORY")).toBe("DIRECTORY_DESCRIPTION");
    const link = new URL(buildTrackingLink("https://acme.example/?ref=x", { source: "g2", medium: "review", campaign: "dist-g2-acme-1" }));
    expect(Object.fromEntries(link.searchParams)).toEqual({ ref: "x", utm_source: "g2", utm_medium: "review", utm_campaign: "dist-g2-acme-1" });
  });

  it("every catalogue venue has an https URL, a category, requirements and a domain", () => {
    expect(new Set(VENUES.map((v) => v.key)).size).toBe(VENUES.length);
    for (const v of VENUES) {
      expect(v.url).toMatch(/^https:\/\//);
      expect(v.requirements.length).toBeGreaterThan(20);
      expect(v.domains.length).toBeGreaterThan(0);
    }
    expect(new Set(VENUES.map((v) => v.category)).size).toBe(11);
  });
});

describe("venue relevance", () => {
  const b2bLive: ProductFit = { category: "B2B SaaS", status: "LIVE", texts: ["Moderation for agencies and teams."], facets: [{ kind: "AUDIENCE", name: "TikTok agencies" }] };
  const consumerBeta: ProductFit = { category: "Mobile app", status: "BETA", texts: ["A personal journal for students."], facets: [] };

  it("derives audience tags from category, texts and facets", () => {
    expect(audienceTags(b2bLive)).toEqual(expect.arrayContaining(["b2b"]));
    expect(audienceTags(consumerBeta)).toEqual(["b2c"]);
  });

  it("scores audience fit, stage and AI citations, with reasons, within 0 to 100", () => {
    const g2 = venueByKey("g2")!;
    const live = venueRelevance(g2, b2bLive);
    const beta = venueRelevance(g2, consumerBeta);
    expect(live.score).toBeGreaterThan(beta.score);
    expect(live.reasons.join(" ")).toMatch(/Audience match: b2b/);
    expect(beta.reasons.join(" ")).toMatch(/not live yet/);
    const cited = venueRelevance(g2, b2bLive, [{ domain: "g2.com", samples: 3 }]);
    expect(cited.score).toBeGreaterThan(live.score);
    expect(cited.reasons.at(-1)).toBe("Cited as a source in 3 sampled AI answer(s)");
    for (const v of VENUES) for (const p of [b2bLive, consumerBeta]) {
      const r = venueRelevance(v, p, [{ domain: v.domains[0], samples: 50 }]);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("a venue that needs an integration does not apply without it", () => {
    const zap = venueByKey("zapier")!;
    expect(venueRelevance(zap, b2bLive).applicable).toBe(false);
    expect(venueRelevance(zap, { ...b2bLive, facets: [{ kind: "INTEGRATION", name: "Zapier" }] }).applicable).toBe(true);
  });

  it("seeding keeps only fitting venues (not the whole catalogue)", () => {
    const seeds = seedableVenues(VENUES, b2bLive);
    expect(seeds.length).toBeGreaterThan(3);
    expect(seeds.length).toBeLessThan(VENUES.length);
    expect(seeds.every((s) => s.applicable && s.score >= 50)).toBe(true);
    expect(seeds.map((s) => s.venue.key)).not.toContain("zapier");
    expect(seedableVenues(VENUES, consumerBeta).map((s) => s.venue.key)).not.toContain("g2");
  });
});

// ─── Autopilot loop ────────────────────────────────────────────────────────
const snap = (over: Partial<MeasurementSnapshot> & { clicks?: number }): MeasurementSnapshot => ({
  kind: "SEARCH",
  state: "OK",
  window: windowOf("2026-01-01", "2026-01-28"),
  metrics: [
    { key: "clicks", value: over.clicks ?? 100 },
    { key: "impressions", value: 1000 },
  ],
  source: "search_daily (GOOGLE_SEARCH_CONSOLE)",
  scope: "product",
  takenAt: "2026-01-29T00:00:00Z",
  ...over,
});

describe("autopilot loop", () => {
  it("labels outcomes against the baseline, always as correlation", () => {
    expect(labelOutcome(snap({ clicks: 100 }), snap({ clicks: 130 }))).toMatchObject({ label: "IMPROVED", before: 100, after: 130, change: 0.3, reason: "MEASURED" });
    expect(labelOutcome(snap({ clicks: 100 }), snap({ clicks: 105 })).label).toBe("NO_CHANGE");
    expect(labelOutcome(snap({ clicks: 100 }), snap({ clicks: 70 })).label).toBe("DECLINED");
    expect(labelOutcome(snap({ clicks: 5 }), snap({ clicks: 9 }))).toMatchObject({ label: "INSUFFICIENT_DATA", reason: "LOW_VOLUME" });
    expect(labelOutcome(snap({ clicks: 0 }), snap({ clicks: 40 })).label).toBe("IMPROVED");
    expect(labelOutcome(snap({ state: "NOT_CONNECTED", metrics: [] }), snap({}))).toMatchObject({ label: "INSUFFICIENT_DATA", reason: "NOT_CONNECTED" });
    expect(labelOutcome(null, snap({})).label).toBe("INSUFFICIENT_DATA");
    expect(labelOutcome(snap({}), snap({})).note).toMatch(/^Correlation, not causation/);
  });

  it("compares per-day rates when the windows differ in length", () => {
    const after = snap({ clicks: 100, window: windowOf("2026-02-01", "2026-02-14") });
    expect(labelOutcome(snap({ clicks: 100 }), after)).toMatchObject({ label: "IMPROVED", change: 1 });
  });

  it("windows: 28 days before approval, then execution to measure_after - 1", () => {
    const at = new Date("2026-03-10T15:00:00Z");
    expect(baselineWindow(at)).toEqual({ start: "2026-02-10", end: "2026-03-09", days: 28 });
    expect(measuredWindow(at, "2026-04-07")).toEqual({ start: "2026-03-10", end: "2026-04-06", days: 28 });
  });

  it("learning adjusts confidence by at most one point, after three decisive outcomes", () => {
    expect(learningAdjustment(null)).toEqual({ delta: 0, rationale: null });
    expect(learningAdjustment({ improved: 2, noChange: 0, declined: 0 }).delta).toBe(0);
    expect(learningAdjustment({ improved: 50, noChange: 0, declined: 0 }).delta).toBe(LEARNING_BOUND);
    expect(learningAdjustment({ improved: 0, noChange: 1, declined: 9 }).delta).toBe(-LEARNING_BOUND);
    expect(learningAdjustment({ improved: 2, noChange: 2, declined: 1 }).delta).toBe(0);
    expect(learningAdjustment({ improved: 0, noChange: 0, declined: 0, insufficient: 9 }).rationale).toBeNull();
    expect(learningAdjustment({ improved: 3, noChange: 1, declined: 0 }).rationale).toMatch(/3 improved, 1 unchanged and 0 declined out of 4 measured outcomes.*\+1/);
    let t = { improved: 0, noChange: 0, declined: 0 };
    for (const l of ["IMPROVED", "IMPROVED", "DECLINED", "INSUFFICIENT_DATA", "NO_CHANGE"] as const) t = addOutcome(t, l) as typeof t;
    expect(t).toEqual({ improved: 2, noChange: 1, declined: 1, insufficient: 1 });
  });

  it("the opportunity engine applies learning within 1 to 5 and explains it", () => {
    const d = (type: string, confidence: number): OpportunityDraft =>
      ({ type, confidence, impact: 4, effort: 2, urgency: 3, potential: "MEDIUM", priorityScore: 0, scoringRationale: { confidence: "base" }, fingerprint: type }) as OpportunityDraft;
    const out = applyLearning([d("CONTENT_GAP", 5), d("LOW_CTR", 3), d("TECHNICAL", 1), d("REFERRAL", 3)], {
      CONTENT_GAP: { improved: 9, noChange: 0, declined: 0 },
      LOW_CTR: { improved: 4, noChange: 0, declined: 0 },
      TECHNICAL: { improved: 0, noChange: 0, declined: 5 },
    });
    expect(out.map((o) => o.confidence)).toEqual([5, 4, 1, 3]);
    expect(out[1].priorityScore).toBe(24);
    expect(out[1].potential).toBe("HIGH");
    expect(out[1].scoringRationale.learning).toMatch(/Autopilot learning/);
    expect(out[1].scoringRationale.confidence).toBe("base");
    expect(out[3].scoringRationale.learning).toBeUndefined();
    // Through the engine: signals carry the tally.
    const signals = {
      product: { id: "p", name: "P", slug: "p" },
      queries: [],
      aiGaps: [],
      seoIssues: [{ rule: "http.error", severity: "CRITICAL" as const, count: 2, exampleUrl: "https://p.example/x" }],
      missingEntity: [],
      competitorsWithoutComparison: [],
      orphanPages: [],
      lowConversionPages: [],
    };
    const base = generateOpportunities(signals).find((o) => o.type === "TECHNICAL")!;
    const learned = generateOpportunities({ ...signals, learning: { TECHNICAL: { improved: 0, noChange: 0, declined: 4 } } }).find((o) => o.type === "TECHNICAL")!;
    expect(learned.confidence).toBe(Math.max(1, base.confidence - 1));
    expect(learned.scoringRationale.learning).toMatch(/-1/);
  });

  it("dedupe keys: one per opportunity, else per product, kind and title", () => {
    expect(dedupeKeyFor({ opportunityId: "o1", kind: "X", title: "T" })).toBe("opp:o1");
    expect(dedupeKeyFor({ productId: "p1", kind: "TECHNICAL", title: "Fix  critical issue" })).toBe("finding:p1:TECHNICAL:fix critical issue");
    expect(dedupeKeyFor({ kind: "TECHNICAL", title: "x" })).toBe("finding:org:TECHNICAL:x");
  });

  it("plans a safe execution per kind (never publication)", () => {
    expect(contentTypeFor("CONTENT_GAP", 'Create a guide for the "x" topic')).toBe("ARTICLE");
    expect(contentTypeFor("CONTENT_GAP", 'Create an alternatives page for the "x" topic')).toBe("COMPARISON");
    expect(contentTypeFor("CONTENT_GAP", 'Cover "x"')).toBe("LANDING_PAGE");
    expect(contentTypeFor("AI_VISIBILITY_GAP", "x")).toBe("FAQ");
    expect(planExecution({ kind: "CONVERSION", title: "Improve CTA on /pricing" })).toMatchObject({ action: "CREATE_EXPERIMENT", measure: "CONVERSIONS", experiment: { metricKey: "CTA_CLICK" } });
    expect(planExecution({ kind: "TECHNICAL", title: "Fix critical issue: http.error" }).action).toBe("QUEUE_AUDIT");
    expect(planExecution({ kind: "DISTRIBUTION", title: "x" }).action).toBe("PREPARE_DISTRIBUTION");
    expect(planExecution({ kind: "REFERRAL", title: "x" }).action).toBe("MANUAL");
    expect(planExecution({ kind: "LOW_CTR", title: "x" })).toMatchObject({ action: "MANUAL", measure: "SEARCH" });
    for (const k of ["CONTENT_GAP", "CONVERSION", "TECHNICAL", "DISTRIBUTION", "REFERRAL"]) expect(JSON.stringify(planExecution({ kind: k, title: "x" })).toLowerCase()).not.toMatch(/auto-?publish|submit automatically/);
  });

  it("prepares a page structure for a query cluster gap", () => {
    const page = pageStructurePlan({
      productName: "Acme",
      topic: "live chat moderation",
      contentType: "LANDING_PAGE",
      queries: ["how to moderate live chat", "live chat moderation tool", "can bots moderate tiktok live"],
      crawledPages: [
        { url: "https://acme.example/blog/a", title: "Tips", text: "Our guide to live chat moderation for streamers." },
        { url: "https://acme.example/pricing", title: "Pricing", text: "Plans and prices." },
      ],
      cta: { label: "Start free trial", url: "https://acme.example/signup" },
    });
    expect(page.title).toBe("Live chat moderation | Acme");
    expect(page.faq).toEqual(["How to moderate live chat?", "Can bots moderate tiktok live?"]);
    expect(page.schemaTypes).toEqual(["SoftwareApplication", "FAQPage"]);
    expect(page.internalLinks).toEqual([{ from: "https://acme.example/blog/a", anchor: "live chat moderation" }]);
    expect(page.cta?.label).toBe("Start free trial");
    expect(page.supportingDrafts.every((d) => d.when === "AFTER_MAIN_ASSET_APPROVAL")).toBe(true);
  });

  it("derives the loop stage", () => {
    expect(loopStage({ status: "PROPOSED", executedAt: null, outcomeLabel: null })).toBe("PROPOSED");
    expect(loopStage({ status: "APPROVED", executedAt: null, outcomeLabel: null })).toBe("APPROVED");
    expect(loopStage({ status: "APPROVED", executedAt: new Date(), outcomeLabel: null }, true)).toBe("EXECUTING");
    expect(loopStage({ status: "APPROVED", executedAt: new Date(), outcomeLabel: null })).toBe("MEASURING");
    expect(loopStage({ status: "DONE", executedAt: new Date(), outcomeLabel: "IMPROVED" })).toBe("MEASURED");
    expect(loopStage({ status: "REJECTED", executedAt: null, outcomeLabel: null })).toBe("REJECTED");
  });
});

describe("analyst correlation scoping", () => {
  const ev = [
    { kind: "CONTENT_PUBLISHED" as const, label: "Published: A guide", at: "2026-02-03T10:00:00Z", productId: "A" },
    { kind: "CONTENT_PUBLISHED" as const, label: "Published: B guide", at: "2026-02-04T10:00:00Z", productId: "B" },
    { kind: "INTEGRATION_ERROR" as const, label: "STRIPE sync error", at: "2026-02-05T10:00:00Z", productId: null, metricKeys: ["new_subs"] },
  ];

  it("relates an event only to its product and to plausible metrics", () => {
    expect(relatedEvents({ key: "clicks", productId: "A" }, ev).map((e) => e.label)).toEqual(["Published: A guide"]);
    expect(relatedEvents({ key: "new_subs", productId: null }, ev).map((e) => e.label)).toEqual(["STRIPE sync error"]);
    expect(relatedEvents({ key: "beacon_mrr", productId: "A" }, ev)).toEqual([]);
  });

  it("explains per-product metrics with that product's events only", () => {
    const r = analyzeGrowth({
      metrics: [],
      scopedMetrics: [
        { key: "clicks", label: "Organic clicks", now: 150, prev: 100, source: "gsc", productId: "A", productName: "Alpha" },
        { key: "clicks", label: "Organic clicks", now: 60, prev: 100, source: "gsc", productId: "C", productName: "Gamma" },
      ],
      events: ev,
      opportunities: [{ id: "o1", productId: "A", title: "Cover x", potential: "HIGH", priorityScore: 20, type: "CONTENT_GAP" }],
      openCriticalIssues: [],
      connected: [],
      missing: [],
    });
    expect(r.whyItMayHaveHappened).toEqual([
      { observation: "Organic clicks rose 50% (100 → 150).", relatedEvents: ["Published: A guide (2026-02-03)"], evidence: "CORRELATION", product: "Alpha" },
      { observation: "Organic clicks fell 40% (100 → 60).", relatedEvents: [], evidence: "INSUFFICIENT_DATA", product: "Gamma" },
    ]);
    expect(r.recommendedActions[0]).toMatchObject({ opportunityId: "o1", productId: "A" });
  });
});

describe("content export", () => {
  const input = {
    asset: { id: "a", title: "Live chat moderation", type: "LANDING_PAGE", status: "APPROVED", approvedAt: new Date("2026-03-01T00:00:00Z") },
    version: {
      version: 3,
      body: "# Live chat moderation\n\nBody.",
      metaTitle: "Live chat moderation | Acme",
      metaDescription: "What Acme does.",
      structuredData: [
        { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Acme" },
        { "@context": "https://schema.org", "@type": "FAQPage" },
      ],
      factRefs: [{ ref: "feature:x", sourceUrl: "https://acme.example/docs" }],
    },
    product: { name: "Acme", slug: "acme" },
    exportedAt: new Date("2026-03-02T00:00:00Z"),
  };

  it("writes Markdown with front matter, JSON-LD and meta", () => {
    const md = exportMarkdown(input);
    expect(md.startsWith('---\ntitle: "Live chat moderation | Acme"\ndescription: "What Acme does."\ntype: LANDING_PAGE')).toBe(true);
    expect(md).toContain('sources:\n  - "https://acme.example/docs"');
    expect(md).toContain("# Live chat moderation");
    const ld = JSON.parse(exportJsonLd(input));
    expect(ld["@graph"].map((x: { "@type": string }) => x["@type"])).toEqual(["SoftwareApplication", "FAQPage"]);
    expect(exportFiles(input).map((f) => f.name)).toEqual(["acme-live-chat-moderation-v3/content.md", "acme-live-chat-moderation-v3/structured-data.jsonld", "acme-live-chat-moderation-v3/meta.json"]);
  });

  it("zips the files (stored, CRC-32)", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const z = zipStore(exportFiles(input));
    expect([z[0], z[1], z[2], z[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const view = new DataView(z.buffer);
    expect(view.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(z.length - 22 + 10, true)).toBe(3);
  });
});
