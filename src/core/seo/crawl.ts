import { safeFetch, type SafeResponse } from "@/lib/security/ssrf";
import { analyzeHtml, analyzeSite, normalizeUrl, type Issue, type PageFacts } from "./analyze";
import { isAllowed, parseRobots, type RobotsRules } from "./robots";
import { parseSitemap } from "./sitemap";

export type Fetcher = (url: string) => Promise<SafeResponse>;

export type CrawlResult = {
  pages: PageFacts[];
  issues: Issue[];
  sitemapUrls: string[];
  robots: RobotsRules | null;
};

/**
 * Polite breadth-first crawler for technical audits. Respects robots.txt,
 * stays on the start host, honours a page budget, and goes through the
 * SSRF-safe fetcher.
 */
export async function crawlSite(startUrl: string, opts: { maxPages?: number; fetcher?: Fetcher; delayMs?: number; onProgress?: (n: number) => void } = {}): Promise<CrawlResult> {
  const fetcher = opts.fetcher ?? ((u: string) => safeFetch(u));
  const maxPages = Math.min(opts.maxPages ?? 50, 500);
  const start = normalizeUrl(startUrl, startUrl);
  if (!start) throw new Error("Invalid start URL");
  const origin = new URL(start).origin;
  const host = new URL(start).host;
  const issues: Issue[] = [];

  // robots.txt
  let robots: RobotsRules | null = null;
  try {
    const r = await fetcher(`${origin}/robots.txt`);
    if (r.status === 200) {
      robots = parseRobots(r.body);
      if (!isAllowed(robots, "/", "Googlebot")) issues.push({ url: `${origin}/robots.txt`, rule: "robots.blocks_all", severity: "CRITICAL", message: "robots.txt disallows crawling the site root for Googlebot." });
    } else issues.push({ url: `${origin}/robots.txt`, rule: "robots.missing", severity: "MEDIUM", message: `robots.txt returned HTTP ${r.status}.` });
  } catch (e) {
    issues.push({ url: `${origin}/robots.txt`, rule: "robots.unreachable", severity: "MEDIUM", message: `robots.txt could not be fetched: ${(e as Error).message}` });
  }

  // Sitemaps (declared in robots.txt, else /sitemap.xml), following one level of index.
  const sitemapUrls: string[] = [];
  const sitemapSources = robots?.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
  let sitemapFound = false;
  for (const sm of sitemapSources.slice(0, 5)) {
    try {
      const r = await fetcher(sm);
      if (r.status !== 200) continue;
      const parsed = parseSitemap(r.body);
      if (parsed.kind === "invalid") {
        issues.push({ url: sm, rule: "sitemap.invalid", severity: "HIGH", message: "Sitemap is not valid XML sitemap format." });
        continue;
      }
      sitemapFound = true;
      if (parsed.kind === "urlset") sitemapUrls.push(...parsed.locs);
      else
        for (const child of parsed.locs.slice(0, 10)) {
          const c = await fetcher(child);
          if (c.status === 200) sitemapUrls.push(...parseSitemap(c.body).locs);
          else issues.push({ url: child, rule: "sitemap.child_error", severity: "MEDIUM", message: `Child sitemap returned HTTP ${c.status}.` });
        }
    } catch {
      /* reported below if nothing found */
    }
  }
  if (!sitemapFound) issues.push({ url: `${origin}/sitemap.xml`, rule: "sitemap.missing", severity: "HIGH", message: "No XML sitemap found (checked robots.txt declarations and /sitemap.xml)." });
  const normalizedSitemap = [...new Set(sitemapUrls.map((u) => normalizeUrl(u, origin)).filter((u): u is string => Boolean(u)))];

  // BFS
  const queue: string[] = [start, ...normalizedSitemap.filter((u) => new URL(u).host === host)];
  const seen = new Set<string>();
  const pages: PageFacts[] = [];
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (robots && !isAllowed(robots, new URL(url).pathname, "Googlebot")) continue;
    try {
      const res = await fetcher(url);
      const ctype = res.headers["content-type"] ?? "";
      if (!ctype.includes("html") && res.status < 300) continue;
      const finalUrl = normalizeUrl(res.url, url) ?? url;
      const { facts, issues: pageIssues } = analyzeHtml({ url: finalUrl, status: res.status, html: res.body, headers: res.headers, bytes: res.bytes, loadMs: res.elapsedMs, redirects: res.redirects });
      if (finalUrl !== url) {
        // Record the redirecting URL too, so broken-link and orphan checks see it.
        seen.add(finalUrl);
      }
      pages.push(facts);
      issues.push(...pageIssues);
      opts.onProgress?.(pages.length);
      for (const l of facts.internalLinks) if (!seen.has(l) && new URL(l).host === host) queue.push(l);
    } catch (e) {
      pages.push({ url, status: 0, title: null, metaDescription: null, canonical: null, indexable: false, robotsMeta: null, h1: [], wordCount: 0, internalLinks: [], externalLinks: [], structuredDataTypes: [], hreflang: [], bytes: 0, loadMs: 0, lastModified: null });
      issues.push({ url, rule: "http.unreachable", severity: "HIGH", message: `Could not fetch: ${(e as Error).message}` });
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }

  issues.push(...analyzeSite({ pages, sitemapUrls: normalizedSitemap, homepage: start }));
  return { pages, issues, sitemapUrls: normalizedSitemap, robots };
}
