import { describe, expect, it } from "vitest";
import {
  INFO_PARTS,
  markStep,
  nextPosition,
  normalizeSteps,
  onboardingHref,
  parsePosition,
  partKey,
  previousPosition,
  progress,
  resumeAt,
  stepState,
  type StoredOnboardingSteps,
} from "@/core/onboarding/steps";
import { cleanText, extractProposals, findKeyPages, jsonLdObjects, sourceKindFor } from "@/core/onboarding/extract";
import { dailyDeltas, launchChecklist, launchPhase, openBlockers, type LaunchFacts } from "@/core/launch/checklist";
import { FEATURES_HTML, FEATURES_URL, HOME_HTML, HOME_URL } from "./fixtures/extraction";

const NOW = new Date("2026-10-01T10:00:00Z");

describe("onboarding step status model", () => {
  it("records done, skipped and pending with timestamps and never turns done into skipped", () => {
    let s: StoredOnboardingSteps = {};
    s = markStep(s, "product", "done", NOW);
    s = markStep(s, "website", "skipped", NOW);
    expect(s.product).toEqual({ status: "done", at: NOW.toISOString() });
    expect(s.website).toEqual({ status: "skipped", at: NOW.toISOString() });
    expect(markStep(s, "product", "skipped", NOW)).toBe(s);
    expect(markStep(s, "website", "pending", NOW).website).toEqual({ status: "pending", at: null });
    expect(() => markStep(s, "info", "done", NOW)).toThrow();
  });

  it("derives PRODUCT INFORMATION from its sub-steps", () => {
    let s: StoredOnboardingSteps = {};
    expect(stepState(s, "info").status).toBe("pending");
    for (const p of INFO_PARTS) s = markStep(s, partKey(p.key), "skipped", NOW);
    expect(stepState(s, "info").status).toBe("skipped");
    s = markStep(s, partKey("features"), "done", new Date("2026-10-02T00:00:00Z"));
    expect(stepState(s, "info")).toEqual({ status: "done", at: "2026-10-02T00:00:00.000Z" });
  });

  it("counts skipped steps as skipped (not done) and resumes at the first pending step", () => {
    let s: StoredOnboardingSteps = {};
    s = markStep(s, "product", "done", NOW);
    s = markStep(s, "website", "skipped", NOW);
    s = markStep(s, partKey("category"), "done", NOW);
    const pr = progress(s);
    expect(pr).toMatchObject({ done: 1, skipped: 1, pending: 9, total: 11, complete: false });
    expect(resumeAt(s)).toEqual({ step: "info", part: "description" });
    for (const p of INFO_PARTS) s = markStep(s, partKey(p.key), "done", NOW);
    expect(resumeAt(s)).toEqual({ step: "verify", part: null });
  });

  it("maps legacy progress once and ignores unknown stored keys", () => {
    expect(normalizeSteps({}, { onboardingStep: 0, completedAt: null })).toEqual({});
    const completed = normalizeSteps(null, { onboardingStep: 14, completedAt: NOW });
    expect(progress(completed)).toMatchObject({ done: 11, complete: true });
    const mid = normalizeSteps(undefined, { onboardingStep: 5, completedAt: null });
    expect(mid.product?.status).toBe("done");
    expect(mid.website?.status).toBe("done");
    expect(mid[partKey("description")]?.status).toBe("done");
    expect(mid[partKey("audience")]).toBeUndefined();
    expect(normalizeSteps({ bogus: { status: "done" }, verify: { status: "weird" }, crawl: { status: "skipped", at: "x" } })).toEqual({ crawl: { status: "skipped", at: "x" } });
  });

  it("walks the flow forward and back and parses legacy URLs", () => {
    expect(nextPosition("website", null)).toEqual({ step: "info", part: "category" });
    expect(nextPosition("info", "category")).toEqual({ step: "info", part: "description" });
    expect(nextPosition("info", "conversions")).toEqual({ step: "verify", part: null });
    expect(nextPosition("score", null)).toBeNull();
    expect(previousPosition("verify", null)).toEqual({ step: "info", part: "conversions" });
    expect(previousPosition("product", null)).toBeNull();
    expect(parsePosition("1", undefined)).toEqual({ step: "product", part: null });
    expect(parsePosition("13", undefined)).toEqual({ step: "search", part: null });
    expect(parsePosition("11", undefined)).toEqual({ step: "info", part: "sources" });
    expect(parsePosition("info", "nope")).toEqual({ step: "info", part: "category" });
    expect(parsePosition("nope", undefined)).toBeNull();
    expect(onboardingHref("acme", { step: "info", part: "pricing" })).toBe("/products/acme/onboarding?step=info&part=pricing");
  });
});

describe("website extraction parser", () => {
  const roles = { features: FEATURES_URL, pricing: "https://acme.example/pricing", docs: "https://docs.acme.example/start" };
  const proposals = extractProposals(
    [
      { url: HOME_URL, html: HOME_HTML },
      { url: FEATURES_URL, html: FEATURES_HTML },
    ],
    roles,
  );
  const find = (kind: string, field: string) => proposals.filter((p) => p.kind === kind && p.field === field);

  it("finds key pages on the same site only", () => {
    expect(findKeyPages(HOME_URL, HOME_HTML)).toEqual([
      { role: "pricing", url: "https://acme.example/pricing" },
      { role: "docs", url: "https://docs.acme.example/start" },
      { role: "features", url: "https://acme.example/features" },
      { role: "about", url: "https://acme.example/about" },
    ]);
    expect(findKeyPages(HOME_URL, `<a href="https://other.example/pricing">Pricing</a>`)).toEqual([]);
  });

  it("proposes descriptions from title, meta, Open Graph, H1 and JSON-LD, each with its source URL", () => {
    const descs = find("CLAIM", "short_description");
    expect(descs.map((d) => d.origin).sort()).toEqual(["h1", "json_ld", "meta_description", "og_description", "title"]);
    expect(descs.every((d) => d.sourceUrl === HOME_URL)).toBe(true);
    // Long dashes in the page are normalised.
    expect(descs.find((d) => d.origin === "h1")!.value).toBe("Keep every TikTok LIVE chat clean, automatically");
    expect(find("CLAIM", "category")[0]).toMatchObject({ value: "BusinessApplication", origin: "json_ld" });
  });

  it("proposes features from section headings and JSON-LD, skipping generic headings and duplicates", () => {
    const names = find("FACET", "FEATURE").map((f) => f.value);
    expect(names).toEqual(expect.arrayContaining(["Keyword filters", "Moderator dashboard", "Spam detection"]));
    expect(names).not.toContain("Pricing");
    expect(names).not.toContain("FAQ");
    expect(names.filter((n) => n === "Keyword filters")).toHaveLength(1);
    expect(find("FACET", "FEATURE").find((f) => f.value === "Moderator dashboard")!.details.description).toBe("A shared dashboard where moderators review flagged comments.");
    expect(find("FACET", "FEATURE").find((f) => f.value === "Spam detection")!.sourceUrl).toBe(HOME_URL);
  });

  it("never guesses prices: currency only when given, interval always unknown", () => {
    const plans = proposals.filter((p) => p.kind === "PRICING");
    expect(plans.find((p) => p.value === "Starter")!.details).toEqual({ priceCents: 2900, currency: "EUR", interval: null });
    expect(plans.find((p) => p.value === "Enterprise")!.details).toEqual({ priceCents: null, currency: null, interval: null });
  });

  it("collects social accounts, logo, pricing and docs URLs and ignores share links", () => {
    const social = proposals.filter((p) => p.kind === "SOCIAL").map((p) => `${p.field} ${p.value}`);
    expect(social).toEqual(expect.arrayContaining(["x https://x.com/acmelive", "linkedin https://www.linkedin.com/company/acme-live", "github https://github.com/acme/live", "youtube https://www.youtube.com/@acme"]));
    expect(social.some((s) => s.includes("intent"))).toBe(false);
    expect(social.some((s) => s.includes("example.org"))).toBe(false);
    expect(proposals.find((p) => p.kind === "LOGO")!.value).toBe("https://acme.example/logo.png");
    expect(find("CLAIM", "pricing_url")[0].value).toBe("https://acme.example/pricing");
    expect(find("CLAIM", "documentation_url")[0].value).toBe("https://docs.acme.example/start");
  });

  it("ignores invalid JSON-LD and classifies source kinds", () => {
    expect(jsonLdObjects(HOME_HTML).map((o) => o["@type"])).toEqual([undefined, "Organization", "SoftwareApplication"]);
    expect(sourceKindFor("https://acme.example/pricing")).toBe("PRICING");
    expect(sourceKindFor("https://docs.acme.example/start", roles)).toBe("DOCUMENTATION");
    expect(sourceKindFor(HOME_URL)).toBe("WEBSITE");
    expect(cleanText("  a\n\tb  ")).toBe("a b");
    expect(cleanText("x".repeat(400)).length).toBe(300);
  });
});

const READY: LaunchFacts = {
  slug: "acme",
  knowledge: { completeness: 0.8, facts: 20, verified: 15 },
  domain: { name: "acme.example", verified: true, https: true },
  audit: { id: "a1", critical: 0, schemaErrorsOnKeyPages: 0, sitemaps: 1, sitemapErrors: 0, finishedAt: "2026-09-30T00:00:00Z" },
  analytics: "CONNECTED",
  searchConsole: "CONNECTED",
  bing: "CONNECTED",
  publicSite: { enabled: true, orgSlug: "acme-org", listed: true },
  aiVisibility: { providerConfigured: true, activePrompts: 3, testedPrompts: 3 },
  referrals: { activeCodes: 1 },
  revenue: { stripe: "CONNECTED", events: 4 },
  productPage: { published: true, planned: true },
  docs: { url: "https://acme.example/docs", verified: true },
  tracking: { activeKeys: 1, events: 3 },
  launchContent: { approved: 1, published: 0 },
  distribution: { prepared: 2, submitted: 0 },
  queries: { active: 12 },
  baseline: { capturedAt: "2026-09-30T00:00:00Z", activeQueries: 12, search: { clicks: 10, impressions: 100, days: 14 }, visitorsPerDay: 3 },
  launchedAt: null,
  postLaunch: { eventsSince: 0, searchDaysSince: 0, analyticsDaysSince: 0 },
};

describe("launch checklist derivation", () => {
  const byKey = (f: LaunchFacts) => Object.fromEntries(launchChecklist(f).map((i) => [i.key, i]));

  it("marks a fully prepared product ready, with every pre-launch item done", () => {
    const items = launchChecklist(READY);
    expect(items.filter((i) => i.phase === "PRE_LAUNCH").every((i) => i.status === "DONE")).toBe(true);
    expect(openBlockers(items)).toEqual([]);
    expect(new Set(items.map((i) => i.phase))).toEqual(new Set(["PRE_LAUNCH", "LAUNCH_DAY", "POST_LAUNCH"]));
  });

  it("blocks on knowledge, site, core pages and tracking with evidence", () => {
    const f = { ...READY, knowledge: { completeness: 0.9, facts: 20, verified: 5 }, domain: { name: "acme.example", verified: false, https: null }, productPage: { published: false, planned: true }, tracking: { activeKeys: 1, events: 0 } };
    const b = byKey(f);
    expect(b.knowledge).toMatchObject({ status: "TODO", blocking: true, evidence: { params: { verified: 5, facts: 20, ratio: 25 } } });
    expect(b.site).toMatchObject({ status: "TODO", href: "/discovery/domains" });
    expect(b.core_pages.evidence.text).toBe("The product page is planned but not published.");
    expect(b.conversion_tracking.status).toBe("TODO");
    expect(openBlockers(launchChecklist(f)).map((i) => i.key)).toEqual(["knowledge", "site", "core_pages", "conversion_tracking"]);
  });

  it("reports a missing provider as NOT_CONNECTED, never as done or as a zero", () => {
    const b = byKey({ ...READY, analytics: "NOT_CONNECTED", searchConsole: "FAILING", launchedAt: "2026-10-01T09:00:00Z" });
    expect(b.analytics.status).toBe("NOT_CONNECTED");
    expect(b.analytics.evidence.text).toBe("Not connected");
    expect(b.search_console.status).toBe("TODO");
    expect(b.analytics_since_launch.status).toBe("NOT_CONNECTED");
    expect(b.search_since_launch.status).toBe("TODO");
  });

  it("needs a successful audit for the site, sitemap and structured data", () => {
    const b = byKey({ ...READY, audit: null });
    expect(b.site.status).toBe("TODO");
    expect(b.sitemap.evidence.text).toBe("No successful audit yet.");
    expect(byKey({ ...READY, audit: { ...READY.audit!, schemaErrorsOnKeyPages: 2 } }).structured_data.status).toBe("TODO");
    expect(byKey({ ...READY, audit: { ...READY.audit!, sitemapErrors: 1 } }).sitemap.status).toBe("TODO");
    // Critical issues are their own (blocking) item, no longer folded into the site item.
    const crit = byKey({ ...READY, audit: { ...READY.audit!, critical: 2 } });
    expect(crit.site.status).toBe("DONE");
    expect(crit.critical_issues).toMatchObject({ status: "TODO", blocking: true, evidence: { params: { n: 2 } }, href: "/discovery/audits/a1" });
    expect(openBlockers(launchChecklist({ ...READY, audit: { ...READY.audit!, critical: 2 } })).map((i) => i.key)).toEqual(["critical_issues"]);
    expect(byKey({ ...READY, audit: null }).critical_issues).toMatchObject({ status: "TODO", evidence: { text: "No successful audit yet." } });
    expect(byKey(READY).critical_issues).toMatchObject({ status: "DONE", evidence: { params: { n: 0 } } });
  });

  it("checks the hosted llms.txt and entity endpoint against the public site switch, onboarding and verified facts", () => {
    expect(byKey(READY).hosted_endpoints).toMatchObject({ status: "DONE", blocking: false, href: "/api/v1/entity/acme-org/acme", evidence: { params: { org: "acme-org", product: "acme", n: 15 } } });
    expect(byKey({ ...READY, publicSite: { ...READY.publicSite, enabled: false } }).hosted_endpoints).toMatchObject({ status: "TODO", href: "/settings" });
    expect(byKey({ ...READY, publicSite: { ...READY.publicSite, listed: false } }).hosted_endpoints).toMatchObject({ status: "TODO", href: "/products/acme/onboarding" });
    expect(byKey({ ...READY, knowledge: { completeness: 0.8, facts: 20, verified: 0 } }).hosted_endpoints).toMatchObject({ status: "TODO", href: "/products/acme/knowledge" });
  });

  it("reports Bing, the AI visibility baseline, referral codes and revenue from measured state", () => {
    expect(byKey(READY).bing.status).toBe("DONE");
    expect(byKey({ ...READY, bing: "FAILING" }).bing.status).toBe("TODO");
    expect(byKey({ ...READY, bing: "NOT_CONNECTED" }).bing).toMatchObject({ status: "NOT_CONNECTED", evidence: { text: "Not connected" } });

    expect(byKey(READY).ai_visibility_baseline).toMatchObject({ status: "DONE", evidence: { params: { tested: 3, n: 3 } } });
    // One active prompt never tested: no baseline yet.
    expect(byKey({ ...READY, aiVisibility: { providerConfigured: true, activePrompts: 3, testedPrompts: 2 } }).ai_visibility_baseline.status).toBe("TODO");
    expect(byKey({ ...READY, aiVisibility: { providerConfigured: true, activePrompts: 0, testedPrompts: 0 } }).ai_visibility_baseline).toMatchObject({ status: "TODO", evidence: { text: "No active AI visibility prompt for this product yet." } });
    // No provider and an incomplete baseline: not connected, never a zero.
    expect(byKey({ ...READY, aiVisibility: { providerConfigured: false, activePrompts: 2, testedPrompts: 0 } }).ai_visibility_baseline).toMatchObject({ status: "NOT_CONNECTED", href: "/settings/integrations" });
    // A baseline already sampled stays done if the provider is removed later.
    expect(byKey({ ...READY, aiVisibility: { providerConfigured: false, activePrompts: 2, testedPrompts: 2 } }).ai_visibility_baseline.status).toBe("DONE");

    expect(byKey(READY).referral_code.status).toBe("DONE");
    expect(byKey({ ...READY, referrals: { activeCodes: 0 } }).referral_code).toMatchObject({ status: "TODO", evidence: { params: { n: 0 } } });

    expect(byKey(READY).revenue_source).toMatchObject({ status: "DONE", evidence: { params: { n: 4 } } });
    expect(byKey({ ...READY, revenue: { stripe: "CONNECTED", events: 0 } }).revenue_source.status).toBe("DONE");
    expect(byKey({ ...READY, revenue: { stripe: "NOT_CONNECTED", events: 2 } }).revenue_source.status).toBe("DONE");
    expect(byKey({ ...READY, revenue: { stripe: "FAILING", events: 0 } }).revenue_source.status).toBe("TODO");
    expect(byKey({ ...READY, revenue: { stripe: "NOT_CONNECTED", events: 0 } }).revenue_source).toMatchObject({ status: "NOT_CONNECTED", evidence: { text: "Not connected" } });

    // None of the new items blocks the launch.
    const bare: LaunchFacts = { ...READY, bing: "NOT_CONNECTED", publicSite: { enabled: false, orgSlug: "x", listed: false }, aiVisibility: { providerConfigured: false, activePrompts: 0, testedPrompts: 0 }, referrals: { activeCodes: 0 }, revenue: { stripe: "NOT_CONNECTED", events: 0 } };
    expect(openBlockers(launchChecklist(bare))).toEqual([]);
  });

  it("requires active queries and a stored baseline", () => {
    expect(byKey({ ...READY, baseline: null }).query_baseline.status).toBe("TODO");
    expect(byKey({ ...READY, queries: { active: 3 } }).query_baseline.status).toBe("TODO");
  });

  it("derives the launch phase from mode, date and day", () => {
    expect(launchPhase({ launchMode: "OFF", launchDate: null, launchedAt: null }, NOW)).toMatchObject({ phase: null, monitoring: false });
    expect(launchPhase({ launchMode: "PRE_LAUNCH", launchDate: "2026-10-10", launchedAt: null }, NOW).phase).toBe("PRE_LAUNCH");
    expect(launchPhase({ launchMode: "LAUNCH", launchDate: "2026-10-01", launchedAt: NOW }, NOW)).toMatchObject({ phase: "LAUNCH_DAY", dayOfLaunch: 0, monitoring: true });
    expect(launchPhase({ launchMode: "LAUNCH", launchDate: "2026-09-25", launchedAt: null }, NOW)).toMatchObject({ mode: "POST_LAUNCH", phase: "POST_LAUNCH", dayOfLaunch: 6, monitoring: true });
    expect(launchPhase({ launchMode: "LAUNCH", launchDate: "2026-09-01", launchedAt: null }, NOW).monitoring).toBe(false);
  });

  it("computes day-over-day deltas without inventing missing days", () => {
    expect(
      dailyDeltas([
        { day: "d1", value: 5 },
        { day: "d2", value: 8 },
        { day: "d3", value: null },
        { day: "d4", value: 2 },
      ]),
    ).toEqual([
      { day: "d1", value: 5, delta: null },
      { day: "d2", value: 8, delta: 3 },
      { day: "d3", value: null, delta: null },
      { day: "d4", value: 2, delta: null },
    ]);
  });
});

describe("French coverage of runtime labels", () => {
  it("translates every flow step, sub-step, checklist label and evidence text", async () => {
    const { FR } = await import("@/i18n/fr");
    const { ONBOARDING_FLOW } = await import("@/core/onboarding/steps");
    const facts: LaunchFacts[] = [
      READY,
      { ...READY, audit: null, domain: { name: null, verified: false, https: null }, docs: { url: null, verified: false }, baseline: null, analytics: "FAILING", searchConsole: "FAILING", productPage: { published: false, planned: false } },
      { ...READY, domain: { name: "a.example", verified: false, https: null }, analytics: "NOT_CONNECTED", searchConsole: "NOT_CONNECTED", launchedAt: "2026-10-01T00:00:00Z", tracking: { activeKeys: 0, events: 0 } },
      { ...READY, domain: { name: "a.example", verified: true, https: false }, docs: { url: "https://a.example/docs", verified: false }, productPage: { published: false, planned: true }, launchedAt: "2026-10-01T00:00:00Z" },
      { ...READY, audit: { ...READY.audit!, sitemaps: 0 } },
      { ...READY, bing: "FAILING", publicSite: { enabled: false, orgSlug: "x", listed: false }, aiVisibility: { providerConfigured: true, activePrompts: 0, testedPrompts: 0 }, referrals: { activeCodes: 0 }, revenue: { stripe: "FAILING", events: 0 } },
      { ...READY, bing: "NOT_CONNECTED", publicSite: { enabled: true, orgSlug: "x", listed: false }, aiVisibility: { providerConfigured: true, activePrompts: 2, testedPrompts: 1 }, revenue: { stripe: "CONNECTED", events: 0 } },
      { ...READY, knowledge: { completeness: 0.8, facts: 20, verified: 0 }, aiVisibility: { providerConfigured: false, activePrompts: 1, testedPrompts: 0 }, revenue: { stripe: "NOT_CONNECTED", events: 0 } },
    ];
    const keys = new Set<string>([...ONBOARDING_FLOW.map((s) => s.label), ...INFO_PARTS.map((p) => p.label), "Not connected", "No data yet", "No results for these filters", "Not generated yet", "PRE LAUNCH", "LAUNCH", "POST LAUNCH", "OFF"]);
    for (const f of facts) for (const i of launchChecklist(f)) keys.add(i.label).add(i.evidence.text);
    expect([...keys].filter((k) => FR[k] === undefined)).toEqual([]);
  });
});
