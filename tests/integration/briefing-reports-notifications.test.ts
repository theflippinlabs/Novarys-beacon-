import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { briefings, contentAssets, integrations, notificationWebhooks, notifications, opportunities, reports, searchDaily, seoAudits, seoIssues } from "@/db/schema";
import { REPORT_METRIC_LABELS, type ReportPayload } from "@/core/reports/report";
import { verifyWebhook, type DigestParams } from "@/core/notifications/notifications";
import { addDays, isoDay } from "@/core/util/text";
import { createSession } from "@/lib/auth/service";
import { encryptSecret } from "@/lib/security/crypto";
import { generateBriefing, latestBriefing } from "@/services/briefings";
import { generateWeeklyReport, getReport } from "@/services/reports";
import { addWebhook, applySignals, evaluateNotifications, evaluateSignals, inbox, markAllRead, saveMemberPreferences, saveOrgNotificationSettings, thresholdsFrom, loadPreferences, unreadCount, webhookAad } from "@/services/notifications";
import { deliverEmail, deliverWebhook, PermanentDeliveryError, type Fetcher } from "@/services/notification-delivery";
import { GET as exportReport } from "@/app/api/reports/[id]/export/route";
import { newOrg, params, seedCompleteProduct } from "./helpers";

let A: Awaited<ReturnType<typeof newOrg>>;
let B: Awaited<ReturnType<typeof newOrg>>;
let productA: string;
let productB: string;
let integB: string;
const day = (n: number) => isoDay(addDays(new Date(), -n));
const qa = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(A.org.id, fn);
const qb = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(B.org.id, fn);
const opp = (orgId: string, productId: string, over: Partial<typeof opportunities.$inferInsert> = {}) => ({
  organizationId: orgId,
  productId,
  type: "CONTENT_GAP",
  category: "CONTENT",
  title: `Opportunity ${randomUUID().slice(0, 6)}`,
  problem: "Measured problem",
  potential: "HIGH" as const,
  impact: 4,
  confidence: 4,
  effort: 2,
  urgency: 3,
  priorityScore: 24,
  fingerprint: randomUUID(),
  ...over,
});

beforeAll(async () => {
  A = await newOrg("w2a-a");
  B = await newOrg("w2a-b");
  productA = (await seedCompleteProduct(A.org.id, { name: "Brief Alpha" })).product.id;
  productB = (await seedCompleteProduct(B.org.id, { name: "Brief Beta" })).product.id;
  const [i] = await qb((tx) => tx.insert(integrations).values({ organizationId: B.org.id, productId: productB, provider: "GOOGLE_SEARCH_CONSOLE", status: "CONNECTED", config: { siteUrl: "sc-domain:beta.example" } }).returning());
  integB = i.id;
  // Days 2 to 8: 10 clicks and 100 impressions per day, query "alpha" at position 15, page /p1 steady, page /p2 only on day 8.
  const rows: (typeof searchDaily.$inferInsert)[] = [];
  for (let d = 2; d <= 8; d++) {
    const base = { organizationId: B.org.id, productId: productB, integrationId: integB, provider: "GOOGLE_SEARCH_CONSOLE" as const, day: day(d) };
    rows.push({ ...base, clicks: 10, impressions: 100, position: 12 });
    rows.push({ ...base, query: "alpha", clicks: 1, impressions: 20, position: 15 });
    rows.push({ ...base, page: "https://beta.example/p1", clicks: 2, impressions: 50, position: 9 });
  }
  rows.push({ organizationId: B.org.id, productId: productB, integrationId: integB, provider: "GOOGLE_SEARCH_CONSOLE", day: day(8), page: "https://beta.example/p2", clicks: 3, impressions: 200, position: 6 });
  await qb((tx) => tx.insert(searchDaily).values(rows));
});
afterAll(closeDb);

describe("daily briefing", () => {
  it("shows unconnected sources as Not connected (never 0) and ranks blocking work first", async () => {
    const auditId = await qa(async (tx) => {
      const [a] = await tx.insert(seoAudits).values({ organizationId: A.org.id, productId: productA, status: "SUCCEEDED", startUrl: "https://brief-alpha.example/" }).returning();
      await tx.insert(seoIssues).values({ organizationId: A.org.id, auditId: a.id, productId: productA, url: "https://brief-alpha.example/", rule: "http.5xx", severity: "CRITICAL", message: "Server error" });
      await tx.insert(contentAssets).values({ organizationId: A.org.id, productId: productA, type: "ARTICLE", title: "Draft waiting", status: "HUMAN_APPROVAL" });
      await tx.insert(opportunities).values(opp(A.org.id, productA));
      return a.id;
    });
    const b = await qa((tx) => generateBriefing(tx, A.org.id, { actor: A.actor }));
    const by = Object.fromEntries(b.deltas.map((l) => [l.key, l]));
    expect(by.CLICKS).toMatchObject({ state: "NOT_CONNECTED", now: null });
    expect(by.SIGNUPS_ORGANIC).toMatchObject({ state: "NOT_CONNECTED", now: null });
    expect(by.MRR_ORGANIC).toMatchObject({ state: "NOT_CONNECTED", now: null });
    expect(by.NEW_CITATIONS.state).toBe("NOT_CONNECTED");
    expect(by.NEW_GAPS).toMatchObject({ state: "BASELINE", now: 1 });
    expect(by.DRAFTS).toMatchObject({ state: "OK", now: 1, prev: null });
    expect(b.topActions.length).toBeLessThanOrEqual(5);
    expect(b.topActions[0]).toMatchObject({ kind: "BLOCKING_SEO", href: `/discovery/audits/${auditId}`, rank: 1 });
    expect(b.topActions.map((x) => x.kind)).toEqual(["BLOCKING_SEO", "OPPORTUNITY", "DRAFT"]);
    expect(b.topActions[1].href).toMatch(/^\/opportunities\/[0-9a-f-]{36}$/);

    const second = await qa(async (tx) => {
      await tx.insert(opportunities).values(opp(A.org.id, productA));
      return generateBriefing(tx, A.org.id);
    });
    expect(second.previousId).toBe(b.id);
    expect(second.periodStart.getTime()).toBe(b.periodEnd.getTime());
    const gaps = second.deltas.find((l) => l.key === "NEW_GAPS")!;
    expect(gaps).toMatchObject({ state: "OK", now: 1 });
    expect(gaps.items?.[0].href).toMatch(/^\/opportunities\//);
  });

  it("computes search deltas against the previous stored briefing", async () => {
    const first = await qb((tx) => generateBriefing(tx, B.org.id));
    const f = Object.fromEntries(first.deltas.map((l) => [l.key, l]));
    expect(f.CLICKS).toMatchObject({ state: "OK", now: 70, prev: null });
    expect(f.ENTERED_TOP10.state).toBe("BASELINE");
    expect(first.kpis.search.lastDay).toBe(day(2));
    // A new day arrives: clicks jump, "alpha" moves into positions 4 to 10, /p2 (day 8 only) leaves the window.
    await qb((tx) =>
      tx.insert(searchDaily).values([
        { organizationId: B.org.id, productId: productB, integrationId: integB, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), clicks: 40, impressions: 100, position: 8 },
        { organizationId: B.org.id, productId: productB, integrationId: integB, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), query: "alpha", clicks: 30, impressions: 200, position: 5 },
        { organizationId: B.org.id, productId: productB, integrationId: integB, provider: "GOOGLE_SEARCH_CONSOLE", day: day(1), page: "https://beta.example/p1", clicks: 2, impressions: 50, position: 9 },
      ]),
    );
    const second = await qb((tx) => generateBriefing(tx, B.org.id));
    const s = Object.fromEntries(second.deltas.map((l) => [l.key, l]));
    expect(s.CLICKS).toMatchObject({ state: "OK", now: 100, prev: 70 });
    expect(s.CLICKS.deltaPct).toBeCloseTo(30 / 70);
    expect(s.ENTERED_TOP10).toMatchObject({ state: "OK", now: 1 });
    expect(s.ENTERED_TOP10.items?.[0]).toMatchObject({ label: "alpha", href: "/queries/search?product=brief-beta" });
    expect(s.LOST_PAGES).toMatchObject({ state: "OK", now: 1 });
    expect(s.LOST_PAGES.items?.[0].label).toBe("https://beta.example/p2");
    // Unchanged data: flagged, not a fake "no change".
    const third = await qb((tx) => generateBriefing(tx, B.org.id));
    expect(third.deltas.find((l) => l.key === "CLICKS")!.state).toBe("NO_NEW_DATA");
    expect((await qb((tx) => latestBriefing(tx, B.org.id)))!.id).toBe(third.id);
  });

  it("isolates briefings per organisation", async () => {
    const leaked = await qb((tx) => tx.select().from(briefings).where(eq(briefings.organizationId, A.org.id)));
    expect(leaked).toEqual([]);
  });
});

describe("weekly executive report", () => {
  let reportId: string;
  it("builds every section per product and for the organisation, with explicit states", async () => {
    const row = await qa((tx) => generateWeeklyReport(tx, A.org.id, { actor: A.actor }));
    reportId = row.id;
    const r = row.payload as unknown as ReportPayload;
    expect(r.scopes.map((s) => s.productId)).toEqual([null, productA]);
    for (const s of r.scopes) {
      expect(s.sections.map((x) => x.key)).toEqual(["DISCOVERY", "VISIBILITY", "CONTENT", "CONVERSION", "REVENUE", "AI_OBSERVATIONS", "OPPORTUNITIES", "EXPERIMENTS", "RISKS", "NEXT_ACTIONS"]);
      for (const sec of s.sections) for (const m of sec.metrics) expect(REPORT_METRIC_LABELS as readonly string[]).toContain(m.label);
    }
    const disc = r.scopes[0].sections[0].metrics;
    expect(disc.find((m) => m.key === "clicks")).toMatchObject({ state: "NOT_CONNECTED", now: null, prev: null });
    expect(r.scopes[0].sections.find((s) => s.key === "AI_OBSERVATIONS")!.metrics[0].state).toBe("NOT_CONNECTED");
    expect(r.scopes[0].sections.find((s) => s.key === "NEXT_ACTIONS")!.items[0].label).toBe("Fix the critical SEO issues on {subject} ({n})");
    // Regenerating the same week replaces the row (one report per period).
    const again = await qa((tx) => generateWeeklyReport(tx, A.org.id));
    expect(again.id).toBe(row.id);
  });

  it("measures search for a connected organisation", async () => {
    const row = await qb((tx) => generateWeeklyReport(tx, B.org.id));
    const clicks = (row.payload as unknown as ReportPayload).scopes[1].sections[0].metrics.find((m) => m.key === "clicks")!;
    expect(clicks.state).toBe("OK");
    // Week = days 1 to 7: 40 + 6 x 10; previous week = days 8 to 14: only day 8 has data.
    expect(clicks).toMatchObject({ now: 100, prev: 10 });
  });

  it("exports CSV, Markdown and JSON to members of the owning organisation only", async () => {
    const tokenA = (await createSession(A.user.id)).token;
    const tokenB = (await createSession(B.user.id)).token;
    const req = (token: string | null, format: string) => new Request(`http://localhost/api/reports/${reportId}/export?format=${format}`, { headers: token ? { cookie: `beacon_session=${token}` } : {} });
    const csv = await exportReport(req(tokenA, "csv"), params({ id: reportId }));
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="beacon-weekly-report-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("Organisation total,Discovery,Organic clicks,Not connected");
    const md = await exportReport(new Request(`http://localhost/api/reports/${reportId}/export?format=md`, { headers: { cookie: `beacon_session=${tokenA}; beacon_locale=fr` } }), params({ id: reportId }));
    expect(await md.text()).toContain("# Rapport de direction hebdomadaire");
    const json = await exportReport(req(tokenA, "json"), params({ id: reportId }));
    expect((await json.json()).scopes.length).toBe(2);
    expect((await exportReport(req(tokenB, "csv"), params({ id: reportId }))).status).toBe(404);
    expect((await exportReport(req(null, "csv"), params({ id: reportId }))).status).toBe(401);
    expect((await exportReport(req(tokenA, "xml"), params({ id: reportId }))).status).toBe(400);
    expect(await qb((tx) => getReport(tx, B.org.id, reportId))).toBeNull();
    expect(await qb((tx) => tx.select().from(reports).where(eq(reports.organizationId, A.org.id)))).toEqual([]);
  });
});

describe("notifications", () => {
  it("evaluates signals into one digest per kind per day, deduplicated", async () => {
    await qa((tx) => tx.insert(integrations).values({ organizationId: A.org.id, productId: productA, provider: "STRIPE", status: "EXPIRED", config: {} }));
    const first = await evaluateNotifications(qa, A.org.id);
    expect(first.fresh).toBeGreaterThan(0);
    const mine = await qa((tx) => inbox(tx, A.org.id, A.user.id));
    const kinds = mine.map((n) => n.kind).sort();
    expect(kinds).toEqual(["CONTENT_AWAITING_APPROVAL", "CRITICAL_SEO_ISSUE", "HIGH_PRIORITY_OPPORTUNITY", "INTEGRATION_DISCONNECTED"]);
    // No search data: never a traffic-drop signal.
    expect(kinds).not.toContain("TRAFFIC_DROP");
    const seo = mine.find((n) => n.kind === "CRITICAL_SEO_ISSUE")!;
    expect(seo.severity).toBe("CRITICAL");
    expect(seo.link).toMatch(/^\/discovery\/audits\//);
    const unread = await qa((tx) => unreadCount(tx, A.org.id, A.user.id));
    expect(unread).toBe(4);

    const again = await evaluateNotifications(qa, A.org.id);
    expect(again.fresh).toBe(0);
    expect(await qa((tx) => unreadCount(tx, A.org.id, A.user.id))).toBe(4);
    expect(await qa((tx) => markAllRead(tx, A.actor))).toBe(4);
    expect(await qa((tx) => unreadCount(tx, A.org.id, A.user.id))).toBe(0);

    // A new opportunity the same day merges into today's digest and makes it unread again.
    await qa((tx) => tx.insert(opportunities).values(opp(A.org.id, productA, { title: "Fresh high opportunity" })));
    const third = await evaluateNotifications(qa, A.org.id);
    expect(third.fresh).toBe(1);
    const digest = (await qa((tx) => inbox(tx, A.org.id, A.user.id))).find((n) => n.kind === "HIGH_PRIORITY_OPPORTUNITY")!;
    expect((digest.params as DigestParams).n).toBe(3);
    expect(digest.readAt).toBeNull();
    expect(await qa((tx) => tx.select().from(notifications).where(and(eq(notifications.organizationId, A.org.id), eq(notifications.kind, "HIGH_PRIORITY_OPPORTUNITY"))))).toHaveLength(2);
  });

  it("detects a week-over-week traffic drop only with search data", async () => {
    // Without a previous week of data, no drop is claimed.
    expect((await qb((tx) => evaluateSignals(tx, B.org.id, thresholdsFrom([])))).some((s) => s.kind === "TRAFFIC_DROP")).toBe(false);
    // Previous week (days 9 to 15) at 50 clicks a day; the latest week (days 2 to 8) at 70 in total.
    await qb((tx) => tx.delete(searchDaily).where(and(eq(searchDaily.organizationId, B.org.id), isNull(searchDaily.query), isNull(searchDaily.page), eq(searchDaily.day, day(1)))));
    await qb((tx) =>
      tx.insert(searchDaily).values(
        [9, 10, 11, 12, 13, 14, 15].map((d) => ({ organizationId: B.org.id, productId: productB, integrationId: integB, provider: "GOOGLE_SEARCH_CONSOLE" as const, day: day(d), clicks: 50, impressions: 400, position: 7 })),
      ),
    );
    const drop = await qb((tx) => evaluateSignals(tx, B.org.id, thresholdsFrom([])));
    const td = drop.find((s) => s.kind === "TRAFFIC_DROP");
    expect(td?.item.vars).toMatchObject({ product: "Brief Beta", now: 70, prev: 350 });
    expect(td?.item.href).toBe("/queries/search?product=brief-beta");
  });

  it("honours member preferences and organisation thresholds", async () => {
    await qa((tx) => markAllRead(tx, A.actor));
    await qa((tx) => saveMemberPreferences(tx, A.actor, new Set(["CRAWL_FAILED:IN_APP"])));
    await qa((tx) => tx.insert(seoAudits).values({ organizationId: A.org.id, productId: productA, status: "FAILED", startUrl: "https://brief-alpha.example/", error: "timeout" }));
    await qa((tx) => tx.insert(contentAssets).values({ organizationId: A.org.id, productId: productA, type: "ARTICLE", title: "Second draft", status: "HUMAN_APPROVAL" }));
    await evaluateNotifications(qa, A.org.id);
    const mine = await qa((tx) => inbox(tx, A.org.id, A.user.id, { unreadOnly: true }));
    expect(mine.map((n) => n.kind)).toEqual(["CRAWL_FAILED"]);
    // The organisation ledger still records the draft signal (no repeat later when preferences change).
    const ledger = await qa((tx) => tx.select().from(notifications).where(and(eq(notifications.organizationId, A.org.id), isNull(notifications.userId), eq(notifications.kind, "CONTENT_AWAITING_APPROVAL"))));
    expect((ledger[0].params as DigestParams).n).toBe(2);

    const t = await qa((tx) => saveOrgNotificationSettings(tx, A.actor, { thresholds: { TRAFFIC_DROP: { dropPct: 45, minClicks: 10 }, QUERY_ENTERED_TOP: { range: "TOP_3", minImpressions: 5 }, CONVERSION_ANOMALY: { z: 2.5, minDailyMean: 3 } }, webhookKinds: new Set(["CRITICAL_SEO_ISSUE"]) }));
    expect(t.TRAFFIC_DROP.dropPct).toBe(45);
    const loaded = thresholdsFrom(await qa((tx) => loadPreferences(tx, A.org.id)));
    expect(loaded).toEqual(t);
  });
});

describe("delivery", () => {
  it("POSTs a signed digest to webhooks, retries on 5xx, stops on 4xx and blocks private addresses", async () => {
    await expect(qb((tx) => addWebhook(tx, B.actor, { url: "https://127.0.0.1/hook", secret: "0123456789abcdef", kinds: [] }))).rejects.toThrow();
    await expect(qb((tx) => addWebhook(tx, B.actor, { url: "http://hooks.example.com/x", secret: "0123456789abcdef", kinds: [] }))).rejects.toThrow(/https/);
    const secret = "whsec-0123456789abcdef";
    const hook = await qb((tx) => addWebhook(tx, B.actor, { url: "https://hooks.example.com/beacon", secret, kinds: [] }));
    const stored = await qb((tx) => tx.query.notificationWebhooks.findFirst({ where: eq(notificationWebhooks.id, hook.id) }));
    expect(stored!.secretCiphertext).not.toContain(secret);

    await qb((tx) => tx.insert(opportunities).values(opp(B.org.id, productB, { title: "Webhook opportunity" })));
    const res = await evaluateNotifications(qb, B.org.id);
    const hookDelivery = res.deliveries.find((d) => d.channel === "WEBHOOK");
    expect(hookDelivery).toBeDefined();
    expect(res.deliveries.some((d) => d.channel === "EMAIL")).toBe(false);

    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const ok: Fetcher = async (url, o) => {
      calls.push({ url, body: o.body, headers: o.headers });
      return { status: 204 };
    };
    await deliverWebhook(B.org.id, hook.id, hookDelivery!.notificationId, { fetcher: ok });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe("https://hooks.example.com/beacon");
    expect(verifyWebhook(secret, c.headers["x-beacon-signature"], c.body, Math.floor(Date.now() / 1000))).toBe(true);
    const body = JSON.parse(c.body);
    expect(body).toMatchObject({ organization: B.org.slug, severity: expect.any(String) });
    // Links are absolute (BEACON_BASE_URL) so the receiver can open them.
    expect(body.items[0].url).toMatch(/^https?:\/\/[^/]+\/(queries|opportunities)/);
    expect((await qb((tx) => tx.query.notificationWebhooks.findFirst({ where: eq(notificationWebhooks.id, hook.id) })))!.lastDeliveryAt).not.toBeNull();

    await expect(deliverWebhook(B.org.id, hook.id, hookDelivery!.notificationId, { fetcher: async () => ({ status: 503 }) })).rejects.not.toBeInstanceOf(PermanentDeliveryError);
    await expect(deliverWebhook(B.org.id, hook.id, hookDelivery!.notificationId, { fetcher: async () => ({ status: 410 }) })).rejects.toBeInstanceOf(PermanentDeliveryError);
    expect((await qb((tx) => tx.query.notificationWebhooks.findFirst({ where: eq(notificationWebhooks.id, hook.id) })))!.lastError).toBe("HTTP 410");

    // A row pointing at a private address (inserted directly) is refused by the real SSRF-safe client.
    const id = randomUUID();
    await qb((tx) => tx.insert(notificationWebhooks).values({ id, organizationId: B.org.id, url: "https://127.0.0.1/hook", secretCiphertext: encryptSecret(secret, webhookAad(id)) }));
    await expect(deliverWebhook(B.org.id, id, hookDelivery!.notificationId)).rejects.toBeInstanceOf(PermanentDeliveryError);
    // Another organisation's webhook id is not found.
    await expect(deliverWebhook(A.org.id, hook.id, null, { fetcher: ok })).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it("emails a member digest once", async () => {
    const n = (await qa((tx) => inbox(tx, A.org.id, A.user.id)))[0];
    const sent: { to: string; subject: string }[] = [];
    const send = async (m: { to: string; subject: string }) => {
      sent.push(m);
      return { id: "x" };
    };
    expect(await deliverEmail(A.org.id, n.id, { send })).toEqual({ sent: true });
    expect(await deliverEmail(A.org.id, n.id, { send })).toEqual({ skipped: "already_sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(A.email);
    expect(sent[0].subject).toMatch(/^Beacon: /);
  });

  it("only signals digests to members with email on when email is configured", async () => {
    const res = await qa((tx) => applySignals(tx, A.org.id, [{ kind: "CRAWL_FAILED", severity: "MEDIUM", item: { fp: `crawl:${randomUUID()}`, key: "The crawl of {product} failed", vars: { product: "X" }, href: "/discovery" } }], addDays(new Date(), 1), { emailConfigured: true }));
    expect(res.deliveries.filter((d) => d.channel === "EMAIL")).toEqual([]);
    await qa((tx) => saveMemberPreferences(tx, A.actor, new Set(["CRAWL_FAILED:IN_APP", "CRAWL_FAILED:EMAIL"])));
    const res2 = await qa((tx) => applySignals(tx, A.org.id, [{ kind: "CRAWL_FAILED", severity: "MEDIUM", item: { fp: `crawl:${randomUUID()}`, key: "The crawl of {product} failed", vars: { product: "Y" }, href: "/discovery" } }], addDays(new Date(), 2), { emailConfigured: true }));
    expect(res2.deliveries.filter((d) => d.channel === "EMAIL")).toHaveLength(1);
  });
});
