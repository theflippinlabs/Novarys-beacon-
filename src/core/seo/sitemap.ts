import * as cheerio from "cheerio";
import { escapeHtml } from "@/core/util/text";

export type SitemapEntry = { loc: string; lastmod?: string; alternates?: { hreflang: string; href: string }[] };

export function parseSitemap(xml: string): { kind: "index" | "urlset" | "invalid"; locs: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  if ($("sitemapindex").length) return { kind: "index", locs: $("sitemapindex > sitemap > loc").map((_, el) => $(el).text().trim()).get() };
  if ($("urlset").length) return { kind: "urlset", locs: $("urlset > url > loc").map((_, el) => $(el).text().trim()).get() };
  return { kind: "invalid", locs: [] };
}

export function buildSitemap(entries: SitemapEntry[]): string {
  const hasAlt = entries.some((e) => e.alternates?.length);
  const body = entries
    .map((e) => {
      const alts = (e.alternates ?? []).map((a) => `    <xhtml:link rel="alternate" hreflang="${escapeHtml(a.hreflang)}" href="${escapeHtml(a.href)}"/>`).join("\n");
      return `  <url>\n    <loc>${escapeHtml(e.loc)}</loc>${e.lastmod ? `\n    <lastmod>${escapeHtml(e.lastmod)}</lastmod>` : ""}${alts ? "\n" + alts : ""}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasAlt ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ""}>\n${body}\n</urlset>\n`;
}

export function buildSitemapIndex(sitemaps: { loc: string; lastmod?: string }[]): string {
  const body = sitemaps.map((s) => `  <sitemap>\n    <loc>${escapeHtml(s.loc)}</loc>${s.lastmod ? `\n    <lastmod>${escapeHtml(s.lastmod)}</lastmod>` : ""}\n  </sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}
