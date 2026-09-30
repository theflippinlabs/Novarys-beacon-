import * as cheerio from "cheerio";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type Issue = { url: string; rule: string; severity: Severity; message: string; details?: Record<string, unknown> };

export type PageFacts = {
  url: string;
  status: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  indexable: boolean;
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
};

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

/**
 * Analyse one HTML document. Pure: takes the fetched response, returns facts
 * and issues. Page-speed findings here are server-side signals only
 * (response time and weight), clearly labelled — not lab/field Web Vitals.
 */
export function analyzeHtml(input: {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  bytes: number;
  loadMs: number;
  redirects?: string[];
}): { facts: PageFacts; issues: Issue[] } {
  const { url, status, html, headers } = input;
  const issues: Issue[] = [];
  const add = (rule: string, severity: Severity, message: string, details?: Record<string, unknown>) => issues.push({ url, rule, severity, message, details });
  const $ = cheerio.load(html);
  const host = new URL(url).host;

  if (status >= 400) add("http.error", status >= 500 ? "CRITICAL" : "HIGH", `Page returned HTTP ${status}.`, { status });
  if ((input.redirects?.length ?? 0) > 1) add("http.redirect_chain", "LOW", `Redirect chain of ${input.redirects!.length} hops.`, { chain: input.redirects });

  const title = $("head > title").first().text().trim() || null;
  if (!title) add("meta.title_missing", "HIGH", "Missing <title>.");
  else if (title.length < 15 || title.length > 65) add("meta.title_length", "LOW", `Title is ${title.length} characters (aim for 15–65).`, { length: title.length });

  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  if (!metaDescription) add("meta.description_missing", "MEDIUM", "Missing meta description.");
  else if (metaDescription.length < 50 || metaDescription.length > 165) add("meta.description_length", "LOW", `Meta description is ${metaDescription.length} characters (aim for 50–165).`);

  const h1 = $("h1").map((_, el) => $(el).text().trim()).get();
  if (h1.length === 0) add("headings.h1_missing", "HIGH", "No H1 heading.");
  else if (h1.length > 1) add("headings.h1_multiple", "LOW", `${h1.length} H1 headings.`);
  let prev = 0;
  let skipped = false;
  $("h1,h2,h3,h4,h5,h6").each((_, el) => {
    const lvl = Number(el.tagName.slice(1));
    if (prev && lvl > prev + 1) skipped = true;
    prev = lvl;
  });
  if (skipped) add("headings.hierarchy", "LOW", "Heading levels skip (e.g. H2 → H4).");

  const canonicalRaw = $('link[rel="canonical"]').attr("href")?.trim() || null;
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, url) : null;
  if (!canonicalRaw) add("canonical.missing", "MEDIUM", "No canonical URL declared.");
  else {
    if (!/^https?:\/\//.test(canonicalRaw)) add("canonical.relative", "LOW", "Canonical URL is relative; use an absolute URL.");
    if (canonical && new URL(canonical).host !== host) add("canonical.cross_domain", "MEDIUM", `Canonical points to another host (${new URL(canonical).host}).`);
  }

  const robotsMeta = [$('meta[name="robots"]').attr("content"), headers["x-robots-tag"]].filter(Boolean).join(", ").toLowerCase() || null;
  const indexable = status < 300 && !(robotsMeta?.includes("noindex") ?? false) && (!canonical || normalizeUrl(canonical, url) === normalizeUrl(url, url));
  if (robotsMeta?.includes("noindex")) add("robots.noindex", "HIGH", "Page is set to noindex.", { robots: robotsMeta });

  if (!$('meta[property="og:title"]').attr("content")) add("social.og_title", "LOW", "Missing og:title.");
  if (!$('meta[property="og:description"]').attr("content")) add("social.og_description", "LOW", "Missing og:description.");
  if (!$('meta[property="og:image"]').attr("content")) add("social.og_image", "LOW", "Missing og:image.");
  if (!$('meta[name="twitter:card"]').attr("content")) add("social.twitter_card", "LOW", "Missing twitter:card.");

  if (!$("html").attr("lang")) add("a11y.html_lang", "LOW", "Missing lang attribute on <html>.");
  if (!$('meta[name="viewport"]').attr("content")) add("mobile.viewport", "MEDIUM", "Missing viewport meta tag.");

  const imgs = $("img");
  const noAlt = imgs.filter((_, el) => $(el).attr("alt") === undefined).length;
  if (noAlt > 0) add("images.alt_missing", "MEDIUM", `${noAlt} of ${imgs.length} images have no alt attribute.`, { count: noAlt });
  const noDims = imgs.filter((_, el) => !$(el).attr("width") || !$(el).attr("height")).length;
  if (noDims > 0) add("images.dimensions", "LOW", `${noDims} images lack explicit width/height (layout shift risk).`);

  const emptyAnchors = $("a[href]").filter((_, el) => !$(el).text().trim() && !$(el).attr("aria-label") && !$(el).find("img[alt]").length).length;
  if (emptyAnchors) add("a11y.empty_links", "LOW", `${emptyAnchors} links have no accessible text.`);

  const hreflang = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr("hreflang") ?? "").trim(), href: normalizeUrl($(el).attr("href") ?? "", url) ?? "" }))
    .get();
  if (hreflang.length) {
    const invalid = hreflang.filter((h) => !/^(x-default|[a-z]{2,3}(-[A-Za-z]{2}|-[A-Za-z]{4})?)$/.test(h.lang));
    if (invalid.length) add("hreflang.invalid", "MEDIUM", `Invalid hreflang values: ${invalid.map((i) => i.lang).join(", ")}`);
    if (!hreflang.some((h) => h.href === normalizeUrl(url, url))) add("hreflang.self", "LOW", "hreflang set does not reference this page.");
  }

  const structuredDataTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const collect = (d: unknown) => {
        if (Array.isArray(d)) d.forEach(collect);
        else if (d && typeof d === "object") {
          const t = (d as Record<string, unknown>)["@type"];
          if (typeof t === "string") structuredDataTypes.push(t);
          else if (Array.isArray(t)) structuredDataTypes.push(...t.map(String));
          const graph = (d as Record<string, unknown>)["@graph"];
          if (graph) collect(graph);
        }
      };
      collect(data);
    } catch {
      add("schema.invalid_json", "MEDIUM", "A JSON-LD block could not be parsed.");
    }
  });

  if (url.startsWith("https:")) {
    const mixed = $('img[src^="http:"],script[src^="http:"],link[href^="http:"][rel="stylesheet"],iframe[src^="http:"]').length;
    if (mixed) add("security.mixed_content", "MEDIUM", `${mixed} resources loaded over insecure http.`);
  }

  $("script,style,noscript,template").remove();
  $("body *").append(" ");
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = text ? text.split(" ").length : 0;
  if (status < 300 && wordCount < 200) add("content.thin", "LOW", `Only ${wordCount} words of visible text.`, { wordCount });

  if (input.bytes > 1_500_000) add("speed.page_weight", "MEDIUM", `HTML document is ${(input.bytes / 1024).toFixed(0)} KB.`);
  if (input.loadMs > 2500) add("speed.server_response", "MEDIUM", `Server responded in ${input.loadMs} ms (signal only; not a Core Web Vitals measurement).`);

  const lastModified = $('meta[property="article:modified_time"]').attr("content") ?? headers["last-modified"] ?? null;
  if (lastModified) {
    const age = Date.now() - new Date(lastModified).getTime();
    if (Number.isFinite(age) && age > 365 * 86_400_000) add("content.stale", "LOW", "Content not updated for over a year.", { lastModified });
  }

  const internalLinks = new Set<string>();
  const externalLinks = new Set<string>();
  const $$ = cheerio.load(html);
  $$("a[href]").each((_, el) => {
    const rel = ($$(el).attr("rel") ?? "").toLowerCase();
    const n = normalizeUrl($$(el).attr("href")!, url);
    if (!n) return;
    if (new URL(n).host === host) internalLinks.add(n);
    else if (!rel.includes("sponsored")) externalLinks.add(n);
  });

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
    },
    issues,
  };
}

/** Cross-page analysis: duplicates, orphans, broken internal links, missing entity schema. */
export function analyzeSite(input: { pages: PageFacts[]; sitemapUrls: string[]; homepage: string }): Issue[] {
  const issues: Issue[] = [];
  const ok = input.pages.filter((p) => p.status < 300);
  const byUrl = new Map(input.pages.map((p) => [p.url, p]));

  const dup = (key: "title" | "metaDescription", rule: string, label: string) => {
    const groups = new Map<string, string[]>();
    for (const p of ok) {
      const v = p[key];
      if (!v) continue;
      groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    for (const [value, urls] of groups)
      if (urls.length > 1)
        for (const u of urls) issues.push({ url: u, rule, severity: "MEDIUM", message: `Duplicate ${label} shared with ${urls.length - 1} other page(s).`, details: { value, urls } });
  };
  dup("title", "duplicate.title", "title");
  dup("metaDescription", "duplicate.description", "meta description");

  const inlinks = new Map<string, number>();
  for (const p of input.pages) for (const l of p.internalLinks) if (l !== p.url) inlinks.set(l, (inlinks.get(l) ?? 0) + 1);
  for (const p of ok) {
    if (p.url === input.homepage) continue;
    if (!inlinks.get(p.url)) issues.push({ url: p.url, rule: "links.orphan", severity: "MEDIUM", message: "Orphan page: no internal links point to it." });
  }
  for (const s of input.sitemapUrls) {
    if (!byUrl.has(s)) continue;
    const p = byUrl.get(s)!;
    if (p.status >= 400) issues.push({ url: s, rule: "sitemap.broken_entry", severity: "MEDIUM", message: `Sitemap lists a URL returning ${p.status}.` });
    if (!p.indexable && p.status < 300) issues.push({ url: s, rule: "sitemap.non_indexable", severity: "LOW", message: "Sitemap lists a non-indexable URL." });
  }

  for (const p of input.pages) {
    for (const l of p.internalLinks) {
      const target = byUrl.get(l);
      if (target && target.status >= 400)
        issues.push({ url: p.url, rule: "links.broken_internal", severity: "HIGH", message: `Links to ${l} which returns ${target.status}.`, details: { target: l } });
    }
  }

  const home = byUrl.get(input.homepage);
  if (home && !home.structuredDataTypes.some((t) => ["Organization", "SoftwareApplication", "WebApplication", "Product"].includes(t)))
    issues.push({ url: input.homepage, rule: "schema.entity_missing", severity: "LOW", message: "Homepage has no Organization / SoftwareApplication structured data." });

  return issues;
}

export const SEVERITY_PENALTY: Record<Severity, number> = { CRITICAL: 4, HIGH: 2, MEDIUM: 1, LOW: 0.25, INFO: 0 };
