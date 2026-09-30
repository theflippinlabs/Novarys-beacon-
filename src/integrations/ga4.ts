import { classifyChannel } from "@/core/attribution/attribution";
import { googleAccessToken } from "./google-auth";
import { ProviderHttpError, type MetricRow, type VisibilityAdapter } from "./types";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export function createGa4Adapter(fetchImpl: typeof fetch = fetch): VisibilityAdapter {
  async function runReport(token: string, propertyId: string, body: object) {
    const res = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new ProviderHttpError("ga4", res.status, await res.text());
    return ((await res.json()) as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }).rows ?? [];
  }
  return {
    provider: "GOOGLE_ANALYTICS",
    label: "Google Analytics 4",
    docsUrl: "https://developers.google.com/analytics/devguides/reporting/data/v1",
    configFields: [{ key: "propertyId", label: "GA4 property ID (numeric)", required: true }],
    secretFields: [{ key: "serviceAccountJson", label: "Service account JSON (grant Viewer on the property)", multiline: true }],
    async testConnection(config, secret) {
      try {
        const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
        await runReport(token, config.propertyId, { dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }], metrics: [{ name: "sessions" }], limit: 1 });
        return { ok: true, message: "Connected to Google Analytics." };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async fetchMetrics(config, secret, range) {
      const token = await googleAccessToken(secret.serviceAccountJson, [SCOPE], fetchImpl);
      const rows = await runReport(token, config.propertyId, {
        dateRanges: [{ startDate: range.start, endDate: range.end }],
        dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }],
        limit: 100000,
      });
      const agg = new Map<string, number>();
      for (const r of rows) {
        const [d, source, medium] = r.dimensionValues.map((v) => v.value);
        const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        const host = source && source !== "(direct)" && source.includes(".") ? source : null;
        const channel = medium === "organic" ? "ORGANIC_SEARCH" : classifyChannel({ referrerHost: host, utm: { utm_source: source === "(direct)" ? "" : source, utm_medium: medium === "(none)" ? "" : medium } });
        const key = `${day}|${channel}`;
        agg.set(key, (agg.get(key) ?? 0) + Number(r.metricValues[0].value));
      }
      const out: MetricRow[] = [];
      for (const [key, value] of agg) {
        const [day, channel] = key.split("|");
        out.push({ metric: "sessions", day, dimension: channel, value });
        if (channel === "AI_REFERRAL") out.push({ metric: "ai_referral_sessions", day, value });
      }
      return out;
    },
  };
}
