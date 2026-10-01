import { describe, expect, it } from "vitest";
import { factCheck, numbersIn, parsePricingClaim, claimSeverity } from "@/core/content/fact-check";
import { generateDraft } from "@/core/content/generate";
import { assessContentQuality, fillerHits, intentFit, repetitionRatio, topTermDensity } from "@/core/content/quality";
import { guardRewrite } from "@/core/content/rewrite-guard";
import { buildDerivative } from "@/core/content/repurpose";
import { CONTENT_TYPES, OPPORTUNITY_CONTENT_TYPES, REPURPOSE_TYPES } from "@/core/content/types";
import { EDITOR_TODO } from "@/core/content/markers";
import { graphFacts, publishableGraph, restrictGraph } from "@/core/knowledge/facts";
import { planPages } from "@/core/discovery/plan";
import { contentTypeEnum } from "@/db/schema";
import { completeGraph, FIXED_DATE, makeChangelog, makeFacet, makePricing, makeProof } from "./fixtures/graph";

const NOW = FIXED_DATE;
const check = (body: string, g = completeGraph(), opts: Parameters<typeof factCheck>[2] = {}) => factCheck(body, g, { now: NOW, ...(opts as object) });
const first = (body: string, g = completeGraph(), opts: Parameters<typeof factCheck>[2] = {}) => check(body, g, opts).claims[0];

describe("content types (single source)", () => {
  it("matches the database enum and derives the sub-lists", () => {
    expect([...CONTENT_TYPES]).toEqual(contentTypeEnum.enumValues);
    for (const t of [...OPPORTUNITY_CONTENT_TYPES, ...REPURPOSE_TYPES]) expect(CONTENT_TYPES).toContain(t);
  });
});

describe("graphFacts (one flattener)", () => {
  it("carries each fact's verification and filters with verifiedOnly", () => {
    const g = completeGraph();
    g.facets.push(makeFacet("FEATURE", "Draft feature", { verification: "UNVERIFIED" }), makeFacet("FEATURE", "Old feature", { verification: "OUTDATED" as never }), makeFacet("FEATURE", "Disputed", { verification: "CONFLICTING" as never }), makeFacet("FEATURE", "Gone", { verification: "REJECTED" }));
    const all = graphFacts(g);
    const by = (name: string) => all.find((f) => f.name === name);
    expect(by("Draft feature")).toMatchObject({ verification: "UNVERIFIED", verified: false });
    expect(by("Old feature")).toMatchObject({ verification: "OUTDATED", verified: false });
    expect(by("Disputed")).toMatchObject({ verification: "CONFLICTING", verified: false });
    expect(by("Gone")).toBeUndefined();
    const verified = graphFacts(g, { verifiedOnly: true });
    expect(verified.every((f) => f.verified)).toBe(true);
    expect(verified.find((f) => f.name === "Draft feature")).toBeUndefined();
  });

  it("treats changelog entries without a VERIFIED status as unverified", () => {
    const g = completeGraph();
    g.changelog = [makeChangelog({ verification: "UNVERIFIED" } as never), makeChangelog({ title: "Verified entry", verification: "VERIFIED" } as never)];
    const facts = graphFacts(g).filter((f) => f.kind === "changelog");
    expect(facts.map((f) => f.verified)).toEqual([false, true]);
    expect(publishableGraph(g).changelog.map((c) => c.title)).toEqual(["Verified entry"]);
  });

  it("is the planner's flattener too: same refs and verification", () => {
    const g = completeGraph();
    g.facets.push(makeFacet("FEATURE", "Unverified planner feature", { verification: "UNVERIFIED", description: "x".repeat(80) }));
    const plan = planPages(g).planned.find((p) => p.type === "PRODUCT")!;
    const facts = new Map(graphFacts(g).map((f) => [f.ref, f]));
    for (const f of plan.facts) expect(facts.get(f.ref)?.verification).toBe(f.verification);
    expect(plan.facts.some((f) => f.verification === "UNVERIFIED")).toBe(true);
  });
});

describe("verified-only generation", () => {
  it("never writes unverified facts into a draft", () => {
    const g = completeGraph();
    g.facets.push(makeFacet("FEATURE", "Secret beta feature", { description: "Unverified capability.", verification: "UNVERIFIED" }));
    g.pricing.push(makePricing({ planName: "Enterprise", priceCents: 99900, verification: "NEEDS_REVIEW" }));
    g.proofs.push(makeProof({ content: "Unverified quote from a customer.", verification: "UNVERIFIED" }));
    const d = generateDraft(g, { type: "LANDING_PAGE", publisher: "N" });
    expect(d.body).not.toContain("Secret beta feature");
    expect(d.body).not.toContain("Enterprise");
    expect(d.body).not.toContain("Unverified quote");
    const refs = d.factRefs.map((r) => r.ref);
    expect(refs.every((r) => graphFacts(g, { verifiedOnly: true }).some((f) => f.ref === r))).toBe(true);
  });

  it("leaves a TODO for a plan without a currency instead of assuming one", () => {
    const g = completeGraph();
    g.pricing = [makePricing({ planName: "Team", priceCents: 1900, currency: null as never })];
    expect(generateDraft(g, { type: "LANDING_PAGE", publisher: "N" }).body).toContain(`${EDITOR_TODO} Plan "Team" has a price without a currency`);
  });

  it("generated drafts from a complete graph have no HIGH claim", () => {
    const g = completeGraph();
    for (const type of ["LANDING_PAGE", "FAQ", "X_POST", "LINKEDIN_POST", "TIKTOK_SCRIPT", "OUTREACH", "DIRECTORY_DESCRIPTION"] as const) {
      const d = generateDraft(g, { type, publisher: "N" });
      const r = check(d.body, g, { metaTitle: d.metaTitle, metaDescription: d.metaDescription });
      expect(r.claims.filter((c) => c.severity === "HIGH").map((c) => `${type}: ${c.claim} (${c.reason})`)).toEqual([]);
    }
  });
});

describe("fact checker: claim kinds and severities", () => {
  it("SUPPORTED claims are LOW", () => {
    expect(first("Beacon Live hides live comments that contain blocked keywords or phrases.")).toMatchObject({ status: "SUPPORTED", kind: "FACT", severity: "LOW" });
  });

  it("claims supported only by unverified, outdated or conflicting facts are NEEDS_REVIEW and HIGH", () => {
    for (const verification of ["UNVERIFIED", "NEEDS_REVIEW", "OUTDATED", "CONFLICTING"]) {
      const g = completeGraph();
      g.facets.push(makeFacet("FEATURE", "Toxicity scoring", { description: "Score every live comment for toxicity before it appears.", verification: verification as never }));
      const r = first("Beacon Live scores every live comment for toxicity before it appears.", g);
      expect(r, verification).toMatchObject({ status: "NEEDS_REVIEW", severity: "HIGH" });
      expect(r.reason).toMatch(/unverified, outdated or conflicting/);
    }
  });

  it("partly supported sentences need acknowledgment (MEDIUM)", () => {
    const r = first("Keyword filters hide live comments for agencies running weekly giveaways.");
    expect(r.severity).toBe("MEDIUM");
    expect(r.status).toBe("NEEDS_REVIEW");
  });

  it("checks headings, meta titles and meta descriptions", () => {
    expect(check("# The #1 moderation tool").claims[0]).toMatchObject({ kind: "SUPERLATIVE", location: "heading", severity: "HIGH" });
    expect(check("Intro.", completeGraph(), { metaTitle: "Trusted by 5,000 agencies" }).claims[0]).toMatchObject({ kind: "CUSTOMER", location: "meta_title", severity: "HIGH" });
    expect(check("Intro.", completeGraph(), { metaDescription: "Beacon Live cuts spam by 80% for every stream." }).claims[0]).toMatchObject({ kind: "STATISTIC", location: "meta_description", status: "UNSUPPORTED", severity: "HIGH" });
    // Structural section headings are not claims.
    expect(check("## How it works\n## Pricing\n## Hook (0-3s)").claims).toEqual([]);
  });

  it("applies risky patterns to short lines and notes", () => {
    expect(first("Award-winning.")).toMatchObject({ kind: "AWARD", severity: "HIGH" });
    expect(first("Rated 4.9/5.")).toMatchObject({ kind: "RATING", severity: "HIGH" });
    expect(first("_Best in class._")).toMatchObject({ kind: "SUPERLATIVE", severity: "HIGH" });
    // Sign-offs are not superlatives.
    expect(check("Best regards,").claims).toEqual([]);
  });

  it("accepts a quantity that restates a verified plan limit", () => {
    const g = completeGraph();
    g.pricing.push(makePricing({ planName: "Agency", priceCents: 9900, interval: "MONTH", description: "Up to 30 creators.", sourceId: g.pricing[0].sourceId, verification: "VERIFIED" }));
    expect(check("Up to 30 creators.", g).claims[0]).toMatchObject({ kind: "CUSTOMER", status: "SUPPORTED" });
    // The same number without the plan behind it is still a customer claim needing proof.
    expect(check("Trusted by 30 creators.").claims[0]).toMatchObject({ kind: "CUSTOMER", severity: "HIGH" });
  });

  it("flags customers, testimonials and statistics without verified proof", () => {
    expect(first("Used by 10,000 agencies.")).toMatchObject({ kind: "CUSTOMER", status: "UNSUPPORTED", severity: "HIGH" });
    expect(first("> Beacon Live doubled our engagement overnight. (Sam, Creator)")).toMatchObject({ kind: "TESTIMONIAL", severity: "HIGH" });
    expect(first("Moderation is 3x faster with Beacon Live.")).toMatchObject({ kind: "STATISTIC", severity: "HIGH" });
    // A verified, publishable proof supports its own testimonial.
    expect(first("> It saved our moderators hours every week. (Jane, Agency lead)")).toMatchObject({ kind: "TESTIMONIAL", status: "SUPPORTED", severity: "LOW" });
    const g = completeGraph();
    g.proofs = [makeProof({ verification: "UNVERIFIED" })];
    expect(first("> It saved our moderators hours every week. (Jane, Agency lead)", g)).toMatchObject({ kind: "TESTIMONIAL", status: "NEEDS_REVIEW", severity: "HIGH" });
  });

  it("flags invented and unverified integrations", () => {
    expect(first("Beacon Live integrates with Slack and Zapier.")).toMatchObject({ kind: "INTEGRATION", status: "UNSUPPORTED", severity: "HIGH" });
    expect(first("Beacon Live connects to TikTok live via the official account login.")).toMatchObject({ kind: "INTEGRATION", status: "SUPPORTED" });
    const g = completeGraph();
    g.facets.push(makeFacet("INTEGRATION", "Discord", { description: "Posts moderation alerts to Discord.", verification: "UNVERIFIED" }));
    expect(first("Beacon Live works with Discord.", g)).toMatchObject({ kind: "INTEGRATION", status: "NEEDS_REVIEW", severity: "HIGH" });
  });

  it("flags unsupported competitor claims and accepts sourced comparisons", () => {
    expect(first("Rival crashes constantly and loses customer data.")).toMatchObject({ kind: "COMPETITOR", status: "UNSUPPORTED", severity: "HIGH" });
    expect(first("Rival Dimension 1 is Rival value 1 while Beacon Live offers Acme value 1.")).toMatchObject({ kind: "COMPETITOR", status: "SUPPORTED" });
  });

  it("superlatives taken from a verified fact need acknowledgment", () => {
    const g = completeGraph();
    g.facets.push(makeFacet("DIFFERENTIATOR", "Fastest setup", { description: "The fastest setup of any TikTok live moderation tool, measured in our docs." }));
    expect(first("The fastest setup of any TikTok live moderation tool, measured in our docs.", g)).toMatchObject({ kind: "SUPERLATIVE", status: "NEEDS_REVIEW", severity: "MEDIUM" });
  });

  it("matches numbers on token boundaries against the supporting fact", () => {
    expect(numbersIn("€29 / month, 14-day trial, 10,000 users, v 1.2.0, 30s")).toEqual(["29", "14", "10000", "1.2.0", "30"]);
    // "2" is part of "29" and "1.2.0" but not a number of its own anywhere: no substring matches.
    expect(first("Moderator dashboard reviews hidden comments in 2 dashboards.")).toMatchObject({ status: "UNSUPPORTED", severity: "HIGH" });
    // The number exists in the graph, but not in the fact that supports this sentence.
    expect(first("Keyword filters hide 14 live comments that contain blocked keywords.")).toMatchObject({ status: "UNSUPPORTED" });
  });

  it("restricts support to the source's facts when repurposing", () => {
    const g = completeGraph();
    const keyword = g.facets.find((f) => f.name === "Keyword filters")!;
    const r = first("Beacon Live detects repeated spam messages in live chat automatically.", g, { allowedRefs: [`facet:${keyword.id}`] });
    expect(r).toMatchObject({ status: "NEEDS_REVIEW", severity: "HIGH" });
    expect(r.reason).toMatch(/source content/);
  });

  it("treats stored legacy claims without severity as HIGH unless supported", () => {
    expect(claimSeverity({ claim: "x", status: "NEEDS_REVIEW" })).toBe("HIGH");
    expect(claimSeverity({ claim: "x", status: "SUPPORTED" })).toBe("LOW");
  });

  it("passes only without HIGH claims and reports counts", () => {
    const r = check(["Beacon Live hides live comments that contain blocked keywords or phrases.", "Keyword filters hide live comments for agencies running weekly giveaways."].join("\n"));
    expect(r.passed).toBe(true);
    expect(r.counts).toEqual({ HIGH: 0, MEDIUM: 1, LOW: 1 });
    expect(check("Used by 10,000 agencies.").passed).toBe(false);
  });
});

describe("pricing validator", () => {
  it("parses price, currency, interval and trial", () => {
    expect(parsePricingClaim("Pro: €29 / month (14-day trial)")).toEqual({ amounts: [{ cents: 2900, currency: "EUR" }], interval: "MONTH", trialDays: 14 });
    expect(parsePricingClaim("Team costs 1,200 USD per year")).toEqual({ amounts: [{ cents: 120000, currency: "USD" }], interval: "YEAR", trialDays: null });
    expect(parsePricingClaim("CA$19.50 monthly")).toEqual({ amounts: [{ cents: 1950, currency: "CAD" }], interval: "MONTH", trialDays: null });
    expect(parsePricingClaim("No price here")).toBeNull();
  });

  it("accepts a price matching a fresh VERIFIED plan", () => {
    expect(first("Pro: €29 / month (14-day trial).")).toMatchObject({ status: "SUPPORTED", kind: "PRICING", severity: "LOW" });
    expect(first("Pro costs €29.")).toMatchObject({ status: "SUPPORTED" });
  });

  it("flags wrong price, currency, interval and trial as WRONG_PRICING (HIGH)", () => {
    for (const claim of ["Pro: €39 / month.", "Pro: $29 / month.", "Pro: €29 per year.", "Pro: €29 / month (30-day trial)."]) expect(first(claim), claim).toMatchObject({ status: "WRONG_PRICING", severity: "HIGH", kind: "PRICING" });
  });

  it("does not let an unverified plan support a price", () => {
    const g = completeGraph();
    g.pricing = [makePricing({ planName: "Pro", priceCents: 2900, verification: "UNVERIFIED" })];
    expect(first("Pro: €29 / month.", g)).toMatchObject({ status: "NEEDS_REVIEW", severity: "HIGH" });
  });

  it("flags OUTDATED plans (HIGH) and verifications older than the freshness threshold (MEDIUM)", () => {
    const g = completeGraph();
    g.pricing = [makePricing({ planName: "Pro", priceCents: 2900, verification: "OUTDATED" as never })];
    expect(first("Pro: €29 / month.", g)).toMatchObject({ status: "OUTDATED_PRICING", severity: "HIGH" });
    const stale = completeGraph();
    stale.pricing = [makePricing({ planName: "Pro", priceCents: 2900, verifiedAt: new Date("2025-01-01T00:00:00Z") } as never)];
    expect(first("Pro: €29 / month.", stale, { freshnessDays: 180 })).toMatchObject({ status: "OUTDATED_PRICING", severity: "MEDIUM" });
    expect(first("Pro: €29 / month.", stale, { freshnessDays: 400 })).toMatchObject({ status: "SUPPORTED" });
  });
});

describe("quality gate", () => {
  const g = completeGraph();
  const landing = generateDraft(g, { type: "LANDING_PAGE", publisher: "N" });
  const claims = check(landing.body, g).claims;
  const base = { type: "LANDING_PAGE" as const, body: landing.body, brandTerms: ["Beacon Live"], claims, others: [], now: NOW };

  it("passes a generated landing page", () => {
    const q = assessContentQuality(base);
    expect(q.checks.filter((c) => !c.ok)).toEqual([]);
    expect(q.passed).toBe(true);
    expect(q.metrics.uniqueVerifiedFacts).toBeGreaterThan(5);
  });

  it("detects near-duplicates of other content", () => {
    const q = assessContentQuality({ ...base, others: [{ label: "Other page v2", body: landing.body.replace("Keyword filters", "Word filters") }] });
    expect(q.passed).toBe(false);
    expect(q.duplicateOf).toBe("Other page v2");
    expect(q.checks.find((c) => c.rule === "near_duplicate")!.ok).toBe(false);
  });

  it("detects keyword stuffing, filler, repetition and unsupported claims", () => {
    expect(topTermDensity("moderation ".repeat(20) + "word ".repeat(80))).toEqual({ term: "word", density: 0.8 });
    expect(topTermDensity("Beacon Live ".repeat(30) + "other words here", ["Beacon Live"]).term).toBe("other");
    expect(fillerHits("In today's fast-paced world, unlock the power of moderation. Dans le monde d'aujourd'hui, il est important de noter.")).toHaveLength(4);
    expect(repetitionRatio("spam filters for live chat ".repeat(10))).toBeGreaterThan(0.5);
    const stuffed = assessContentQuality({ ...base, body: `${landing.body}\n${"moderation ".repeat(80)}` });
    expect(stuffed.checks.find((c) => c.rule === "keyword_stuffing")!.ok).toBe(false);
    const filler = assessContentQuality({ ...base, body: `${landing.body}\nIn today's fast-paced world, our cutting-edge tool works seamlessly.` });
    expect(filler.checks.find((c) => c.rule === "generic_filler")!.ok).toBe(false);
    const unsupported = assessContentQuality({ ...base, claims: claims.map((c) => ({ ...c, status: "UNSUPPORTED" as const })) });
    expect(unsupported.checks.find((c) => c.rule === "unsupported_claims")!.ok).toBe(false);
  });

  it("measures intent fit and original information", () => {
    expect(intentFit("COMPARISON", "beacon live vs rival")).toMatchObject({ intent: "COMPARISON", fit: 1 });
    expect(intentFit("COMPARISON", "how to stop spam in tiktok live").fit).toBeLessThan(0.5);
    expect(intentFit("X_POST", "anything").fit).toBeNull();
    const misfit = assessContentQuality({ ...base, type: "COMPARISON", targetQuery: "how to stop spam in tiktok live" });
    expect(misfit.checks.find((c) => c.rule === "intent_fit")!.ok).toBe(false);
    const thin = assessContentQuality({ ...base, claims: [] });
    expect(thin.checks.find((c) => c.rule === "original_information")!.ok).toBe(false);
  });
});

describe("rewrite guard", () => {
  const g = completeGraph();
  const template = { body: ["# Title", "", "Beacon Live hides live comments that contain blocked keywords or phrases.", "", `${EDITOR_TODO} Add a case study.`, "", "- [Start free trial](https://beaconlive.example/signup) {cta:TRY_FREE}", "", "## Sources", "", "- <https://beaconlive.example/docs>", ""].join("\n") };
  const fc = (body: string) => check(body, g);

  it("accepts a rewrite that keeps markers and adds no claim", () => {
    const rewrite = { body: template.body.replace("# Title", "# A clearer title") };
    expect(guardRewrite(template, rewrite, fc(template.body), fc(rewrite.body))).toEqual({ ok: true, reasons: [] });
  });

  it("rejects removed TODO lines, Sources URLs and CTA markers", () => {
    const rewrite = { body: template.body.replace(`${EDITOR_TODO} Add a case study.`, "").replace("- <https://beaconlive.example/docs>", "").replace(" {cta:TRY_FREE}", "") };
    const r = guardRewrite(template, rewrite, fc(template.body), fc(rewrite.body));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" | ")).toMatch(/TODO.*source URL.*CTA/);
  });

  it("rejects added unsupported claims and higher NEEDS_REVIEW or HIGH counts", () => {
    const added = { body: template.body.replace("## Sources", "Trusted by 10,000 agencies worldwide.\n\n## Sources") };
    const r = guardRewrite(template, added, fc(template.body), fc(added.body));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining(["More high-severity claims", expect.stringMatching(/Adds 1 claim/)]));
    const review = { body: template.body.replace("## Sources", "Keyword filters hide live comments for agencies running weekly giveaways.\n\n## Sources") };
    expect(guardRewrite(template, review, fc(template.body), fc(review.body)).reasons).toContain("More claims need review");
  });
});

describe("repurposing", () => {
  it("builds derivatives only from the source version's facts", () => {
    const g = completeGraph();
    const keyword = g.facets.find((f) => f.name === "Keyword filters")!;
    const source = { title: "Keyword filters | Beacon Live", factRefs: [{ ref: "product:short_description" }, { ref: `facet:${keyword.id}` }] };
    const d = buildDerivative(g, source, "LINKEDIN_POST", "N");
    expect(d.title).toBe("Keyword filters | Beacon Live (LinkedIn post)");
    expect(d.body).toContain("Keyword filters");
    expect(d.body).not.toContain("Spam detection");
    expect(d.factRefs.every((r) => source.factRefs.some((s) => s.ref === r.ref))).toBe(true);
    const r = check(d.body, g, { allowedRefs: source.factRefs.map((x) => x.ref) });
    expect(r.claims.filter((c) => c.severity === "HIGH")).toEqual([]);
  });

  it("FAQ additions only answer from the source's facts", () => {
    const g = completeGraph();
    const faq = g.faqs[0];
    const d = buildDerivative(g, { title: "Source", factRefs: [{ ref: `faq:${faq.id}` }] }, "FAQ", "N");
    expect(d.body).toContain(faq.question);
    expect(d.body).not.toContain("How much does");
    const none = buildDerivative(g, { title: "Source", factRefs: [] }, "FAQ", "N");
    expect(none.body).toContain(EDITOR_TODO);
  });

  it("restrictGraph keeps only listed refs", () => {
    const g = completeGraph();
    const r = restrictGraph(g, [`pricing:${g.pricing[0].id}`]);
    expect(r.facets).toEqual([]);
    expect(r.pricing).toHaveLength(1);
    expect(r.product.shortDescription).toBeNull();
    expect(r.product.name).toBe(g.product.name);
  });
});
