import { describe, expect, it } from "vitest";
import type { Estimate, ImpactEstimate } from "@/core/estimate/types";
import { opportunityFinding, opportunitySeverity, type OppRow, type ProductRow } from "@/brain/common";
import { allowedNumbers, extractNumbers, inventedNumbers } from "@/brain/guard";
import { applySpecialistOutput, specialistInput, synthesisInput, validateSynthesis } from "@/brain/llm";
import { specialistSystem, SYNTHESIS_SYSTEM } from "@/brain/prompts";
import { coverageMap, mergeFindings, newCriticalFindings, rankFindings } from "@/brain/rank";
import { analyzeAiVisibility, type AiVisibilitySignals } from "@/brain/specialists/ai-visibility";
import { analyzeCompetitors, type CompetitorsSignals } from "@/brain/specialists/competitors";
import { analyzeContentKnowledge, type ContentKnowledgeSignals } from "@/brain/specialists/content-knowledge";
import { analyzeConversionRevenue, type ConversionRevenueSignals } from "@/brain/specialists/conversion-revenue";
import { analyzeDistributionGrowth, type DistributionGrowthSignals } from "@/brain/specialists/distribution-growth";
import { analyzeTechnicalSeo, type TechnicalSeoSignals } from "@/brain/specialists/technical-seo";
import { SPECIALISTS, type Finding, type SpecialistReport } from "@/brain/types";
import { FR } from "@/i18n/fr";
import { placeholders } from "@/i18n/core";

const P = (n: number, extra: Partial<ProductRow> = {}): ProductRow => ({ id: `00000000-0000-4000-8000-00000000000${n}`, slug: `p${n}`, name: `Product ${n}`, domain: `p${n}.example`, ...extra });

const opp = (o: Partial<OppRow> = {}): OppRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  productId: P(1).id,
  queryId: null,
  type: "TECHNICAL",
  category: "TECHNICAL",
  title: "Fix critical technical issue: missing_title",
  problem: "3 page(s) affected, e.g. https://p1.example/a.",
  evidence: [
    { label: "Rule", value: "missing_title" },
    { label: "Affected pages", value: "3" },
  ],
  potential: "HIGH",
  impact: 5,
  urgency: 5,
  effort: 2,
  priorityScore: 9,
  sources: {},
  nextAction: null,
  ...o,
});

const est = (p50: number, extra: Partial<Extract<Estimate, { state: "ESTIMATED" }>> = {}): Estimate => ({ key: "expected_impact", label: "Expected extra signups", unit: "signups", state: "ESTIMATED", p10: p50 / 2, p50, p90: p50 * 2, horizonDays: 90, confidence: "MEDIUM", method: "clicks x rate", inputs: [], ...extra });
const notEst: Estimate = { key: "expected_impact", label: "Expected extra signups", unit: "signups", state: "NOT_ESTIMABLE", reason: "No search data", missing: ["Search Console"], inputs: [] };
const impact = (signups: Estimate, revenue: Estimate[] = []): ImpactEstimate => ({ signups, revenue, parts: [], reached: signups.state === "ESTIMATED" ? "signups" : "none", missing: signups.state === "ESTIMATED" ? [] : ["Search Console"] });

const finding = (id: string, f: Partial<Finding> = {}): Finding => ({
  id,
  key: id,
  specialist: "technical_seo",
  title: `Finding ${id}`,
  summary: "Summary",
  severity: "MEDIUM",
  effort: 3,
  evidence: [{ label: "Pages", value: "12" }],
  action: { label: "Open", href: "/", kind: "OPEN" },
  ...f,
});

const report = (specialist: Finding["specialist"], findings: Finding[], coverage: SpecialistReport["coverage"] = "MEASURED"): SpecialistReport => ({ specialist, coverage, missing: [], findings: findings.map((f) => ({ ...f, specialist })) });

// ─── Specialists ─────────────────────────────────────────────────────────

const NOW = "2026-10-01T00:00:00.000Z";
const audit = (finishedAt: string, pagesCrawled = 20) => ({ id: "22222222-2222-4222-8222-222222222222", finishedAt, pagesCrawled });

describe("technical SEO specialist", () => {
  const base: TechnicalSeoSignals = { now: NOW, products: [], searchConnected: true, searchData: true, opportunities: [] };

  it("is not connected without products, and asks for a domain or a first audit", () => {
    expect(analyzeTechnicalSeo(base)).toMatchObject({ coverage: "NOT_CONNECTED", missing: ["A product"], findings: [] });
    const r = analyzeTechnicalSeo({
      ...base,
      products: [
        { product: P(1, { domain: null }), audit: null, latestStatus: null, openBySeverity: {}, nonIndexable: 0, crawled: 0, sitemaps: 0, sitemapErrors: 0 },
        { product: P(2), audit: null, latestStatus: "FAILED", openBySeverity: {}, nonIndexable: 0, crawled: 0, sitemaps: 0, sitemapErrors: 0 },
      ],
    });
    expect(r.coverage).toBe("PARTIAL");
    expect(r.findings.map((f) => [f.key, f.severity])).toEqual([
      [`seo:no_domain:${P(1).id}`, "MEDIUM"],
      [`seo:no_audit:${P(2).id}`, "HIGH"],
    ]);
    expect(r.findings[1].evidence).toContainEqual({ label: "Latest audit", value: "FAILED" });
    expect(r.missing).toEqual(["A completed site audit of Product 1", "A completed site audit of Product 2"]);
  });

  it("rolls up open issues only when no technical opportunity covers them, and flags stale audits, indexability and sitemaps", () => {
    const pa = { product: P(1), audit: audit("2026-08-01T00:00:00.000Z"), latestStatus: "SUCCEEDED", openBySeverity: { CRITICAL: 2, HIGH: 1 }, nonIndexable: 5, crawled: 20, sitemaps: 2, sitemapErrors: 1 };
    const r = analyzeTechnicalSeo({ ...base, products: [pa] });
    const byKey = Object.fromEntries(r.findings.map((f) => [f.key.split(":")[1], f]));
    expect(byKey.stale_audit).toMatchObject({ severity: "MEDIUM", vars: { product: "Product 1", days: 61 } });
    expect(byKey.open_issues).toMatchObject({ severity: "CRITICAL", vars: { n: 2 }, target: { productId: P(1).id, opportunityType: "TECHNICAL" } });
    expect(byKey.non_indexable.evidence).toContainEqual({ label: "Share of crawled pages", value: "25%" });
    expect(byKey.non_indexable.severity).toBe("MEDIUM");
    expect(byKey.sitemap_errors.severity).toBe("MEDIUM");
    expect(r.coverage).toBe("PARTIAL"); // stale audit

    const withOpp = analyzeTechnicalSeo({ ...base, products: [{ ...pa, audit: audit("2026-09-20T00:00:00.000Z"), sitemapErrors: 0, sitemaps: 0 }], opportunities: [opp()] });
    expect(withOpp.findings.some((f) => f.key.startsWith("seo:open_issues"))).toBe(false);
    expect(withOpp.findings.find((f) => f.opportunityId)).toMatchObject({ severity: "CRITICAL", key: `opp:${opp().id}`, action: { href: `/opportunities/${opp().id}`, kind: "PROPOSE_RECOMMENDATION" } });
    expect(withOpp.findings.find((f) => f.key.startsWith("seo:no_sitemap"))?.severity).toBe("LOW");
    expect(withOpp.coverage).toBe("MEASURED");
  });

  it("asks for a search provider", () => {
    const r = analyzeTechnicalSeo({ ...base, searchConnected: false, searchData: false, products: [{ product: P(1), audit: audit("2026-09-28T00:00:00.000Z"), latestStatus: "SUCCEEDED", openBySeverity: {}, nonIndexable: 0, crawled: 3, sitemaps: 1, sitemapErrors: 0 }] });
    expect(r).toMatchObject({ coverage: "PARTIAL", missing: ["Search Console or Bing Webmaster"], findings: [] });
  });
});

describe("content and knowledge specialist", () => {
  const base: ContentKnowledgeSignals = { products: [], searchConnected: false, searchData: false, content: { awaitingApproval: 0, inChecks: 0, published: 0, total: 0 }, opportunities: [] };
  it("flags incomplete and unverified knowledge and the drafts waiting for people", () => {
    const r = analyzeContentKnowledge({
      ...base,
      products: [{ product: P(1), completeness: 0.42, missingItems: ["Pricing", "Proof"], facts: 10, verifiedFacts: 0 }],
      content: { awaitingApproval: 3, inChecks: 1, published: 2, total: 6 },
    });
    expect(r.coverage).toBe("PARTIAL");
    expect(r.missing).toEqual(["Search Console or Bing Webmaster"]);
    expect(r.findings.map((f) => [f.key.split(":").slice(0, 2).join(":"), f.severity])).toEqual([
      ["knowledge:completeness", "HIGH"],
      ["knowledge:unverified", "HIGH"],
      ["content:awaiting_approval", "MEDIUM"],
      ["content:in_checks", "LOW"],
    ]);
    expect(r.findings[0].evidence[0]).toEqual({ label: "Knowledge completeness", value: "42%", href: "/products/p1/knowledge" });
  });
  it("leaves completeness to an open knowledge opportunity", () => {
    const r = analyzeContentKnowledge({ ...base, searchConnected: true, searchData: true, products: [{ product: P(1), completeness: 0.6, missingItems: [], facts: 4, verifiedFacts: 4 }], opportunities: [opp({ type: "PRODUCT_KNOWLEDGE", category: "PRODUCT_KNOWLEDGE", impact: 4, urgency: 3, potential: "MEDIUM" })] });
    expect(r.coverage).toBe("MEASURED");
    expect(r.findings.map((f) => f.key)).toEqual([`opp:${opp().id}`]);
    expect(r.findings[0].severity).toBe("MEDIUM");
  });
});

describe("AI visibility specialist", () => {
  const base: AiVisibilitySignals = { providers: 1, activePrompts: 4, tests: 20, orgMentioned: 5, ownDomainCited: 0, products: [], opportunities: [] };
  it("is not connected without a provider", () => {
    expect(analyzeAiVisibility({ ...base, providers: 0, tests: 0 })).toMatchObject({ coverage: "NOT_CONNECTED", missing: ["An AI provider key (Settings, Integrations)"] });
  });
  it("asks for prompts, then for tests", () => {
    expect(analyzeAiVisibility({ ...base, activePrompts: 0, tests: 0 }).findings.map((f) => f.key)).toEqual(["ai:no_prompts"]);
    const r = analyzeAiVisibility({ ...base, tests: 0 });
    expect(r.findings.map((f) => f.key)).toEqual(["ai:no_recent_tests"]);
    expect(r.coverage).toBe("PARTIAL");
  });
  it("judges mention rates only with enough samples", () => {
    const r = analyzeAiVisibility({
      ...base,
      products: [
        { product: P(1), tests: 12, mentioned: 0 },
        { product: P(2), tests: 10, mentioned: 3 },
        { product: P(3), tests: 9, mentioned: 0 },
        { product: P(4), tests: 10, mentioned: 6 },
      ],
    });
    expect(r.coverage).toBe("MEASURED");
    const low = r.findings.filter((f) => f.key.startsWith("ai:low_mentions"));
    expect(low.map((f) => [f.productId, f.severity, f.vars?.rate])).toEqual([
      [P(1).id, "HIGH", "0%"],
      [P(2).id, "MEDIUM", "30%"],
    ]);
    expect(low[0].title).toBe("{product} is absent from its sampled AI answers");
    expect(r.findings.some((f) => f.key === "ai:own_domain_not_cited")).toBe(true);
  });
});

describe("competitors specialist", () => {
  const base: CompetitorsSignals = { competitors: [], samplesTotal: 0, orgMentioned: 0, activeWatches: 0, changes: [], opportunities: [] };
  it("needs competitors", () => {
    expect(analyzeCompetitors(base)).toMatchObject({ coverage: "NOT_CONNECTED", missing: ["Competitors in the knowledge graph"] });
  });
  it("flags competitors ahead in sampled answers, watched-page changes and unwatched competitors", () => {
    const r = analyzeCompetitors({
      ...base,
      competitors: [
        { id: "c1", name: "Rival", samplesMentioning: 9 },
        { id: "c2", name: "Other", samplesMentioning: 2 },
      ],
      samplesTotal: 12,
      orgMentioned: 4,
      changes: [{ id: "s1", watchId: "w1", competitorName: "Rival", url: "https://rival.example/pricing", fetchedAt: NOW, linesAdded: 2, linesRemoved: 1 }],
    });
    expect(r.findings.map((f) => [f.key, f.severity])).toEqual([
      ["competitor:ahead:c1", "HIGH"],
      ["competitor:change:s1", "MEDIUM"],
      ["competitor:no_watch", "LOW"],
    ]);
    expect(r.coverage).toBe("PARTIAL");
    expect(r.missing).toEqual(["Watched competitor pages"]);
  });
});

describe("conversion and revenue specialist", () => {
  const base: ConversionRevenueSignals = { products: [], trackerKey: true, events: true, revenueConnected: true, revenue: true, visitors: { now: 100, prev: 90 }, signups: { now: 10, prev: 12 }, readyExperiments: [], opportunities: [] };
  it("measures coverage from events and revenue", () => {
    expect(analyzeConversionRevenue({ ...base, products: [{ product: P(1), events: 5 }] }).coverage).toBe("MEASURED");
    expect(analyzeConversionRevenue({ ...base, products: [{ product: P(1), events: 0 }], events: false, revenue: false, revenueConnected: false, trackerKey: false })).toMatchObject({
      coverage: "NOT_CONNECTED",
      missing: ["Beacon tracker events", "A revenue source (Stripe or the revenue API)"],
    });
  });
  it("flags a signup drop from 30% with enough volume, visitors without signups, products without tracking and ready experiments", () => {
    const keys = (s: Partial<ConversionRevenueSignals>) => analyzeConversionRevenue({ ...base, products: [{ product: P(1), events: 3 }], ...s }).findings.map((f) => f.key);
    expect(keys({ signups: { now: 14, prev: 20 } })).toEqual(["conv:signup_drop"]);
    expect(keys({ signups: { now: 15, prev: 20 } })).toEqual([]);
    expect(keys({ signups: { now: 5, prev: 19 } })).toEqual([]);
    expect(keys({ visitors: { now: 50, prev: 0 }, signups: { now: 0, prev: 0 } })).toEqual(["conv:no_signups"]);
    expect(keys({ visitors: { now: 49, prev: 0 }, signups: { now: 0, prev: 0 } })).toEqual([]);
    const r = analyzeConversionRevenue({ ...base, products: [{ product: P(2), events: 0 }], readyExperiments: [{ id: "e1", name: "CTA test" }] });
    expect(r.findings.map((f) => f.key)).toEqual([`conv:no_tracker:${P(2).id}`, "conv:experiment_ready:e1"]);
  });
});

describe("distribution and growth specialist", () => {
  const base: DistributionGrowthSignals = { today: "2026-10-01", products: 2, events: true, targets: 3, awaitingApproval: 2, followUpsDue: 1, activeReferralCodes: 0, activeCrossSellRules: 0, opportunities: [] };
  it("flags work waiting for people and missing growth loops", () => {
    const r = analyzeDistributionGrowth(base);
    expect(r.coverage).toBe("MEASURED");
    expect(r.findings.map((f) => f.key)).toEqual(["dist:awaiting_approval", "dist:follow_ups", "growth:no_cross_sell", "growth:no_referral"]);
  });
  it("defers to open cross-sell and referral opportunities and needs tracked events", () => {
    const r = analyzeDistributionGrowth({ ...base, events: false, awaitingApproval: 0, followUpsDue: 0, opportunities: [opp({ id: "o1", type: "CROSS_SELL", impact: 3 }), opp({ id: "o2", type: "REFERRAL", impact: 3 })] });
    expect(r.coverage).toBe("NOT_CONNECTED");
    expect(r.findings.map((f) => f.key)).toEqual(["opp:o1", "opp:o2"]);
  });
});

describe("opportunity findings", () => {
  it("maps severity, target and the propose action", () => {
    expect(opportunitySeverity({ impact: 5, urgency: 5, potential: "HIGH" })).toBe("CRITICAL");
    expect(opportunitySeverity({ impact: 5, urgency: 4, potential: "HIGH" })).toBe("HIGH");
    const f = opportunityFinding("content_knowledge", opp({ type: "CONTENT_GAP", queryId: "q1", sources: { queryIds: ["q2", "q1"] }, effort: 9 }));
    expect(f.target).toEqual({ productId: P(1).id, queryIds: ["q2", "q1"], opportunityType: "CONTENT_GAP" });
    expect(f.effort).toBe(5);
    expect(f.evidence).toEqual(opp().evidence);
  });
});

// ─── Merge and rank ──────────────────────────────────────────────────────

describe("merge and rank", () => {
  it("deduplicates by opportunity and by search target across specialists", () => {
    const a = finding("a", { opportunityId: "o1", severity: "MEDIUM", evidence: [{ label: "x", value: "1" }] });
    const b = finding("b", { opportunityId: "o1", severity: "HIGH", evidence: [{ label: "y", value: "2" }] });
    const c = finding("c", { target: { productId: "p", queryIds: ["q2", "q1"], opportunityType: "CONTENT_GAP" } });
    const d = finding("d", { target: { productId: "p", queryIds: ["q1", "q2"], opportunityType: "CONTENT_GAP" } });
    const merged = mergeFindings([report("ai_visibility", [b, d]), report("technical_seo", [a, c])]);
    expect(merged.map((f) => f.id)).toEqual(["a", "c"]);
    expect(merged[0]).toMatchObject({ severity: "HIGH", alsoFrom: ["ai_visibility"], evidence: [{ label: "x", value: "1" }, { label: "y", value: "2" }] });
    expect(merged[1].alsoFrom).toEqual(["ai_visibility"]);
  });

  it("ranks estimable findings by p50 signups, then revenue in one currency, then severity and effort; unknowns stay apart", () => {
    const eur = (p50: number): Estimate => est(p50, { key: "expected_revenue", label: "Expected extra revenue", unit: "money_minor", currency: "EUR" });
    const fs = [
      finding("low", { estimate: impact(est(2)) }),
      finding("high", { estimate: impact(est(9)) }),
      finding("tie-rev", { estimate: impact(est(5), [eur(1000)]) }),
      finding("tie-rev-more", { estimate: impact(est(5), [eur(5000)]) }),
      finding("tie-sev", { estimate: impact(est(2)), severity: "CRITICAL" }),
      finding("unknown-crit", { estimate: impact(notEst), severity: "CRITICAL" }),
      finding("no-target", { severity: "LOW" }),
      finding("unknown-med", { estimate: impact(notEst) }),
    ];
    const { ranked, unestimated } = rankFindings([report("technical_seo", fs)]);
    expect(ranked.map((f) => f.id)).toEqual(["high", "tie-rev-more", "tie-rev", "tie-sev", "low"]);
    expect(unestimated.map((f) => f.id)).toEqual(["unknown-crit", "unknown-med", "no-target"]);
  });

  it("orders unknowns of equal severity by the specialist's order", () => {
    const { unestimated } = rankFindings([report("technical_seo", [finding("z"), finding("a")])]);
    expect(unestimated.map((f) => f.id)).toEqual(["z", "a"]);
  });

  it("builds the coverage map and finds new critical findings", () => {
    const map = coverageMap([report("competitors", [finding("x")], "PARTIAL")]);
    expect(Object.keys(map)).toEqual([...SPECIALISTS]);
    expect(map.competitors).toEqual({ coverage: "PARTIAL", missing: [], findings: 1 });
    expect(map.technical_seo.coverage).toBe("NOT_CONNECTED");
    const crit = [finding("k1", { severity: "CRITICAL" }), finding("k2", { severity: "CRITICAL", opportunityId: "o9" }), finding("k3")];
    expect(newCriticalFindings(crit, new Set(["k1"])).map((f) => f.id)).toEqual(["k2"]);
    expect(newCriticalFindings(crit, new Set(["opp:o9"])).map((f) => f.id)).toEqual(["k1"]);
  });
});

// ─── Number guard ────────────────────────────────────────────────────────

describe("number guard", () => {
  it("normalises thousands separators and decimal commas", () => {
    expect(extractNumbers("1,234 clicks and 1 234 visits, 12,5 % and 3.75")).toEqual([1234, 1234, 12.5, 3.75]);
    expect(extractNumbers("On 2026-09-30, 45% of 12 answers")).toEqual([2026, 9, 30, 45, 12]);
  });
  it("accepts values from the data, their roundings and ratios as percentages", () => {
    const allowed = allowedNumbers([{ evidence: [{ label: "Mention rate", value: "45%" }], estimate: { p10: 3.6, p50: 12.34, p90: 40 }, rate: 0.3 }, 7]);
    expect(inventedNumbers("About 12 signups (12.3 median), between 3.6 and 40, rate 30% and 45 percent; 7 findings.", allowed)).toEqual([]);
    expect(inventedNumbers("This could bring 4,200 visits and 15 signups.", allowed)).toEqual([4200, 15]);
  });
});

// ─── LLM output validation ───────────────────────────────────────────────

describe("specialist LLM output", () => {
  const base = report("ai_visibility", [
    finding("ai_visibility:a", { title: "{product} appears in only {rate} of its sampled AI answers", vars: { product: "Acme", rate: "30%" }, evidence: [{ label: "Sampled answers (30 days)", value: "10" }] }),
    finding("ai_visibility:b", { opportunityId: "o1", severity: "HIGH", evidence: [{ label: "Prompt", value: "best tool" }] }),
    finding("ai_visibility:c", { opportunityId: "o1", severity: "LOW", evidence: [{ label: "Extra", value: "3" }] }),
    finding("ai_visibility:d", { opportunityId: "o2" }),
  ]);
  const ok = {
    narrative_en: "Acme is named in 30% of the 10 sampled answers. Fix the prompt gaps first — they are the most severe.",
    narrative_fr: "Acme apparaît dans 30 % des 10 réponses échantillonnées.",
    order: ["ai_visibility:b", "unknown", "ai_visibility:a"],
    merges: [
      { keep: "ai_visibility:b", drop: ["ai_visibility:c"] },
      { keep: "ai_visibility:b", drop: ["ai_visibility:d"] },
    ],
  };

  it("applies a valid output: narrative, order, merges (never across opportunities); long dashes removed", () => {
    const r = applySpecialistOutput(base, ok, { model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.findings.map((f) => f.id)).toEqual(["ai_visibility:b", "ai_visibility:a", "ai_visibility:d"]);
    expect(r.value.findings[0].evidence).toEqual([
      { label: "Prompt", value: "best tool" },
      { label: "Extra", value: "3" },
    ]);
    expect(r.value.narrative?.en).toBe("Acme is named in 30% of the 10 sampled answers. Fix the prompt gaps first, they are the most severe.");
    expect(r.value.llm).toEqual({ model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5 });
  });

  it("rejects an invented number (in either language), a schema mismatch and an empty text", () => {
    expect(applySpecialistOutput(base, { ...ok, narrative_en: "This should bring 4200 visits." })).toEqual({ ok: false, reason: "numbers not in the evidence: 4200" });
    expect(applySpecialistOutput(base, { ...ok, narrative_fr: "Environ 55 % des réponses." })).toMatchObject({ ok: false });
    expect(applySpecialistOutput(base, { narrative: "x" })).toEqual({ ok: false, reason: "output does not match the schema" });
    expect(applySpecialistOutput(base, { ...ok, narrative_en: "  " })).toEqual({ ok: false, reason: "empty text" });
  });

  it("does not let ids count as quotable numbers", () => {
    const r = report("technical_seo", [finding("technical_seo:opp:12345678-0000-4000-8000-000000004200", { title: "A finding" })]);
    expect(applySpecialistOutput(r, { narrative_en: "Expect 4200 clicks.", narrative_fr: "Texte.", order: [], merges: [] })).toMatchObject({ ok: false });
    expect(specialistInput(r).findings[0].id).toContain("4200");
  });

  it("validates the synthesis against the merged plan", () => {
    const merged = rankFindings([base]);
    const input = synthesisInput({ coverage: coverageMap([base]), ...merged, estimationPower: { measured: [], missing: ["Search Console"], bestNextConnection: { connect: "Search Console", unlocks: 14 } } });
    expect(validateSynthesis({ summary_en: "1 area is measured and 5 are not connected. Connect Search Console to estimate 14 actions.", summary_fr: "Connectez Search Console pour estimer 14 actions." }, input)).toMatchObject({ ok: true });
    expect(validateSynthesis({ summary_en: "Revenue could grow by 25,000 EUR.", summary_fr: "x" }, input)).toMatchObject({ ok: false });
    expect(validateSynthesis({ summary: "x" }, input)).toMatchObject({ ok: false });
  });

  it("frames prompts around the number and data rules", () => {
    for (const k of SPECIALISTS) expect(specialistSystem(k)).toContain('trust="untrusted"');
    expect(SYNTHESIS_SYSTEM).toContain("Every number you write must appear");
    expect(/[–—]/.test(SYNTHESIS_SYSTEM + SPECIALISTS.map(specialistSystem).join(""))).toBe(false);
  });
});

// ─── French coverage of runtime templates ────────────────────────────────

describe("French dictionary for Brain findings", () => {
  it("translates every template the specialists produce", () => {
    const reports = [
      analyzeTechnicalSeo({
        now: NOW,
        searchConnected: false,
        searchData: false,
        opportunities: [],
        products: [
          { product: P(1, { domain: null }), audit: null, latestStatus: null, openBySeverity: {}, nonIndexable: 0, crawled: 0, sitemaps: 0, sitemapErrors: 0 },
          { product: P(2), audit: null, latestStatus: null, openBySeverity: {}, nonIndexable: 0, crawled: 0, sitemaps: 0, sitemapErrors: 0 },
          { product: P(3), audit: audit("2026-08-01T00:00:00.000Z"), latestStatus: "SUCCEEDED", openBySeverity: { CRITICAL: 1 }, nonIndexable: 1, crawled: 2, sitemaps: 1, sitemapErrors: 1 },
          { product: P(4), audit: audit("2026-08-01T00:00:00.000Z"), latestStatus: "SUCCEEDED", openBySeverity: { HIGH: 1 }, nonIndexable: 0, crawled: 2, sitemaps: 0, sitemapErrors: 0 },
        ],
      }),
      analyzeTechnicalSeo({ now: NOW, searchConnected: true, searchData: false, opportunities: [], products: [] }),
      analyzeContentKnowledge({ products: [{ product: P(1), completeness: 0.2, missingItems: [], facts: 2, verifiedFacts: 1 }], searchConnected: true, searchData: false, content: { awaitingApproval: 1, inChecks: 1, published: 0, total: 2 }, opportunities: [] }),
      analyzeAiVisibility({ providers: 1, activePrompts: 0, tests: 0, orgMentioned: 0, ownDomainCited: 0, products: [], opportunities: [] }),
      analyzeAiVisibility({ providers: 1, activePrompts: 2, tests: 0, orgMentioned: 0, ownDomainCited: 0, products: [], opportunities: [] }),
      analyzeAiVisibility({ providers: 0, activePrompts: 2, tests: 12, orgMentioned: 0, ownDomainCited: 0, products: [{ product: P(1), tests: 12, mentioned: 0 }, { product: P(2), tests: 12, mentioned: 1 }], opportunities: [] }),
      analyzeCompetitors({ competitors: [{ id: "c", name: "R", samplesMentioning: 5 }], samplesTotal: 12, orgMentioned: 1, activeWatches: 0, changes: [{ id: "s", watchId: "w", competitorName: "R", url: "https://r.example", fetchedAt: NOW, linesAdded: 1, linesRemoved: 0 }], opportunities: [] }),
      analyzeCompetitors({ competitors: [{ id: "c", name: "R", samplesMentioning: 0 }], samplesTotal: 2, orgMentioned: 1, activeWatches: 0, changes: [], opportunities: [] }),
      analyzeCompetitors({ competitors: [], samplesTotal: 0, orgMentioned: 0, activeWatches: 0, changes: [], opportunities: [] }),
      analyzeConversionRevenue({ products: [{ product: P(1), events: 0 }], trackerKey: true, events: false, revenueConnected: true, revenue: false, visitors: { now: 60, prev: 0 }, signups: { now: 0, prev: 40 }, readyExperiments: [{ id: "e", name: "X" }], opportunities: [] }),
      analyzeConversionRevenue({ products: [], trackerKey: false, events: false, revenueConnected: false, revenue: false, visitors: { now: null, prev: null }, signups: { now: null, prev: null }, readyExperiments: [], opportunities: [] }),
      analyzeDistributionGrowth({ today: "2026-10-01", products: 2, events: false, targets: 0, awaitingApproval: 1, followUpsDue: 1, activeReferralCodes: 0, activeCrossSellRules: 0, opportunities: [] }),
      analyzeDistributionGrowth({ today: "2026-10-01", products: 1, events: true, targets: 0, awaitingApproval: 0, followUpsDue: 0, activeReferralCodes: 0, activeCrossSellRules: 0, opportunities: [] }),
      analyzeDistributionGrowth({ today: "2026-10-01", products: 0, events: true, targets: 0, awaitingApproval: 0, followUpsDue: 0, activeReferralCodes: 0, activeCrossSellRules: 0, opportunities: [] }),
    ];
    const keys = new Set<string>();
    for (const r of reports) {
      r.missing.forEach((m) => keys.add(m.replace(/Product \d/g, "{product}")));
      for (const f of r.findings) {
        if (f.opportunityId) continue;
        [f.title, f.summary, f.action.label, ...f.evidence.map((e) => e.label)].forEach((k) => keys.add(k));
      }
    }
    const missing = [...keys].filter((k) => FR[k] === undefined);
    expect(missing).toEqual([]);
    for (const k of keys) expect(placeholders(FR[k]).join()).toBe(placeholders(k).join());
  });
});
