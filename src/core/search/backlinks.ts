/**
 * Backlink data (Bing Webmaster Tools) parsing and aggregation. Pure: the
 * network paging lives in src/integrations/bing.ts.
 *
 * Response shapes (Bing Webmaster API, IWebmasterApi, JSON endpoint wraps
 * the result in `d`):
 *   GetLinkCounts(siteUrl, page)       -> LinkCounts  { Links: LinkCount[], TotalPages: int }
 *                                         LinkCount   { Url: string, Count: int }
 *   GetUrlLinks(siteUrl, link, page)   -> LinkDetails { Details: LinkDetail[], TotalPages: int }
 *                                         LinkDetail  { Url: string, AnchorText: string }
 * Pages are zero-based. See
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.linkcounts?view=bing-webmaster-dotnet
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.linkcount?view=bing-webmaster-dotnet
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.linkdetails?view=bing-webmaster-dotnet
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.linkdetail?view=bing-webmaster-dotnet
 * Every field is read defensively: anything missing or malformed is dropped,
 * never replaced by an invented value.
 */

export type LinkCountEntry = { url: string; count: number };
export type LinkPage<T> = { items: T[]; totalPages: number | null };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const totalPagesOf = (o: Record<string, unknown> | null) => {
  const n = Number(o?.TotalPages);
  return o && o.TotalPages !== undefined && o.TotalPages !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};
const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : null);

/** One GetLinkCounts page (`d` already unwrapped). Entries without a URL or a non-negative count are dropped. */
export function parseLinkCounts(d: unknown): LinkPage<LinkCountEntry> {
  const o = obj(d);
  const items: LinkCountEntry[] = [];
  for (const raw of Array.isArray(o?.Links) ? (o!.Links as unknown[]) : []) {
    const e = obj(raw);
    const url = httpUrl(e?.Url);
    const count = Number(e?.Count);
    if (!url || e?.Count === null || e?.Count === undefined || !Number.isFinite(count) || count < 0) continue;
    items.push({ url, count: Math.round(count) });
  }
  return { items, totalPages: totalPagesOf(o) };
}

/** One GetUrlLinks page (`d` already unwrapped): the linking (source) URLs. */
export function parseUrlLinks(d: unknown): LinkPage<string> {
  const o = obj(d);
  const items: string[] = [];
  for (const raw of Array.isArray(o?.Details) ? (o!.Details as unknown[]) : []) {
    const url = httpUrl(obj(raw)?.Url);
    if (url) items.push(url);
  }
  return { items, totalPages: totalPagesOf(o) };
}

/**
 * Referring "domain" key of a URL: the lower-cased host without a trailing
 * dot and without a leading "www.". This is host level, not the registrable
 * domain (no public suffix list is bundled), so blog.example.com and
 * example.com count as two referring domains. Returns null for non-HTTP URLs.
 */
export function referringDomain(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/** Paging and request limits for one backlink fetch (Bing API quota and job duration friendly). */
export type LinkBudget = {
  /** GetLinkCounts pages read at most. */
  maxCountPages: number;
  /** Most-linked target pages whose linking URLs are read. */
  maxTargets: number;
  /** GetUrlLinks pages read per target. */
  maxLinkPagesPerTarget: number;
  /** Hard cap on API requests for the whole fetch. */
  maxRequests: number;
  /** Wall-clock budget in ms; paging stops when exceeded. */
  deadlineMs: number;
};
export const DEFAULT_LINK_BUDGET: LinkBudget = { maxCountPages: 10, maxTargets: 10, maxLinkPagesPerTarget: 2, maxRequests: 40, deadlineMs: 120_000 };

/** Number of pages to read, given what the API reported (null = unknown: read until an empty page) and the cap. */
export const pagesToRead = (totalPages: number | null, cap: number) => (totalPages === null ? cap : Math.min(totalPages, cap));

export type BacklinkSummary = {
  /** Sum of Bing's per-page inbound link counts over the pages read (product-scoped when a page prefix applies). */
  inboundLinks: number;
  /** Site pages with inbound links that were read. */
  linkedPages: number;
  /** Distinct referring hosts among the sampled linking URLs (own host excluded); null when no linking URL was returned. */
  referringDomains: number | null;
  /** Target pages whose linking URLs were sampled. */
  sampledTargets: number;
  /** True when every page of every list was read (no budget cut). */
  complete: boolean;
};

/**
 * Aggregate fetched link data. Returns null when Bing returned no inbound
 * link data at all (nothing is measured then; zero is never invented).
 */
export function summarizeBacklinks(input: { counts: LinkCountEntry[]; linking: { target: string; urls: string[] }[]; ownHosts: string[]; complete: boolean }): BacklinkSummary | null {
  const byUrl = new Map<string, number>();
  for (const c of input.counts) byUrl.set(c.url, Math.max(byUrl.get(c.url) ?? 0, c.count));
  if (!byUrl.size) return null;
  const own = new Set(input.ownHosts.map((h) => referringDomain(/^https?:\/\//i.test(h) ? h : `https://${h}`)).filter((h): h is string => Boolean(h)));
  const domains = new Set<string>();
  let anyUrl = false;
  for (const t of input.linking)
    for (const u of t.urls) {
      const d = referringDomain(u);
      if (!d) continue;
      anyUrl = true;
      if (!own.has(d)) domains.add(d);
    }
  return {
    inboundLinks: [...byUrl.values()].reduce((a, b) => a + b, 0),
    linkedPages: byUrl.size,
    referringDomains: anyUrl ? domains.size : null,
    sampledTargets: input.linking.length,
    complete: input.complete,
  };
}

/** Most-linked pages first (ties by URL, deterministic), limited to `n`. */
export function topLinkedPages(counts: LinkCountEntry[], n: number): string[] {
  return [...counts]
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .slice(0, n)
    .map((c) => c.url);
}
