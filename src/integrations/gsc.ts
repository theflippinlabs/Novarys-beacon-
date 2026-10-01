import { googleAccessToken } from "./google-auth";
import { googleOAuthClient, GSC_SCOPE, refreshAccessToken, type GoogleOAuthClient } from "./google-oauth";
import { AuthExpiredError, IntegrationConfigError, ProviderHttpError, searchRow, type ConnectionTest, type DateRange, type MetricRow, type SearchFetchOptions, type SearchRow, type VisibilityAdapter } from "./types";

type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
type Dim = "date" | "query" | "page" | "country" | "device";

/** Maximum rows per Search Analytics request (API limit). */
export const GSC_PAGE_SIZE = 25_000;
const MAX_PAGES = 40;

/**
 * Reports pulled per range. Each one yields one row grain in search_daily:
 * daily totals, per query, per page, per query and page, per country, per device.
 */
export const GSC_REPORTS: Dim[][] = [["date"], ["date", "query"], ["date", "page"], ["date", "query", "page"], ["date", "country"], ["date", "device"]];

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createSearchConsoleAdapter(fetchImpl: typeof fetch = fetch, opts: { oauthClient?: () => GoogleOAuthClient | null; delayMs?: number } = {}): VisibilityAdapter {
  const oauthClient = opts.oauthClient ?? googleOAuthClient;

  /** OAuth refresh token when connected with Google; service-account JWT otherwise. */
  async function token(secret: Record<string, string>): Promise<string> {
    if (secret.refreshToken) {
      const client = oauthClient();
      if (!client) throw new IntegrationConfigError("Google OAuth client is not configured (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET).");
      return refreshAccessToken(client, secret.refreshToken, fetchImpl);
    }
    if (secret.serviceAccountJson) return googleAccessToken(secret.serviceAccountJson, [GSC_SCOPE], fetchImpl);
    throw new IntegrationConfigError("No Search Console credentials stored: connect with Google or add a service account.");
  }

  async function query(accessToken: string, siteUrl: string, body: object): Promise<Row[]> {
    const res = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new ProviderHttpError("search-console", res.status, await res.text());
    return ((await res.json()) as { rows?: Row[] }).rows ?? [];
  }

  /** One report, paginated with startRow until exhausted; calls are sequential with a small pause (quota). */
  async function report(accessToken: string, siteUrl: string, range: DateRange, dims: Dim[], o: SearchFetchOptions): Promise<Row[]> {
    const out: Row[] = [];
    const filter = o.pagePrefix ? { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "includingRegex", expression: `^${escapeRe(o.pagePrefix)}` }] }] } : {};
    for (let page = 0, startRow = 0; page < MAX_PAGES; page++) {
      const rows = await query(accessToken, siteUrl, { startDate: range.start, endDate: range.end, dimensions: dims, type: "web", dataState: "final", rowLimit: GSC_PAGE_SIZE, startRow, ...filter });
      out.push(...rows);
      if (rows.length < GSC_PAGE_SIZE) break;
      startRow += rows.length;
      await sleep(o.delayMs ?? opts.delayMs ?? 200);
    }
    return out;
  }

  const adapter: VisibilityAdapter = {
    provider: "GOOGLE_SEARCH_CONSOLE",
    label: "Google Search Console",
    docsUrl: "https://developers.google.com/webmaster-tools/v1/searchanalytics/query",
    capabilities: ["daily", "query", "page", "country", "device"],
    backfill: { months: 16, chunked: true },
    configFields: [
      { key: "siteUrl", label: "Property (e.g. sc-domain:example.com or https://example.com/)", placeholder: "sc-domain:example.com", required: true },
      { key: "urlPrefix", label: "Page URL prefix for this product (optional)", placeholder: "https://example.com/product/", required: false, hint: "Only when one property serves several products. Defaults to the product domain in that case." },
    ],
    secretFields: [{ key: "serviceAccountJson", label: "Service account JSON", multiline: true, hint: "Add the service account email as a user on the property." }],
    async testConnection(config, secret): Promise<ConnectionTest> {
      try {
        const accessToken = await token(secret);
        const site = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(config.siteUrl)}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
        if (!site.ok) throw new ProviderHttpError("search-console", site.status, await site.text());
        const permission = ((await site.json()) as { permissionLevel?: string }).permissionLevel ?? "unknown";
        if (permission === "siteUnverifiedUser") return { ok: false, message: "The account has no verified access to this property.", httpStatus: 403 };
        const end = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
        await query(accessToken, config.siteUrl, { startDate: end, endDate: end, rowLimit: 1 });
        return { ok: true, message: "Connected to Search Console.", scopes: [GSC_SCOPE, `property:${permission}`] };
      } catch (e) {
        return { ok: false, message: (e as Error).message, httpStatus: e instanceof ProviderHttpError ? e.status : e instanceof AuthExpiredError ? 401 : undefined };
      }
    },
    async fetchMetrics(config, secret, range: DateRange) {
      const accessToken = await token(secret);
      const daily = await report(accessToken, config.siteUrl, range, ["date"], {});
      const rows: MetricRow[] = [];
      for (const r of daily) {
        rows.push({ metric: "search_impressions", day: r.keys[0], value: r.impressions });
        rows.push({ metric: "search_clicks", day: r.keys[0], value: r.clicks });
        rows.push({ metric: "search_position", day: r.keys[0], value: r.position, weight: r.impressions });
      }
      return rows;
    },
    async fetchSearchRows(config, secret, range, o: SearchFetchOptions = {}): Promise<SearchRow[]> {
      const accessToken = await token(secret);
      const out: SearchRow[] = [];
      for (const dims of GSC_REPORTS) {
        const rows = await report(accessToken, config.siteUrl, range, dims, o);
        for (const r of rows) {
          const v = (d: Dim) => {
            const i = dims.indexOf(d);
            return i >= 0 ? (r.keys[i] ?? null) : null;
          };
          // A row missing one of its own dimensions would collide with another grain: skip it.
          if (dims.some((d) => !v(d))) continue;
          out.push(searchRow({ day: v("date")!, query: v("query"), page: v("page"), country: v("country"), device: v("device"), clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
        }
        await sleep(o.delayMs ?? opts.delayMs ?? 200);
      }
      return out;
    },
  };
  return adapter;
}
