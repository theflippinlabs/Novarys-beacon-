import { classifyChannel } from "@/core/attribution/attribution";
import { googleAccessToken } from "./google-auth";
import { clipBytes, ProviderHttpError, type AnalyticsRow, type ConnectionTest, type DateRange, type MetricRow, type VisibilityAdapter } from "./types";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** Rows per runReport page and the page cap per report (500k rows). */
export const GA4_PAGE_SIZE = 10_000;
const MAX_PAGES = 50;

type ReportRow = { dimensionValues: { value: string }[]; metricValues: { value: string }[] };

/** GA4 reports imported into analytics_daily (one row grain each). */
export const GA4_REPORTS = {
  landing: ["date", "landingPage", "sessionSource", "sessionMedium", "sessionCampaignName"],
  geo_device: ["date", "countryId", "deviceCategory"],
} as const;
const GA4_METRICS = ["sessions", "totalUsers", "engagedSessions", "keyEvents"] as const;

const isoDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const num = (v: string | undefined) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));

export function createGa4Adapter(fetchImpl: typeof fetch = fetch): VisibilityAdapter {
  async function runReport(token: string, propertyId: string, body: object) {
    const res = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new ProviderHttpError("ga4", res.status, await res.text());
    const json = (await res.json()) as { rows?: ReportRow[]; rowCount?: number };
    return { rows: json.rows ?? [], rowCount: json.rowCount ?? 0 };
  }

  /** One report, paginated with offset until `rowCount` rows were read. */
  async function allRows(token: string, propertyId: string, body: Record<string, unknown>) {
    const out: ReportRow[] = [];
    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      const r = await runReport(token, propertyId, { ...body, limit: GA4_PAGE_SIZE, offset });
      out.push(...r.rows);
      offset += r.rows.length;
      if (!r.rows.length || offset >= r.rowCount) break;
    }
    return out;
  }

  return {
    provider: "GOOGLE_ANALYTICS",
    label: "Google Analytics 4",
    docsUrl: "https://developers.google.com/analytics/devguides/reporting/data/v1",
    configFields: [{ key: "propertyId", label: "GA4 property ID (numeric)", required: true }],
    secretFields: [{ key: "serviceAccountJson", label: "Service account JSON (grant Viewer on the property)", multiline: true }],
    async testConnection(config, secret): Promise<ConnectionTest> {
      try {
        const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
        await runReport(token, config.propertyId, { dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }], metrics: [{ name: "sessions" }], limit: 1 });
        return { ok: true, message: "Connected to Google Analytics.", scopes: [SCOPE] };
      } catch (e) {
        return { ok: false, message: (e as Error).message, httpStatus: e instanceof ProviderHttpError ? e.status : undefined };
      }
    },
    /** Sessions per day and channel (visibility_metrics), including GA4's own AI-assistant referral sessions. */
    async fetchMetrics(config, secret, range: DateRange) {
      const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
      const rows = await allRows(token, config.propertyId, {
        dateRanges: [{ startDate: range.start, endDate: range.end }],
        dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }],
      });
      const agg = new Map<string, number>();
      for (const r of rows) {
        const [d, source, medium] = r.dimensionValues.map((v) => v.value);
        const host = source && source !== "(direct)" && source.includes(".") ? source : null;
        const channel = medium === "organic" ? "ORGANIC_SEARCH" : classifyChannel({ referrerHost: host, utm: { utm_source: source === "(direct)" ? "" : source, utm_medium: medium === "(none)" ? "" : medium } });
        const key = `${isoDate(d)}|${channel}`;
        agg.set(key, (agg.get(key) ?? 0) + num(r.metricValues[0]?.value));
      }
      const out: MetricRow[] = [];
      for (const [key, value] of agg) {
        const [day, channel] = key.split("|");
        out.push({ metric: "sessions", day, dimension: channel, value });
        if (channel === "AI_REFERRAL") out.push({ metric: "ai_referral_sessions", day, value });
      }
      return out;
    },
    /** Landing page / source / medium / campaign and country / device reports, every page of each. */
    async fetchAnalyticsDaily(config, secret, range: DateRange): Promise<AnalyticsRow[]> {
      const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
      const out: AnalyticsRow[] = [];
      for (const report of ["landing", "geo_device"] as const) {
        const dims = GA4_REPORTS[report];
        const rows = await allRows(token, config.propertyId, {
          dateRanges: [{ startDate: range.start, endDate: range.end }],
          dimensions: dims.map((name) => ({ name })),
          metrics: GA4_METRICS.map((name) => ({ name })),
        });
        for (const r of rows) {
          const v = Object.fromEntries(dims.map((d, i) => [d, r.dimensionValues[i]?.value ?? ""])) as Record<string, string>;
          const m = r.metricValues.map((x) => num(x.value));
          out.push({
            report,
            day: isoDate(v.date),
            landingPage: clipBytes(v.landingPage ?? "", 1000),
            source: clipBytes(v.sessionSource ?? "", 200),
            medium: clipBytes(v.sessionMedium ?? "", 100),
            campaign: clipBytes(v.sessionCampaignName ?? "", 200),
            country: (v.countryId ?? "").slice(0, 8),
            device: (v.deviceCategory ?? "").slice(0, 16),
            sessions: Math.round(m[0] ?? 0),
            users: Math.round(m[1] ?? 0),
            engagedSessions: Math.round(m[2] ?? 0),
            keyEvents: m[3] ?? 0,
          });
        }
      }
      return out;
    },
  };
}
