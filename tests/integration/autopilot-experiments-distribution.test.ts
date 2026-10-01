import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb, withOrg, type Tx } from "@/db";
import {
  attributionEvents,
  auditLogs,
  autopilotLearning,
  campaigns,
  contentAssets,
  contentVersions,
  conversionEvents,
  distributionTargets,
  experiments,
  integrations,
  jobs,
  opportunities,
  recommendations,
  searchDaily,
} from "@/db/schema";
import { decideRecommendation, generateGrowthReport, identifyRecommendations, measureRecommendation, measurementSnapshot, autopilotLoop, dueMeasurements } from "@/services/autopilot";
import { learningTallies } from "@/services/autopilot-learning";
import { createExperiment, designExperiment, enterExperimentCounts, refreshExperimentCounts, setExperimentStatus } from "@/services/experiments";
import { approveSubmission, measureTargets, prepareSubmission, seedDistributionTargets, setDistributionStatus, addDistributionTarget } from "@/services/distribution";
import { exportApprovedAsset } from "@/services/content-export";
import { experimentTags } from "@/services/tracking";
import { dayPlus } from "@/core/autopilot/loop";
import { createKey, newOrg, seedCompleteProduct, uid } from "./helpers";

type Ctx = Awaited<ReturnType<typeof newOrg>>;
let A: Ctx;
let B: Ctx;
let productA: string;
let productB: string;
const qa = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(A.org.id, fn);
const qb = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(B.org.id, fn);

async function opp(orgId: string, productId: string, over: Partial<typeof opportunities.$inferInsert> = {}) {
  const fp = over.fingerprint ?? `test:${uid()}`;
  const [o] = await withOrg(orgId, (tx) =>
    tx
      .insert(opportunities)
      .values({
        organizationId: orgId,
        productId,
        type: "CONTENT_GAP",
        category: "CONTENT",
        title: `Create a guide for the "topic ${uid()}" topic`,
        problem: "Content gap for a cluster of 2 queries.",
        potential: "HIGH",
        impact: 4,
        confidence: 4,
        effort: 3,
        urgency: 3,
        priorityScore: 16,
        fingerprint: fp,
        ...over,
      })
      .returning(),
  );
  return o;
}

beforeAll(async () => {
  A = await newOrg("w2b-a");
  B = await newOrg("w2b-b");
  productA = (await seedCompleteProduct(A.org.id, { name: `Loop A ${uid()}`, domain: "loop-a.example" })).product.id;
  productB = (await seedCompleteProduct(B.org.id, { name: `Loop B ${uid()}` })).product.id;
});
afterAll(closeDb);

describe("autopilot: identify and dedupe", () => {
  it("proposes the top opportunities per product once, however often it runs", async () => {
    const o1 = await opp(A.org.id, productA, { priorityScore: 30 });
    const o2 = await opp(A.org.id, productA, { priorityScore: 20, type: "TECHNICAL", category: "TECHNICAL", title: "Fix critical technical issue: http.error" });
    const first = await qa((tx) => identifyRecommendations(tx, A.org.id));
    expect(first.created).toBeGreaterThanOrEqual(2);
    const again = await qa((tx) => identifyRecommendations(tx, A.org.id));
    expect(again.created).toBe(0);
    await qa((tx) => generateGrowthReport(tx, A.org.id, 7));
    await qa((tx) => generateGrowthReport(tx, A.org.id, 7));
    const recs = await qa((tx) => tx.select().from(recommendations).where(eq(recommendations.organizationId, A.org.id)));
    for (const id of [o1.id, o2.id]) expect(recs.filter((r) => r.opportunityId === id)).toHaveLength(1);
    const keys = recs.filter((r) => r.status === "PROPOSED").map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    const r1 = recs.find((r) => r.opportunityId === o1.id)!;
    expect(r1).toMatchObject({ source: "OPPORTUNITY", productId: productA, kind: "CONTENT_GAP", status: "PROPOSED" });
    expect(r1.targetRef).toMatchObject({ productId: productA, opportunityType: "CONTENT_GAP" });
  });

  it("the database refuses a second open recommendation for the same opportunity", async () => {
    const o = await opp(A.org.id, productA);
    const row = { organizationId: A.org.id, opportunityId: o.id, kind: "CONTENT_GAP", title: "x", body: "y", dedupeKey: `opp:${o.id}` };
    await qa((tx) => tx.insert(recommendations).values(row));
    await expect(qa((tx) => tx.insert(recommendations).values({ ...row, dedupeKey: "other" }))).rejects.toThrow();
  });

  it("a rejected opportunity is not proposed again on the next run", async () => {
    const o = await opp(A.org.id, productA, { priorityScore: 99 });
    await qa((tx) => identifyRecommendations(tx, A.org.id));
    const r = await qa((tx) => tx.query.recommendations.findFirst({ where: eq(recommendations.opportunityId, o.id) }));
    await qa((tx) => decideRecommendation(tx, A.actor, r!.id, "REJECTED"));
    await qa((tx) => identifyRecommendations(tx, A.org.id));
    const all = await qa((tx) => tx.select().from(recommendations).where(eq(recommendations.opportunityId, o.id)));
    expect(all.map((x) => x.status)).toEqual(["REJECTED"]);
    await expect(qa((tx) => decideRecommendation(tx, A.actor, r!.id, "APPROVED"))).rejects.toThrow(/already decided/);
  });
});

describe("autopilot: approve → execute (never publish)", () => {
  it("approving a content gap creates a draft, records the baseline and schedules the measurement", async () => {
    const o = await opp(A.org.id, productA, { priorityScore: 98, sources: { queryIds: [] } });
    await qa((tx) => identifyRecommendations(tx, A.org.id));
    const r = (await qa((tx) => tx.query.recommendations.findFirst({ where: eq(recommendations.opportunityId, o.id) })))!;
    const now = new Date("2026-05-10T12:00:00Z");
    const done = await qa((tx) => decideRecommendation(tx, A.actor, r.id, "APPROVED", now));
    expect(done.executedAt).toEqual(now);
    expect(done.measureAfter).toBe("2026-06-07");
    expect(done.executionPlan).toMatchObject({ action: "CREATE_CONTENT", contentType: "ARTICLE", measure: "SEARCH" });
    expect(done.executionPlan!.page).toMatchObject({ faq: expect.any(Array), schemaTypes: expect.arrayContaining(["Article"]) });
    expect(done.baseline).toMatchObject({ kind: "SEARCH", state: "NOT_CONNECTED", window: { start: "2026-04-12", end: "2026-05-09", days: 28 } });
    const ref = done.executedRef!.find((x) => x.type === "content_asset")!;
    const asset = await qa((tx) => tx.query.contentAssets.findFirst({ where: eq(contentAssets.id, ref.id!) }));
    expect(asset).toMatchObject({ status: "IDEA", publishedVersionId: null, approvedVersionId: null, productId: productA });
    expect(asset!.brief).toContain("Page title:");
    expect((await qa((tx) => tx.query.opportunities.findFirst({ where: eq(opportunities.id, o.id) })))!.status).toBe("IN_PROGRESS");
    const job = await systemDb().query.jobs.findFirst({ where: eq(jobs.idempotencyKey, `${A.org.id}:measure:${r.id}`) });
    expect(job).toMatchObject({ type: "recommendation.measure", status: "QUEUED" });
    expect(job!.runAt.toISOString()).toBe("2026-06-07T06:00:00.000Z");
    const logs = await qa((tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, r.id), eq(auditLogs.organizationId, A.org.id))));
    expect(logs.map((l) => l.action).sort()).toEqual(["recommendation.decide", "recommendation.execute"]);
    const loop = await qa((tx) => autopilotLoop(tx, A.org.id));
    expect(loop.find((x) => x.id === r.id)?.stage).toBe("EXECUTING");
  });

  it("a conversion recommendation drafts an experiment; an audit on an unverified domain is skipped, not fatal", async () => {
    const conv = await opp(A.org.id, productA, { type: "CONVERSION", category: "CONVERSION", title: "Improve CTA on /pricing", fingerprint: `cta:${productA}:/pricing`, priorityScore: 97 });
    const tech = await opp(A.org.id, productA, { type: "TECHNICAL", category: "TECHNICAL", title: "Fix critical technical issue: http.error", fingerprint: `tech:${productA}:${uid()}`, priorityScore: 96 });
    await qa((tx) => identifyRecommendations(tx, A.org.id));
    const rc = (await qa((tx) => tx.query.recommendations.findFirst({ where: eq(recommendations.opportunityId, conv.id) })))!;
    const rt = (await qa((tx) => tx.query.recommendations.findFirst({ where: eq(recommendations.opportunityId, tech.id) })))!;
    const c = await qa((tx) => decideRecommendation(tx, A.actor, rc.id, "APPROVED"));
    const x = await qa((tx) => tx.query.experiments.findFirst({ where: eq(experiments.recommendationId, rc.id) }));
    expect(x).toMatchObject({ status: "DRAFT", metricKey: "CTA_CLICK", productId: productA });
    expect(x!.control.url).toBe("https://loop-a.example/pricing");
    expect(c.targetRef.pagePaths).toEqual(["/pricing"]);
    expect(c.baseline).toMatchObject({ kind: "CONVERSIONS", state: "NOT_CONNECTED" });
    const t = await qa((tx) => decideRecommendation(tx, A.actor, rt.id, "APPROVED"));
    expect(t.status).toBe("APPROVED");
    expect(t.executionError).toBeTruthy();
    expect(t.executedRef![0]).toMatchObject({ status: "SKIPPED" });
  });

  it("refuses decisions on another organisation's recommendation", async () => {
    const o = await opp(B.org.id, productB);
    await qb((tx) => identifyRecommendations(tx, B.org.id));
    const r = (await qb((tx) => tx.query.recommendations.findFirst({ where: eq(recommendations.opportunityId, o.id) })))!;
    await expect(qa((tx) => decideRecommendation(tx, A.actor, r.id, "APPROVED"))).rejects.toThrow(/not found/);
  });
});

describe("autopilot: measure → learn", () => {
  it("compares search clicks after execution with the baseline, labels the outcome and feeds learning", async () => {
    const { product } = await seedCompleteProduct(A.org.id, { name: `Measured ${uid()}` });
    const [integ] = await qa((tx) => tx.insert(integrations).values({ organizationId: A.org.id, productId: product.id, provider: "GOOGLE_SEARCH_CONSOLE", status: "CONNECTED", config: { siteUrl: "sc-domain:measured.example" } }).returning());
    const approvedAt = new Date("2026-03-01T09:00:00Z");
    const rows: (typeof searchDaily.$inferInsert)[] = [];
    for (let d = 1; d <= 28; d++) {
      rows.push({ organizationId: A.org.id, productId: product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: dayPlus(approvedAt, -d), query: "tiktok live moderation", clicks: 2, impressions: 40, position: 12 });
      rows.push({ organizationId: A.org.id, productId: product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: dayPlus(approvedAt, d - 1), query: "tiktok live moderation", clicks: 4, impressions: 60, position: 8 });
      rows.push({ organizationId: A.org.id, productId: product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: dayPlus(approvedAt, d - 1), query: "unrelated query", clicks: 50, impressions: 500, position: 3 });
    }
    await qa((tx) => tx.insert(searchDaily).values(rows));
    const o = await opp(A.org.id, product.id, { type: "STRIKING_DISTANCE", category: "QUERY", title: 'Improve ranking for "tiktok live moderation" (avg. position 12.0)', priorityScore: 50 });
    const [r] = await qa((tx) =>
      tx
        .insert(recommendations)
        .values({ organizationId: A.org.id, productId: product.id, opportunityId: o.id, source: "OPPORTUNITY", dedupeKey: `opp:${o.id}`, kind: o.type, title: o.title, body: "x", targetRef: { productId: product.id, opportunityType: o.type, queries: ["TikTok live moderation"] } })
        .returning(),
    );
    const executed = await qa((tx) => decideRecommendation(tx, A.actor, r.id, "APPROVED", approvedAt));
    expect(executed.baseline).toMatchObject({ state: "OK", metrics: [{ key: "clicks", value: 56 }, { key: "impressions", value: 1120 }] });
    expect(await qa((tx) => measureRecommendation(tx, A.org.id, r.id, new Date("2026-03-15T00:00:00Z")))).toMatchObject({ skipped: "not due" });
    expect((await qa((tx) => dueMeasurements(tx, "2026-03-29"))).map((d) => d.id)).toContain(r.id);
    const m = await qa((tx) => measureRecommendation(tx, A.org.id, r.id, new Date("2026-03-29T07:00:00Z")));
    expect(m).toMatchObject({ label: "IMPROVED", outcome: { primary: "clicks", before: 56, after: 112, change: 1, reason: "MEASURED" } });
    expect((m as { outcome: { note: string } }).outcome.note).toMatch(/^Correlation, not causation/);
    const after = (await qa((tx) => tx.query.recommendations.findFirst({ where: eq(recommendations.id, r.id) })))!;
    expect(after).toMatchObject({ status: "DONE", outcomeLabel: "IMPROVED" });
    expect(await qa((tx) => measureRecommendation(tx, A.org.id, r.id))).toMatchObject({ skipped: "already measured" });
    expect((await qa((tx) => learningTallies(tx, A.org.id))).STRIKING_DISTANCE).toEqual({ improved: 1, noChange: 0, declined: 0, insufficient: 0 });
  });

  it("without connected data the outcome is INSUFFICIENT_DATA, never a number", async () => {
    const o = await opp(A.org.id, productA, { type: "REFERRAL", category: "REFERRAL", title: "Start a referral program", priorityScore: 1 });
    const [r] = await qa((tx) => tx.insert(recommendations).values({ organizationId: A.org.id, productId: productA, opportunityId: o.id, source: "OPPORTUNITY", dedupeKey: `opp:${o.id}`, kind: o.type, title: o.title, body: "x", targetRef: { productId: productA, opportunityType: o.type } }).returning());
    const at = new Date("2026-01-01T00:00:00Z");
    await qa((tx) => decideRecommendation(tx, A.actor, r.id, "APPROVED", at));
    const m = await qa((tx) => measureRecommendation(tx, A.org.id, r.id, new Date("2026-02-01T00:00:00Z")));
    expect(m).toMatchObject({ label: "INSUFFICIENT_DATA", outcome: { before: null, after: null, reason: "NOT_CONNECTED" } });
    expect((await qa((tx) => learningTallies(tx, A.org.id))).REFERRAL).toMatchObject({ insufficient: 1, improved: 0 });
  });

  it("conversion snapshots: Not connected without a tracker key, counted with one", async () => {
    const { product } = await seedCompleteProduct(A.org.id, { name: `Conv ${uid()}` });
    const w = { start: "2026-01-01", end: "2026-01-28", days: 28 };
    expect((await qa((tx) => measurementSnapshot(tx, A.org.id, "CONVERSIONS", { productId: product.id }, w))).state).toBe("NOT_CONNECTED");
    await createKey(A.org.id, "PUBLISHABLE", { productId: product.id });
    expect((await qa((tx) => measurementSnapshot(tx, A.org.id, "CONVERSIONS", { productId: product.id }, w))).state).toBe("NO_DATA_YET");
    await qa((tx) =>
      tx.insert(conversionEvents).values([
        { organizationId: A.org.id, productId: product.id, type: "CTA_CLICK", pagePath: "/pricing", occurredAt: new Date("2026-01-05T10:00:00Z") },
        { organizationId: A.org.id, productId: product.id, type: "CTA_CLICK", pagePath: "/other", occurredAt: new Date("2026-01-05T10:00:00Z") },
        { organizationId: A.org.id, productId: product.id, type: "CTA_CLICK", pagePath: "/pricing", occurredAt: new Date("2026-02-05T10:00:00Z") },
      ]),
    );
    const s = await qa((tx) => measurementSnapshot(tx, A.org.id, "CONVERSIONS", { productId: product.id, pagePaths: ["/pricing"] }, w));
    expect(s).toMatchObject({ state: "OK", metrics: [{ key: "conversions", value: 1 }] });
  });
});

describe("experiments", () => {
  it("enforces audited transitions and refuses a winner below the minimum sample", async () => {
    const e = await qa((tx) => createExperiment(tx, A.actor, { name: "CTA test", hypothesis: "A clearer CTA raises clicks.", primaryMetric: "CTA click rate", productId: productA }));
    await expect(qa((tx) => setExperimentStatus(tx, A.actor, e.id, "RUNNING"))).rejects.toThrow(/conversion event/);
    await expect(qa((tx) => setExperimentStatus(tx, A.actor, e.id, "CONCLUDED"))).rejects.toThrow(/cannot move/);
    const d = await qa((tx) => designExperiment(tx, A.actor, e.id, { metricKey: "CTA_CLICK", baselineRate: 0.1, minDetectableEffect: 0.2, control: { description: "Current" }, variant: { description: "New" } }));
    expect(d.minSampleSize).toBe(3841);
    await qa((tx) => setExperimentStatus(tx, A.actor, e.id, "RUNNING"));
    await expect(qa((tx) => designExperiment(tx, A.actor, e.id, { metricKey: "SIGNUP_COMPLETED" }))).rejects.toThrow(/fixed/);
    await qa((tx) => enterExperimentCounts(tx, A.actor, e.id, { controlN: 1000, controlConversions: 100, variantN: 1000, variantConversions: 300 }));
    await expect(qa((tx) => refreshExperimentCounts(tx, A.actor, e.id))).rejects.toThrow(/manually/);
    await qa((tx) => setExperimentStatus(tx, A.actor, e.id, "READY_FOR_REVIEW"));
    await qa((tx) => setExperimentStatus(tx, A.actor, e.id, "CONCLUDED", "Stopped early."));
    const x = (await qa((tx) => tx.query.experiments.findFirst({ where: eq(experiments.id, e.id) })))!;
    expect(x).toMatchObject({ status: "CONCLUDED", winner: "INCONCLUSIVE", countsSource: "MANUAL", result: "Stopped early.", testMethod: "Z_TEST" });
    expect(x.pValue!).toBeLessThan(0.001);
    expect(x.resultExplanation).toMatch(/Below the minimum sample size/);
    await expect(qa((tx) => setExperimentStatus(tx, A.actor, e.id, "RUNNING"))).rejects.toThrow(/cannot move/);
    const logs = await qa((tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, e.id), eq(auditLogs.action, "experiment.status"))));
    expect(logs.map((l) => (l.metadata as { to: string }).to)).toEqual(expect.arrayContaining(["RUNNING", "READY_FOR_REVIEW", "CONCLUDED"]));
  });

  it("counts units and conversions per arm from tagged tracker events", async () => {
    const e = await qa((tx) => createExperiment(tx, A.actor, { name: "Tracked", hypothesis: "Variant converts better.", primaryMetric: "Signups", productId: productA, metricKey: "SIGNUP" }));
    expect(e.metricKey).toBe("SIGNUP_COMPLETED");
    const ev = (visitorId: string, variant: string, type: "PAGE_VIEW" | "SIGNUP" | "SIGNUP_COMPLETED", experiment = e.id) => ({ organizationId: A.org.id, productId: productA, type, visitorId, properties: { experiment, variant } });
    await qa((tx) =>
      tx.insert(conversionEvents).values([
        ev("v1", "control", "PAGE_VIEW"),
        ev("v1", "control", "PAGE_VIEW"),
        ev("v2", "control", "PAGE_VIEW"),
        ev("v2", "control", "SIGNUP"),
        ev("v3", "Variant", "PAGE_VIEW"),
        ev("v3", "variant", "SIGNUP_COMPLETED"),
        ev("v4", "variant", "PAGE_VIEW"),
        ev("v4", "variant", "SIGNUP_COMPLETED"),
        ev("v5", "variant", "PAGE_VIEW", "another-experiment"),
      ]),
    );
    const r = await qa((tx) => refreshExperimentCounts(tx, A.actor, e.id));
    expect(r).toMatchObject({ controlN: 2, controlConversions: 1, variantN: 2, variantConversions: 2, countsSource: "TRACKER", winner: "INCONCLUSIVE", testMethod: "FISHER_EXACT" });
  });

  it("keeps the experiment tags of consent-denied events", () => {
    expect(experimentTags({ experiment: "abc", variant: " Variant ", email: "x" })).toEqual({ experiment: "abc", variant: "variant" });
    expect(experimentTags({ experiment: "abc" })).toEqual({});
    expect(experimentTags(undefined)).toEqual({});
  });
});

describe("distribution", () => {
  it("seeds only fitting catalogue venues, with relevance, reason, category and requirements", async () => {
    const { product } = await seedCompleteProduct(A.org.id, { name: `Seed ${uid()}` });
    const n = await qa((tx) => seedDistributionTargets(tx, A.org.id, product.id));
    const rows = await qa((tx) => tx.select().from(distributionTargets).where(eq(distributionTargets.productId, product.id)));
    expect(rows).toHaveLength(n);
    expect(n).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.relevance).toBeGreaterThanOrEqual(50);
      expect(r.relevanceReason).toBeTruthy();
      expect(r.category).toBeTruthy();
      expect(r.requirements).toBeTruthy();
      expect(r.status).toBe("DISCOVERED");
    }
    expect(rows.map((r) => r.catalogKey)).not.toContain("zapier");
    expect(await qa((tx) => seedDistributionTargets(tx, A.org.id, product.id))).toBe(0);
  });

  it("enforces transitions; approval needs PREPARED and an approved listing; it resets when the listing changes or the target goes back", async () => {
    const t = await qa((tx) => addDistributionTarget(tx, A.actor, { name: `Directory ${uid()}`, kind: "DIRECTORY", url: "https://directory.example", productId: productA, relevance: 70 }));
    expect(t.category).toBe("SOFTWARE_DIRECTORY");
    await expect(qa((tx) => setDistributionStatus(tx, A.actor, t.id, "PREPARED"))).rejects.toThrow(/cannot move/);
    await expect(qa((tx) => approveSubmission(tx, A.actor, t.id))).rejects.toThrow(/PREPARED/);
    await qa((tx) => setDistributionStatus(tx, A.actor, t.id, "QUALIFIED"));
    const prep = await qa((tx) => prepareSubmission(tx, A.actor, t.id));
    expect(prep.created).toBe(true);
    expect(prep.asset).toMatchObject({ type: "DIRECTORY_DESCRIPTION", status: "IDEA" });
    const prepared = (await qa((tx) => tx.query.distributionTargets.findFirst({ where: eq(distributionTargets.id, t.id) })))!;
    expect(prepared.status).toBe("PREPARED");
    expect(prepared.utmCampaign).toMatch(/^dist-directory-/);
    expect(prepared.contentAssetId).toBe(prep.asset.id);
    const camp = await qa((tx) => tx.query.campaigns.findFirst({ where: eq(campaigns.id, prepared.campaignId!) }));
    expect(camp).toMatchObject({ utmCampaign: prepared.utmCampaign, utmMedium: "directory" });
    await expect(qa((tx) => approveSubmission(tx, A.actor, t.id))).rejects.toThrow(/approved in the Content studio/);
    await expect(qa((tx) => setDistributionStatus(tx, A.actor, t.id, "SUBMITTED"))).rejects.toThrow(/approve/);

    // A person approves the listing (simulated), then the submission.
    const [v] = await qa((tx) => tx.insert(contentVersions).values({ organizationId: A.org.id, assetId: prep.asset.id, version: 1, body: "Listing copy." }).returning());
    await qa((tx) => tx.update(contentAssets).set({ status: "APPROVED", approvedVersionId: v.id, currentVersion: 1 }).where(eq(contentAssets.id, prep.asset.id)));
    await qa((tx) => approveSubmission(tx, A.actor, t.id));
    expect((await qa((tx) => tx.query.distributionTargets.findFirst({ where: eq(distributionTargets.id, t.id) }))))!.toMatchObject({ approvedAssetId: prep.asset.id, approvedVersionId: v.id });

    // The listing is edited after approval: the approval no longer applies.
    await qa((tx) => tx.update(contentAssets).set({ status: "GENERATED" }).where(eq(contentAssets.id, prep.asset.id)));
    await expect(qa((tx) => setDistributionStatus(tx, A.actor, t.id, "SUBMITTED"))).rejects.toThrow(/listing changed/);
    await qa((tx) => tx.update(contentAssets).set({ status: "APPROVED" }).where(eq(contentAssets.id, prep.asset.id)));
    await qa((tx) => setDistributionStatus(tx, A.actor, t.id, "SUBMITTED"));

    // Going back resets the approval.
    const t2 = await qa((tx) => addDistributionTarget(tx, A.actor, { name: `Back ${uid()}`, kind: "COMMUNITY", url: null, productId: productA }));
    await qa((tx) => setDistributionStatus(tx, A.actor, t2.id, "QUALIFIED"));
    await qa((tx) => setDistributionStatus(tx, A.actor, t2.id, "PREPARED"));
    await qa((tx) => tx.update(distributionTargets).set({ contentAssetId: prep.asset.id }).where(eq(distributionTargets.id, t2.id)));
    await qa((tx) => approveSubmission(tx, A.actor, t2.id));
    await qa((tx) => setDistributionStatus(tx, A.actor, t2.id, "QUALIFIED"));
    expect((await qa((tx) => tx.query.distributionTargets.findFirst({ where: eq(distributionTargets.id, t2.id) }))))!.toMatchObject({ submissionApprovedAt: null, approvedAssetId: null, approvedVersionId: null, lastAction: "Moved to QUALIFIED" });
    const logs = await qa((tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, t2.id), eq(auditLogs.action, "distribution.status"))));
    expect(logs.some((l) => (l.metadata as { approvalReset?: boolean }).approvalReset)).toBe(true);
  });

  it("measures traffic and conversions by the target's UTM campaign (Not connected / No data yet otherwise)", async () => {
    const { product } = await seedCompleteProduct(A.org.id, { name: `Utm ${uid()}`, domain: "utm.example" });
    const t = await qa((tx) => addDistributionTarget(tx, A.actor, { name: `Venue ${uid()}`, kind: "DIRECTORY", url: null, productId: product.id }));
    await qa((tx) => setDistributionStatus(tx, A.actor, t.id, "QUALIFIED"));
    await qa((tx) => setDistributionStatus(tx, A.actor, t.id, "PREPARED"));
    const row = (await qa((tx) => tx.query.distributionTargets.findFirst({ where: eq(distributionTargets.id, t.id) })))!;
    expect((await qa((tx) => measureTargets(tx, A.org.id, [row]))).get(t.id)).toEqual({ state: "NOT_CONNECTED", visits: null, conversions: null });
    await createKey(A.org.id, "PUBLISHABLE", { productId: product.id });
    expect((await qa((tx) => measureTargets(tx, A.org.id, [row]))).get(t.id)!.state).toBe("NO_DATA_YET");
    const [touch] = await qa((tx) =>
      tx.insert(attributionEvents).values({ organizationId: A.org.id, productId: product.id, visitorId: "vis-utm-1", channel: "REFERRAL", utm: { source: "venue", medium: "directory", campaign: row.utmCampaign! } }).returning(),
    );
    await qa((tx) => tx.insert(attributionEvents).values({ organizationId: A.org.id, productId: product.id, visitorId: "vis-utm-2", channel: "REFERRAL", utm: { campaign: row.utmCampaign!.toUpperCase() } }));
    await qa((tx) => tx.insert(attributionEvents).values({ organizationId: A.org.id, productId: product.id, visitorId: "vis-utm-3", channel: "REFERRAL", utm: { campaign: "other" } }));
    await qa((tx) => tx.insert(conversionEvents).values({ organizationId: A.org.id, productId: product.id, type: "SIGNUP_COMPLETED", visitorId: "vis-utm-1", attributionTouchId: touch.id }));
    await qa((tx) => tx.insert(conversionEvents).values({ organizationId: A.org.id, productId: product.id, type: "PAGE_VIEW", visitorId: "vis-utm-1", attributionTouchId: touch.id }));
    expect((await qa((tx) => measureTargets(tx, A.org.id, [row]))).get(t.id)).toEqual({ state: "OK", visits: 2, conversions: 1 });
  });
});

describe("content export", () => {
  it("exports approved content only, as a ZIP or Markdown", async () => {
    const [asset] = await qa((tx) => tx.insert(contentAssets).values({ organizationId: A.org.id, productId: productA, type: "ARTICLE", title: "Export me", status: "GENERATED" }).returning());
    const [v] = await qa((tx) => tx.insert(contentVersions).values({ organizationId: A.org.id, assetId: asset.id, version: 1, body: "# Export me\n\nBody.", metaTitle: "Export me | A", structuredData: [{ "@context": "https://schema.org", "@type": "Article" }] }).returning());
    await expect(qa((tx) => exportApprovedAsset(tx, A.actor, asset.id, "zip"))).rejects.toThrow(/approved or published/);
    await qa((tx) => tx.update(contentAssets).set({ status: "APPROVED", approvedVersionId: v.id, approvedAt: new Date() }).where(eq(contentAssets.id, asset.id)));
    const zip = await qa((tx) => exportApprovedAsset(tx, A.actor, asset.id, "zip"));
    expect(zip.contentType).toBe("application/zip");
    expect(zip.filename).toMatch(/export-me-v1\.zip$/);
    expect(Buffer.from(zip.body).subarray(0, 2).toString()).toBe("PK");
    const md = await qa((tx) => exportApprovedAsset(tx, A.actor, asset.id, "md"));
    const text = new TextDecoder().decode(md.body);
    expect(text).toContain('title: "Export me | A"');
    expect(text).toContain('"@type": "Article"');
    await expect(qb((tx) => exportApprovedAsset(tx, B.actor, asset.id, "md"))).rejects.toThrow(/not found/);
  });
});

describe("tenant isolation of the new data", () => {
  it("autopilot_learning, recommendations and experiments are invisible across organisations", async () => {
    await qb((tx) => tx.insert(autopilotLearning).values({ organizationId: B.org.id, opportunityType: "CONTENT_GAP", improved: 5 }));
    const seenByA = await qa((tx) => tx.select().from(autopilotLearning));
    expect(seenByA.every((r) => r.organizationId === A.org.id)).toBe(true);
    expect((await qa((tx) => learningTallies(tx, B.org.id))).CONTENT_GAP).toBeUndefined();
    await expect(qa((tx) => tx.insert(autopilotLearning).values({ organizationId: B.org.id, opportunityType: "X" }))).rejects.toThrow();
    const recsSeenByA = await qa((tx) => tx.select().from(recommendations));
    expect(recsSeenByA.every((r) => r.organizationId === A.org.id)).toBe(true);
    const e = await qb((tx) => createExperiment(tx, B.actor, { name: "B only", hypothesis: "Private to B.", primaryMetric: "x" }));
    await expect(qa((tx) => setExperimentStatus(tx, A.actor, e.id, "ABANDONED"))).rejects.toThrow(/not found/);
    await expect(qa((tx) => enterExperimentCounts(tx, A.actor, e.id, null))).rejects.toThrow(/not found/);
    const t = await qb((tx) => addDistributionTarget(tx, B.actor, { name: "B target", kind: "DIRECTORY", url: null, productId: productB }));
    await expect(qa((tx) => setDistributionStatus(tx, A.actor, t.id, "QUALIFIED"))).rejects.toThrow(/Not found/);
    await expect(qa((tx) => prepareSubmission(tx, A.actor, t.id))).rejects.toThrow(/Not found/);
  });
});
