import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { jaccard } from "@/core/util/text";
import { isAllowed, robotsPath, SEARCH_ENGINE_TOKEN, type RobotsRules } from "./robots";
import { renderDetail, RULES, type IssueParams, type Severity } from "./rules";
import { validateJsonLd, type JsonLdResult } from "./structured-data";

export type { Severity } from "./rules";
export type Issue = { url: string; rule: string; severity: Severity; message: string; params?: IssueParams; details?: Record<string, unknown>; key?: string };

export type IndexabilityReason = "INDEXABLE" | "HTTP_STATUS" | "REDIRECT" | "NOINDEX_META" | "NOINDEX_HEADER" | "CANONICALISED" | "ROBOTS_BLOCKED" | "NON_HTML" | "UNREACHABLE";
export type Heading = { level: number; text: string };
export type LinkFact = { href: string; anchor: string; nofollow: boolean; internal: boolean };
export type ImageFact = { src: string; alt: string | null; hasWidth: boolean; hasHeight: boolean };

export type PageFacts = {
  url: string;
  status: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  indexable: boolean;
  /** robots meta tag content (lowercased). */
  robotsMeta: string | null;
  h1: string[];
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  structuredDataTypes: string[];
  hreflang: { lang: string; href: string }[];
  bytes: number;
  loadMs: number;
  lastModified: string | null;
  /** URL after redirects (equal to url when the page did not redirect). */
  finalUrl: string;
  /** Redirect hops followed by the final URL (empty when there was no redirect). */
  redirectChain: string[];
  xRobotsTag: string | null;
  indexability: IndexabilityReason;
  headings: Heading[];
  links: LinkFact[];
  jsonLd: JsonLdResult[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  images: ImageFact[];
  /** sha256 of the normalised visible text (null when there is no text). */
  contentHash: string | null;
  /** First characters of the visible text (for internal link suggestions). */
  textSample: string;
  /** Click depth from the start URL (null when not reachable through links). */
  depth: number | null;
  fetchedAt: string | null;
};

export const CAPS = { headings: 100, headingText: 200, links: 300, anchor: 120, images: 100, textSample: 5000, linkIssuesPerPage: 20 } as const;

const TRACKING_PARAMS = /^(utm_|gclid|fbclid|ref$|mc_)/;

export function normalizeUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}

/** Facts for a URL that was not analysed as HTML (redirect source, unreachable, blocked). */
export function emptyFacts(url: string, over: Partial<PageFacts> = {}): PageFacts {
  return {
    url,
    status: 0,
    title: null,
    metaDescription: null,
    canonical: null,
    indexable: false,
    robotsMeta: null,
    h1: [],
    wordCount: 0,
    internalLinks: [],
    externalLinks: [],
    structuredDataTypes: [],
    hreflang: [],
    bytes: 0,
    loadMs: 0,
    lastModified: null,
    finalUrl: url,
    redirectChain: [],
    xRobotsTag: null,
    indexability: "UNREACHABLE",
    headings: [],
    links: [],
    jsonLd: [],
    openGraph: {},
    twitter: {},
    images: [],
    contentHash: null,
    textSample: "",
    depth: null,
    fetchedAt: null,
    ...over,
  };
}

/** Lowercase, Unicode-normalised, whitespace-collapsed visible text: the input of the content hash. */
export function normalizeVisibleText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function contentHash(text: string): string | null {
  const n = normalizeVisibleText(text);
  return n ? createHash("sha256").update(n).digest("hex") : null;
}

/** Build an issue from the rule catalogue (severity and English message come from the rule). */
export function mkIssue(rule: string, url: string, params: IssueParams = {}, extra: { details?: Record<string, unknown>; key?: string } = {}): Issue {
  const def = RULES[rule];
  if (!def) throw new Error(`Unknown SEO rule ${rule}`);
  return { url, rule, severity: def.severity, message: renderDetail(rule, params), params, details: extra.details, key: extra.key };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Analyse one HTML document. Pure: takes the fetched response, returns facts
 * and issues. Page-speed findings here are server-side signals only
 * (response time and weight), clearly labelled, not lab/field Web Vitals.
 */
export function analyzeHtml(input: {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  bytes: number;
  loadMs: number;
  redirects?: string[];
  fetchedAt?: string;
}): { facts: PageFacts; issues: Issue[] } {
  const { url, status, html, headers } = input;
  const issues: Issue[] = [];
  const add = (rule: string, params: IssueParams = {}, extra: { details?: Record<string, unknown>; key?: string; at?: string } = {}) => issues.push(mkIssue(rule, extra.at ?? url, params, extra));
  const $ = cheerio.load(html);
  const host = new URL(url).host;

  if (status >= 500) add("http.server_error", { status });
  else if (status >= 400) add("http.error", { status });
  const redirects = (input.redirects ?? []).map((r) => normalizeUrl(r, url) ?? r);
  if (redirects.length > 1) add("http.redirect_chain", { hops: redirects.length, final: url }, { at: redirects[0], details: { chain: [...redirects, url] } });

  const title = squash($("head > title").first().text()) || null;
  if (!title) add("meta.title_missing");
  else if (title.length < 15 || title.length > 65) add("meta.title_length", { length: title.length });

  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  if (!metaDescription) add("meta.description_missing");
  else if (metaDescription.length < 50 || metaDescription.length > 165) add("meta.description_length", { length: metaDescription.length });

  const h1 = $("h1").map((_, el) => squash($(el).text())).get();
  if (h1.length === 0) add("headings.h1_missing");
  else if (h1.length > 1) add("headings.h1_multiple", { count: h1.length });
  const headings: Heading[] = [];
  let prev = 0;
  let skip: { from: number; to: number } | null = null;
  $("h1,h2,h3,h4,h5,h6").each((_, el) => {
    const lvl = Number(el.tagName.slice(1));
    if (prev && lvl > prev + 1 && !skip) skip = { from: prev, to: lvl };
    prev = lvl;
    if (headings.length < CAPS.headings) headings.push({ level: lvl, text: clip(squash($(el).text()), CAPS.headingText) });
  });
  if (skip) add("headings.hierarchy", skip);

  const canonicalRaw = $('link[rel="canonical"]').attr("href")?.trim() || null;
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, url) : null;
  if (!canonicalRaw) add("canonical.missing");
  else {
    if (!/^https?:\/\//.test(canonicalRaw)) add("canonical.relative");
    if (canonical && new URL(canonical).host !== host) add("canonical.cross_domain", { host: new URL(canonical).host });
  }

  const robotsMeta = $('meta[name="robots"]').attr("content")?.trim().toLowerCase() || null;
  const xRobotsTag = headers["x-robots-tag"]?.trim().toLowerCase() || null;
  const self = normalizeUrl(url, url);
  let indexability: IndexabilityReason = "INDEXABLE";
  if (status < 200 || status >= 300) indexability = "HTTP_STATUS";
  else if (robotsMeta?.includes("noindex")) indexability = "NOINDEX_META";
  else if (xRobotsTag?.includes("noindex")) indexability = "NOINDEX_HEADER";
  else if (canonical && canonical !== self) indexability = "CANONICALISED";
  const indexable = indexability === "INDEXABLE";
  if (robotsMeta?.includes("noindex")) add("robots.noindex", { source: "META", value: robotsMeta });
  else if (xRobotsTag?.includes("noindex")) add("robots.noindex", { source: "HEADER", value: xRobotsTag });

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const k = $(el).attr("property")!.trim();
    const v = $(el).attr("content")?.trim();
    if (v && !(k in openGraph) && Object.keys(openGraph).length < 30) openGraph[k] = clip(v, 500);
  });
  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const k = $(el).attr("name")!.trim();
    const v = $(el).attr("content")?.trim();
    if (v && !(k in twitter) && Object.keys(twitter).length < 30) twitter[k] = clip(v, 500);
  });
  if (!openGraph["og:title"]) add("social.og_title");
  if (!openGraph["og:description"]) add("social.og_description");
  if (!openGraph["og:image"]) add("social.og_image");
  if (!twitter["twitter:card"]) add("social.twitter_card");

  if (!$("html").attr("lang")) add("a11y.html_lang");
  if (!$('meta[name="viewport"]').attr("content")) add("mobile.viewport");

  const imgEls = $("img").toArray();
  const images: ImageFact[] = imgEls.slice(0, CAPS.images).map((el) => ({
    src: clip(normalizeUrl($(el).attr("src") ?? "", url) ?? ($(el).attr("src") ?? ""), 500),
    alt: $(el).attr("alt") ?? null,
    hasWidth: Boolean($(el).attr("width")),
    hasHeight: Boolean($(el).attr("height")),
  }));
  const noAlt = imgEls.filter((el) => $(el).attr("alt") === undefined);
  if (noAlt.length > 0)
    add("images.alt_missing", { count: noAlt.length, total: imgEls.length }, { details: { count: noAlt.length, images: noAlt.slice(0, 20).map((el) => clip($(el).attr("src") ?? "", 500)) } });
  const noDims = imgEls.filter((el) => !$(el).attr("width") || !$(el).attr("height")).length;
  if (noDims > 0) add("images.dimensions", { count: noDims });

  const emptyAnchors = $("a[href]").filter((_, el) => !$(el).text().trim() && !$(el).attr("aria-label") && !$(el).find("img[alt]").length).length;
  if (emptyAnchors) add("a11y.empty_links", { count: emptyAnchors });

  const hreflang = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr("hreflang") ?? "").trim(), href: normalizeUrl($(el).attr("href") ?? "", url) ?? "" }))
    .get();
  if (hreflang.length) {
    const invalid = hreflang.filter((h) => !/^(x-default|[a-z]{2,3}(-[A-Za-z]{2}|-[A-Za-z]{4})?)$/.test(h.lang));
    if (invalid.length) add("hreflang.invalid", { values: invalid.map((i) => i.lang).join(", ") });
    if (!hreflang.some((h) => h.href === self)) add("hreflang.self");
  }

  const structuredDataTypes: string[] = [];
  const jsonLd: JsonLdResult[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const res = validateJsonLd($(el).contents().text());
    if (jsonLd.length < 20) jsonLd.push(res);
    if (!res.valid) return void add("schema.invalid_json", {}, { key: `block${jsonLd.length}` });
    structuredDataTypes.push(...res.types);
  });
  const missingByType = new Map<string, string[]>();
  for (const b of jsonLd) for (const m of b.missing) missingByType.set(m.type, [...new Set([...(missingByType.get(m.type) ?? []), m.property])]);
  for (const [type, props] of missingByType) add("schema.required_missing", { type, properties: props.join(", ") }, { key: type });

  if (url.startsWith("https:")) {
    const mixed = $('img[src^="http:"],script[src^="http:"],link[href^="http:"][rel="stylesheet"],iframe[src^="http:"]').length;
    if (mixed) add("security.mixed_content", { count: mixed });
  }

  const lastModified = $('meta[property="article:modified_time"]').attr("content") ?? headers["last-modified"] ?? null;

  // Links (before the DOM is stripped for text extraction).
  const internalLinks = new Set<string>();
  const externalLinks = new Set<string>();
  const links: LinkFact[] = [];
  $("a[href]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    const n = normalizeUrl($(el).attr("href")!, url);
    if (!n) return;
    const internal = new URL(n).host === host;
    if (internal) internalLinks.add(n);
    else if (!rel.includes("sponsored")) externalLinks.add(n);
    if (links.length < CAPS.links) {
      const anchor = clip(squash($(el).text()) || $(el).attr("aria-label")?.trim() || $(el).find("img[alt]").first().attr("alt")?.trim() || "", CAPS.anchor);
      links.push({ href: n, anchor, nofollow: rel.includes("nofollow") || rel.includes("sponsored") || rel.includes("ugc"), internal });
    }
  });

  $("script,style,noscript,template").remove();
  $("body *").append(" ");
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = text ? text.split(" ").length : 0;
  if (status < 300 && wordCount < 200) add("content.thin", { words: wordCount }, { details: { wordCount } });

  if (input.bytes > 1_500_000) add("speed.page_weight", { kb: Math.round(input.bytes / 1024) });
  if (input.loadMs > 2500) add("speed.server_response", { ms: input.loadMs });

  if (lastModified) {
    const age = Date.now() - new Date(lastModified).getTime();
    if (Number.isFinite(age) && age > 365 * 86_400_000) add("content.stale", {}, { details: { lastModified } });
  }

  return {
    facts: {
      url,
      status,
      title,
      metaDescription,
      canonical,
      indexable,
      robotsMeta,
      h1,
      wordCount,
      internalLinks: [...internalLinks],
      externalLinks: [...externalLinks],
      structuredDataTypes,
      hreflang,
      bytes: input.bytes,
      loadMs: input.loadMs,
      lastModified,
      finalUrl: url,
      redirectChain: redirects.length ? [...redirects, url] : [],
      xRobotsTag,
      indexability,
      headings,
      links,
      jsonLd,
      openGraph,
      twitter,
      images,
      contentHash: status < 300 ? contentHash(text) : null,
      textSample: clip(text, CAPS.textSample),
      depth: null,
      fetchedAt: input.fetchedAt ?? null,
    },
    issues,
  };
}

/** Click depth from the start URL over internal links (redirects resolved). */
export function computeDepths(start: string, pages: PageFacts[], redirects: Map<string, string> = new Map()): Map<string, number> {
  const resolve = (u: string) => redirects.get(u) ?? u;
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift()!;
    const d = depth.get(u)!;
    const p = byUrl.get(u);
    if (!p) continue;
    const next = p.indexability === "REDIRECT" ? [p.finalUrl] : p.internalLinks;
    for (const raw of next) {
      for (const l of new Set([raw, resolve(raw)])) {
        if (depth.has(l)) continue;
        // A redirect hop does not add a click.
        depth.set(l, p.indexability === "REDIRECT" ? d : d + 1);
        queue.push(l);
      }
    }
  }
  return depth;
}

const GENERIC_TITLES = new Set(
  ["home", "homepage", "home page", "index", "untitled", "untitled document", "welcome", "page", "new page", "default", "document", "test", "accueil", "bienvenue", "sans titre", "page d'accueil", "page d’accueil"].map((s) => s.toLowerCase()),
);
const normTitle = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const titleTokens = (s: string) => normTitle(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t && !/^\d+$/.test(t));

/**
 * Weak title: (a) generic wording (Home, Untitled, Welcome, Index…), or
 * (b) on a page other than the homepage, exactly the site name (og:site_name,
 * else the homepage title). A title equal to the page's H1 is fine.
 */
export function weakTitleKind(title: string | null, opts: { isHome: boolean; siteName: string | null }): "GENERIC" | "SITE_NAME" | null {
  if (!title) return null;
  const t = normTitle(title);
  if (GENERIC_TITLES.has(t)) return "GENERIC";
  if (!opts.isHome && opts.siteName && t === normTitle(opts.siteName)) return "SITE_NAME";
  return null;
}

/**
 * Near-duplicate titles: different titles whose word sets (brand words
 * shared by most titles and pure numbers removed) have a Jaccard similarity
 * of at least 0.8. Returns groups of URLs.
 */
export function nearDuplicateTitles(pages: { url: string; title: string | null }[], siteName: string | null = null): string[][] {
  const withTitle = pages.filter((p) => p.title);
  const freq = new Map<string, number>();
  const sets = withTitle.map((p) => new Set(titleTokens(p.title!)));
  for (const s of sets) for (const t of s) freq.set(t, (freq.get(t) ?? 0) + 1);
  const brand = new Set(siteName ? titleTokens(siteName) : []);
  if (withTitle.length >= 4) for (const [t, n] of freq) if (n / withTitle.length >= 0.6) brand.add(t);
  const core = sets.map((s) => new Set([...s].filter((t) => !brand.has(t))));
  const parent = withTitle.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < withTitle.length; i++)
    for (let j = i + 1; j < withTitle.length; j++) {
      if (normTitle(withTitle[i].title!) === normTitle(withTitle[j].title!)) continue;
      if (!core[i].size || !core[j].size) continue;
      if (jaccard(core[i], core[j]) >= 0.8) parent[find(i)] = find(j);
    }
  const groups = new Map<number, string[]>();
  withTitle.forEach((p, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), p.url]);
  });
  // Only groups where at least two distinct titles were linked.
  return [...groups.values()].filter((g) => new Set(g.map((u) => normTitle(withTitle.find((p) => p.url === u)!.title!))).size > 1);
}

export type SiteInput = {
  pages: PageFacts[];
  /** Every URL listed in the site's sitemaps (normalised), crawled or not. */
  sitemapUrls: string[];
  homepage: string;
  /** Redirect map: requested URL → final URL. */
  redirects?: Map<string, string>;
  robots?: RobotsRules | null;
  /** Search impressions per URL (when Search Console data exists). */
  impressions?: Map<string, number>;
  /** URLs Beacon did not fetch because robots.txt disallows them for its own token. */
  blocked?: Set<string>;
};

/** Cross-page analysis: duplicates, canonicals, links, sitemaps, hreflang, important pages. */
export function analyzeSite(input: SiteInput): Issue[] {
  const issues: Issue[] = [];
  const redirects = input.redirects ?? new Map<string, string>();
  const resolve = (u: string) => redirects.get(u) ?? u;
  const isRedirect = (p: PageFacts) => p.indexability === "REDIRECT";
  const ok = input.pages.filter((p) => p.status >= 200 && p.status < 300 && !isRedirect(p));
  const byUrl = new Map(input.pages.map((p) => [p.url, p]));
  const finalPage = (u: string) => {
    const p = byUrl.get(u);
    return p && isRedirect(p) ? byUrl.get(p.finalUrl) ?? p : p;
  };
  const home = finalPage(input.homepage);
  const siteName = home?.openGraph["og:site_name"] ?? ok.find((p) => p.openGraph["og:site_name"])?.openGraph["og:site_name"] ?? home?.title ?? null;

  const dup = (key: "title" | "metaDescription", rule: string) => {
    const groups = new Map<string, string[]>();
    for (const p of ok) {
      const v = p[key];
      if (!v) continue;
      groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    for (const [value, urls] of groups) if (urls.length > 1) for (const u of urls) issues.push(mkIssue(rule, u, { others: urls.length - 1 }, { details: { value, urls: urls.slice(0, 50) } }));
  };
  dup("title", "duplicate.title");
  dup("metaDescription", "duplicate.description");

  for (const g of nearDuplicateTitles(ok, siteName)) for (const u of g) issues.push(mkIssue("duplicate.title_near", u, { others: g.length - 1 }, { details: { urls: g.slice(0, 50), titles: g.slice(0, 10).map((x) => byUrl.get(x)?.title) } }));

  for (const p of ok) {
    const kind = weakTitleKind(p.title, { isHome: p.url === home?.url, siteName });
    if (kind) issues.push(mkIssue("meta.title_weak", p.url, { title: p.title!, kind }));
  }

  // Duplicate content: same normalised visible text on several indexable-candidate URLs.
  const byHash = new Map<string, string[]>();
  for (const p of ok) if (p.contentHash && p.indexability !== "CANONICALISED" && p.wordCount >= 20) byHash.set(p.contentHash, [...(byHash.get(p.contentHash) ?? []), p.url]);
  for (const urls of byHash.values()) if (urls.length > 1) for (const u of urls) issues.push(mkIssue("duplicate.content", u, { others: urls.length - 1 }, { details: { urls: urls.slice(0, 50) } }));

  // Inlinks (redirects resolved, self links ignored).
  const inlinks = new Map<string, number>();
  for (const p of input.pages)
    for (const l of new Set(p.internalLinks.map(resolve))) if (l !== p.url && l !== resolve(p.url)) inlinks.set(l, (inlinks.get(l) ?? 0) + 1);
  for (const p of ok) {
    if (p.url === home?.url || p.url === input.homepage) continue;
    if (!inlinks.get(p.url)) issues.push(mkIssue("links.orphan", p.url));
  }

  for (const p of input.pages) {
    let toRedirect = 0;
    for (const l of p.internalLinks) {
      const target = byUrl.get(l);
      const final = finalPage(l);
      if (target && isRedirect(target) && toRedirect < CAPS.linkIssuesPerPage) {
        toRedirect++;
        issues.push(mkIssue("links.to_redirect", p.url, { target: l, final: target.finalUrl }, { key: l, details: { target: l, final: target.finalUrl } }));
      }
      if (final && final.status >= 400) issues.push(mkIssue("links.broken_internal", p.url, { target: l, status: final.status }, { key: l, details: { target: l } }));
    }
  }

  // Canonical conflicts.
  for (const p of ok) {
    const c = p.canonical;
    if (!c || c === p.url) continue;
    const t = byUrl.get(c);
    if (!t) continue;
    if (isRedirect(t)) issues.push(mkIssue("canonical.to_redirect", p.url, { target: c, final: t.finalUrl }));
    else if (t.status >= 400 || t.status === 0) issues.push(mkIssue("canonical.to_error", p.url, { target: c, status: t.status }));
    else if (t.indexability === "NOINDEX_META" || t.indexability === "NOINDEX_HEADER") issues.push(mkIssue("canonical.to_noindex", p.url, { target: c }));
    else if (t.canonical && t.canonical !== t.url && t.canonical !== p.url) issues.push(mkIssue("canonical.chain", p.url, { target: c, next: t.canonical }));
  }

  // Sitemaps.
  const sitemapSet = new Set(input.sitemapUrls);
  let unchecked = 0;
  for (const s of input.sitemapUrls) {
    const blockedForSearch = input.robots ? !isAllowed(input.robots, robotsPath(s), SEARCH_ENGINE_TOKEN) : false;
    if (blockedForSearch) issues.push(mkIssue("sitemap.blocked_by_robots", s, { agent: SEARCH_ENGINE_TOKEN }));
    const p = byUrl.get(s);
    if (!p) {
      if (!blockedForSearch && !input.blocked?.has(s)) unchecked++;
      continue;
    }
    if (p.indexability === "ROBOTS_BLOCKED") continue;
    if (isRedirect(p)) issues.push(mkIssue("sitemap.redirect_entry", s, { final: p.finalUrl }));
    else if (p.status >= 400) issues.push(mkIssue("sitemap.not_found_entry", s, { status: p.status }));
    else if (p.indexability === "CANONICALISED" && p.canonical) issues.push(mkIssue("sitemap.canonical_mismatch", s, { canonical: p.canonical }));
    else if (!p.indexable && p.status > 0 && p.status < 300) issues.push(mkIssue("sitemap.non_indexable_entry", s, { reason: p.indexability }));
  }
  if (unchecked > 0) issues.push(mkIssue("sitemap.unchecked", input.homepage, { count: unchecked }));
  if (sitemapSet.size)
    for (const p of ok) if (p.indexable && (inlinks.get(p.url) ?? 0) > 0 && !sitemapSet.has(p.url)) issues.push(mkIssue("sitemap.missing_important", p.url, { inlinks: inlinks.get(p.url)! }));

  // hreflang reciprocity.
  for (const p of ok)
    for (const h of p.hreflang) {
      if (!h.href || h.href === p.url) continue;
      const t = byUrl.get(h.href);
      if (!t || t.status < 200 || t.status >= 300 || isRedirect(t)) continue;
      if (!t.hreflang.some((x) => x.href === p.url)) issues.push(mkIssue("hreflang.no_return", p.url, { target: h.href, lang: h.lang }, { key: h.href }));
    }

  // Important pages that cannot be indexed.
  if (home && !home.indexable) issues.push(mkIssue("indexability.homepage", home.url, { reason: home.indexability }));
  for (const [u, n] of input.impressions ?? []) {
    if (u === home?.url || n <= 0) continue;
    const p = byUrl.get(u);
    if (!p || p.indexable || isRedirect(p)) continue;
    issues.push(mkIssue("indexability.impressions_page", u, { impressions: n, reason: p.indexability }));
  }

  if (home && home.status < 300 && !home.structuredDataTypes.some((t) => ["Organization", "SoftwareApplication", "WebApplication", "Product"].includes(t))) issues.push(mkIssue("schema.entity_missing", home.url));

  return issues;
}

export const SEVERITY_PENALTY: Record<Severity, number> = { CRITICAL: 4, HIGH: 2, MEDIUM: 1, LOW: 0.25, INFO: 0 };
