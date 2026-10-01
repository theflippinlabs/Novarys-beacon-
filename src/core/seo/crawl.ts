import { safeFetch, type SafeResponse } from "@/lib/security/ssrf";
import { analyzeHtml, analyzeSite, computeDepths, emptyFacts, mkIssue, normalizeUrl, type Issue, type PageFacts } from "./analyze";
import { BEACON_ROBOTS_TOKEN, crawlDelayMs, DEFAULT_CRAWL_DELAY_MS, isAllowed, parseRobots, robotsPath, robotsPolicy, SEARCH_ENGINE_TOKEN, type RobotsRules } from "./robots";
import { decodeSitemapBody, parseSitemapDetailed, SitemapDecodeError } from "./sitemap";

export type FetchOptions = { maxBytes?: number; acceptEncoding?: string; timeoutMs?: number };
/** Response as returned by safeFetch; `raw` (undecoded bytes) and `redirectStatuses` are used when the fetcher provides them. */
export type CrawlResponse = SafeResponse;
export type Fetcher = (url: string, opts?: FetchOptions) => Promise<CrawlResponse>;

export type SitemapSnapshot = {
  sitemapUrl: string;
  parentUrl: string | null;
  kind: "urlset" | "index" | "invalid" | "error";
  status: number | null;
  urlCount: number;
  compressed: boolean;
  lastmodMax: string | null;
  errors: string[];
  fetchedAt: string;
};

export type CrawlResult = {
  pages: PageFacts[];
  issues: Issue[];
  /** Every URL listed in the sitemaps (normalised). */
  sitemapUrls: string[];
  sitemaps: SitemapSnapshot[];
  robots: RobotsRules | null;
  /** URLs Beacon did not fetch because robots.txt disallows them for its token. */
  robotsBlocked: string[];
  /** Requested URL → final URL for every redirect followed. */
  redirects: Map<string, string>;
  crawlDelayMs: number;
};

/** Raised when the crawl must stop (robots.txt unavailable means the whole site is disallowed). */
export class CrawlAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlAbortError";
  }
}

export const REQUEST_DEADLINE_MS = 20_000;
const SITEMAP_MAX_FETCH_BYTES = 20 * 1024 * 1024;
const MAX_SITEMAP_DOCS = 50;
const MAX_SITEMAP_URLS = 50_000;
const MAX_BLOCKED_ISSUES = 200;

/** Hard per-request deadline, independent of the fetcher's own idle timeout. */
export async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Request deadline of ${Math.round(ms / 1000)} s exceeded for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultFetcher: Fetcher = (u, o = {}) => safeFetch(u, { maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, acceptEncoding: o.acceptEncoding });

export type CrawlOptions = {
  maxPages?: number;
  fetcher?: Fetcher;
  /** Politeness delay between requests (default 200 ms); robots.txt Crawl-delay raises it (capped at 10 s). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  requestDeadlineMs?: number;
  /** Called after every fetched page (use it to report progress and send job heartbeats). */
  onProgress?: (done: number, queued: number) => void | Promise<void>;
  impressions?: Map<string, number>;
};

/**
 * Polite breadth-first crawler for technical audits. Obeys robots.txt for
 * Beacon's own token (falling back to "*"), stops when robots.txt is
 * unavailable (5xx or unreachable), honours Crawl-delay, stays on the start
 * host, honours a page budget, reads gzip sitemaps and sitemap indexes (two
 * levels), and goes through the SSRF-safe fetcher with a hard deadline.
 */
export async function crawlSite(startUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = opts.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  const fetchUrl = (u: string, o?: FetchOptions) => withDeadline(fetcher(u, o), deadline, u);
  const maxPages = Math.min(opts.maxPages ?? 50, 500);
  const start = normalizeUrl(startUrl, startUrl);
  if (!start) throw new Error("Invalid start URL");
  const origin = new URL(start).origin;
  const host = new URL(start).host;
  const issues: Issue[] = [];

  // robots.txt (RFC 9309): 2xx parse, 4xx allow all, 5xx / unreachable disallow all.
  let robots: RobotsRules | null = null;
  const robotsUrl = `${origin}/robots.txt`;
  let robotsRes: CrawlResponse | null = null;
  let robotsErr: string | null = null;
  try {
    robotsRes = await fetchUrl(robotsUrl, { maxBytes: 512 * 1024 });
  } catch (e) {
    robotsErr = (e as Error).message;
  }
  const policy = robotsPolicy(robotsRes?.status ?? null);
  if (policy === "DISALLOW_ALL")
    throw new CrawlAbortError(
      robotsRes
        ? `robots.txt returned HTTP ${robotsRes.status}. Until it answers normally the site is treated as fully disallowed, so the audit stopped.`
        : `robots.txt could not be fetched (${robotsErr}). Until it is reachable the site is treated as fully disallowed, so the audit stopped.`,
    );
  if (policy === "PARSE") {
    robots = parseRobots(robotsRes!.body);
    if (!isAllowed(robots, "/", SEARCH_ENGINE_TOKEN)) issues.push(mkIssue("robots.blocks_all", robotsUrl, { agent: SEARCH_ENGINE_TOKEN }));
  } else issues.push(mkIssue("robots.missing", robotsUrl, { status: robotsRes!.status }));
  const delay = crawlDelayMs(robots, BEACON_ROBOTS_TOKEN, opts.delayMs ?? DEFAULT_CRAWL_DELAY_MS);
  const allowedForBeacon = (u: string) => !robots || isAllowed(robots, robotsPath(u), BEACON_ROBOTS_TOKEN);

  // Sitemaps (declared in robots.txt, else /sitemap.xml); indexes followed two levels deep.
  const sitemaps: SitemapSnapshot[] = [];
  const sitemapUrls: string[] = [];
  const seenSitemaps = new Set<string>();
  const readSitemap = async (url: string, parent: string | null, level: number): Promise<void> => {
    if (seenSitemaps.has(url) || seenSitemaps.size >= MAX_SITEMAP_DOCS) return;
    seenSitemaps.add(url);
    const snap: SitemapSnapshot = { sitemapUrl: url, parentUrl: parent, kind: "error", status: null, urlCount: 0, compressed: false, lastmodMax: null, errors: [], fetchedAt: new Date().toISOString() };
    sitemaps.push(snap);
    let res: CrawlResponse;
    try {
      res = await fetchUrl(url, { maxBytes: SITEMAP_MAX_FETCH_BYTES, acceptEncoding: "gzip" });
    } catch (e) {
      snap.errors.push((e as Error).message.slice(0, 300));
      if (parent) issues.push(mkIssue("sitemap.child_error", url, { status: 0 }));
      return;
    }
    snap.status = res.status;
    if (res.status !== 200) {
      snap.errors.push(`HTTP ${res.status}`);
      if (parent) issues.push(mkIssue("sitemap.child_error", url, { status: res.status }));
      return;
    }
    let xml = res.body;
    if (res.raw) {
      try {
        const d = decodeSitemapBody(res.raw);
        xml = d.xml;
        snap.compressed = d.compressed;
      } catch (e) {
        const reason = e instanceof SitemapDecodeError ? e.reason : "DECOMPRESS_FAILED";
        snap.kind = "invalid";
        snap.errors.push(reason);
        issues.push(mkIssue("sitemap.invalid", url, { reason }));
        return;
      }
    } else if (/\.gz($|\?)/i.test(url) && !xml.trimStart().startsWith("<")) {
      snap.kind = "invalid";
      snap.errors.push("DECOMPRESS_FAILED");
      issues.push(mkIssue("sitemap.invalid", url, { reason: "DECOMPRESS_FAILED" }));
      return;
    }
    if (res.truncated) {
      snap.kind = "invalid";
      snap.errors.push("TOO_LARGE");
      issues.push(mkIssue("sitemap.invalid", url, { reason: "TOO_LARGE" }));
      return;
    }
    const parsed = parseSitemapDetailed(xml);
    snap.kind = parsed.kind;
    snap.urlCount = parsed.entries.length;
    snap.lastmodMax = parsed.entries.reduce<string | null>((m, e) => (e.lastmod && Number.isFinite(Date.parse(e.lastmod)) && (!m || Date.parse(e.lastmod) > Date.parse(m)) ? e.lastmod : m), null);
    if (parsed.kind === "invalid") {
      snap.errors.push("NOT_SITEMAP");
      issues.push(mkIssue("sitemap.invalid", url, { reason: "NOT_SITEMAP" }));
      return;
    }
    if (parsed.kind === "urlset") {
      for (const e of parsed.entries) if (sitemapUrls.length < MAX_SITEMAP_URLS) sitemapUrls.push(e.loc);
      return;
    }
    if (level >= 2) {
      snap.errors.push("TOO_DEEP");
      issues.push(mkIssue("sitemap.invalid", url, { reason: "TOO_DEEP" }));
      return;
    }
    for (const child of parsed.entries) await readSitemap(child.loc, url, level + 1);
  };
  const sources = robots?.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
  for (const sm of sources.slice(0, 5)) await readSitemap(sm, null, 0);
  if (!sitemaps.some((s) => s.kind === "urlset" || s.kind === "index"))
    issues.push(mkIssue("sitemap.missing", `${origin}/sitemap.xml`));
  const normalizedSitemap = [...new Set(sitemapUrls.map((u) => normalizeUrl(u, origin)).filter((u): u is string => Boolean(u)))];

  // Breadth-first crawl.
  const queue: string[] = [start, ...normalizedSitemap.filter((u) => new URL(u).host === host)];
  const seen = new Set<string>();
  const pages: PageFacts[] = [];
  const redirects = new Map<string, string>();
  const robotsBlocked: string[] = [];
  let fetched = 0;
  while (queue.length && fetched < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!allowedForBeacon(url)) {
      robotsBlocked.push(url);
      continue;
    }
    if (fetched > 0 && delay > 0) await sleep(delay);
    fetched++;
    const fetchedAt = new Date().toISOString();
    try {
      const res = await fetchUrl(url);
      const finalUrl = normalizeUrl(res.url, url) ?? url;
      const redirected = finalUrl !== url;
      if (redirected) {
        const chain = [...res.redirects.map((r) => normalizeUrl(r, url) ?? r), finalUrl];
        redirects.set(url, finalUrl);
        pages.push(emptyFacts(url, { status: res.redirectStatuses?.[0] ?? 0, finalUrl, redirectChain: chain, indexability: "REDIRECT", loadMs: res.elapsedMs, fetchedAt }));
        if (chain.length > 2) issues.push(mkIssue("http.redirect_chain", url, { hops: chain.length - 1, final: finalUrl }, { details: { chain } }));
        if (new URL(finalUrl).host !== host || seen.has(finalUrl)) {
          await opts.onProgress?.(pages.length, queue.length);
          continue;
        }
        seen.add(finalUrl);
      }
      const ctype = res.headers["content-type"] ?? "";
      if (!ctype.includes("html") && res.status < 300) {
        pages.push(emptyFacts(finalUrl, { status: res.status, indexability: "NON_HTML", bytes: res.bytes, loadMs: res.elapsedMs, fetchedAt }));
      } else {
        const { facts, issues: pageIssues } = analyzeHtml({ url: finalUrl, status: res.status, html: res.body, headers: res.headers, bytes: res.bytes, loadMs: res.elapsedMs, fetchedAt });
        pages.push(facts);
        issues.push(...pageIssues);
        for (const l of facts.internalLinks) if (!seen.has(l) && new URL(l).host === host) queue.push(l);
      }
    } catch (e) {
      pages.push(emptyFacts(url, { status: 0, indexability: "UNREACHABLE", fetchedAt }));
      issues.push(mkIssue("http.unreachable", url, { error: (e as Error).message.slice(0, 300) }));
    }
    await opts.onProgress?.(pages.length, queue.length);
  }

  for (const u of robotsBlocked.slice(0, MAX_BLOCKED_ISSUES)) issues.push(mkIssue("robots.blocked_url", u, { agent: BEACON_ROBOTS_TOKEN }));

  const depths = computeDepths(start, pages, redirects);
  for (const p of pages) p.depth = depths.get(p.url) ?? null;

  issues.push(...analyzeSite({ pages, sitemapUrls: normalizedSitemap, homepage: start, redirects, robots, impressions: opts.impressions, blocked: new Set(robotsBlocked) }));
  return { pages, issues, sitemapUrls: normalizedSitemap, sitemaps, robots, robotsBlocked, redirects, crawlDelayMs: delay };
}
