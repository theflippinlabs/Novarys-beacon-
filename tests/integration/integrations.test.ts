import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { auditLogs, integrations, products, providerCredentials, visibilityMetrics } from "@/db/schema";
import { loadSecret, metricSeries, saveIntegration, syncIntegration, upsertMetrics } from "@/services/visibility";
import { createSearchConsoleAdapter } from "@/integrations/gsc";
import { createGa4Adapter } from "@/integrations/ga4";
import { createBingAdapter } from "@/integrations/bing";
import { encryptSecret } from "@/lib/security/crypto";
import { newOrg, uid } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
let productId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({ client_email: "beacon@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => unknown, calls: Call[] = []) {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

beforeAll(async () => {
  ctx = await newOrg("integ");
  orgId = ctx.org.id;
  productId = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `gsc-${uid()}`, name: "Search Product" }).returning()))[0].id;
});
afterAll(closeDb);

describe("encrypted credentials", () => {
  it("saveIntegration stores the secret encrypted; loadSecret round-trips; audit log never contains it", async () => {
    const secret = { serviceAccountJson: `{"private_key":"PLAINTEXT-${uid()}"}` };
    const integ = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId, config: { siteUrl: "sc-domain:example.com" }, secret }));
    const row = (await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integ.id) })))!;
    expect(row).toMatchObject({ status: "CONNECTED", config: { siteUrl: "sc-domain:example.com" } });
    const cred = (await q((tx) => tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integ.id) })))!;
    expect(cred.ciphertext).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(cred.ciphertext).not.toContain("PLAINTEXT");
    expect(cred.ciphertext).not.toContain(secret.serviceAccountJson);
    expect(Buffer.from(cred.ciphertext.split(":")[3], "base64").toString("utf8")).not.toContain("PLAINTEXT");
    expect(await q((tx) => loadSecret(tx, integ.id))).toEqual(secret);

    const logs = await q((tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "integration.save"))));
    expect(JSON.stringify(logs)).not.toContain("PLAINTEXT");
    // Note: the `secretUpdated` boolean itself is redacted by the logger (key matches /secret/).
    expect(logs[0].metadata).toMatchObject({ provider: "GOOGLE_SEARCH_CONSOLE", configKeys: ["siteUrl"] });

    // Saving again updates the same integration and rotates the credential.
    const again = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId, config: { siteUrl: "https://example.com/" }, secret: { serviceAccountJson: "{}" } }));
    expect(again.id).toBe(integ.id);
    const cred2 = (await q((tx) => tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integ.id) })))!;
    expect(cred2.rotatedAt).toBeInstanceOf(Date);
    expect(await q((tx) => loadSecret(tx, integ.id))).toEqual({ serviceAccountJson: "{}" });
    // Saving without a secret keeps the stored one.
    await q((tx) => saveIntegration(tx, ctx.actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId, config: { siteUrl: "https://example.com/" }, secret: null }));
    expect(await q((tx) => loadSecret(tx, integ.id))).toEqual({ serviceAccountJson: "{}" });
  });

  it("a ciphertext moved to another integration does not decrypt (AAD bound to integration id)", async () => {
    const a = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "BING_WEBMASTER", productId, config: { siteUrl: "https://example.com/" }, secret: { apiKey: "bing-secret" } }));
    const b = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "GOOGLE_ANALYTICS", productId, config: { propertyId: "1" }, secret: null }));
    const credA = (await q((tx) => tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, a.id) })))!;
    await q((tx) => tx.insert(providerCredentials).values({ organizationId: orgId, integrationId: b.id, ciphertext: credA.ciphertext }));
    await expect(q((tx) => loadSecret(tx, b.id))).rejects.toThrow();
    await q((tx) => tx.update(providerCredentials).set({ ciphertext: encryptSecret(JSON.stringify({ apiKey: "x" }), b.id) }).where(eq(providerCredentials.integrationId, b.id)));
    expect(await q((tx) => loadSecret(tx, b.id))).toEqual({ apiKey: "x" });
    expect(await q((tx) => loadSecret(tx, "00000000-0000-4000-8000-000000000000"))).toEqual({});
  });

  it("credentials are invisible to another organisation", async () => {
    const other = await newOrg("integ-other");
    expect(await withOrg(other.org.id, (tx) => tx.select().from(providerCredentials))).toHaveLength(0);
    expect(await withOrg(other.org.id, (tx) => tx.select().from(integrations))).toHaveLength(0);
  });

  it("syncIntegration skips non-visibility providers without any network call", async () => {
    const s = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "STRIPE", productId: null, config: {}, secret: { webhookSecret: "whsec" } }));
    expect(await syncIntegration(q, s.id)).toEqual({ skipped: true });
  });
});

describe("visibility adapters (injected fetch)", () => {
  const range = { start: "2026-09-01", end: "2026-09-03" };

  it("Search Console: exchanges a JWT for a token and maps daily/query/page rows", async () => {
    const { f, calls } = fakeFetch((url, init) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "tok-gsc" };
      const body = JSON.parse(String(init!.body));
      if (body.dimensions?.[0] === "date") return { rows: [{ keys: ["2026-09-01"], clicks: 5, impressions: 100, ctr: 0.05, position: 7.5 }, { keys: ["2026-09-02"], clicks: 7, impressions: 120, ctr: 0.06, position: 6.1 }] };
      if (body.dimensions?.[0] === "query") return { rows: [{ keys: ["tiktok moderation"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }] };
      if (body.dimensions?.[0] === "page") return { rows: [{ keys: ["https://example.com/"], clicks: 1, impressions: 10 }, { keys: ["https://example.com/x"], clicks: 0, impressions: 0 }] };
      return { rows: [] };
    });
    const rows = await createSearchConsoleAdapter(f).fetchMetrics({ siteUrl: "sc-domain:example.com" }, { serviceAccountJson }, range);
    const tokenCall = calls[0];
    expect(tokenCall.url).toBe("https://oauth2.googleapis.com/token");
    const assertion = new URLSearchParams(String(tokenCall.init!.body)).get("assertion")!;
    expect(assertion.split(".")).toHaveLength(3);
    const apiCalls = calls.slice(1);
    expect(apiCalls).toHaveLength(3);
    for (const c of apiCalls) {
      expect(c.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
      expect((c.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-gsc");
    }
    expect(rows).toEqual(
      expect.arrayContaining([
        { metric: "search_impressions", day: "2026-09-01", value: 100 },
        { metric: "search_clicks", day: "2026-09-02", value: 7 },
        { metric: "search_position", day: "2026-09-01", value: 7.5, weight: 100 },
        { metric: "query_impressions", day: "2026-09-03", dimension: "tiktok moderation", value: 40 },
        { metric: "indexed_pages_with_impressions", day: "2026-09-03", value: 1 },
      ]),
    );
  });

  it("Search Console surfaces HTTP errors", async () => {
    const { f } = fakeFetch((url) => (url.includes("oauth2") ? { access_token: "t" } : new Response("forbidden", { status: 403 })));
    await expect(createSearchConsoleAdapter(f).fetchMetrics({ siteUrl: "x" }, { serviceAccountJson }, range)).rejects.toThrow(/search-console HTTP 403/);
    const res = await createSearchConsoleAdapter(f).testConnection({ siteUrl: "x" }, { serviceAccountJson: "not json" });
    expect(res).toEqual({ ok: false, message: "Service account JSON is invalid" });
  });

  it("GA4: aggregates sessions per day and channel, including AI referrals", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.includes("oauth2")) return { access_token: "tok-ga" };
      return {
        rows: [
          { dimensionValues: [{ value: "20260901" }, { value: "google" }, { value: "organic" }], metricValues: [{ value: "10" }] },
          { dimensionValues: [{ value: "20260901" }, { value: "chatgpt.com" }, { value: "referral" }], metricValues: [{ value: "3" }] },
          { dimensionValues: [{ value: "20260901" }, { value: "perplexity.ai" }, { value: "referral" }], metricValues: [{ value: "2" }] },
          { dimensionValues: [{ value: "20260902" }, { value: "(direct)" }, { value: "(none)" }], metricValues: [{ value: "4" }] },
        ],
      };
    });
    const rows = await createGa4Adapter(f).fetchMetrics({ propertyId: "123" }, { serviceAccountJson }, range);
    expect(calls[1].url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
    expect(rows).toEqual(
      expect.arrayContaining([
        { metric: "sessions", day: "2026-09-01", dimension: "ORGANIC_SEARCH", value: 10 },
        { metric: "sessions", day: "2026-09-01", dimension: "AI_REFERRAL", value: 5 },
        { metric: "ai_referral_sessions", day: "2026-09-01", value: 5 },
        { metric: "sessions", day: "2026-09-02", dimension: "DIRECT", value: 4 },
      ]),
    );
  });

  it("Bing: parses WCF dates and filters to the requested range", async () => {
    const day = (iso: string) => `/Date(${Date.parse(`${iso}T12:00:00Z`)}-0800)/`;
    const { f, calls } = fakeFetch(() => ({ d: [{ Date: day("2026-08-31"), Impressions: 1, Clicks: 1 }, { Date: day("2026-09-02"), Impressions: 50, Clicks: 4 }] }));
    const rows = await createBingAdapter(f).fetchMetrics({ siteUrl: "https://example.com/" }, { apiKey: "bing-key" }, range);
    expect(new URL(calls[0].url).searchParams.get("apikey")).toBe("bing-key");
    expect(rows).toEqual([
      { metric: "search_impressions", day: "2026-09-02", value: 50 },
      { metric: "search_clicks", day: "2026-09-02", value: 4 },
    ]);
  });
});

describe("metrics storage", () => {
  it("upsertMetrics replaces values on conflict and metricSeries sums per day", async () => {
    await q((tx) =>
      upsertMetrics(tx, orgId, productId, "GOOGLE_SEARCH_CONSOLE", [
        { metric: "search_clicks", day: "2026-09-01", value: 5 },
        { metric: "search_clicks", day: "2026-09-02", value: 7 },
        { metric: "query_clicks", day: "2026-09-02", dimension: "a", value: 1 },
        { metric: "query_clicks", day: "2026-09-02", dimension: "b", value: 2 },
      ]),
    );
    await q((tx) => upsertMetrics(tx, orgId, productId, "BING_WEBMASTER", [{ metric: "search_clicks", day: "2026-09-01", value: 3 }]));
    // Re-import with corrected numbers replaces instead of duplicating.
    await q((tx) => upsertMetrics(tx, orgId, productId, "GOOGLE_SEARCH_CONSOLE", [{ metric: "search_clicks", day: "2026-09-01", value: 6, weight: 2 }]));
    const rows = await q((tx) => tx.select().from(visibilityMetrics).where(and(eq(visibilityMetrics.productId, productId), eq(visibilityMetrics.metric, "search_clicks"))));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.provider === "GOOGLE_SEARCH_CONSOLE" && r.day === "2026-09-01")).toMatchObject({ value: 6, weight: 2 });

    expect(await q((tx) => metricSeries(tx, orgId, "search_clicks", "2026-08-01"))).toEqual([
      { day: "2026-09-01", value: 9 },
      { day: "2026-09-02", value: 7 },
    ]);
    expect(await q((tx) => metricSeries(tx, orgId, "search_clicks", "2026-08-01", { provider: "GOOGLE_SEARCH_CONSOLE" }))).toEqual([
      { day: "2026-09-01", value: 6 },
      { day: "2026-09-02", value: 7 },
    ]);
    expect(await q((tx) => metricSeries(tx, orgId, "query_clicks", "2026-08-01", { dimension: "b" }))).toEqual([{ day: "2026-09-02", value: 2 }]);
    expect(await q((tx) => metricSeries(tx, orgId, "search_clicks", "2026-09-02"))).toEqual([{ day: "2026-09-02", value: 7 }]);
    // Another org's series is empty even when it passes this org's id.
    const other = await newOrg("integ-metrics");
    expect(await withOrg(other.org.id, (tx) => metricSeries(tx, orgId, "search_clicks", "2026-08-01"))).toEqual([]);
  });
});
