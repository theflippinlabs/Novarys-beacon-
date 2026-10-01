import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeHtml, analyzeSite, emptyFacts, normalizeUrl, type PageFacts } from "@/core/seo/analyze";
import { isAllowed, parseRobots } from "@/core/seo/robots";
import { buildSitemap, buildSitemapIndex, parseSitemap } from "@/core/seo/sitemap";
import { faqPageJsonLd, howToJsonLd, organizationJsonLd, serializeJsonLd, softwareApplicationJsonLd, breadcrumbJsonLd, articleJsonLd } from "@/core/seo/schema-org";
import { makeFacet, makeGraph, makePricing } from "./fixtures/graph";

const URL0 = "https://acme.example/product";
const WORDS = Array.from({ length: 220 }, (_, i) => `word${i}`).join(" ");

function page(opts: { head?: string; body?: string; lang?: boolean } = {}) {
  const head =
    opts.head ??
    `<title>Acme | live moderation for TikTok</title>
     <meta name="description" content="Acme hides spam and abusive comments in TikTok live chats in real time.">
     <link rel="canonical" href="${URL0}">
     <meta name="viewport" content="width=device-width">
     <meta property="og:title" content="Acme"><meta property="og:description" content="Acme"><meta property="og:image" content="https://acme.example/og.png">
     <meta name="twitter:card" content="summary">
     <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme","url":"https://acme.example/"},{"@type":["SoftwareApplication","WebApplication"],"name":"Acme","offers":{"@type":"Offer","price":"0","priceCurrency":"EUR"}}]}</script>`;
  const body = opts.body ?? `<h1>Acme</h1><h2>Features</h2><h3>Filters</h3><p>${WORDS}</p><a href="/pricing">Pricing</a>`;
  return `<!doctype html><html${opts.lang === false ? "" : ' lang="en"'}><head>${head}</head><body>${body}</body></html>`;
}

const run = (html: string, extra: Partial<Parameters<typeof analyzeHtml>[0]> = {}) =>
  analyzeHtml({ url: URL0, status: 200, html, headers: {}, bytes: html.length, loadMs: 100, ...extra });
const rules = (r: ReturnType<typeof run>) => r.issues.map((i) => i.rule);

afterEach(() => vi.useRealTimers());

describe("normalizeUrl", () => {
  it("resolves relative URLs, strips hash, tracking params and trailing slashes", () => {
    expect(normalizeUrl("/pricing/?utm_source=x&gclid=1&fbclid=2&ref=abc&mc_eid=3&plan=pro#top", URL0)).toBe("https://acme.example/pricing?plan=pro");
    expect(normalizeUrl("https://acme.example/", URL0)).toBe("https://acme.example/");
    expect(normalizeUrl("docs//", URL0)).toBe("https://acme.example/docs");
    // "ref" is only stripped as an exact key.
    expect(normalizeUrl("/x?referrer=1", URL0)).toBe("https://acme.example/x?referrer=1");
  });

  it("rejects non-http(s) and invalid URLs", () => {
    expect(normalizeUrl("mailto:hi@acme.example", URL0)).toBeNull();
    expect(normalizeUrl("javascript:alert(1)", URL0)).toBeNull();
    expect(normalizeUrl("http://[bad", URL0)).toBeNull();
  });
});

describe("analyzeHtml", () => {
  it("reports no structural issues for a well-formed page and extracts facts", () => {
    const r = run(page());
    expect(r.issues).toEqual([]);
    expect(r.facts).toMatchObject({
      title: "Acme | live moderation for TikTok",
      canonical: URL0,
      indexable: true,
      robotsMeta: null,
      h1: ["Acme"],
      internalLinks: ["https://acme.example/pricing"],
      externalLinks: [],
    });
    expect(r.facts.structuredDataTypes).toEqual(["Organization", "SoftwareApplication", "WebApplication"]);
    expect(r.facts.wordCount).toBeGreaterThanOrEqual(220);
  });

  it("flags missing title, meta description, h1, canonical, lang and viewport", () => {
    const r = run(page({ head: "", body: `<p>${WORDS}</p>`, lang: false }));
    const got = rules(r);
    for (const rule of ["meta.title_missing", "meta.description_missing", "headings.h1_missing", "canonical.missing", "a11y.html_lang", "mobile.viewport", "social.og_title", "social.twitter_card"])
      expect(got).toContain(rule);
    expect(r.issues.find((i) => i.rule === "meta.title_missing")?.severity).toBe("HIGH");
    expect(r.facts.title).toBeNull();
    expect(r.facts.metaDescription).toBeNull();
  });

  it("flags multiple h1 and skipped heading levels", () => {
    const r = run(page({ body: `<h1>A</h1><h1>B</h1><h2>x</h2><h4>y</h4><p>${WORDS}</p>` }));
    expect(rules(r)).toContain("headings.h1_multiple");
    expect(rules(r)).toContain("headings.hierarchy");
    expect(rules(run(page()))).not.toContain("headings.hierarchy");
  });

  it("flags noindex from meta robots or X-Robots-Tag and marks the page non-indexable", () => {
    const meta = run(page({ head: page().match(/<head>([\s\S]*)<\/head>/)![1] + '<meta name="robots" content="NOINDEX, follow">' }));
    expect(rules(meta)).toContain("robots.noindex");
    expect(meta.facts.indexable).toBe(false);
    expect(meta.facts.robotsMeta).toBe("noindex, follow");
    const header = run(page(), { headers: { "x-robots-tag": "noindex" } });
    expect(header.issues.find((i) => i.rule === "robots.noindex")?.severity).toBe("HIGH");
  });

  it("flags cross-domain and relative canonicals", () => {
    const cross = run(page({ head: '<title>Acme | live moderation for TikTok</title><link rel="canonical" href="https://other.example/p">' }));
    expect(rules(cross)).toContain("canonical.cross_domain");
    expect(cross.facts.indexable).toBe(false);
    const rel = run(page({ head: '<title>Acme | live moderation for TikTok</title><link rel="canonical" href="/product">' }));
    expect(rules(rel)).toContain("canonical.relative");
    expect(rules(rel)).not.toContain("canonical.cross_domain");
    expect(rel.facts.canonical).toBe(URL0);
    expect(rel.facts.indexable).toBe(true);
  });

  it("counts images without alt (empty alt is fine) and without dimensions", () => {
    const r = run(page({ body: `<h1>A</h1><p>${WORDS}</p><img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt="c" width="1" height="1">` }));
    const alt = r.issues.find((i) => i.rule === "images.alt_missing");
    expect(alt?.details).toEqual({ count: 1, images: ["/a.png"] });
    expect(alt?.params).toEqual({ count: 1, total: 3 });
    expect(alt?.message).toBe("1 of 3 images have no alt attribute.");
    expect(r.issues.find((i) => i.rule === "images.dimensions")?.message).toMatch(/^2 images/);
  });

  it("flags unparseable JSON-LD", () => {
    const r = run(page({ head: '<title>Acme | live moderation for TikTok</title><script type="application/ld+json">{not json</script>' }));
    expect(rules(r)).toContain("schema.invalid_json");
    expect(r.facts.structuredDataTypes).toEqual([]);
  });

  it("validates hreflang values and self reference", () => {
    const r = run(
      page({
        head: `<title>Acme | live moderation for TikTok</title><link rel="alternate" hreflang="english" href="https://acme.example/en"><link rel="alternate" hreflang="de-DE" href="https://acme.example/de">`,
      }),
    );
    const invalid = r.issues.find((i) => i.rule === "hreflang.invalid");
    expect(invalid?.message).toContain("english");
    expect(invalid?.message).not.toContain("de-DE");
    expect(rules(r)).toContain("hreflang.self");
    const ok = run(page({ head: `<title>Acme | live moderation for TikTok</title><link rel="alternate" hreflang="x-default" href="${URL0}"><link rel="alternate" hreflang="zh-Hant" href="https://acme.example/zh">` }));
    expect(rules(ok)).not.toContain("hreflang.invalid");
    expect(rules(ok)).not.toContain("hreflang.self");
  });

  it("flags mixed content only on https pages", () => {
    const html = page({ body: `<h1>A</h1><p>${WORDS}</p><img src="http://cdn.example/a.png" alt="a" width="1" height="1"><script src="http://cdn.example/x.js"></script>` });
    expect(run(html).issues.find((i) => i.rule === "security.mixed_content")?.message).toMatch(/^2 resources/);
    expect(rules(analyzeHtml({ url: "http://acme.example/product", status: 200, html, headers: {}, bytes: 1, loadMs: 1 }))).not.toContain("security.mixed_content");
  });

  it("flags thin content (ignoring script text) only for successful responses", () => {
    const thin = run(page({ body: "<h1>A</h1>\n<p>only a few words</p><script>var lots = 'of words that do not count at all';</script>" }));
    expect(thin.facts.wordCount).toBe(5);
    expect(thin.issues.find((i) => i.rule === "content.thin")?.details).toEqual({ wordCount: 5 });
    const err = run(page({ body: "<h1>Not found</h1>" }), { status: 404 });
    expect(rules(err)).not.toContain("content.thin");
    expect(err.issues.find((i) => i.rule === "http.error")?.severity).toBe("HIGH");
    expect(run(page(), { status: 503 }).issues.find((i) => i.rule === "http.server_error")?.severity).toBe("CRITICAL");
    expect(rules(run(page(), { status: 503 }))).not.toContain("http.error");
  });

  it("flags heavy pages, slow responses and redirect chains", () => {
    const r = run(page(), { bytes: 2_000_000, loadMs: 3000, redirects: ["http://acme.example/a", "https://acme.example/a"] });
    expect(rules(r)).toEqual(expect.arrayContaining(["speed.page_weight", "speed.server_response", "http.redirect_chain"]));
    expect(rules(run(page(), { redirects: ["http://acme.example/"] }))).not.toContain("http.redirect_chain");
  });

  it("flags stale content relative to the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    expect(rules(run(page(), { headers: { "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" } }))).toContain("content.stale");
    expect(rules(run(page(), { headers: { "last-modified": "Mon, 01 May 2026 00:00:00 GMT" } }))).not.toContain("content.stale");
  });

  it("normalises internal/external links and skips sponsored and non-http links", () => {
    const r = run(
      page({
        body: `<h1>A</h1><p>${WORDS}</p>
        <a href="/pricing/?utm_source=nl#plans">p</a><a href="https://acme.example/pricing">p2</a>
        <a href="https://partner.example/x?utm_medium=y&id=2">ext</a>
        <a href="https://ads.example/" rel="Sponsored nofollow">ad</a>
        <a href="mailto:hi@acme.example">mail</a><a href="#top">top</a>`,
      }),
    );
    expect(r.facts.internalLinks.sort()).toEqual(["https://acme.example/pricing", "https://acme.example/product"]);
    expect(r.facts.externalLinks).toEqual(["https://partner.example/x?id=2"]);
  });
});

function facts(url: string, over: Partial<PageFacts> = {}): PageFacts {
  return emptyFacts(url, {
    status: 200,
    title: `${url.split("/").pop() || "home"} overview page`,
    metaDescription: `Description ${url}`,
    canonical: url,
    indexable: true,
    indexability: "INDEXABLE",
    h1: ["x"],
    wordCount: 500,
    bytes: 1,
    loadMs: 1,
    ...over,
  });
}

describe("analyzeSite", () => {
  const HOME = "https://acme.example/";
  const A = "https://acme.example/a";
  const B = "https://acme.example/b";
  const C = "https://acme.example/c";

  it("finds duplicate titles/descriptions, orphans, broken links, sitemap issues and missing entity schema", () => {
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [A, C, "https://acme.example/not-crawled"],
      pages: [
        facts(HOME, { internalLinks: [A, C, HOME] }),
        facts(A, { title: "Same", metaDescription: "Same desc", internalLinks: [A] }),
        facts(B, { title: "Same", metaDescription: "Same desc" }),
        facts(C, { status: 404 }),
      ],
    });
    const by = (rule: string) => issues.filter((i) => i.rule === rule).map((i) => i.url).sort();
    expect(by("duplicate.title")).toEqual([A, B]);
    expect(by("duplicate.description")).toEqual([A, B]);
    // B has no inlinks; A's self link does not count but home links to it; home itself is exempt.
    expect(by("links.orphan")).toEqual([B]);
    expect(by("links.broken_internal")).toEqual([HOME]);
    expect(issues.find((i) => i.rule === "links.broken_internal")?.details).toEqual({ target: C });
    expect(by("sitemap.not_found_entry")).toEqual([C]);
    expect(issues.find((i) => i.rule === "sitemap.unchecked")?.params).toEqual({ count: 1 });
    expect(by("schema.entity_missing")).toEqual([HOME]);
  });

  it("treats a self-link as not preventing orphan status and accepts entity schema on the homepage", () => {
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [A],
      pages: [facts(HOME, { structuredDataTypes: ["Organization"] }), facts(A, { internalLinks: [A], indexable: false, indexability: "NOINDEX_META" })],
    });
    expect(issues.map((i) => i.rule).sort()).toEqual(["links.orphan", "sitemap.non_indexable_entry"]);
    expect(issues.find((i) => i.rule === "sitemap.non_indexable_entry")?.message).toBe("Sitemap lists a non-indexable URL (noindex in the robots meta tag).");
  });
});

describe("robots.txt", () => {
  const txt = `
# comment
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Disallow: /tmp/*/cache

User-agent: Googlebot
User-agent: Bingbot
Disallow: /no-google

Sitemap: https://acme.example/sitemap.xml
`;
  const rules = parseRobots(txt);

  it("parses groups (consecutive user-agents share a group) and sitemaps", () => {
    expect(rules.groups).toHaveLength(2);
    expect(rules.groups[1].agents).toEqual(["googlebot", "bingbot"]);
    expect(rules.sitemaps).toEqual(["https://acme.example/sitemap.xml"]);
  });

  it("applies longest-match semantics", () => {
    expect(isAllowed(rules, "/")).toBe(true);
    expect(isAllowed(rules, "/private/x")).toBe(false);
    expect(isAllowed(rules, "/private/public/doc")).toBe(true);
  });

  it("supports * wildcards and the $ end anchor", () => {
    expect(isAllowed(rules, "/files/report.pdf")).toBe(false);
    expect(isAllowed(rules, "/files/report.pdf?download=1")).toBe(true);
    expect(isAllowed(rules, "/tmp/a/cache/x")).toBe(false);
    expect(isAllowed(rules, "/tmp/a/other")).toBe(true);
  });

  it("uses the agent-specific group instead of *", () => {
    expect(isAllowed(rules, "/no-google", "Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(false);
    // The Googlebot group does not inherit * rules.
    expect(isAllowed(rules, "/private/x", "Googlebot")).toBe(true);
    expect(isAllowed(rules, "/no-google", "SomeOtherBot")).toBe(true);
  });

  it("allows everything with no rules or an empty Disallow", () => {
    expect(isAllowed(parseRobots(""), "/anything")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/anything")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /"), "/anything")).toBe(false);
  });

  it("prefers allow when allow and disallow patterns tie in length", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /page\nAllow: /page"), "/page")).toBe(true);
  });
});

describe("sitemaps", () => {
  it("parses urlset, index and invalid documents", () => {
    expect(parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc> https://a.example/ </loc></url><url><loc>https://a.example/b</loc></url></urlset>`)).toEqual({
      kind: "urlset",
      locs: ["https://a.example/", "https://a.example/b"],
    });
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://a.example/s1.xml</loc></sitemap></sitemapindex>`)).toEqual({ kind: "index", locs: ["https://a.example/s1.xml"] });
    expect(parseSitemap("<html><body>nope</body></html>")).toEqual({ kind: "invalid", locs: [] });
  });

  it("builds a sitemap with XML escaping and round-trips through the parser", () => {
    const xml = buildSitemap([{ loc: "https://a.example/?a=1&b=<2>", lastmod: "2026-01-01" }, { loc: "https://a.example/c" }]);
    expect(xml).toContain("<loc>https://a.example/?a=1&amp;b=&lt;2&gt;</loc>");
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).not.toContain("xmlns:xhtml");
    expect(parseSitemap(xml)).toEqual({ kind: "urlset", locs: ["https://a.example/?a=1&b=<2>", "https://a.example/c"] });
  });

  it("emits hreflang alternates with the xhtml namespace", () => {
    const xml = buildSitemap([{ loc: "https://a.example/en", alternates: [{ hreflang: "de", href: "https://a.example/de?x=1&y=2" }] }]);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="de" href="https://a.example/de?x=1&amp;y=2"/>');
  });

  it("builds a sitemap index", () => {
    const xml = buildSitemapIndex([{ loc: "https://a.example/s1.xml", lastmod: "2026-01-01" }]);
    expect(parseSitemap(xml)).toEqual({ kind: "index", locs: ["https://a.example/s1.xml"] });
  });
});

describe("schema.org JSON-LD", () => {
  it("includes only verified, known prices as offers", () => {
    const g = makeGraph({
      product: { domain: "acme.example", shortDescription: "Live moderation.", category: "Moderation" },
      facets: [makeFacet("FEATURE", "Keyword filters"), makeFacet("FEATURE", "Nope", { verification: "REJECTED" })],
      pricing: [
        makePricing({ planName: "Pro", priceCents: 4900, interval: "MONTH" }),
        makePricing({ planName: "Unverified", priceCents: 9900, verification: "UNVERIFIED" }),
        makePricing({ planName: "Enterprise", priceCents: null }),
      ],
    });
    const ld = softwareApplicationJsonLd(g, { url: "https://acme.example/acme", publisher: "Acme Inc" });
    expect(ld["@type"]).toBe("WebApplication");
    expect(ld.offers).toEqual({
      "@type": "Offer",
      name: "Pro",
      price: "49.00",
      priceCurrency: "EUR",
      priceSpecification: { "@type": "UnitPriceSpecification", price: "49.00", priceCurrency: "EUR", billingDuration: "P1M", unitCode: "MON" },
    });
    expect(ld.featureList).toEqual(["Keyword filters"]);
    expect(ld.publisher).toEqual({ "@type": "Organization", name: "Acme Inc" });
    expect(JSON.stringify(ld)).not.toContain("99.00");
  });

  it("omits unknown values, empty arrays and offers when none qualify or are hidden", () => {
    const ld = softwareApplicationJsonLd(makeGraph({ pricing: [makePricing({ priceCents: null })] }), { url: "https://x.example" });
    expect(ld).toEqual({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Acme", url: "https://x.example" });
    const hidden = softwareApplicationJsonLd(makeGraph({ pricing: [makePricing()] }), { url: "u", visibleOffers: false });
    expect(hidden.offers).toBeUndefined();
    const two = softwareApplicationJsonLd(makeGraph({ pricing: [makePricing(), makePricing({ planName: "Year", interval: "YEAR", priceCents: 49000 })] }), { url: "u" });
    expect(Array.isArray(two.offers)).toBe(true);
    expect((two.offers as { priceSpecification: { billingDuration: string } }[])[1].priceSpecification.billingDuration).toBe("P1Y");
  });

  it("faqPageJsonLd returns null on empty input", () => {
    expect(faqPageJsonLd([])).toBeNull();
    const ld = faqPageJsonLd([{ question: "Q?", answer: "A." }])!;
    expect(ld.mainEntity).toEqual([{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } }]);
  });

  it("howToJsonLd requires at least two steps", () => {
    expect(howToJsonLd("x", [])).toBeNull();
    expect(howToJsonLd("x", ["one"])).toBeNull();
    expect((howToJsonLd("x", ["one", "two"])!.step as unknown[]).length).toBe(2);
  });

  it("serializeJsonLd cannot break out of a script tag", () => {
    const s = serializeJsonLd({ name: "</script><script>alert(1)</script>", q: "a & b" });
    expect(s).not.toContain("</script>");
    expect(s).not.toContain("<");
    expect(s).not.toContain("&");
    expect(JSON.parse(s)).toEqual({ name: "</script><script>alert(1)</script>", q: "a & b" });
  });

  it("other builders", () => {
    expect(organizationJsonLd({ name: "Acme", url: null, sameAs: [] })).toEqual({ "@context": "https://schema.org", "@type": "Organization", name: "Acme" });
    expect(breadcrumbJsonLd([{ name: "A", url: "u1" }, { name: "B", url: "u2" }]).itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "A", item: "u1" },
      { "@type": "ListItem", position: 2, name: "B", item: "u2" },
    ]);
    const art = articleJsonLd({ headline: "h".repeat(200), url: "u", publisher: "P", datePublished: "2026-01-01" });
    expect((art.headline as string).length).toBe(110);
    expect(art.dateModified).toBe("2026-01-01");
  });
});
