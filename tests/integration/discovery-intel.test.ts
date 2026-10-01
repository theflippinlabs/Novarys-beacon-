import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import {
  aiCitations,
  aiMentions,
  aiVisibilityPrompts,
  aiVisibilityTests,
  competitors,
  contentAssets,
  crawledPages,
  integrations,
  opportunities,
  queries,
  queryClusters,
  searchDaily,
  seoAudits,
  visibilityMetrics,
} from "@/db/schema";
import type { LlmProvider } from "@/ai/types";
import { addQuery, generateQueryUniverse, importSearchQueries, reclusterProduct, searchDemand } from "@/services/queries";
import { recomputeCoverage } from "@/services/discovery";
import { aiVisibilityTrend, citationDomains, competitorIntel, runPromptTests, setCompetitorAliases, testDetail } from "@/services/ai-visibility";
import { queryMetrics, upsertOpportunities } from "@/services/opportunities";
import { contentGapsForProduct, draftFromGap, opportunityFromGap } from "@/services/content-gaps";
import { generateOpportunities } from "@/core/opportunities/engine";
import { isoDay, addDays } from "@/core/util/text";
import type { Actor } from "@/lib/audit";
import { newOrg, pgError, seedCompleteProduct, uid } from "./helpers";

let orgId: string;
let actor: Actor;
let productA: { id: string; name: string; domain: string | null; slug: string };
let productB: { id: string; name: string; domain: string | null; slug: string };
let competitorId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);
const day = (n: number) => isoDay(addDays(new Date(), -n));

beforeAll(async () => {
  const o = await newOrg("intel");
  orgId = o.org.id;
  actor = o.actor;
  const a = await seedCompleteProduct(orgId, { name: "Beacon Live", slug: `beacon-live-${uid()}`, competitorName: "ModBot" });
  productA = a.product;
  competitorId = a.competitor.id;
  productB = (await seedCompleteProduct(orgId, { name: `Second Product ${uid()}`, competitorName: `Other Rival ${uid()}` })).product;
});
afterAll(closeDb);

async function searchIntegration(productId: string) {
  const [i] = await q((tx) => tx.insert(integrations).values({ organizationId: orgId, productId, provider: "GOOGLE_SEARCH_CONSOLE", status: "CONNECTED", config: { siteUrl: "sc-domain:example" } }).returning());
  return i;
}

describe("query universe", () => {
  it("keeps the same query for several products (product-scoped uniqueness) and is idempotent per product", async () => {
    const a = await q((tx) => addQuery(tx, orgId, { query: "live chat moderation", productId: productA.id }));
    const b = await q((tx) => addQuery(tx, orgId, { query: "Live chat moderation?", productId: productB.id }));
    const eco = await q((tx) => addQuery(tx, orgId, { query: "live chat moderation", productId: null }));
    expect(a && b && eco).toBeTruthy();
    expect(new Set([a!.id, b!.id, eco!.id]).size).toBe(3);
    expect(await q((tx) => addQuery(tx, orgId, { query: "LIVE chat moderation", productId: productA.id }))).toBeNull();
    expect(await q((tx) => addQuery(tx, orgId, { query: "live chat moderation", productId: null }))).toBeNull();
  });

  it("generates the universe in batches with branded flags, topic types and semantic clusters", async () => {
    const res = await q((tx) => generateQueryUniverse(tx, orgId, productB.id));
    expect(res.inserted).toBeGreaterThan(5);
    expect(res.clusters).toBeGreaterThan(0);
    expect(res.clusters).toBeLessThan(res.candidates + 2);
    const rows = await q((tx) => tx.select().from(queries).where(eq(queries.productId, productB.id)));
    const brand = rows.find((r) => r.normalized === productB.name.toLowerCase())!;
    expect(brand).toMatchObject({ branded: true, topicType: "BRAND", status: "CANDIDATE", source: "GENERATED" });
    expect(brand.classification.source).toBe("generation");
    expect(rows.some((r) => !r.branded && r.topicType === "FEATURE")).toBe(true);
    expect(rows.filter((r) => r.clusterId).length).toBe(rows.length);
    const clusters = await q((tx) => tx.select().from(queryClusters).where(and(eq(queryClusters.productId, productB.id), eq(queryClusters.origin, "SEMANTIC"))));
    expect(clusters.length).toBe(res.clusters);
    expect(clusters.every((c) => c.recommendedAsset && c.intent)).toBe(true);
    // Re-clustering is stable.
    const again = await q((tx) => reclusterProduct(tx, orgId, productB.id));
    expect(again).toEqual({ clusters: res.clusters, removed: 0 });
  });

  it("manual clusters are kept by semantic clustering", async () => {
    const row = await q((tx) => addQuery(tx, orgId, { query: "moderation for esports tournaments", productId: productA.id, clusterName: "Esports" }));
    await q((tx) => reclusterProduct(tx, orgId, productA.id));
    const after = await q((tx) => tx.query.queries.findFirst({ where: eq(queries.id, row!.id) }));
    const cluster = await q((tx) => tx.query.queryClusters.findFirst({ where: eq(queryClusters.id, after!.clusterId!) }));
    expect(cluster).toMatchObject({ name: "Esports", origin: "MANUAL" });
  });
});

describe("coverage from crawled pages and search data", () => {
  it("covers a query from the latest crawl (title/H1) and from search query-page pairs, storing URL and reason", async () => {
    const crawled = await q((tx) => addQuery(tx, orgId, { query: "keyword filters", productId: productA.id, status: "ACTIVE" }));
    const searched = await q((tx) => addQuery(tx, orgId, { query: "tiktok spam blocker", productId: productA.id, status: "ACTIVE" }));
    const none = await q((tx) => addQuery(tx, orgId, { query: "quantum invoicing ledger", productId: productA.id, status: "ACTIVE" }));
    await q(async (tx) => {
      const [audit] = await tx.insert(seoAudits).values({ organizationId: orgId, productId: productA.id, status: "SUCCEEDED", startUrl: `https://${productA.domain}/` }).returning();
      await tx.insert(crawledPages).values({ organizationId: orgId, auditId: audit.id, url: `https://${productA.domain}/features`, status: 200, title: "Features", h1: ["Keyword filters for TikTok live"] });
    });
    const integ = await searchIntegration(productA.id);
    await q((tx) =>
      tx.insert(searchDaily).values([
        { organizationId: orgId, productId: productA.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(3), query: "tiktok spam blocker", page: `https://${productA.domain}/blog/spam`, clicks: 1, impressions: 30, ctr: 0.03, position: 24 },
        { organizationId: orgId, productId: productA.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(2), query: "tiktok spam blocker", page: `https://${productA.domain}/blog/spam`, clicks: 0, impressions: 20, ctr: 0, position: 14 },
      ]),
    );
    await q((tx) => recomputeCoverage(tx, orgId, productA.id));
    const get = (id: string) => q((tx) => tx.query.queries.findFirst({ where: eq(queries.id, id) }));
    expect(await get(crawled!.id)).toMatchObject({ coverage: "COVERED", coveredByUrl: `https://${productA.domain}/features` });
    expect((await get(crawled!.id))!.coverageReason).toMatch(/title or H1/);
    const s = (await get(searched!.id))!;
    expect(s).toMatchObject({ coverage: "PARTIAL", coveredByUrl: `https://${productA.domain}/blog/spam` });
    // 50 impressions, impressions-weighted position (30 × 24 + 20 × 14) / 50 = 20.
    expect(s.coverageReason).toBe("Search data: 50 impressions but average position 20.0");
    expect(await get(none!.id)).toMatchObject({ coverage: "NONE", coveredByUrl: null });
  });

  it("imports measured search queries above the threshold as SEARCH_CONSOLE candidates", async () => {
    const integ = await q((tx) => tx.query.integrations.findFirst({ where: and(eq(integrations.organizationId, orgId), eq(integrations.productId, productA.id)) }));
    await q((tx) =>
      tx.insert(searchDaily).values([
        { organizationId: orgId, productId: productA.id, integrationId: integ!.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(4), query: "best live chat filter app", page: `https://${productA.domain}/`, clicks: 2, impressions: 140, ctr: 0.01, position: 31 },
        { organizationId: orgId, productId: productA.id, integrationId: integ!.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(4), query: "rare long tail query", page: `https://${productA.domain}/`, clicks: 0, impressions: 3, ctr: 0, position: 50 },
      ]),
    );
    const res = await q((tx) => importSearchQueries(tx, orgId, productA.id, { minImpressions: 20 }));
    // "tiktok spam blocker" (50 impressions) already exists as a manual query; "rare long tail query" (3) is below the threshold.
    expect(res).toMatchObject({ connected: true, considered: 2, inserted: 1 });
    const rows = await q((tx) => tx.select().from(queries).where(and(eq(queries.productId, productA.id), eq(queries.source, "SEARCH_CONSOLE"))));
    expect(rows.map((r) => r.normalized)).toEqual(["best live chat filter app"]);
    expect(rows[0]).toMatchObject({ status: "CANDIDATE", importance: 3, branded: false });
    expect(rows[0].classification.source).toBe("search_import");
    expect(rows[0].clusterId).not.toBeNull();
    expect(rows.some((r) => r.normalized === "rare long tail query")).toBe(false);
    // Importing again inserts nothing.
    expect((await q((tx) => importSearchQueries(tx, orgId, productA.id))).inserted).toBe(0);
  });

  it("never inflates metrics with overlapping snapshots; daily rows add up with a weighted position", async () => {
    // Legacy visibility_metrics: a 28-day aggregate re-stored on two days. Only the latest counts.
    const c = await seedCompleteProduct(orgId, { name: `Legacy ${uid()}` });
    await q((tx) =>
      tx.insert(visibilityMetrics).values([
        { organizationId: orgId, productId: c.product.id, provider: "gsc", metric: "query_impressions", day: day(2), dimension: "legacy query", value: 100 },
        { organizationId: orgId, productId: c.product.id, provider: "gsc", metric: "query_impressions", day: day(1), dimension: "legacy query", value: 110 },
        { organizationId: orgId, productId: c.product.id, provider: "gsc", metric: "query_clicks", day: day(2), dimension: "legacy query", value: 5 },
        { organizationId: orgId, productId: c.product.id, provider: "gsc", metric: "query_clicks", day: day(1), dimension: "legacy query", value: 6 },
        { organizationId: orgId, productId: c.product.id, provider: "gsc", metric: "query_position", day: day(1), dimension: "legacy query", value: 9.5 },
      ]),
    );
    const legacy = await q((tx) => queryMetrics(tx, orgId, c.product.id));
    expect(legacy.source).toBe("visibility_metrics");
    expect(legacy.byQuery.get("legacy query")).toEqual({ impressions: 110, clicks: 6, position: 9.5 });
    // search_daily: daily rows sum, position weighted by impressions; country/device splits are not double counted.
    const integ = await searchIntegration(c.product.id);
    await q((tx) =>
      tx.insert(searchDaily).values([
        { organizationId: orgId, productId: c.product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(2), query: "daily query", page: "https://x.example/a", clicks: 10, impressions: 100, ctr: 0.1, position: 10 },
        { organizationId: orgId, productId: c.product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), query: "daily query", page: "https://x.example/a", clicks: 30, impressions: 300, ctr: 0.1, position: 2 },
        { organizationId: orgId, productId: c.product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), query: "daily query", page: "https://x.example/a", country: "fra", clicks: 30, impressions: 300, ctr: 0.1, position: 2 },
      ]),
    );
    // Query-grain rows (page null) are the provider's per-query totals (latestQueryMetrics); query x page rows are not added on top.
    await q((tx) =>
      tx.insert(searchDaily).values([
        { organizationId: orgId, productId: c.product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(2), query: "grain query", clicks: 5, impressions: 50, ctr: 0.1, position: 8 },
        { organizationId: orgId, productId: c.product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), query: "grain query", clicks: 15, impressions: 150, ctr: 0.1, position: 4 },
        { organizationId: orgId, productId: c.product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), query: "grain query", page: "https://x.example/g", clicks: 20, impressions: 200, ctr: 0.1, position: 5 },
      ]),
    );
    const m = await q((tx) => queryMetrics(tx, orgId, c.product.id));
    expect(m.source).toBe("search_daily");
    expect(m.byQuery.get("daily query")).toEqual({ impressions: 400, clicks: 40, position: 4 });
    expect(m.byQuery.get("grain query")).toEqual({ impressions: 200, clicks: 20, position: 5 });
    const d = await q((tx) => searchDemand(tx, orgId, c.product.id));
    expect(d.byQuery.get("daily query")!.pages).toEqual([{ page: "https://x.example/a", impressions: 400, clicks: 40, position: 4 }]);
  });
});

describe("AI visibility lab and citations", () => {
  const provider = (answer: LlmProvider["answer"], id: LlmProvider["id"] = "perplexity"): LlmProvider => ({ id, label: id, model: "configured-model", answer });
  let testId: string;

  it("stores prompt snapshot, served model, grounding, mention snippets and classified citations", async () => {
    await q((tx) => tx.update(competitors).set({ domain: "modbot.io" }).where(eq(competitors.id, competitorId)));
    const [prompt] = await q((tx) => tx.insert(aiVisibilityPrompts).values({ organizationId: orgId, productId: productA.id, prompt: "Best tool for TikTok live moderation?", locale: "en" }).returning());
    const pad = " Some neutral filler text about moderation workflows.".repeat(8);
    const text = `ModBot is popular [1].${pad} Beacon Live also filters spam [2].${pad} Reviews: [3].${pad} Docs at https://${productA.domain}/docs`;
    const res = await runPromptTests(q, orgId, prompt.id, [
      provider(async () => ({
        text,
        citations: ["https://modbot.io/", "https://reviews.example/tiktok-moderation", "https://www.g2.com/categories/moderation"],
        servedModel: "sonar-pro-2026",
        grounded: true,
        params: { webSearch: "built-in" },
        citationDetails: [{ url: "https://www.g2.com/categories/moderation", title: "G2", offsets: [] }],
      })),
    ]);
    expect(res).toEqual([{ provider: "perplexity", ok: true, mentioned: true }]);
    const [t] = await q((tx) => tx.select().from(aiVisibilityTests).where(eq(aiVisibilityTests.promptId, prompt.id)));
    testId = t.id;
    expect(t).toMatchObject({ promptText: prompt.prompt, servedModel: "sonar-pro-2026", model: "configured-model", grounded: true, locale: "en", params: { webSearch: "built-in" } });
    expect(t.productsMentioned[0]).toMatchObject({ productId: productA.id, position: 2, offset: text.indexOf("Beacon Live") });
    expect(t.productsMentioned[0].snippet).toContain("Beacon Live also filters spam");
    const [m] = await q((tx) => tx.select().from(aiMentions).where(eq(aiMentions.testId, t.id)));
    expect(m).toMatchObject({ mentionOffset: text.indexOf("Beacon Live"), engine: "perplexity:sonar-pro-2026" });
    expect(m.snippet).toContain("Beacon Live");
    const cites = await q((tx) => tx.select().from(aiCitations).where(eq(aiCitations.testId, t.id)).orderBy(aiCitations.position));
    expect(cites.map((c) => [c.registrableDomain, c.kind, c.category])).toEqual([
      ["modbot.io", "COMPETITOR", "OFFICIAL_SITE"],
      ["reviews.example", "THIRD_PARTY", "OTHER"],
      ["g2.com", "THIRD_PARTY", "REVIEW_SITE"],
      [productA.domain, "OWN", "DOCUMENTATION"],
    ]);
    expect(cites[0]).toMatchObject({ competitorId, productId: productA.id, nearCompetitorIds: [competitorId] });
    expect(cites[1].nearProductIds).toEqual([productA.id]);
    expect(cites[2].title).toBe("G2");
    const detail = await q((tx) => testDetail(tx, orgId, t.id));
    expect(detail!.citations).toHaveLength(4);
  });

  it("aggregates citation domains (cited in X of Y samples) with product and competitor association", async () => {
    const [prompt] = await q((tx) => tx.insert(aiVisibilityPrompts).values({ organizationId: orgId, productId: productA.id, prompt: "Which TikTok live moderation app is best?" }).returning());
    await runPromptTests(q, orgId, prompt.id, [provider(async () => ({ text: "Try ModBot [1].", citations: ["https://www.g2.com/compare/x"] }))]);
    const rows = await q((tx) => citationDomains(tx, orgId, { productId: productA.id }));
    const g2 = rows.find((r) => r.domain === "g2.com")!;
    expect(g2).toMatchObject({ samplesCiting: 2, samplesTotal: 2, category: "REVIEW_SITE", productAppears: false, kind: "THIRD_PARTY" });
    expect(g2.prompts).toHaveLength(2);
    expect(rows.find((r) => r.domain === "reviews.example")!.productAppears).toBe(true);
    expect(rows.find((r) => r.domain === productA.domain)).toMatchObject({ kind: "OWN", productAppears: true });
    expect(rows.find((r) => r.domain === "modbot.io")!.competitors).toEqual(["ModBot"]);
    // Another product's view sees none of these samples.
    expect(await q((tx) => citationDomains(tx, orgId, { productId: productB.id }))).toEqual([]);
  });

  it("filters the trend by product (P0): tests of other products' prompts are not counted", async () => {
    const [pb] = await q((tx) => tx.insert(aiVisibilityPrompts).values({ organizationId: orgId, productId: productB.id, prompt: "Unrelated question for product B" }).returning());
    await runPromptTests(q, orgId, pb.id, [provider(async () => ({ text: "Nothing relevant.", citations: [] }))]);
    const a = await q((tx) => aiVisibilityTrend(tx, orgId, 12, productA.id));
    const b = await q((tx) => aiVisibilityTrend(tx, orgId, 12, productB.id));
    const all = await q((tx) => aiVisibilityTrend(tx, orgId, 12));
    const sum = (rows: { tests: number }[]) => rows.reduce((s, r) => s + r.tests, 0);
    expect(sum(a)).toBe(2);
    expect(sum(b)).toBe(1);
    expect(sum(all)).toBe(3);
    expect(a.reduce((s, r) => s + r.mentioned, 0)).toBe(1);
  });

  it("competitor intelligence reports observed facts and where the competitor appears without the product", async () => {
    const intel = await q((tx) => competitorIntel(tx, orgId, { productId: productA.id }));
    const mod = intel.find((c) => c.competitor.id === competitorId)!;
    expect(mod).toMatchObject({ samplesMentioning: 2, samplesTotal: 2, ownDomainCitedIn: 1 });
    expect(mod.comparisonFacts).toEqual([{ productName: "Beacon Live", sourced: 3 }]);
    expect(mod.gaps.map((g) => g.prompt)).toEqual(["Which TikTok live moderation app is best?"]);
    expect(await q((tx) => setCompetitorAliases(tx, actor, competitorId, [" Mod Bot ", "ModBot", "x"]))).toEqual(["Mod Bot", "ModBot"]);
  });

  it("ai_citations is tenant-isolated", async () => {
    const other = await newOrg("intel-other");
    const seen = await withOrg(other.org.id, (tx) => tx.select().from(aiCitations).where(eq(aiCitations.testId, testId)));
    expect(seen).toEqual([]);
    const err = await pgError(
      withOrg(other.org.id, (tx) =>
        tx.insert(aiCitations).values({ organizationId: orgId, testId, url: "https://x.example/", host: "x.example", registrableDomain: "x.example", kind: "THIRD_PARTY", category: "OTHER", position: 1 }),
      ),
    );
    expect(err.code).toBe("42501");
    expect(await withOrg(other.org.id, (tx) => citationDomains(tx, other.org.id))).toEqual([]);
  });
});

describe("content gaps and opportunity engine v2", () => {
  it("derives gaps from active queries and creates an opportunity and a draft from a gap", async () => {
    await q((tx) => tx.update(queries).set({ status: "ACTIVE", importance: 5 }).where(and(eq(queries.productId, productA.id), eq(queries.normalized, "quantum invoicing ledger"))));
    await q((tx) => reclusterProduct(tx, orgId, productA.id));
    await q((tx) => recomputeCoverage(tx, orgId, productA.id));
    const gaps = await q((tx) => contentGapsForProduct(tx, orgId, productA.id));
    const gap = gaps.find((g) => g.clusterName === "quantum invoicing ledger")!;
    expect(gap).toMatchObject({ coverage: { status: "NONE" }, demand: { status: "MEASURED" }, relevance: { level: "HIGH" } });
    expect(gap.reasons).toContain("UNCOVERED_RELEVANT");
    const { opportunity } = await q((tx) => opportunityFromGap(tx, actor, productA.id, gap.clusterId));
    expect(opportunity).toMatchObject({ type: "CONTENT_GAP", category: "CONTENT", fingerprint: `content_gap:cluster:${gap.clusterId}`, status: "OPEN" });
    expect(Object.keys(opportunity.scoringRationale).sort()).toEqual(["confidence", "effort", "impact", "urgency"]);
    expect(opportunity.nextAction?.href).toContain(`#gap-${gap.clusterId}`);
    const { asset, opportunity: same } = await q((tx) => draftFromGap(tx, actor, productA.id, gap.clusterId));
    expect(same.id).toBe(opportunity.id);
    const a = await q((tx) => tx.query.contentAssets.findFirst({ where: eq(contentAssets.id, asset.id) }));
    expect(a).toMatchObject({ productId: productA.id, type: "LANDING_PAGE", status: "IDEA" });
  });

  it("marks vanished opportunities OBSOLETE and reopens them when the fingerprint recurs (batched upsert)", async () => {
    const base = generateOpportunities({
      product: { id: productB.id, name: productB.name, slug: productB.slug },
      queries: [],
      aiGaps: [],
      seoIssues: [
        { rule: "rule.a", severity: "HIGH", count: 1, exampleUrl: "https://b/1" },
        { rule: "rule.b", severity: "HIGH", count: 1, exampleUrl: "https://b/2" },
        { rule: "rule.c", severity: "HIGH", count: 1, exampleUrl: "https://b/3" },
      ],
      missingEntity: [],
      competitorsWithoutComparison: [],
      orphanPages: [],
      lowConversionPages: [],
    });
    expect(await q((tx) => upsertOpportunities(tx, orgId, productB.id, base))).toEqual({ created: 3, reopened: 0, resolved: 0 });
    const byFp = async (fp: string) => (await q((tx) => tx.query.opportunities.findFirst({ where: and(eq(opportunities.organizationId, orgId), eq(opportunities.fingerprint, fp)) })))!;
    await q((tx) => tx.update(opportunities).set({ status: "DISMISSED" }).where(eq(opportunities.fingerprint, `tech:${productB.id}:rule.c`)));
    expect(await q((tx) => upsertOpportunities(tx, orgId, productB.id, base.slice(0, 1)))).toEqual({ created: 0, reopened: 0, resolved: 1 });
    const b = await byFp(`tech:${productB.id}:rule.b`);
    expect(b.status).toBe("OBSOLETE");
    expect(b.obsoletedAt).not.toBeNull();
    expect((await byFp(`tech:${productB.id}:rule.c`)).status).toBe("DISMISSED");
    expect(await q((tx) => upsertOpportunities(tx, orgId, productB.id, base))).toEqual({ created: 0, reopened: 1, resolved: 0 });
    expect(await byFp(`tech:${productB.id}:rule.b`)).toMatchObject({ status: "OPEN", obsoletedAt: null });
    expect((await byFp(`tech:${productB.id}:rule.c`)).status).toBe("DISMISSED");
    expect((await byFp(`tech:${productB.id}:rule.a`)).scoringRationale.confidence).toBe("Measured by the latest crawl.");
  });
});
