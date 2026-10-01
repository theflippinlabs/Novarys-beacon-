import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { escapeHtml } from "@/core/util/text";

export type SitemapEntry = { loc: string; lastmod?: string; alternates?: { hreflang: string; href: string }[] };

export function parseSitemap(xml: string): { kind: "index" | "urlset" | "invalid"; locs: string[] } {
  const d = parseSitemapDetailed(xml);
  return { kind: d.kind, locs: d.entries.map((e) => e.loc) };
}

/** Like parseSitemap, with each entry's lastmod. */
export function parseSitemapDetailed(xml: string): { kind: "index" | "urlset" | "invalid"; entries: { loc: string; lastmod: string | null }[] } {
  const $ = cheerio.load(xml, { xml: true });
  const read = (sel: string) =>
    $(sel)
      .map((_, el) => ({ loc: $(el).children("loc").first().text().trim(), lastmod: $(el).children("lastmod").first().text().trim() || null }))
      .get()
      .filter((e) => e.loc);
  if ($("sitemapindex").length) return { kind: "index", entries: read("sitemapindex > sitemap") };
  if ($("urlset").length) return { kind: "urlset", entries: read("urlset > url") };
  return { kind: "invalid", entries: [] };
}

/** Maximum decompressed sitemap size (the sitemaps.org limit). */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

export class SitemapDecodeError extends Error {
  constructor(public reason: "TOO_LARGE" | "DECOMPRESS_FAILED") {
    super(reason === "TOO_LARGE" ? "Sitemap is larger than 50 MB once decompressed" : "Sitemap gzip data could not be decompressed");
    this.name = "SitemapDecodeError";
  }
}

/**
 * Decode a fetched sitemap body. gzip is detected from the .gz suffix, a
 * Content-Encoding: gzip header or the gzip magic bytes, and decompressed
 * with a hard output cap so a small "zip bomb" cannot exhaust memory.
 */
export function decodeSitemapBody(raw: Buffer, opts: { maxBytes?: number } = {}): { xml: string; compressed: boolean } {
  const max = opts.maxBytes ?? MAX_SITEMAP_BYTES;
  const magic = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  // A .gz URL or Content-Encoding: gzip whose bytes are not gzip was already decoded upstream: read it as is.
  if (!magic) {
    if (raw.length > max) throw new SitemapDecodeError("TOO_LARGE");
    return { xml: raw.toString("utf8"), compressed: false };
  }
  let out: Buffer;
  try {
    out = gunzipSync(raw, { maxOutputLength: max });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw new SitemapDecodeError("TOO_LARGE");
    throw new SitemapDecodeError("DECOMPRESS_FAILED");
  }
  return { xml: out.toString("utf8"), compressed: true };
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
