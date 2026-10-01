import { ProviderHttpError, searchRow, type ConnectionTest, type MetricRow, type SearchRow, type VisibilityAdapter } from "./types";

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
  };
}
