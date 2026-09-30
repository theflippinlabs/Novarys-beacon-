import { ProviderHttpError, type MetricRow, type VisibilityAdapter } from "./types";

type Stat = { Date: string; Impressions: number; Clicks: number };

/** Parses Bing's WCF JSON dates: "/Date(1700000000000-0800)/". */
export function parseBingDate(s: string): string {
  const m = /\/Date\((-?\d+)/.exec(s);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : s.slice(0, 10);
}

export function createBingAdapter(fetchImpl: typeof fetch = fetch): VisibilityAdapter {
  async function call<T>(method: string, apiKey: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, apikey: apiKey });
    const res = await fetchImpl(`https://ssl.bing.com/webmaster/api.svc/json/${method}?${qs}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ProviderHttpError("bing-webmaster", res.status, await res.text());
    return ((await res.json()) as { d: T }).d;
  }
  return {
    provider: "BING_WEBMASTER",
    label: "Bing Webmaster Tools",
    docsUrl: "https://learn.microsoft.com/en-us/bingwebmaster/getting-access",
    configFields: [{ key: "siteUrl", label: "Verified site URL (e.g. https://example.com/)", required: true }],
    secretFields: [{ key: "apiKey", label: "Bing Webmaster API key" }],
    async testConnection(config, secret) {
      try {
        await call("GetRankAndTrafficStats", secret.apiKey, { siteUrl: config.siteUrl });
        return { ok: true, message: "Connected to Bing Webmaster Tools." };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
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
  };
}
