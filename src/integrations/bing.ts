import { DEFAULT_LINK_BUDGET, pagesToRead, parseLinkCounts, parseUrlLinks, summarizeBacklinks, topLinkedPages, type BacklinkSummary, type LinkCountEntry } from "@/core/search/backlinks";
import { isAuthFailure, ProviderHttpError, searchRow, type BacklinkFetchOptions, type ConnectionTest, type MetricRow, type SearchRow, type VisibilityAdapter } from "./types";

type Stat = { Date: string; Impressions: number; Clicks: number };
type QueryStat = { Query: string; Date: string; Impressions: number; Clicks: number; AvgImpressionPosition?: number; AvgClickPosition?: number };

/** Parses Bing's WCF JSON dates: "/Date(1700000000000-0800)/". */
export function parseBingDate(s: string): string {
  const m = /\/Date\((-?\d+)/.exec(s);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : s.slice(0, 10);
}

/** Bing reports -1 (or 0) when it has no position. */
const bingPosition = (v: number | undefined) => (typeof v === "number" && v > 0 ? v : null);

export function createBingAdapter(fetchImpl: typeof fetch = fetch): VisibilityAdapter {
  async function call<T>(method: string, apiKey: string, params: Record<string, string>): Promise<T> {
    if (!apiKey) throw new ProviderHttpError("bing-webmaster", 401, "No API key stored");
    // The URL carries the API key: it is never logged, and errors below never include it.
    const qs = new URLSearchParams({ ...params, apikey: apiKey });
    let res: Response;
    try {
      res = await fetchImpl(`https://ssl.bing.com/webmaster/api.svc/json/${method}?${qs}`, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new Error(`bing-webmaster ${method} request failed (${(e as Error).name})`);
    }
    if (!res.ok) throw new ProviderHttpError("bing-webmaster", res.status, `${method}: ${(await res.text()).replaceAll(apiKey, "[redacted]")}`);
    return ((await res.json()) as { d: T }).d;
  }
  return {
    provider: "BING_WEBMASTER",
    label: "Bing Webmaster Tools",
    docsUrl: "https://learn.microsoft.com/en-us/bingwebmaster/getting-access",
    capabilities: ["daily", "query", "page"],
    // Bing returns its whole history (about 6 months) in one call: no chunking needed.
    backfill: { months: 6, chunked: false },
    configFields: [{ key: "siteUrl", label: "Verified site URL (e.g. https://example.com/)", placeholder: "https://example.com/", required: true }],
    secretFields: [{ key: "apiKey", label: "Bing Webmaster API key" }],
    async testConnection(config, secret): Promise<ConnectionTest> {
      try {
        await call("GetRankAndTrafficStats", secret.apiKey, { siteUrl: config.siteUrl });
        return { ok: true, message: "Connected to Bing Webmaster Tools.", scopes: ["api-key:site-read"] };
      } catch (e) {
        return { ok: false, message: (e as Error).message, httpStatus: e instanceof ProviderHttpError ? e.status : undefined };
      }
    },
    async fetchMetrics(config, secret, range) {
      const stats = await call<Stat[]>("GetRankAndTrafficStats", secret.apiKey, { siteUrl: config.siteUrl });
      const out: MetricRow[] = [];
      for (const s of stats ?? []) {
        const day = parseBingDate(s.Date);
        if (day < range.start || day > range.end) continue;
        out.push({ metric: "search_impressions", day, value: s.Impressions });
        out.push({ metric: "search_clicks", day, value: s.Clicks });
      }
      return out;
    },
    async fetchSearchRows(config, secret, range, o = {}): Promise<SearchRow[]> {
      const inRange = (day: string) => day >= range.start && day <= range.end;
      const out: SearchRow[] = [];
      const totals = await call<Stat[]>("GetRankAndTrafficStats", secret.apiKey, { siteUrl: config.siteUrl });
      for (const s of totals ?? []) {
        const day = parseBingDate(s.Date);
        if (inRange(day)) out.push(searchRow({ day, clicks: s.Clicks, impressions: s.Impressions, position: null }));
      }
      const queries = await call<QueryStat[]>("GetQueryStats", secret.apiKey, { siteUrl: config.siteUrl });
      for (const s of queries ?? []) {
        const day = parseBingDate(s.Date);
        if (inRange(day) && s.Query) out.push(searchRow({ day, query: s.Query, clicks: s.Clicks, impressions: s.Impressions, position: bingPosition(s.AvgImpressionPosition) }));
      }
      const pages = await call<QueryStat[]>("GetPageStats", secret.apiKey, { siteUrl: config.siteUrl });
      for (const s of pages ?? []) {
        const day = parseBingDate(s.Date);
        if (inRange(day) && s.Query && (!o.pagePrefix || s.Query.startsWith(o.pagePrefix))) out.push(searchRow({ day, page: s.Query, clicks: s.Clicks, impressions: s.Impressions, position: bingPosition(s.AvgImpressionPosition) }));
      }
      return out;
    },
    /**
     * Inbound links (Bing Webmaster API GetLinkCounts + GetUrlLinks, see
     * src/core/search/backlinks.ts for the documented shapes and doc URLs).
     * Reads the site pages with inbound links (paged, capped), then the
     * linking URLs of the most-linked pages within a strict request and
     * time budget. Pages outside `pagePrefix` (another product on the same
     * property) are ignored. Returns null when Bing has no link data.
     * Failures of GetLinkCounts, and auth failures anywhere, throw; another
     * failure on one target's GetUrlLinks only marks the result incomplete.
     */
    async fetchBacklinks(config, secret, o: BacklinkFetchOptions = {}): Promise<BacklinkSummary | null> {
      const budget = { ...DEFAULT_LINK_BUDGET, ...o.budget };
      const now = o.clock ?? Date.now;
      const deadline = now() + budget.deadlineMs;
      let requests = 0;
      let complete = true;
      const canCall = () => requests < budget.maxRequests && now() < deadline;
      const get = async (method: string, params: Record<string, string>) => {
        if (requests > 0 && o.delayMs !== 0) await new Promise((r) => setTimeout(r, o.delayMs ?? 200));
        requests++;
        return call<unknown>(method, secret.apiKey, { siteUrl: config.siteUrl, ...params });
      };
      const inScope = (url: string) => !o.pagePrefix || url.startsWith(o.pagePrefix);

      const counts: LinkCountEntry[] = [];
      let pages = budget.maxCountPages;
      for (let page = 0; page < pages; page++) {
        if (!canCall()) {
          complete = false;
          break;
        }
        const r = parseLinkCounts(await get("GetLinkCounts", { page: String(page) }));
        if (page === 0) pages = pagesToRead(r.totalPages, budget.maxCountPages);
        if (page === 0 && r.totalPages !== null && r.totalPages > budget.maxCountPages) complete = false;
        if (!r.items.length) break;
        counts.push(...r.items.filter((c) => inScope(c.url)));
      }
      if (!counts.length) return null;

      const linking: { target: string; urls: string[] }[] = [];
      for (const target of topLinkedPages(counts, budget.maxTargets)) {
        const urls: string[] = [];
        let linkPages = budget.maxLinkPagesPerTarget;
        let read = false;
        for (let page = 0; page < linkPages; page++) {
          if (!canCall()) {
            complete = false;
            break;
          }
          let r;
          try {
            r = parseUrlLinks(await get("GetUrlLinks", { link: target, page: String(page) }));
          } catch (e) {
            if (isAuthFailure(e)) throw e;
            complete = false;
            break;
          }
          read = true;
          if (page === 0) linkPages = pagesToRead(r.totalPages, budget.maxLinkPagesPerTarget);
          if (page === 0 && r.totalPages !== null && r.totalPages > budget.maxLinkPagesPerTarget) complete = false;
          if (!r.items.length) break;
          urls.push(...r.items);
        }
        if (read) linking.push({ target, urls });
      }
      if (counts.length > linking.length) complete = false;
      const ownHosts = [config.siteUrl, o.pagePrefix].filter((h): h is string => Boolean(h));
      return summarizeBacklinks({ counts, linking, ownHosts, complete });
    },
  };
}
