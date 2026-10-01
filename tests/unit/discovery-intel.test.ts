import { describe, expect, it } from "vitest";
import { classifyQueryFull, classifyTopic, type TopicContext } from "@/core/queries/classify";
import { assetContentType, clusterQueries, recommendAsset, type ClusterInput } from "@/core/queries/cluster";
import { assessQueryCoverage, clusterCoverage } from "@/core/queries/coverage";
import { lemma, topicTerms } from "@/core/queries/terms";
import { deriveContentGaps, promptMatchesCluster, type GapClusterInput, type GapInput } from "@/core/content/gaps";
import { citationOffsets, classifyCitation, entitiesNear, registrableDomain } from "@/core/visibility/citations";
import { generateOpportunities, priority, type OpportunitySignals } from "@/core/opportunities/engine";
import { parseChatCompletion } from "@/ai/providers/openai-compatible";

const CTX: TopicContext = {
  brandTerms: ["Acme Live", "Novarys"],
  competitors: ["ModBot"],
  facets: [
    { kind: "FEATURE", name: "Keyword filters" },
    { kind: "AUDIENCE", name: "TikTok agencies" },
    { kind: "INTEGRATION", name: "Twitch" },
    { kind: "PROBLEM", name: "Spam in live chat" },
  ],
};

describe("query classification: branded flag and topic type", () => {
  it("flags branded queries and explains the topic type", () => {
    const b = classifyQueryFull("acme live pricing", CTX);
    expect(b).toMatchObject({ branded: true, brandTerm: "Acme Live", topicType: "BRAND", intent: "TRANSACTIONAL" });
    const n = classifyQueryFull("keyword filters for live chat", CTX);
    expect(n.branded).toBe(false);
    expect(n.topicType).toBe("FEATURE");
    expect(n.topicSignals).toEqual(["facet:feature:keyword filters"]);
  });

  it("competitor names win over brand terms, facets over patterns, CATEGORY as fallback", () => {
    expect(classifyTopic("acme live vs modbot", CTX).topicType).toBe("COMPETITOR");
    expect(classifyTopic("moderation for tiktok agencies", CTX).topicType).toBe("AUDIENCE");
    expect(classifyTopic("twitch moderation bot", CTX).topicType).toBe("INTEGRATION");
    expect(classifyTopic("zapier moderation integration", CTX).topicType).toBe("INTEGRATION");
    expect(classifyTopic("how to stop raids", CTX, "PROBLEM").topicType).toBe("PROBLEM");
    expect(classifyTopic("live moderation software", CTX)).toEqual({ topicType: "CATEGORY", signals: ["fallback:category"] });
    // Whole-word brand matching: "acme lively" is not branded.
    expect(classifyQueryFull("acme lively", CTX).branded).toBe(false);
  });
});

describe("semantic clustering", () => {
  const q = (id: string, query: string, over: Partial<ClusterInput> = {}): ClusterInput => ({ id, query, intent: "COMMERCIAL", importance: 3, ...over });

  it("lemmatises and drops intent modifiers from topic terms", () => {
    expect(lemma("filters")).toBe("filter");
    expect(lemma("agencies")).toBe("agency");
    expect(lemma("status")).toBe("status");
    expect(topicTerms("Best TikTok live moderation tools 2026")).toEqual(["tiktok", "live", "moderation"]);
  });

  it("groups queries sharing topic terms into one cluster with one recommended asset", () => {
    const out = clusterQueries([
      q("a", "tiktok live moderation", { importance: 5 }),
      q("b", "best tiktok live moderation tools"),
      q("c", "tiktok live moderation software pricing", { intent: "TRANSACTIONAL" }),
      q("d", "keyword filters for streams"),
      q("e", "how to filter keywords in streams", { intent: "INFORMATIONAL" }),
    ]);
    const main = out.find((c) => c.memberIds.includes("a"))!;
    expect(main.memberIds.sort()).toEqual(["a", "b", "c"]);
    expect(main.seedId).toBe("a");
    expect(main.intent).toBe("COMMERCIAL");
    expect(main.recommendedAsset).toBe("LANDING_PAGE");
    expect(main.headTerms.slice(0, 3)).toEqual(["tiktok", "live", "moderation"]);
    // Never one page per keyword: 5 queries, 2 or 3 assets.
    expect(out.length).toBeLessThan(5);
  });

  it("keeps comparison queries in their own family and is deterministic", () => {
    const items = [q("a", "acme vs modbot", { intent: "COMPARISON" }), q("b", "modbot alternatives", { intent: "ALTERNATIVE" }), q("c", "modbot moderation features")];
    const out = clusterQueries(items);
    const cmp = out.find((c) => c.memberIds.includes("a"))!;
    expect(cmp.memberIds).toContain("b");
    expect(cmp.memberIds).not.toContain("c");
    expect(cmp.recommendedAsset).toBe("COMPARISON_PAGE");
    expect(clusterQueries([...items].reverse())).toEqual(out);
  });

  it("maps intents and topic types to one asset and a content format", () => {
    expect(recommendAsset("ALTERNATIVE", "COMPETITOR", false)).toBe("ALTERNATIVES_PAGE");
    expect(recommendAsset("COMMERCIAL", "INTEGRATION", false)).toBe("INTEGRATION_PAGE");
    expect(recommendAsset("TRANSACTIONAL", "BRAND", true)).toBe("PRICING_PAGE");
    expect(recommendAsset("INFORMATIONAL", "BRAND", true)).toBe("FAQ");
    expect(recommendAsset("PROBLEM", "PROBLEM", false)).toBe("GUIDE");
    expect(assetContentType("GUIDE")).toBe("TUTORIAL");
    expect(assetContentType("ALTERNATIVES_PAGE")).toBe("COMPARISON");
  });
});

describe("coverage", () => {
  const base = { beaconPages: [], crawled: [], search: [] };

  it("is NONE without evidence", () => {
    expect(assessQueryCoverage({ id: "q", query: "keyword filters" }, base)).toMatchObject({ coverage: "NONE", url: null, source: null });
  });

  it("uses the crawled site: title/H1 is COVERED, headings or URL PARTIAL", () => {
    const full = assessQueryCoverage({ id: "q", query: "keyword filters" }, { ...base, crawled: [{ url: "https://acme.io/features", title: "Features", h1: "Keyword filters for live chat", headings: [] }] });
    expect(full).toMatchObject({ coverage: "COVERED", url: "https://acme.io/features", source: "CRAWLED_PAGE" });
    const part = assessQueryCoverage({ id: "q", query: "keyword filters moderation" }, { ...base, crawled: [{ url: "https://acme.io/keyword-filters", title: "Home", h1: null, headings: ["Moderation"] }] });
    expect(part).toMatchObject({ coverage: "PARTIAL", source: "CRAWLED_PAGE" });
    expect(part.reason).toMatch(/100% of the query words/);
  });

  it("uses search query/page pairs: impressions mean at least PARTIAL, page one means COVERED", () => {
    const deep = assessQueryCoverage({ id: "q", query: "x y" }, { ...base, search: [{ page: "https://acme.io/a", impressions: 40, clicks: 0, position: 18.2 }] });
    expect(deep).toMatchObject({ coverage: "PARTIAL", url: "https://acme.io/a", source: "SEARCH_DATA" });
    const top = assessQueryCoverage({ id: "q", query: "x y" }, { ...base, search: [{ page: "https://acme.io/b", impressions: 400, clicks: 30, position: 3.4 }] });
    expect(top).toMatchObject({ coverage: "COVERED", source: "SEARCH_DATA" });
  });

  it("prefers a published Beacon page targeting the query; unpublished is PARTIAL", () => {
    const pages = [
      { id: "p1", title: "Other", status: "PUBLISHED", targetQueryId: "q", url: "https://acme.io/p1" },
      { id: "p2", title: "Draft", status: "DRAFT", targetQueryId: "q2", url: "https://acme.io/p2" },
    ];
    expect(assessQueryCoverage({ id: "q", query: "x" }, { ...base, beaconPages: pages })).toMatchObject({ coverage: "COVERED", pageId: "p1", source: "BEACON_PAGE" });
    expect(assessQueryCoverage({ id: "q2", query: "x" }, { ...base, beaconPages: pages })).toMatchObject({ coverage: "PARTIAL", pageId: "p2" });
  });

  it("aggregates cluster coverage from members", () => {
    const cov = (c: "NONE" | "PARTIAL" | "COVERED") => ({ coverage: c, reason: c, url: c === "NONE" ? null : "u", pageId: null, source: null });
    expect(clusterCoverage([{ id: "a", coverage: cov("COVERED") }, { id: "b", coverage: cov("NONE") }, { id: "c", coverage: cov("NONE") }], "a").coverage).toBe("COVERED");
    expect(clusterCoverage([{ id: "a", coverage: cov("NONE") }, { id: "b", coverage: cov("PARTIAL") }, { id: "c", coverage: cov("NONE") }], "a")).toMatchObject({ coverage: "PARTIAL", covered: 0, total: 3 });
    expect(clusterCoverage([{ id: "a", coverage: cov("NONE") }], "a").coverage).toBe("NONE");
  });
});

describe("content gap derivation", () => {
  const cluster = (over: Partial<GapClusterInput> = {}): GapClusterInput => ({
    id: "c1",
    name: "tiktok live moderation",
    intent: "COMMERCIAL",
    topicType: "CATEGORY",
    branded: false,
    coverage: "NONE",
    coverageReason: null,
    coveredByUrl: null,
    pillarPageId: null,
    recommendedAsset: "LANDING_PAGE",
    queries: [{ id: "q1", query: "tiktok live moderation", importance: 2, search: null }],
    ...over,
  });
  const input = (over: Partial<GapInput> = {}): GapInput => ({ product: { id: "p", name: "Acme" }, clusters: [cluster()], facts: [], prompts: [], searchConnected: false, searchProvider: null, ...over });

  it("returns nothing for a low-relevance cluster without evidence, and never invents demand", () => {
    expect(deriveContentGaps(input())).toEqual([]);
    const g = deriveContentGaps(input({ clusters: [cluster({ queries: [{ id: "q1", query: "tiktok live moderation", importance: 5, search: null }] })] }))[0];
    expect(g.reasons).toEqual(["UNCOVERED_RELEVANT"]);
    expect(g.demand).toEqual({ status: "UNKNOWN", impressions: null, clicks: null, provider: null });
    expect(g.relevance).toEqual({ level: "HIGH", reason: "Importance 5/5" });
  });

  it("combines search demand without a ranking page, facts, AI competitor-only prompts and missing pillars", () => {
    const gaps = deriveContentGaps(
      input({
        searchConnected: true,
        searchProvider: "GOOGLE_SEARCH_CONSOLE",
        facts: [{ kind: "USE_CASE", name: "TikTok live moderation" }],
        prompts: [
          { promptId: "pr1", prompt: "What is the best tool for TikTok live moderation?", testIds: ["t1", "t2"], samples: 2, productMentions: 0, competitorsMentioned: ["ModBot"], competitorCitedUrls: ["https://modbot.io/"] },
          { promptId: "pr2", prompt: "Best CRM for lawyers", testIds: ["t3"], samples: 1, productMentions: 0, competitorsMentioned: ["X"], competitorCitedUrls: [] },
        ],
        clusters: [
          cluster({
            coverage: "PARTIAL",
            coverageReason: "Search data: 120 impressions but average position 34.0",
            coveredByUrl: "https://acme.io/",
            queries: [
              { id: "q1", query: "tiktok live moderation", importance: 3, search: { impressions: 120, clicks: 1, position: 34, page: "https://acme.io/" } },
              { id: "q2", query: "tiktok live moderation tool", importance: 3, search: { impressions: 30, clicks: 0, position: 12, page: "https://acme.io/blog" } },
              { id: "q3", query: "moderate tiktok live chat", importance: 2, search: null },
            ],
          }),
        ],
      }),
    );
    expect(gaps).toHaveLength(1);
    const g = gaps[0];
    expect(g.reasons).toEqual(["DEMAND_WITHOUT_RANKING", "UNCOVERED_RELEVANT", "AI_COMPETITOR_ONLY", "NO_PILLAR"]);
    expect(g.demand).toEqual({ status: "MEASURED", impressions: 150, clicks: 1, provider: "GOOGLE_SEARCH_CONSOLE" });
    expect(g.relevance.level).toBe("MEDIUM");
    expect(g.existingPage).toBe("https://acme.io/");
    expect(g.competitors).toEqual(["ModBot"]);
    expect(g.sources.testIds).toEqual(["t1", "t2"]);
    expect(g.sources.urls).toEqual(expect.arrayContaining(["https://acme.io/", "https://modbot.io/"]));
    expect(g.supportingAssets).toEqual(["FAQ", "GUIDE"]);
    expect(g.topQueryId).toBe("q1");
  });

  it("matches prompts to clusters by topic words", () => {
    expect(promptMatchesCluster("Which app helps with TikTok live moderation?", { name: "tiktok live moderation", queries: [] })).toBe(true);
    expect(promptMatchesCluster("Best CRM for lawyers", { name: "tiktok live moderation", queries: [] })).toBe(false);
  });
});

describe("citation classification", () => {
  const ctx = { products: [{ id: "p1", domain: "https://www.acme.io/" }], competitors: [{ id: "c1", domain: "modbot.com" }] };

  it("computes host and registrable domain with common second-level suffixes", () => {
    expect(registrableDomain("blog.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(classifyCitation("not a url", ctx)).toBeNull();
    expect(classifyCitation("ftp://x.example/", ctx)).toBeNull();
  });

  it("classifies kind and category with the documented heuristic", () => {
    const k = (u: string) => {
      const c = classifyCitation(u, ctx)!;
      return `${c.kind}/${c.category}`;
    };
    expect(k("https://acme.io/pricing")).toBe("OWN/OFFICIAL_SITE");
    expect(k("https://docs.acme.io/start")).toBe("OWN/DOCUMENTATION");
    expect(k("https://modbot.com/docs/api")).toBe("COMPETITOR/DOCUMENTATION");
    expect(k("https://www.g2.com/products/acme")).toBe("THIRD_PARTY/REVIEW_SITE");
    expect(k("https://www.producthunt.com/posts/acme")).toBe("THIRD_PARTY/DIRECTORY");
    expect(k("https://apps.apple.com/app/acme")).toBe("THIRD_PARTY/DIRECTORY");
    expect(k("https://news.ycombinator.com/item?id=1")).toBe("THIRD_PARTY/COMMUNITY");
    expect(k("https://www.reddit.com/r/Twitch/x")).toBe("THIRD_PARTY/COMMUNITY");
    expect(k("https://techcrunch.com/2026/acme")).toBe("THIRD_PARTY/NEWS");
    expect(k("https://news.example.org/a")).toBe("THIRD_PARTY/NEWS");
    expect(k("https://blog.example.com/acme-vs-modbot")).toBe("THIRD_PARTY/COMPARISON");
    expect(k("https://example.com/best-moderation-tools")).toBe("THIRD_PARTY/COMPARISON");
    expect(k("https://help.zendesk.com/x")).toBe("THIRD_PARTY/DOCUMENTATION");
    expect(k("https://example.com/about")).toBe("THIRD_PARTY/OTHER");
    expect(classifyCitation("https://modbot.com/", ctx)).toMatchObject({ competitorId: "c1", productId: null });
  });

  it("finds citation offsets (inline URLs, numbered markers) and entities mentioned nearby", () => {
    const text = "Acme Live is solid [1]. ".padEnd(400, ".") + " ModBot too, see https://modbot.com/x";
    expect(citationOffsets(text, "https://a.example/", 1)).toEqual([19]);
    const mOff = citationOffsets(text, "https://modbot.com/x", 2);
    expect(mOff).toEqual([text.indexOf("https://modbot.com/x")]);
    const mentions = [
      { id: "p1", offsets: [0] },
      { id: "c1", offsets: [text.indexOf("ModBot")] },
    ];
    expect(entitiesNear([19], mentions)).toEqual(["p1"]);
    expect(entitiesNear(mOff, mentions)).toEqual(["c1"]);
    expect(entitiesNear([], mentions)).toEqual([]);
  });
});

describe("chat-completions citations parsing", () => {
  it("parses OpenAI url_citation annotations with offsets and the served model", () => {
    const r = parseChatCompletion(
      "openai",
      { model: "gpt-5-search-2026", choices: [{ message: { content: "Use Acme.", annotations: [{ type: "url_citation", url_citation: { url: "https://acme.io/", title: "Acme", start_index: 4, end_index: 8 } }] } }] },
      { webSearchRequested: true },
    );
    expect(r).toMatchObject({ text: "Use Acme.", citations: ["https://acme.io/"], servedModel: "gpt-5-search-2026", grounded: true });
    expect(r.citationDetails).toEqual([{ url: "https://acme.io/", title: "Acme", offsets: [4] }]);
  });

  it("parses Perplexity citations with [n] markers and search_results titles", () => {
    const r = parseChatCompletion("perplexity", { model: "sonar", choices: [{ message: { content: "A [1]. B [2][1]." } }], citations: ["https://a.example/", "https://b.example/"], search_results: [{ url: "https://a.example/", title: "A" }] });
    expect(r.grounded).toBe(true);
    expect(r.citationDetails).toEqual([
      { url: "https://a.example/", title: "A", offsets: [2, 12] },
      { url: "https://b.example/", title: null, offsets: [9] },
    ]);
  });

  it("an ungrounded OpenAI answer has no citations", () => {
    expect(parseChatCompletion("openai", { choices: [{ message: { content: "Hi" } }] })).toMatchObject({ citations: [], grounded: false, servedModel: null });
  });
});

describe("opportunity engine v2", () => {
  const SIG: OpportunitySignals = { product: { id: "p1", name: "Acme", slug: "acme" }, queries: [], aiGaps: [], seoIssues: [], missingEntity: [], competitorsWithoutComparison: [], orphanPages: [], lowConversionPages: [] };

  it("every opportunity carries a category, a rationale per factor and a linked next action", () => {
    const out = generateOpportunities({
      ...SIG,
      queries: [{ id: "q", query: "tiktok live moderation", intent: "COMMERCIAL", importance: 4, coverage: "NONE", search: { impressions: 80, clicks: 1, position: 12 } }],
      aiGaps: [{ prompt: "p", promptId: "pr", testsRun: 3, productMentions: 0, competitorsMentioned: ["R"] }],
      seoIssues: [{ rule: "http.error", severity: "CRITICAL", count: 1, exampleUrl: "https://a/x" }],
      missingEntity: [{ key: "a", label: "Pricing", weight: 10, earned: 0 }],
      citationDomains: [{ domain: "g2.com", category: "REVIEW_SITE", samplesCiting: 3, samplesTotal: 5, productAppears: false, prompts: ["p"], testIds: ["t1", "t2", "t3"], urls: ["https://g2.com/x"], competitors: ["R"] }],
      distributionNeeds: [{ kind: "DIRECTORY", citedCategory: "REVIEW_SITE", citedSamples: 3, exampleDomains: ["g2.com"], preparedTargets: 0 }],
      crossSell: [{ productId: "p2", productName: "Other", sharedIdentities: 12, relationship: null, hasRule: false }],
      referral: { conversions90d: 25, activeReferralCodes: 0, affiliates: 0 },
    });
    const types = out.map((o) => o.type);
    expect(types).toEqual(expect.arrayContaining(["CONTENT_GAP", "STRIKING_DISTANCE", "AI_VISIBILITY_GAP", "TECHNICAL", "PRODUCT_KNOWLEDGE", "CITATION", "DISTRIBUTION", "CROSS_SELL", "REFERRAL"]));
    for (const o of out) {
      expect(Object.keys(o.scoringRationale).sort()).toEqual(["confidence", "effort", "impact", "urgency"]);
      expect(o.nextAction.href).toMatch(/^\//);
      for (const f of [o.impact, o.confidence, o.effort, o.urgency]) expect(f).toBeGreaterThanOrEqual(1);
      for (const f of [o.impact, o.confidence, o.effort, o.urgency]) expect(f).toBeLessThanOrEqual(5);
      expect(o.priorityScore).toBe(priority(o.impact, o.confidence, o.effort, o.urgency));
    }
    expect(out.find((o) => o.type === "STRIKING_DISTANCE")!.category).toBe("QUERY");
    expect(out.find((o) => o.type === "PRODUCT_KNOWLEDGE")!.fingerprint).toBe("entity:p1");
    const cite = out.find((o) => o.type === "CITATION")!;
    expect(cite.problem).toMatch(/frequently cited for this topic but was not associated with Acme/);
    expect(cite.problem).toMatch(/never contacts third parties automatically/);
    expect(cite.scoringRationale.confidence).toBe("Cited in 3 of 5 sampled responses.");
  });

  it("does not raise citation, distribution, cross-sell or referral opportunities without evidence", () => {
    const out = generateOpportunities({
      ...SIG,
      citationDomains: [
        { domain: "a.com", category: "OTHER", samplesCiting: 1, samplesTotal: 5, productAppears: false, prompts: [], testIds: [], urls: [], competitors: [] },
        { domain: "b.com", category: "OTHER", samplesCiting: 4, samplesTotal: 5, productAppears: true, prompts: [], testIds: [], urls: [], competitors: [] },
      ],
      distributionNeeds: [{ kind: "DIRECTORY", citedCategory: "DIRECTORY", citedSamples: 5, exampleDomains: [], preparedTargets: 1 }],
      crossSell: [
        { productId: "p2", productName: "B", sharedIdentities: 2, relationship: null, hasRule: false },
        { productId: "p3", productName: "C", sharedIdentities: 50, relationship: "COMPLEMENTARY", hasRule: true },
      ],
      referral: { conversions90d: 3, activeReferralCodes: 0, affiliates: 0 },
    });
    expect(out).toEqual([]);
  });

  it("content gaps produce one opportunity per cluster and skip clustered queries", () => {
    const out = generateOpportunities({
      ...SIG,
      queries: [{ id: "q1", query: "a b", intent: "COMMERCIAL", importance: 5, coverage: "NONE", clusterId: "c1" }],
      contentGaps: [
        {
          clusterId: "c1",
          clusterName: "a b",
          intent: "COMMERCIAL",
          topicType: "CATEGORY",
          reasons: ["UNCOVERED_RELEVANT"],
          coverage: { status: "NONE", evidence: null, url: null },
          existingPage: null,
          relevance: { level: "HIGH", reason: "Importance 5/5" },
          recommendedAsset: "LANDING_PAGE",
          supportingAssets: ["FAQ"],
          sources: { queryIds: ["q1"], testIds: [], urls: [] },
          demand: { status: "UNKNOWN", impressions: null, clicks: null, provider: null },
          competitors: [],
          topQueryId: "q1",
          score: 4,
        },
      ],
    });
    expect(out.map((o) => o.fingerprint)).toEqual(["content_gap:cluster:c1"]);
    expect(out[0]).toMatchObject({ title: 'Create a landing page for the "a b" topic', queryId: "q1", category: "CONTENT", sources: { clusterId: "c1" } });
    expect(out[0].evidence).toContainEqual({ label: "Search demand", value: "Unknown (no search provider data)" });
    expect(out[0].nextAction.href).toBe("/queries?product=acme#gap-c1");
  });
});
