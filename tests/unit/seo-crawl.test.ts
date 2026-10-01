import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyzeHtml, analyzeSite, contentHash, emptyFacts, nearDuplicateTitles, normalizeVisibleText, weakTitleKind, type PageFacts } from "@/core/seo/analyze";
import { CrawlAbortError, crawlSite, withDeadline, type CrawlResponse, type Fetcher } from "@/core/seo/crawl";
import { diffAudits } from "@/core/seo/diff";
import { fileBodyMatches, hostCoveredBy, isLocalDevHost, isVerifiableDomain, normalizeDomain, registrableDomain, txtRecordsMatch } from "@/core/seo/domains";
import { relatedPages, suggestLinks, titleCore, type LinkPage } from "@/core/seo/link-suggest";
import { BEACON_ROBOTS_TOKEN, crawlDelayMs, isAllowed, parseRobots, robotsPolicy } from "@/core/seo/robots";
import { catalogueStrings, issueFingerprint, renderDetail, RULES } from "@/core/seo/rules";
import { decodeSitemapBody, parseSitemapDetailed, SitemapDecodeError } from "@/core/seo/sitemap";
import { validateJsonLd } from "@/core/seo/structured-data";
import { makeT, placeholders } from "@/i18n/core";
import { FR } from "@/i18n/fr";
import { fr as p2crawl } from "@/i18n/fr/p2crawl";

const SITE = "https://site.example";
const html = (title: string, body = "", head = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="A description that is long enough for the meta description length rule."><link rel="canonical" href="__SELF__">${head}</head><body><h1>${title}</h1>${body}</body></html>`;

type Route = { status: number; body?: string; type?: string; location?: string; raw?: Buffer; headers?: Record<string, string> };

/** In-memory site: follows `location` redirects like safeFetch does (recording hops and their statuses). */
function site(routes: Record<string, Route | (() => Route)>, log: string[] = []): Fetcher {
  return async (url) => {
    const redirects: string[] = [];
    const redirectStatuses: number[] = [];
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      log.push(current);
      const u = new URL(current);
      const def = routes[u.pathname + u.search] ?? routes[u.pathname];
      const r = typeof def === "function" ? def() : def ?? { status: 404, body: "<h1>Not found</h1>", type: "text/html" };
      if (r.location) {
        redirects.push(current);
        redirectStatuses.push(r.status);
        current = new URL(r.location, current).toString();
        continue;
      }
      const body = (r.body ?? "").replace(/__SELF__/g, current);
      const res: CrawlResponse = { url: current, status: r.status, headers: { "content-type": r.type ?? "text/html", ...(r.headers ?? {}) }, body, bytes: body.length, elapsedMs: 1, redirects, redirectStatuses, truncated: false, raw: r.raw ?? Buffer.from(body) };
      return res;
    }
    throw new Error("Too many redirects");
  };
}

const urlset = (locs: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc><lastmod>2026-09-0${(l.length % 9) + 1}</lastmod></url>`).join("")}</urlset>`;
const index = (locs: string[]) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
const noSleep = async () => undefined;

describe("robots.txt for Beacon's token", () => {
  const rules = parseRobots(`User-agent: *\nDisallow: /private\nCrawl-delay: 1\n\nUser-agent: novarysbeacon\nDisallow: /no-beacon\nCrawl-delay: 3\n\nUser-agent: Googlebot\nDisallow: /no-google\n`);

  it("uses the NovarysBeacon group (case-insensitive) and falls back to *", () => {
    expect(isAllowed(rules, "/no-beacon", BEACON_ROBOTS_TOKEN)).toBe(false);
    // The Beacon group does not inherit "*" rules.
    expect(isAllowed(rules, "/private", BEACON_ROBOTS_TOKEN)).toBe(true);
    expect(isAllowed(rules, "/no-google", BEACON_ROBOTS_TOKEN)).toBe(true);
    const star = parseRobots("User-agent: *\nDisallow: /private");
    expect(isAllowed(star, "/private", BEACON_ROBOTS_TOKEN)).toBe(false);
  });

  it("reads Crawl-delay for the matching group, capped at 10 s, never below the default", () => {
    expect(crawlDelayMs(rules, BEACON_ROBOTS_TOKEN)).toBe(3000);
    expect(crawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: 60"))).toBe(10_000);
    expect(crawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: 0.05"))).toBe(200);
    expect(crawlDelayMs(null)).toBe(200);
    expect(crawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: nope"))).toBe(200);
  });

  it("maps robots.txt statuses per RFC 9309", () => {
    expect(robotsPolicy(200)).toBe("PARSE");
    expect(robotsPolicy(404)).toBe("ALLOW_ALL");
    expect(robotsPolicy(401)).toBe("ALLOW_ALL");
    expect(robotsPolicy(429)).toBe("DISALLOW_ALL");
    expect(robotsPolicy(500)).toBe("DISALLOW_ALL");
    expect(robotsPolicy(503)).toBe("DISALLOW_ALL");
    expect(robotsPolicy(null)).toBe("DISALLOW_ALL");
  });
});

describe("crawlSite", () => {
  it("stops with a clear error when robots.txt returns 5xx or cannot be fetched", async () => {
    await expect(crawlSite(`${SITE}/`, { fetcher: site({ "/robots.txt": { status: 503 } }), sleep: noSleep })).rejects.toThrow(CrawlAbortError);
    await expect(crawlSite(`${SITE}/`, { fetcher: site({ "/robots.txt": { status: 500 } }), sleep: noSleep })).rejects.toThrow(/HTTP 500.*fully disallowed/);
    await expect(crawlSite(`${SITE}/`, { fetcher: async () => Promise.reject(new Error("ECONNREFUSED")), sleep: noSleep })).rejects.toThrow(/could not be fetched \(ECONNREFUSED\)/);
  });

  it("treats a 4xx robots.txt as allow-all and reports robots.missing as LOW", async () => {
    const r = await crawlSite(`${SITE}/`, { fetcher: site({ "/": { status: 200, body: html("Home page of the site") } }), sleep: noSleep });
    expect(r.robots).toBeNull();
    const missing = r.issues.find((i) => i.rule === "robots.missing")!;
    expect(missing.severity).toBe("LOW");
    expect(missing.params).toEqual({ status: 404 });
    expect(r.pages.map((p) => p.url)).toEqual([`${SITE}/`]);
  });

  it("records robots-blocked URLs (INFO, counted) and honours Crawl-delay with the injected sleep", async () => {
    const slept: number[] = [];
    const log: string[] = [];
    const r = await crawlSite(`${SITE}/`, {
      fetcher: site(
        {
          "/robots.txt": { status: 200, body: "User-agent: NovarysBeacon\nDisallow: /secret\nCrawl-delay: 2\n" },
          "/": { status: 200, body: html("Home page of the site", '<a href="/a">A</a> <a href="/secret">S</a> <a href="/secret/2">S2</a>') },
          "/a": { status: 200, body: html("Page A of the site", '<a href="/">Home</a>') },
        },
        log,
      ),
      sleep: async (ms) => void slept.push(ms),
    });
    expect(log).not.toContain(`${SITE}/secret`);
    expect(r.robotsBlocked.sort()).toEqual([`${SITE}/secret`, `${SITE}/secret/2`]);
    const blocked = r.issues.filter((i) => i.rule === "robots.blocked_url");
    expect(blocked).toHaveLength(2);
    expect(blocked.every((i) => i.severity === "INFO")).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
    expect(slept).toEqual([2000]);
  });

  it("enforces a hard per-request deadline", async () => {
    const r = await crawlSite(`${SITE}/`, {
      fetcher: (url) => (url.endsWith("/slow") ? new Promise(() => undefined) : site({ "/": { status: 200, body: html("Home page of the site", '<a href="/slow">slow</a>') } })(url)),
      requestDeadlineMs: 30,
      sleep: noSleep,
    });
    const slow = r.issues.find((i) => i.rule === "http.unreachable")!;
    expect(slow.url).toBe(`${SITE}/slow`);
    expect(slow.message).toMatch(/deadline/);
    await expect(withDeadline(Promise.resolve(1), 10, "x")).resolves.toBe(1);
  });

  it("keeps a redirect map: redirect sources are recorded with their status, links and sitemap entries to redirects are matched", async () => {
    const r = await crawlSite(`${SITE}/`, {
      fetcher: site({
        "/robots.txt": { status: 200, body: `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml` },
        "/sitemap.xml": { status: 200, type: "application/xml", body: urlset([`${SITE}/`, `${SITE}/old`, `${SITE}/chain`]) },
        "/": { status: 200, body: html("Home page of the site", '<a href="/old">Old</a> <a href="/new">New</a>') },
        "/old": { status: 301, location: "/new" },
        "/chain": { status: 302, location: "/hop" },
        "/hop": { status: 301, location: "/new" },
        "/new": { status: 200, body: html("The new page of the site", '<a href="/">Home</a>') },
      }),
      sleep: noSleep,
    });
    const old = r.pages.find((p) => p.url === `${SITE}/old`)!;
    expect(old).toMatchObject({ status: 301, finalUrl: `${SITE}/new`, indexability: "REDIRECT", redirectChain: [`${SITE}/old`, `${SITE}/new`] });
    expect(r.redirects.get(`${SITE}/chain`)).toBe(`${SITE}/new`);
    expect(r.pages.filter((p) => p.url === `${SITE}/new`)).toHaveLength(1);
    const by = (rule: string) => r.issues.filter((i) => i.rule === rule).map((i) => i.url).sort();
    expect(by("sitemap.redirect_entry")).toEqual([`${SITE}/chain`, `${SITE}/old`]);
    expect(by("links.to_redirect")).toEqual([`${SITE}/`]);
    expect(by("http.redirect_chain")).toEqual([`${SITE}/chain`]);
    // The final page is reached through the redirect: it is not an orphan and has click depth 1.
    expect(by("links.orphan")).toEqual([]);
    expect(r.pages.find((p) => p.url === `${SITE}/new`)!.depth).toBe(1);
    expect(r.pages.find((p) => p.url === `${SITE}/`)!.depth).toBe(0);
  });

  it("reads gzip sitemaps and sitemap indexes two levels deep, rejects deeper nesting, and snapshots each document", async () => {
    const gz = gzipSync(Buffer.from(urlset([`${SITE}/a`])));
    const r = await crawlSite(`${SITE}/`, {
      maxPages: 1,
      fetcher: site({
        "/robots.txt": { status: 200, body: `Sitemap: ${SITE}/root.xml\nSitemap: ${SITE}/deep0.xml` },
        "/root.xml": { status: 200, type: "application/xml", body: index([`${SITE}/level1.xml`]) },
        "/level1.xml": { status: 200, type: "application/xml", body: index([`${SITE}/pages.xml.gz`, `${SITE}/gone.xml`]) },
        "/pages.xml.gz": { status: 200, type: "application/gzip", raw: gz },
        "/gone.xml": { status: 404 },
        "/deep0.xml": { status: 200, type: "application/xml", body: index([`${SITE}/deep1.xml`]) },
        "/deep1.xml": { status: 200, type: "application/xml", body: index([`${SITE}/deep2.xml`]) },
        "/deep2.xml": { status: 200, type: "application/xml", body: index([`${SITE}/deep3.xml`]) },
        "/": { status: 200, body: html("Home page of the site") },
      }),
      sleep: noSleep,
    });
    expect(r.sitemapUrls).toEqual([`${SITE}/a`]);
    const snap = r.sitemaps.find((s) => s.sitemapUrl.endsWith("pages.xml.gz"))!;
    expect(snap).toMatchObject({ kind: "urlset", compressed: true, urlCount: 1, parentUrl: `${SITE}/level1.xml` });
    expect(snap.lastmodMax).toMatch(/^2026-09/);
    expect(r.sitemaps.find((s) => s.sitemapUrl.endsWith("gone.xml"))).toMatchObject({ status: 404, kind: "error" });
    expect(r.issues.find((i) => i.rule === "sitemap.child_error")?.url).toBe(`${SITE}/gone.xml`);
    expect(r.issues.find((i) => i.rule === "sitemap.invalid")).toMatchObject({ url: `${SITE}/deep2.xml`, params: { reason: "TOO_DEEP" } });
    // /a is listed but the budget (1 page) was spent on the start URL.
    expect(r.issues.find((i) => i.rule === "sitemap.unchecked")?.params).toEqual({ count: 1 });
  });
});

describe("gzip sitemap decoding", () => {
  it("decompresses gzip and caps the decompressed size", () => {
    const xml = urlset([`${SITE}/x`]);
    expect(decodeSitemapBody(gzipSync(Buffer.from(xml)))).toEqual({ xml, compressed: true });
    expect(decodeSitemapBody(Buffer.from(xml))).toEqual({ xml, compressed: false });
    const bomb = gzipSync(Buffer.alloc(200_000, 0x20));
    expect(bomb.length).toBeLessThan(2000);
    expect(() => decodeSitemapBody(bomb, { maxBytes: 100_000 })).toThrow(SitemapDecodeError);
    try {
      decodeSitemapBody(bomb, { maxBytes: 100_000 });
    } catch (e) {
      expect((e as SitemapDecodeError).reason).toBe("TOO_LARGE");
    }
    expect(() => decodeSitemapBody(Buffer.from([0x1f, 0x8b, 1, 2, 3]))).toThrow(/could not be decompressed/);
    expect(() => decodeSitemapBody(Buffer.alloc(2000, 0x20), { maxBytes: 1000 })).toThrow(/larger than 50 MB/);
  });

  it("parses lastmod per entry", () => {
    expect(parseSitemapDetailed(`<urlset><url><loc>https://a.example/</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://a.example/b</loc></url></urlset>`)).toEqual({
      kind: "urlset",
      entries: [
        { loc: "https://a.example/", lastmod: "2026-01-02" },
        { loc: "https://a.example/b", lastmod: null },
      ],
    });
  });
});

describe("page facts", () => {
  it("normalises visible text before hashing", () => {
    expect(normalizeVisibleText("  Hello\n\tWORLD  ")).toBe("hello world");
    expect(contentHash("Hello   world")).toBe(contentHash("hello WORLD\n"));
    expect(contentHash("Hello world")).not.toBe(contentHash("Hello there"));
    expect(contentHash("   ")).toBeNull();
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts headings, links with anchors and nofollow, images, OpenGraph/Twitter, X-Robots-Tag and JSON-LD validation", () => {
    const r = analyzeHtml({
      url: `${SITE}/p`,
      status: 200,
      headers: { "x-robots-tag": "noindex" },
      bytes: 1,
      loadMs: 1,
      html: `<html lang="en"><head><title>Page title for the test</title><meta property="og:title" content="OG"><meta property="og:site_name" content="Site"><meta name="twitter:card" content="summary">
        <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script><script type="application/ld+json">{oops</script></head>
        <body><h1>Main</h1><h2>Sub</h2><h4>Deep</h4><a href="/x" rel="nofollow">Go to X</a><a href="https://other.example/">Other</a><img src="/i.png" alt="i" width="1"><p>Some words here.</p></body></html>`,
    });
    expect(r.facts.headings).toEqual([
      { level: 1, text: "Main" },
      { level: 2, text: "Sub" },
      { level: 4, text: "Deep" },
    ]);
    expect(r.issues.find((i) => i.rule === "headings.hierarchy")?.params).toEqual({ from: 2, to: 4 });
    expect(r.facts.links).toEqual([
      { href: `${SITE}/x`, anchor: "Go to X", nofollow: true, internal: true },
      { href: "https://other.example/", anchor: "Other", nofollow: false, internal: false },
    ]);
    expect(r.facts.images).toEqual([{ src: `${SITE}/i.png`, alt: "i", hasWidth: true, hasHeight: false }]);
    expect(r.facts.openGraph).toEqual({ "og:title": "OG", "og:site_name": "Site" });
    expect(r.facts.twitter).toEqual({ "twitter:card": "summary" });
    expect(r.facts).toMatchObject({ xRobotsTag: "noindex", robotsMeta: null, indexable: false, indexability: "NOINDEX_HEADER" });
    expect(r.issues.find((i) => i.rule === "robots.noindex")?.params).toEqual({ source: "HEADER", value: "noindex" });
    expect(r.facts.jsonLd).toHaveLength(2);
    expect(r.facts.jsonLd[0]).toEqual({ valid: true, types: ["FAQPage"], missing: [{ type: "FAQPage", property: "mainEntity" }] });
    expect(r.facts.jsonLd[1].valid).toBe(false);
    expect(r.issues.find((i) => i.rule === "schema.required_missing")?.params).toEqual({ type: "FAQPage", properties: "mainEntity" });
    expect(r.facts.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("structured data required properties", () => {
  it("checks Organization, Product, SoftwareApplication, FAQPage, Article and BreadcrumbList", () => {
    const miss = (o: unknown) => validateJsonLd(JSON.stringify(o)).missing.map((m) => `${m.type}.${m.property}`);
    expect(miss({ "@type": "Organization", name: "A" })).toEqual(["Organization.url"]);
    expect(miss({ "@type": "Product", name: "A" })).toEqual(["Product.offers | review | aggregateRating"]);
    expect(miss({ "@type": "Product", name: "A", offers: { price: "1" } })).toEqual([]);
    expect(miss({ "@type": "SoftwareApplication", name: "A" })).toEqual(["SoftwareApplication.offers"]);
    expect(miss({ "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }] })).toEqual(["FAQPage.mainEntity.name | acceptedAnswer.text"]);
    expect(miss({ "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { text: "A." } }] })).toEqual([]);
    expect(miss({ "@type": "Article", headline: "H" })).toEqual(["Article.author", "Article.datePublished"]);
    expect(miss({ "@type": "BreadcrumbList", itemListElement: [{ position: 1, name: "Home", item: "u" }] })).toEqual([]);
    expect(miss({ "@type": "BreadcrumbList", itemListElement: [{ name: "Home" }] })).toEqual(["BreadcrumbList.itemListElement.position | name"]);
    expect(miss({ "@graph": [{ "@type": "Organization", name: "A", url: "u" }, { "@type": "Thing" }] })).toEqual([]);
    expect(validateJsonLd("{bad").valid).toBe(false);
  });
});

const ok = (url: string, over: Partial<PageFacts> = {}): PageFacts =>
  emptyFacts(url, { status: 200, indexable: true, indexability: "INDEXABLE", canonical: url, title: `${url.split("/").pop() || "home"} unique words`, wordCount: 300, structuredDataTypes: ["Organization"], ...over });
const HOME = `${SITE}/`;
const rulesAt = (issues: ReturnType<typeof analyzeSite>, rule: string) => issues.filter((i) => i.rule === rule).map((i) => i.url).sort();

describe("site detections", () => {
  it("duplicate content by content hash (canonicalised duplicates excluded)", () => {
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [],
      pages: [ok(HOME, { internalLinks: [`${SITE}/a`, `${SITE}/b`, `${SITE}/c`] }), ok(`${SITE}/a`, { contentHash: "h1" }), ok(`${SITE}/b`, { contentHash: "h1" }), ok(`${SITE}/c`, { contentHash: "h1", indexability: "CANONICALISED", indexable: false, canonical: `${SITE}/a` })],
    });
    expect(rulesAt(issues, "duplicate.content")).toEqual([`${SITE}/a`, `${SITE}/b`]);
    expect(issues.find((i) => i.rule === "duplicate.content")?.params).toEqual({ others: 1 });
  });

  it("near-duplicate titles ignore brand words and numbers but not exact duplicates", () => {
    expect(nearDuplicateTitles([
      { url: "1", title: "Pricing plans | Acme" },
      { url: "2", title: "Pricing plans - Acme" },
      { url: "3", title: "Features | Acme" },
      { url: "4", title: "Blog page 2 | Acme" },
      { url: "5", title: "Blog page 3 | Acme" },
      { url: "6", title: "Features | Acme" },
    ], "Acme").map((g) => g.sort())).toEqual([["1", "2"], ["4", "5"]]);
  });

  it("weak titles: generic wording, or the bare site name on an inner page", () => {
    expect(weakTitleKind("Home", { isHome: true, siteName: "Acme" })).toBe("GENERIC");
    expect(weakTitleKind("  untitled ", { isHome: false, siteName: null })).toBe("GENERIC");
    expect(weakTitleKind("Acme", { isHome: false, siteName: "acme" })).toBe("SITE_NAME");
    expect(weakTitleKind("Acme", { isHome: true, siteName: "Acme" })).toBeNull();
    expect(weakTitleKind("Acme pricing plans", { isHome: false, siteName: "Acme" })).toBeNull();
    const issues = analyzeSite({ homepage: HOME, sitemapUrls: [], pages: [ok(HOME, { title: "Acme", openGraph: { "og:site_name": "Acme" }, internalLinks: [`${SITE}/x`] }), ok(`${SITE}/x`, { title: "Acme", h1: ["Acme"] })] });
    expect(issues.find((i) => i.rule === "meta.title_weak")).toMatchObject({ url: `${SITE}/x`, params: { title: "Acme", kind: "SITE_NAME" } });
  });

  it("canonical conflicts: to redirect, to error, to noindex, chains, and sitemap URLs canonicalised elsewhere", () => {
    const P = (p: string) => `${SITE}${p}`;
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [P("/a")],
      redirects: new Map([[P("/moved"), P("/final")]]),
      pages: [
        ok(HOME, { internalLinks: [P("/a"), P("/b"), P("/c"), P("/d")] }),
        ok(P("/a"), { canonical: P("/moved"), indexable: false, indexability: "CANONICALISED" }),
        emptyFacts(P("/moved"), { status: 301, indexability: "REDIRECT", finalUrl: P("/final") }),
        ok(P("/final")),
        ok(P("/b"), { canonical: P("/gone"), indexable: false, indexability: "CANONICALISED" }),
        emptyFacts(P("/gone"), { status: 404, indexability: "HTTP_STATUS" }),
        ok(P("/c"), { canonical: P("/hidden"), indexable: false, indexability: "CANONICALISED" }),
        ok(P("/hidden"), { indexable: false, indexability: "NOINDEX_META" }),
        ok(P("/d"), { canonical: P("/final2"), indexable: false, indexability: "CANONICALISED" }),
        ok(P("/final2"), { canonical: P("/final3"), indexable: false, indexability: "CANONICALISED" }),
      ],
    });
    expect(issues.find((i) => i.rule === "canonical.to_redirect")).toMatchObject({ url: P("/a"), params: { target: P("/moved"), final: P("/final") } });
    expect(issues.find((i) => i.rule === "canonical.to_error")).toMatchObject({ url: P("/b"), params: { status: 404 } });
    expect(rulesAt(issues, "canonical.to_noindex")).toEqual([P("/c")]);
    expect(issues.find((i) => i.rule === "canonical.chain")).toMatchObject({ url: P("/d"), params: { next: P("/final3") } });
    expect(issues.find((i) => i.rule === "sitemap.canonical_mismatch")).toMatchObject({ url: P("/a"), params: { canonical: P("/moved") } });
  });

  it("important pages that cannot be indexed: homepage and pages with search impressions", () => {
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [],
      impressions: new Map([[`${SITE}/seen`, 120], [`${SITE}/fine`, 5]]),
      pages: [ok(HOME, { indexable: false, indexability: "NOINDEX_META", internalLinks: [`${SITE}/seen`, `${SITE}/fine`] }), ok(`${SITE}/seen`, { status: 404, indexable: false, indexability: "HTTP_STATUS" }), ok(`${SITE}/fine`)],
    });
    expect(issues.find((i) => i.rule === "indexability.homepage")).toMatchObject({ severity: "CRITICAL", params: { reason: "NOINDEX_META" } });
    expect(issues.find((i) => i.rule === "indexability.impressions_page")).toMatchObject({ url: `${SITE}/seen`, params: { impressions: 120, reason: "HTTP_STATUS" } });
    expect(rulesAt(issues, "indexability.impressions_page")).toEqual([`${SITE}/seen`]);
  });

  it("hreflang reciprocity", () => {
    const en = `${SITE}/en`;
    const fr = `${SITE}/fr`;
    const de = `${SITE}/de`;
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [],
      pages: [
        ok(HOME, { internalLinks: [en, fr, de] }),
        ok(en, { hreflang: [{ lang: "en", href: en }, { lang: "fr", href: fr }, { lang: "de", href: de }] }),
        ok(fr, { hreflang: [{ lang: "fr", href: fr }, { lang: "en", href: en }] }),
        ok(de, { hreflang: [{ lang: "de", href: de }] }),
      ],
    });
    expect(issues.filter((i) => i.rule === "hreflang.no_return").map((i) => i.params)).toEqual([{ target: de, lang: "de" }]);
  });

  it("robots vs sitemap conflicts, important pages missing from the sitemap, unchecked entries", () => {
    const issues = analyzeSite({
      homepage: HOME,
      sitemapUrls: [HOME, `${SITE}/private/x`, `${SITE}/never`, `${SITE}/beacon-blocked`],
      robots: parseRobots("User-agent: *\nDisallow: /private"),
      blocked: new Set([`${SITE}/beacon-blocked`]),
      pages: [ok(HOME, { internalLinks: [`${SITE}/linked`] }), ok(`${SITE}/linked`)],
    });
    expect(issues.find((i) => i.rule === "sitemap.blocked_by_robots")).toMatchObject({ url: `${SITE}/private/x`, params: { agent: "Googlebot" } });
    expect(issues.find((i) => i.rule === "sitemap.missing_important")).toMatchObject({ url: `${SITE}/linked`, params: { inlinks: 1 } });
    expect(issues.find((i) => i.rule === "sitemap.unchecked")?.params).toEqual({ count: 1 });
  });

  it("lists 404 and 5xx pages separately", () => {
    const run = (status: number) => analyzeHtml({ url: `${SITE}/x`, status, html: "<html></html>", headers: {}, bytes: 1, loadMs: 1 }).issues.map((i) => i.rule);
    expect(run(404)).toContain("http.error");
    expect(run(502)).toContain("http.server_error");
  });
});

describe("audit diff", () => {
  const page = (url: string, over: Partial<{ status: number; title: string; canonical: string; indexable: boolean; contentHash: string | null }> = {}) => ({ url, status: 200, title: "T", canonical: url, indexable: true, contentHash: "h", ...over });
  it("detects new/removed pages, field changes and new/fixed issues by fingerprint, carrying human decisions", () => {
    const fp = (rule: string, url: string) => issueFingerprint("prod", rule, url);
    const { diff, carried } = diffAudits(
      {
        auditId: "a1",
        pages: [page("/a"), page("/b"), page("/gone"), page("/legacy", { contentHash: null })],
        issues: [
          { fingerprint: fp("meta.title_missing", "/a"), rule: "meta.title_missing", url: "/a", status: "IGNORED" },
          { fingerprint: fp("links.orphan", "/b"), rule: "links.orphan", url: "/b", status: "RESOLVED" },
          { fingerprint: fp("http.error", "/gone"), rule: "http.error", url: "/gone", status: "OPEN" },
        ],
      },
      {
        pages: [page("/a", { title: "New title", contentHash: "h2" }), page("/b", { status: 500, indexable: false }), page("/new"), page("/legacy", { contentHash: "x" })],
        issues: [
          { fingerprint: fp("meta.title_missing", "/a"), rule: "meta.title_missing", url: "/a" },
          { fingerprint: fp("links.orphan", "/b"), rule: "links.orphan", url: "/b" },
          { fingerprint: fp("http.server_error", "/b"), rule: "http.server_error", url: "/b" },
        ],
      },
    );
    expect(diff).toMatchObject({ previousAuditId: "a1", newPages: 1, removedPages: 1, newIssues: 1, fixedIssues: 1, carriedIgnored: 1, stillDetectedResolved: 1 });
    expect(diff.changed).toEqual({ status: 1, title: 1, canonical: 0, indexability: 1, content: 1 });
    expect(diff.examples.newIssues).toEqual([{ rule: "http.server_error", url: "/b" }]);
    expect(diff.examples.fixedIssues).toEqual([{ rule: "http.error", url: "/gone" }]);
    expect([...carried.entries()]).toEqual([
      [fp("meta.title_missing", "/a"), "IGNORED"],
      [fp("links.orphan", "/b"), "RESOLVED"],
    ]);
  });

  it("returns an empty diff without a previous audit", () => {
    const { diff, carried } = diffAudits(null, { pages: [page("/a")], issues: [] });
    expect(diff.previousAuditId).toBeNull();
    expect(diff.newPages).toBe(0);
    expect(carried.size).toBe(0);
  });

  it("fingerprints are stable and include the sub-key", () => {
    expect(issueFingerprint("p", "r", "u")).toBe("p|r|u|");
    expect(issueFingerprint("p", "r", "u", "k")).not.toBe(issueFingerprint("p", "r", "u"));
  });
});

describe("internal link suggestions", () => {
  const P = (url: string, over: Partial<LinkPage> = {}): LinkPage => ({ url, title: null, h1: null, text: "", cluster: "/", inlinks: 1, indexable: true, ...over });
  it("matches target queries and topics in source text, skips existing links, varies anchors and caps per target", () => {
    const target = P("/moderation", { title: "Live chat moderation | Acme", h1: "Live chat moderation", inlinks: 0, queries: ["tiktok live moderation", "moderate live streams"], cluster: "/features" });
    const sources = [1, 2, 3, 4, 5].map((n) => P(`/s${n}`, { text: `Article ${n}. Creators use tiktok live moderation and live chat moderation to moderate live streams safely.`, cluster: n === 1 ? "/features" : "/blog" }));
    const linked = P("/linked", { text: "We love tiktok live moderation." });
    const s = suggestLinks({ pages: [target, ...sources, linked], existing: new Set([`/linked\u0000/moderation`]), siteName: "Acme" });
    const toTarget = s.filter((x) => x.target === "/moderation");
    expect(toTarget).toHaveLength(3);
    expect(toTarget.map((x) => x.source)).not.toContain("/linked");
    expect(toTarget[0]).toMatchObject({ source: "/s1", anchor: "tiktok live moderation", reason: { code: "QUERY_MENTION", sameCluster: true, targetInlinks: 0 } });
    // No exact anchor twice for the same target.
    expect(new Set(toTarget.map((x) => x.anchor)).size).toBe(toTarget.length);
    // When no unused anchor is available the suggestion is dropped rather than repeating one.
    const one = suggestLinks({ pages: [P("/t", { title: "Pricing plans | Acme", inlinks: 0 }), P("/a", { text: "See our pricing plans." }), P("/b", { text: "Compare pricing plans." })], existing: new Set(), siteName: "Acme" });
    expect(one.filter((x) => x.target === "/t")).toHaveLength(1);
  });

  it("does not suggest when the source does not mention the topic, and strips the brand from titles", () => {
    expect(suggestLinks({ pages: [P("/t", { title: "Pricing plans | Acme" }), P("/s", { text: "Nothing related here at all." })], existing: new Set() })).toEqual([]);
    expect(titleCore("Pricing plans | Acme", "Acme")).toBe("Pricing plans");
    expect(titleCore("Acme")).toBe("Acme");
  });

  it("related pages: same product, same cluster first", () => {
    const items = [
      { id: "1", productId: "p", path: "/a", cluster: "x" },
      { id: "2", productId: "p", path: "/b", cluster: "y" },
      { id: "3", productId: "p", path: "/c", cluster: "x" },
      { id: "4", productId: "q", path: "/d", cluster: "x" },
    ];
    expect(relatedPages(items[0], items).map((i) => i.id)).toEqual(["3", "2"]);
  });
});

describe("domain verification rules", () => {
  it("normalises domains and refuses public suffixes and IPs", () => {
    expect(normalizeDomain(" https://WWW.Example.com/path ")).toBe("www.example.com");
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("127.0.0.1")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(isVerifiableDomain("example.com")).toBe(true);
    expect(isVerifiableDomain("shop.example.co.uk")).toBe(true);
    expect(isVerifiableDomain("co.uk")).toBe(false);
    expect(isVerifiableDomain("github.io")).toBe(false);
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
  });

  it("covers subdomains of a verified domain only", () => {
    expect(hostCoveredBy("www.example.com", ["example.com"])).toBe("example.com");
    expect(hostCoveredBy("example.com", ["example.com"])).toBe("example.com");
    expect(hostCoveredBy("badexample.com", ["example.com"])).toBeNull();
    expect(hostCoveredBy("example.com", ["www.example.com"])).toBeNull();
  });

  it("matches the DNS TXT record and the verification file", () => {
    expect(txtRecordsMatch([["v=spf1 -all"], ["beacon-verification=", "abc"]], "abc")).toBe(true);
    expect(txtRecordsMatch([["beacon-verification=abcd"]], "abc")).toBe(false);
    expect(fileBodyMatches("abc\n", "abc")).toBe(true);
    expect(fileBodyMatches("beacon-verification=abc", "abc")).toBe(true);
    expect(fileBodyMatches("xabc", "abc")).toBe(false);
  });

  it("identifies local development hosts for the documented bypass", () => {
    for (const h of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.0.4", "::1"]) expect(isLocalDevHost(h)).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1"]) expect(isLocalDevHost(h)).toBe(false);
  });
});

describe("rule catalogue", () => {
  it("every rule is complete and has a French translation for every text", () => {
    for (const r of Object.values(RULES)) {
      expect(r.what && r.why && r.howToFix && r.detail, r.id).toBeTruthy();
      expect(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).toContain(r.severity);
    }
    const missing = catalogueStrings().filter((s) => FR[s] === undefined);
    expect(missing).toEqual([]);
    for (const s of catalogueStrings()) if (FR[s]) expect(placeholders(FR[s]).join(), s).toBe(placeholders(s).join());
    expect(RULES["robots.missing"].severity).toBe("LOW");
    expect(Object.keys(p2crawl).length).toBeGreaterThan(50);
  });

  it("every rule id used by the SEO engine exists in the catalogue", () => {
    const dir = join(process.cwd(), "src/core/seo");
    const used = new Set<string>();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/mkIssue\("([a-z0-9_.]+)"|add\("([a-z0-9_.]+)"/g)) used.add(m[1] ?? m[2]);
    }
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter((u) => !RULES[u])).toEqual([]);
  });

  it("renders translated details with coded params", () => {
    const t = makeT(FR);
    expect(renderDetail("sitemap.non_indexable_entry", { reason: "NOINDEX_META" })).toBe("Sitemap lists a non-indexable URL (noindex in the robots meta tag).");
    const fr = renderDetail("sitemap.non_indexable_entry", { reason: "NOINDEX_META" }, t);
    expect(fr).not.toContain("Sitemap lists");
    expect(fr).toContain(FR["noindex in the robots meta tag"]);
    expect(renderDetail("http.error", { status: 404 }, t)).toContain("404");
  });
});
