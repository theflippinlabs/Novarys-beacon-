import { googleAccessToken } from "./google-auth";
import { ProviderHttpError, type DateRange, type MetricRow, type VisibilityAdapter } from "./types";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

export function createSearchConsoleAdapter(fetchImpl: typeof fetch = fetch): VisibilityAdapter {
  async function query(token: string, siteUrl: string, body: object): Promise<Row[]> {
    const res = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new ProviderHttpError("search-console", res.status, await res.text());
    return ((await res.json()) as { rows?: Row[] }).rows ?? [];
  }
  return {
    provider: "GOOGLE_SEARCH_CONSOLE",
    label: "Google Search Console",
    docsUrl: "https://developers.google.com/webmaster-tools/v1/searchanalytics/query",
    configFields: [{ key: "siteUrl", label: "Property (e.g. sc-domain:example.com or https://example.com/)", required: true }],
    secretFields: [{ key: "serviceAccountJson", label: "Service account JSON (add the service account email as a user on the property)", multiline: true }],
    async testConnection(config, secret) {
      try {
        const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
        const end = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
        await query(token, config.siteUrl, { startDate: end, endDate: end, rowLimit: 1 });
        return { ok: true, message: "Connected to Search Console." };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async fetchMetrics(config, secret, range: DateRange) {
      const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
      const daily = await query(token, config.siteUrl, { startDate: range.start, endDate: range.end, dimensions: ["date"], rowLimit: 500 });
      const rows: MetricRow[] = [];
      for (const r of daily) {
        rows.push({ metric: "search_impressions", day: r.keys[0], value: r.impressions });
        rows.push({ metric: "search_clicks", day: r.keys[0], value: r.clicks });
        rows.push({ metric: "search_position", day: r.keys[0], value: r.position, weight: r.impressions });
      }
      // Per-query aggregates for the whole range, stored on the range end date.
      const byQuery = await query(token, config.siteUrl, { startDate: range.start, endDate: range.end, dimensions: ["query"], rowLimit: 1000 });
      for (const r of byQuery) {
        rows.push({ metric: "query_impressions", day: range.end, dimension: r.keys[0], value: r.impressions });
        rows.push({ metric: "query_clicks", day: range.end, dimension: r.keys[0], value: r.clicks });
        rows.push({ metric: "query_position", day: range.end, dimension: r.keys[0], value: r.position, weight: r.impressions });
      }
      const byPage = await query(token, config.siteUrl, { startDate: range.start, endDate: range.end, dimensions: ["page"], rowLimit: 1000 });
      rows.push({ metric: "indexed_pages_with_impressions", day: range.end, value: byPage.filter((r) => r.impressions > 0).length });
      return rows;
    },
  };
}
