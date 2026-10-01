import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withOrg, type Tx } from "@/db";
import { integrations, jobs, products, searchDaily } from "@/db/schema";
import { backfillSearch, saveIntegration, syncIntegration } from "@/services/visibility";
import { checkIntegration, connectGoogleOAuth } from "@/services/integration-health";
import { latestQueryMetrics, searchDataState, searchInsights, searchTotals } from "@/services/search-insights";
import { upsertSearchRows } from "@/services/search-data";
import { googleOAuthCallback } from "@/services/google-oauth-flow";
import { kpis } from "@/services/metrics";
import { scheduleRecurring } from "@/jobs/handlers";
import { NonRetryableError } from "@/jobs/queue";
import { createSearchConsoleAdapter, GSC_PAGE_SIZE } from "@/integrations/gsc";
import { createBingAdapter } from "@/integrations/bing";
import { signOAuthState, verifyOAuthState } from "@/integrations/google-oauth";
import { searchRow } from "@/integrations/types";
import { backfillRanges, dailySyncRange } from "@/core/integrations/health";
import type { AuthContext } from "@/lib/auth/service";
import { resetEnvCache } from "@/lib/env";
import { newOrg, pgError, uid } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
let productId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({ client_email: "beacon@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

const days = (start: string, end: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

type Call = { url: string; body: Record<string, unknown> | null };
/** Fake Google APIs: deterministic rows per day for every report; optional status override. */
function fakeGoogle(opts: { status?: number; calls?: Call[] } = {}) {
  const calls = opts.calls ?? [];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", refresh_token: "refresh-1", scope: "https://www.googleapis.com/auth/webmasters.readonly", expires_in: 3600 });
    if (opts.status) return new Response("denied", { status: opts.status });
    if (url === "https://www.googleapis.com/webmasters/v3/sites") return json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://other.example/", permissionLevel: "siteUnverifiedUser" }] });
    if (!url.includes("searchAnalytics")) return json({ siteUrl: "sc-domain:example.com", permissionLevel: "siteFullUser" });
    const dims = (body!.dimensions as string[] | undefined) ?? [];
    if (Number(body!.startRow ?? 0) > 0 || !dims.length) return json({ rows: dims.length ? [] : [{ keys: [], clicks: 1, impressions: 1, ctr: 1, position: 1 }] });
    const rows = [];
    for (const d of days(String(body!.startDate), String(body!.endDate))) {
      const key = dims.join(",");
      if (key === "date") rows.push({ keys: [d], clicks: 10, impressions: 100, ctr: 0.1, position: 5 });
      if (key === "date,query")
        rows.push({ keys: [d, "search product pricing"], clicks: 4, impressions: 40, ctr: 0.1, position: 3 }, { keys: [d, "other query"], clicks: 1, impressions: 30, ctr: 1 / 30, position: 12 });
      if (key === "date,page") rows.push({ keys: [d, "https://example.com/"], clicks: 6, impressions: 70, ctr: 6 / 70, position: 4 });
      if (key === "date,query,page") rows.push({ keys: [d, "search product pricing", "https://example.com/"], clicks: 4, impressions: 40, ctr: 0.1, position: 3 });
      if (key === "date,country") rows.push({ keys: [d, "fra"], clicks: 7, impressions: 60, ctr: 7 / 60, position: 5 }, { keys: [d, "usa"], clicks: 3, impressions: 40, ctr: 0.075, position: 5 });
      if (key === "date,device") rows.push({ keys: [d, "MOBILE"], clicks: 8, impressions: 90, ctr: 8 / 90, position: 5 }, { keys: [d, "DESKTOP"], clicks: 2, impressions: 10, ctr: 0.2, position: 5 });
    }
    return json({ rows });
  }) as typeof fetch;
}

async function gscIntegration(status: (typeof integrations.$inferInsert)["status"] = "CONNECTED", pid = productId) {
  const integ = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId: pid, config: { siteUrl: "sc-domain:example.com" }, secret: { serviceAccountJson } }));
  await q((tx) => tx.update(integrations).set({ status, lastSuccessAt: status === "CONNECTED" ? new Date() : null, config: { siteUrl: "sc-domain:example.com", _backfillDone: "2026-01-01" } }).where(eq(integrations.id, integ.id)));
  return integ.id;
}

beforeAll(async () => {
  ctx = await newOrg("search");
  orgId = ctx.org.id;
  productId = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `sp-${uid()}`, name: "Search Product", domain: "example.com" }).returning()))[0].id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
});
afterAll(closeDb);

describe("Search Console adapter normalisation (mocked fetch)", () => {
  it("pulls date x query x page, query, page, country and device reports with final data state and maps them to grains", async () => {
    const calls: Call[] = [];
    const rows = await createSearchConsoleAdapter(fakeGoogle({ calls }), { delayMs: 0 }).fetchSearchRows!({ siteUrl: "sc-domain:example.com" }, { serviceAccountJson }, { start: "2026-09-01", end: "2026-09-02" }, { delayMs: 0 });
    const api = calls.filter((c) => c.url.includes("searchAnalytics"));
    expect(api.map((c) => (c.body!.dimensions as string[]).join(","))).toEqual(["date", "date,query", "date,page", "date,query,page", "date,country", "date,device"]);
    for (const c of api) expect(c.body).toMatchObject({ dataState: "final", type: "web", rowLimit: GSC_PAGE_SIZE, startRow: 0 });
    expect(rows.filter((r) => r.day === "2026-09-01")).toEqual(
      expect.arrayContaining([
        { day: "2026-09-01", query: null, page: null, country: null, device: null, clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
        { day: "2026-09-01", query: "search product pricing", page: null, country: null, device: null, clicks: 4, impressions: 40, ctr: 0.1, position: 3 },
        { day: "2026-09-01", query: "search product pricing", page: "https://example.com/", country: null, device: null, clicks: 4, impressions: 40, ctr: 0.1, position: 3 },
        expect.objectContaining({ country: "fra", query: null, page: null, device: null }),
        expect.objectContaining({ device: "MOBILE", query: null, page: null, country: null }),
      ]),
    );
    expect(rows).toHaveLength(2 * 9);
  });

  it("paginates with startRow until a short page, and filters pages by prefix", async () => {
    const calls: Call[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "t" }));
      const body = JSON.parse(String(init!.body));
      calls.push({ url, body });
      const start = Number(body.startRow);
      const n = start === 0 ? GSC_PAGE_SIZE : 3;
      return new Response(JSON.stringify({ rows: Array.from({ length: n }, (_, i) => ({ keys: ["2026-09-01", `q${start + i}`], clicks: 0, impressions: 1, ctr: 0, position: 9 })) }));
    }) as typeof fetch;
    const adapter = createSearchConsoleAdapter(f, { delayMs: 0 });
    const rows = await adapter.fetchSearchRows!({ siteUrl: "sc-domain:example.com" }, { serviceAccountJson }, { start: "2026-09-01", end: "2026-09-01" }, { pagePrefix: "https://example.com/a.b/", delayMs: 0 });
    const queryCalls = calls.filter((c) => c.body?.dimensions && (c.body.dimensions as string[]).join(",") === "date,query");
    expect(queryCalls.map((c) => c.body!.startRow)).toEqual([0, GSC_PAGE_SIZE]);
    expect(queryCalls[0].body!.dimensionFilterGroups).toEqual([{ filters: [{ dimension: "page", operator: "includingRegex", expression: "^https://example\\.com/a\\.b/" }] }]);
    expect(rows.filter((r) => r.query && !r.page)).toHaveLength(GSC_PAGE_SIZE + 3);
  });

  it("a revoked refresh token (invalid_grant) is reported as expired", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    const adapter = createSearchConsoleAdapter(f, { oauthClient: () => ({ clientId: "id", clientSecret: "s", redirectUri: "http://x/cb" }) });
    const res = await adapter.testConnection({ siteUrl: "sc-domain:example.com" }, { refreshToken: "r" });
    expect(res).toMatchObject({ ok: false, httpStatus: 401 });
  });
});

describe("Bing adapter normalisation", () => {
  it("maps rank and traffic, query and page stats into search rows; errors never include the API key", async () => {
    const day = (iso: string) => `/Date(${Date.parse(`${iso}T12:00:00Z`)}-0800)/`;
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("GetRankAndTrafficStats")) return new Response(JSON.stringify({ d: [{ Date: day("2026-09-02"), Impressions: 50, Clicks: 4 }] }));
      if (url.includes("GetQueryStats"))
        return new Response(JSON.stringify({ d: [{ Query: "bing q", Date: day("2026-09-02"), Impressions: 20, Clicks: 2, AvgImpressionPosition: 3, AvgClickPosition: 2 }, { Query: "old", Date: day("2026-01-01"), Impressions: 1, Clicks: 0, AvgImpressionPosition: -1 }] }));
      return new Response(JSON.stringify({ d: [{ Query: "https://example.com/p", Date: day("2026-09-02"), Impressions: 30, Clicks: 3, AvgImpressionPosition: -1 }] }));
    }) as typeof fetch;
    const rows = await createBingAdapter(f).fetchSearchRows!({ siteUrl: "https://example.com/" }, { apiKey: "BINGKEY" }, { start: "2026-09-01", end: "2026-09-03" });
    expect(rows).toEqual([
      { day: "2026-09-02", query: null, page: null, country: null, device: null, clicks: 4, impressions: 50, ctr: 0.08, position: null },
      { day: "2026-09-02", query: "bing q", page: null, country: null, device: null, clicks: 2, impressions: 20, ctr: 0.1, position: 3 },
      { day: "2026-09-02", query: null, page: "https://example.com/p", country: null, device: null, clicks: 3, impressions: 30, ctr: 0.1, position: null },
    ]);
    const failing = (async () => new Response("Invalid API key BINGKEY", { status: 401 })) as typeof fetch;
    const err = await createBingAdapter(failing).fetchSearchRows!({ siteUrl: "https://example.com/" }, { apiKey: "BINGKEY" }, { start: "2026-09-01", end: "2026-09-03" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/bing-webmaster HTTP 401/);
    expect((err as Error).message).not.toContain("BINGKEY");
    const network = (async () => {
      throw new TypeError("fetch failed https://ssl.bing.com/x?apikey=BINGKEY");
    }) as typeof fetch;
    const err2 = await createBingAdapter(network).testConnection({ siteUrl: "https://example.com/" }, { apiKey: "BINGKEY" });
    expect(err2.message).not.toContain("BINGKEY");
  });
});

describe("search_daily storage", () => {
  it("two overlapping syncs of the same days give the same totals (upsert, no double counting)", async () => {
    const id = await gscIntegration();
    vi.stubGlobal("fetch", fakeGoogle());
    const now1 = new Date("2026-09-20T10:00:00Z");
    const now2 = new Date("2026-09-22T10:00:00Z");
    const r1 = await syncIntegration(q, id, undefined, { delayMs: 0, now: now1 });
    expect(r1).toMatchObject({ range: dailySyncRange(now1) });
    await syncIntegration(q, id, undefined, { delayMs: 0, now: now2 });
    await syncIntegration(q, id, undefined, { delayMs: 0, now: now2 }); // exact replay
    const span = days(dailySyncRange(now1).start, dailySyncRange(now2).end);
    expect(span).toHaveLength(7);
    const totals = await q((tx) => searchTotals(tx, { organizationId: orgId, productId, provider: "GOOGLE_SEARCH_CONSOLE" }, { start: span[0], end: span.at(-1)! }));
    expect(totals.now).toMatchObject({ clicks: 70, impressions: 700, position: 5 });
    expect(totals.now.ctr).toBeCloseTo(0.1);
    const rowCount = await q((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(searchDaily).where(eq(searchDaily.integrationId, id)));
    expect(rowCount[0].n).toBe(7 * 9);
    // visibility_metrics daily totals (KPI source) are not inflated either.
    const k = await q((tx) => kpis(tx, orgId, { days: 7, productId, end: new Date(`${span.at(-1)}T23:00:00Z`) }));
    expect(k.discovery.organicImpressions.now).toBe(700);
    // Branded impressions: daily query rows containing the product name, counted once per day.
    expect(k.discovery.brandedImpressions.now).toBe(7 * 40);
    const integ = await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, id) }));
    expect(integ).toMatchObject({ status: "CONNECTED", consecutiveFailures: 0, lastError: null });
    expect(integ!.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("insights and latestQueryMetrics read only their grain, with impressions-weighted positions", async () => {
    const other = await newOrg("search-ins");
    const pid = (await withOrg(other.org.id, (tx) => tx.insert(products).values({ organizationId: other.org.id, slug: "p", name: "Alpha" }).returning()))[0].id;
    const integ = await withOrg(other.org.id, (tx) => saveIntegration(tx, other.actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId: pid, config: { siteUrl: "sc-domain:a.example" }, secret: { serviceAccountJson } }));
    await withOrg(other.org.id, (tx) => tx.update(integrations).set({ status: "CONNECTED" }).where(eq(integrations.id, integ.id)));
    const target = { organizationId: other.org.id, productId: pid, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE" as const };
    const rows = [
      // previous period (2026-09-01..07): "falling" strong, "gone" present
      ...days("2026-09-01", "2026-09-07").flatMap((d) => [
        searchRow({ day: d, query: "falling", clicks: 5, impressions: 50, position: 4 }),
        searchRow({ day: d, query: "gone", clicks: 1, impressions: 10, position: 9 }),
        searchRow({ day: d, query: "rising", clicks: 1, impressions: 20, position: 8 }),
        searchRow({ day: d, page: "https://a.example/old", clicks: 2, impressions: 20, position: 6 }),
      ]),
      // current period (2026-09-08..14)
      ...days("2026-09-08", "2026-09-14").flatMap((d) => [
        searchRow({ day: d, query: "falling", clicks: 2, impressions: 40, position: 6 }),
        searchRow({ day: d, query: "rising", clicks: 4, impressions: 30, position: 2 }),
        searchRow({ day: d, query: "rising", page: "https://a.example/", clicks: 4, impressions: 30, position: 2 }),
        searchRow({ day: d, query: "fresh", clicks: 0, impressions: 10, position: 11 }),
        searchRow({ day: d, query: "fresh", page: "https://a.example/new", clicks: 0, impressions: 10, position: 11 }),
        searchRow({ day: d, page: "https://a.example/new", clicks: 1, impressions: 15, position: 7 }),
        searchRow({ day: d, country: "fra", clicks: 99, impressions: 999, position: 1 }),
      ]),
    ];
    await withOrg(other.org.id, (tx) => upsertSearchRows(tx, target, rows));
    const scope = { organizationId: other.org.id, productId: pid, provider: "GOOGLE_SEARCH_CONSOLE" as const };
    const ins = await withOrg(other.org.id, (tx) => searchInsights(tx, scope, { start: "2026-09-08", end: "2026-09-14" }, { minImpressions: 20 }));
    expect(ins.growingQueries.map((m) => m.key)).toEqual(["rising"]);
    expect(ins.growingQueries[0]).toMatchObject({ clicksDelta: 21, impressionsDelta: 70 });
    expect(ins.decliningQueries.map((m) => m.key)).toEqual(["falling"]);
    expect(ins.newQueries.map((m) => m.key)).toEqual(["fresh"]);
    expect(ins.lostQueries.map((m) => m.key)).toEqual(["gone"]);
    expect(ins.newPages.map((m) => m.key)).toEqual(["https://a.example/new"]);
    expect(ins.strikingDistance.map((s) => s.key)).toEqual(["falling", "fresh"]);
    expect(ins.lowCtrMethod).toMatch(/median CTR/);
    const latest = await withOrg(other.org.id, (tx) => latestQueryMetrics(tx, other.org.id, pid, 14));
    const falling = latest.find((r) => r.query === "falling")!;
    // 7 days at position 4 (50 impressions) + 7 days at position 6 (40 impressions): weighted, not last-row-wins.
    expect(falling).toMatchObject({ clicks: 49, impressions: 630 });
    expect(falling.position).toBeCloseTo((4 * 350 + 6 * 280) / 630);
    expect(latest.find((r) => r.query === "rising")).toMatchObject({ clicks: 35, impressions: 350 });
    // Last 7 days of data only.
    expect((await withOrg(other.org.id, (tx) => latestQueryMetrics(tx, other.org.id, pid, 7))).find((r) => r.query === "gone")).toBeUndefined();
    const st = await withOrg(other.org.id, (tx) => searchDataState(tx, scope));
    expect(st).toMatchObject({ connected: true, hasData: false });
  });

  it("is isolated per tenant (RLS)", async () => {
    const other = await newOrg("search-iso");
    expect(await withOrg(other.org.id, (tx) => tx.select().from(searchDaily))).toHaveLength(0);
    const integ = await q((tx) => tx.query.integrations.findFirst({ where: and(eq(integrations.organizationId, orgId), eq(integrations.provider, "GOOGLE_SEARCH_CONSOLE")) }));
    const res = await pgError(withOrg(other.org.id, (tx) => tx.insert(searchDaily).values({ organizationId: orgId, productId, integrationId: integ!.id, provider: "GOOGLE_SEARCH_CONSOLE", day: "2026-01-01", clicks: 1, impressions: 1 })));
    expect(res.message).toMatch(/row-level security|violates/);
    expect(await withOrg(other.org.id, (tx) => latestQueryMetrics(tx, orgId, productId, 28))).toEqual([]);
  });
});

describe("backfill", () => {
  it("imports 16 months in calendar-month chunks, newest first, and resumes a retried run", async () => {
    const p2 = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `bf-${uid()}`, name: "Backfill Product" }).returning()))[0].id;
    const id = await gscIntegration("CONNECTED", p2);
    const calls: Call[] = [];
    vi.stubGlobal("fetch", fakeGoogle({ calls }));
    const now = new Date("2026-09-30T08:00:00Z");
    const expected = backfillRanges(dailySyncRange(now).end, 16, { chunked: true });
    const res = await backfillSearch(q, id, { now, delayMs: 0, runId: "run-1" });
    expect(res).toMatchObject({ chunks: expected.length });
    const dateCalls = calls.filter((c) => c.url.includes("searchAnalytics") && (c.body!.dimensions as string[]).join(",") === "date");
    expect(dateCalls.map((c) => [c.body!.startDate, c.body!.endDate])).toEqual(expected.map((r) => [r.start, r.end]));
    const integ = await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, id) }));
    expect(integ!.config._backfillOldest).toBe(expected.at(-1)!.start);
    expect(integ!.config._backfillDone).toBeTruthy();
    // Retrying the same run resumes after the last finished chunk: nothing left to fetch.
    calls.length = 0;
    expect(await backfillSearch(q, id, { now, delayMs: 0, runId: "run-1" })).toMatchObject({ chunks: 0 });
    expect(calls.filter((c) => c.url.includes("searchAnalytics"))).toHaveLength(0);
    const total = await q((tx) => searchTotals(tx, { organizationId: orgId, productId: p2 }, { start: expected.at(-1)!.start, end: expected[0].end }));
    expect(total.now.impressions).toBe(days(expected.at(-1)!.start, expected[0].end).length * 100);
  });
});

describe("integration health", () => {
  it("401/403 mark the integration EXPIRED and the sync is not retried; 5xx is a retryable ERROR; DISABLED is skipped", async () => {
    const p3 = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `h-${uid()}`, name: "Health Product" }).returning()))[0].id;
    const id = await gscIntegration("CONNECTED", p3);
    vi.stubGlobal("fetch", fakeGoogle({ status: 403 }));
    const e1 = await syncIntegration(q, id, undefined, { delayMs: 0 }).catch((e) => e);
    expect(e1).toBeInstanceOf(NonRetryableError);
    let row = (await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, id) })))!;
    expect(row).toMatchObject({ status: "EXPIRED", consecutiveFailures: 1 });
    expect(row.lastFailureAt).toBeInstanceOf(Date);
    vi.stubGlobal("fetch", fakeGoogle({ status: 503 }));
    const e2 = await syncIntegration(q, id, undefined, { delayMs: 0 }).catch((e) => e);
    expect(e2).not.toBeInstanceOf(NonRetryableError);
    row = (await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, id) })))!;
    expect(row).toMatchObject({ status: "ERROR", consecutiveFailures: 2 });
    await q((tx) => tx.update(integrations).set({ status: "DISABLED" }).where(eq(integrations.id, id)));
    expect(await syncIntegration(q, id)).toEqual({ skipped: true, reason: "disabled" });
  });

  it("a connection test runs outside the transaction and only then sets CONNECTED, scopes and the backfill job", async () => {
    const p4 = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `t-${uid()}`, name: "Test Product" }).returning()))[0].id;
    const integ = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId: p4, config: { siteUrl: "sc-domain:example.com" }, secret: { serviceAccountJson } }));
    expect((await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integ.id) })))!.status).toBe("NOT_CONNECTED");
    vi.stubGlobal("fetch", fakeGoogle({ status: 401 }));
    expect(await checkIntegration(q, ctx.actor, integ.id)).toMatchObject({ ok: false, status: "EXPIRED" });
    vi.stubGlobal("fetch", fakeGoogle());
    const ok = await checkIntegration(q, ctx.actor, integ.id);
    expect(ok).toMatchObject({ ok: true, status: "CONNECTED" });
    const row = (await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integ.id) })))!;
    expect(row.scopes).toEqual(["https://www.googleapis.com/auth/webmasters.readonly", "property:siteFullUser"]);
    expect(row.lastSuccessAt).toBeInstanceOf(Date);
    const backfill = await withOrg(orgId, (tx) => tx.select().from(jobs).where(and(eq(jobs.organizationId, orgId), eq(jobs.type, "search.backfill"))));
    expect(backfill.some((j) => j.payload.integrationId === integ.id)).toBe(true);
  });

  it("the scheduler enqueues CONNECTED and ERROR (after back-off) integrations, never EXPIRED or DISABLED", async () => {
    const org = await newOrg("sched");
    const mk = async (status: (typeof integrations.$inferInsert)["status"], extra: Partial<typeof integrations.$inferInsert> = {}) => {
      const p = (await withOrg(org.org.id, (tx) => tx.insert(products).values({ organizationId: org.org.id, slug: `s-${uid()}`, name: `S ${uid()}` }).returning()))[0];
      const [i] = await withOrg(org.org.id, (tx) => tx.insert(integrations).values({ organizationId: org.org.id, productId: p.id, provider: "BING_WEBMASTER", status, config: { siteUrl: "https://x.example/" }, ...extra }).returning());
      return i.id;
    };
    const connected = await mk("CONNECTED");
    const errorDue = await mk("ERROR", { consecutiveFailures: 1, lastFailureAt: new Date(Date.now() - 2 * 3_600_000) });
    const errorWaiting = await mk("ERROR", { consecutiveFailures: 4, lastFailureAt: new Date(Date.now() - 3_600_000) });
    const expired = await mk("EXPIRED");
    const disabled = await mk("DISABLED");
    await scheduleRecurring(new Date());
    const queued = await systemDb().select().from(jobs).where(and(eq(jobs.organizationId, org.org.id), eq(jobs.type, "integration.sync")));
    const ids = new Set(queued.map((j) => j.payload.integrationId));
    expect(ids.has(connected)).toBe(true);
    expect(ids.has(errorDue)).toBe(true);
    expect(ids.has(errorWaiting)).toBe(false);
    expect(ids.has(expired)).toBe(false);
    expect(ids.has(disabled)).toBe(false);
  });
});

describe("Google OAuth", () => {
  const client = { clientId: "cid", clientSecret: "csecret", redirectUri: "http://localhost:3000/api/integrations/google/callback" };
  const authCtx = (): AuthContext => ({ user: { id: ctx.user.id, email: ctx.email, name: "Owner" }, org: { id: orgId, slug: ctx.org.slug, name: ctx.org.name, settings: ctx.org.settings, branding: ctx.org.branding }, role: "OWNER", sessionTokenHash: "x" });

  it("state is signed, expires and is bound to the organisation and the user", () => {
    const s = signOAuthState({ organizationId: orgId, userId: ctx.user.id, productId });
    expect(verifyOAuthState(s, { organizationId: orgId, userId: ctx.user.id })).toMatchObject({ o: orgId, u: ctx.user.id, p: productId });
    expect(verifyOAuthState(s, { organizationId: orgId, userId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    expect(verifyOAuthState(s, { organizationId: "00000000-0000-4000-8000-000000000000", userId: ctx.user.id })).toBeNull();
    const [body, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), p: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`, { organizationId: orgId, userId: ctx.user.id })).toBeNull();
    expect(verifyOAuthState(s, { organizationId: orgId, userId: ctx.user.id }, Date.now() + 11 * 60_000)).toBeNull();
    expect(verifyOAuthState(null, { organizationId: orgId, userId: ctx.user.id })).toBeNull();
  });

  it("callback exchanges the code, stores the refresh token encrypted, records scopes and selects the only verified property", async () => {
    const p5 = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `o-${uid()}`, name: "OAuth Product" }).returning()))[0].id;
    // The adapter refreshes access tokens with the configured client.
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", client.clientId);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", client.clientSecret);
    resetEnvCache();
    const calls: Call[] = [];
    const f = fakeGoogle({ calls });
    vi.stubGlobal("fetch", f);
    const bad = await googleOAuthCallback(authCtx(), { code: "c", state: "tampered.sig", error: null }, { client, fetchImpl: f });
    expect(bad).toContain("error=");
    const state = signOAuthState({ organizationId: orgId, userId: ctx.user.id, productId: p5 });
    const target = await googleOAuthCallback(authCtx(), { code: "auth-code", state, error: null }, { client, fetchImpl: f });
    expect(target).toContain("ok=");
    const tokenBody = String(calls.find((c) => c.url.startsWith("https://oauth2.googleapis.com/token"))?.url);
    expect(tokenBody).toBe("https://oauth2.googleapis.com/token");
    const integ = (await q((tx) => tx.query.integrations.findFirst({ where: and(eq(integrations.productId, p5), eq(integrations.provider, "GOOGLE_SEARCH_CONSOLE")) })))!;
    expect(integ.config).toMatchObject({ siteUrl: "sc-domain:example.com", _authMode: "oauth" });
    expect(JSON.parse(integ.config._sites)).toEqual([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }]);
    const { loadSecret } = await import("@/services/visibility");
    expect(await q((tx) => loadSecret(tx, integ.id))).toEqual({ refreshToken: "refresh-1" });
    const cred = await q((tx) => tx.execute<{ ciphertext: string }>(sql`select ciphertext from provider_credentials where integration_id = ${integ.id}`));
    expect(cred.rows[0].ciphertext).not.toContain("refresh-1");
  });

  it("several properties: the user picks one; without a refresh token nothing is stored", async () => {
    const p6 = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `m-${uid()}`, name: "Multi Product" }).returning()))[0].id;
    const sites = [
      { siteUrl: "sc-domain:a.example", permissionLevel: "siteOwner" },
      { siteUrl: "sc-domain:b.example", permissionLevel: "siteFullUser" },
    ];
    const res = await connectGoogleOAuth(q, ctx.actor, { productId: p6, refreshToken: "r2", scopes: ["https://www.googleapis.com/auth/webmasters.readonly"], sites });
    expect(res).toMatchObject({ needsSite: true, test: null });
    const integ = (await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, res.integrationId) })))!;
    expect(integ.status).toBe("NOT_CONNECTED");
    expect(integ.scopes).toEqual(["https://www.googleapis.com/auth/webmasters.readonly"]);
    const p7 = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `n-${uid()}`, name: "No Token" }).returning()))[0].id;
    await expect(connectGoogleOAuth(q, ctx.actor, { productId: p7, refreshToken: null, scopes: [], sites })).rejects.toThrow(/refresh token/);
  });
});
