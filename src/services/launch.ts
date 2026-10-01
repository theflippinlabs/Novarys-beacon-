import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { products } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { claimVerification } from "@/core/knowledge/types";
import { hostCoveredBy } from "@/core/seo/domains";
import { addDays, isoDay } from "@/core/util/text";
import { dailyDeltas, launchChecklist, launchPhase, MONITORING_DAYS, openBlockers, type ChecklistItem, type DeltaRow, type LaunchBaseline, type LaunchFacts } from "@/core/launch/checklist";
import { eventTypesFor } from "@/core/conversions/events";
import { audit, type Actor } from "@/lib/audit";
import { availability, type KpiState } from "./metrics";
import { latestAudit, openIssueCounts, verifiedDomainNames } from "./seo";

/**
 * Product launch mode: facts for the launch checklist (all measured), the
 * launch actions and the post-launch monitoring panel. Queries are issued
 * sequentially on the one transaction.
 */
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const SCHEMA_ERRORS = ["schema.invalid_json", "schema.required_missing"];

export async function launchFacts(tx: Tx, organizationId: string, productId: string): Promise<LaunchFacts> {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const p = g.product;
  const c = computeCompleteness(g);
  const facts = c.items.reduce((s, i) => s + i.facts, 0);
  const verified = c.items.reduce((s, i) => s + i.verifiedFacts, 0);
  const host = p.domain ? p.domain.replace(/^https?:\/\//, "").split("/")[0] : null;
  const domainVerified = host ? Boolean(hostCoveredBy(host, await verifiedDomainNames(tx, organizationId))) : false;
  const a = await latestAudit(tx, organizationId, productId);
  let auditFacts: LaunchFacts["audit"] = null;
  let https: boolean | null = null;
  if (a) {
    const counts = await openIssueCounts(tx, a.id);
    const row = (
      await tx.execute<{ schema_errors: number; sitemaps: number; sitemap_errors: number; home_final: string | null }>(sql`
      select
        (select count(*) from seo_issues i where i.audit_id = ${a.id} and i.status = 'OPEN' and i.rule in (${sql.join(SCHEMA_ERRORS.map((r) => sql`${r}`), sql`, `)})
           and (i.url = ${a.startUrl} or exists (select 1 from crawled_pages c where c.audit_id = ${a.id} and c.url = i.url and coalesce(c.depth, 99) <= 1)))::int as schema_errors,
        (select count(*) from sitemap_snapshots where audit_id = ${a.id})::int as sitemaps,
        (select count(*) from sitemap_snapshots where audit_id = ${a.id} and (kind in ('invalid', 'error') or coalesce(status, 0) <> 200 or jsonb_array_length(errors) > 0))::int as sitemap_errors,
        (select coalesce(final_url, url) from crawled_pages where audit_id = ${a.id} and (depth = 0 or url = ${a.startUrl}) order by depth nulls last limit 1) as home_final`)
    ).rows[0];
    https = a.startUrl.startsWith("https://") && (!row?.home_final || row.home_final.startsWith("https://"));
    auditFacts = { id: a.id, critical: counts.CRITICAL, schemaErrorsOnKeyPages: n(row?.schema_errors), sitemaps: n(row?.sitemaps), sitemapErrors: n(row?.sitemap_errors), finishedAt: a.finishedAt?.toISOString() ?? null };
  }
  const launchDay = p.launchedAt ? isoDay(p.launchedAt) : null;
  const s = (
    await tx.execute<Record<string, unknown>>(sql`
    select
      (select status::text from integrations where organization_id = ${organizationId} and provider = 'GOOGLE_ANALYTICS' and (product_id = ${productId} or product_id is null) order by product_id nulls last limit 1) as ga4,
      (select status::text from integrations where organization_id = ${organizationId} and provider = 'GOOGLE_SEARCH_CONSOLE' and (product_id = ${productId} or product_id is null) order by product_id nulls last limit 1) as gsc,
      exists(select 1 from pages where organization_id = ${organizationId} and product_id = ${productId} and type = 'PRODUCT' and status = 'PUBLISHED') as product_published,
      exists(select 1 from pages where organization_id = ${organizationId} and product_id = ${productId} and type = 'PRODUCT' and status <> 'ARCHIVED') as product_planned,
      (select count(*) from api_keys where organization_id = ${organizationId} and revoked_at is null and (product_id = ${productId} or product_id is null))::int as keys,
      (select count(*) from conversion_events where organization_id = ${organizationId} and product_id = ${productId})::int as events,
      (select count(*) from content_assets where organization_id = ${organizationId} and product_id = ${productId} and type = 'RELEASE_ANNOUNCEMENT' and status = 'APPROVED')::int as content_approved,
      (select count(*) from content_assets where organization_id = ${organizationId} and product_id = ${productId} and type = 'RELEASE_ANNOUNCEMENT' and status = 'PUBLISHED')::int as content_published,
      (select count(*) from distribution_targets where organization_id = ${organizationId} and product_id = ${productId} and status = 'PREPARED')::int as dist_prepared,
      (select count(*) from distribution_targets where organization_id = ${organizationId} and product_id = ${productId} and status in ('SUBMITTED', 'PUBLISHED', 'PERFORMING', 'FOLLOW_UP'))::int as dist_submitted,
      (select count(*) from queries where organization_id = ${organizationId} and product_id = ${productId} and status = 'ACTIVE')::int as active_queries,
      ${launchDay ? sql`(select count(*) from conversion_events where organization_id = ${organizationId} and product_id = ${productId} and occurred_at >= ${launchDay}::date)::int` : sql`0`} as events_since,
      ${launchDay ? sql`(select count(distinct day) from search_daily where organization_id = ${organizationId} and product_id = ${productId} and query is null and page is null and country is null and device is null and day >= ${launchDay}::date)::int` : sql`0`} as search_days,
      ${launchDay ? sql`(select count(distinct day) from analytics_daily where organization_id = ${organizationId} and product_id = ${productId} and day >= ${launchDay}::date)::int` : sql`0`} as analytics_days`)
  ).rows[0];
  const integ = (v: unknown): LaunchFacts["analytics"] => (v === "CONNECTED" ? "CONNECTED" : v === "ERROR" || v === "EXPIRED" ? "FAILING" : "NOT_CONNECTED");
  const b = (v: unknown) => v === true || v === "t";
  return {
    slug: p.slug,
    knowledge: { completeness: c.score, facts, verified },
    domain: { name: host, verified: domainVerified, https },
    audit: auditFacts,
    analytics: integ(s.ga4),
    searchConsole: integ(s.gsc),
    productPage: { published: b(s.product_published), planned: b(s.product_planned) },
    docs: { url: p.documentationUrl, verified: Boolean(p.documentationUrl) && claimVerification(g, "documentation_url") === "VERIFIED" },
    tracking: { activeKeys: n(s.keys), events: n(s.events) },
    launchContent: { approved: n(s.content_approved), published: n(s.content_published) },
    distribution: { prepared: n(s.dist_prepared), submitted: n(s.dist_submitted) },
    queries: { active: n(s.active_queries) },
    baseline: p.launchBaseline ?? null,
    launchedAt: p.launchedAt?.toISOString() ?? null,
    postLaunch: { eventsSince: n(s.events_since), searchDaysSince: n(s.search_days), analyticsDaysSince: n(s.analytics_days) },
  };
}

/** The launch checklist of a product, derived from real state. */
export async function productLaunchChecklist(tx: Tx, organizationId: string, productId: string): Promise<ChecklistItem[]> {
  return launchChecklist(await launchFacts(tx, organizationId, productId));
}

async function productOf(tx: Tx, actor: Actor, productId: string) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) });
  if (!p) throw new Error("Product not found");
  return p;
}

/** Plan the launch (PRE_LAUNCH with an optional date) or turn launch mode off. */
export async function setLaunchPlan(tx: Tx, actor: Actor, productId: string, input: { mode: "PRE_LAUNCH" | "OFF"; launchDate: string | null }) {
  const p = await productOf(tx, actor, productId);
  if (p.launchedAt && input.mode === "PRE_LAUNCH") throw new Error("This product is already launched.");
  await tx
    .update(products)
    .set({ launchMode: input.mode, launchDate: input.launchDate })
    .where(and(eq(products.id, p.id), eq(products.organizationId, actor.organizationId)));
  await audit(tx, actor, "launch.plan", "product", p.id, { mode: input.mode, launchDate: input.launchDate });
}

/** Capture the query baseline the post-launch deltas compare against (14 days before now). */
export async function captureBaseline(tx: Tx, actor: Actor, productId: string, now = new Date()): Promise<LaunchBaseline> {
  const p = await productOf(tx, actor, productId);
  const av = await availability(tx, actor.organizationId, p.id);
  const since = isoDay(addDays(now, -MONITORING_DAYS));
  const today = isoDay(now);
  const r = (
    await tx.execute<{ active: number; clicks: number; impressions: number; visitors: number }>(sql`
    select
      (select count(*) from queries where organization_id = ${actor.organizationId} and product_id = ${p.id} and status = 'ACTIVE')::int as active,
      (select coalesce(sum(clicks), 0) from search_daily where organization_id = ${actor.organizationId} and product_id = ${p.id} and query is null and page is null and country is null and device is null and day >= ${since}::date and day < ${today}::date)::float as clicks,
      (select coalesce(sum(impressions), 0) from search_daily where organization_id = ${actor.organizationId} and product_id = ${p.id} and query is null and page is null and country is null and device is null and day >= ${since}::date and day < ${today}::date)::float as impressions,
      (select count(distinct (visitor_id, occurred_at::date)) from conversion_events where organization_id = ${actor.organizationId} and product_id = ${p.id} and type = 'PAGE_VIEW' and occurred_at >= ${since}::date and occurred_at < ${today}::date)::int as visitors`)
  ).rows[0];
  const baseline: LaunchBaseline = {
    capturedAt: now.toISOString(),
    activeQueries: n(r?.active),
    search: av.searchConnected ? { clicks: n(r?.clicks), impressions: n(r?.impressions), days: MONITORING_DAYS } : null,
    visitorsPerDay: av.events ? Math.round((n(r?.visitors) / MONITORING_DAYS) * 10) / 10 : null,
  };
  await tx.update(products).set({ launchBaseline: baseline }).where(and(eq(products.id, p.id), eq(products.organizationId, actor.organizationId)));
  await audit(tx, actor, "launch.baseline", "product", p.id, { activeQueries: baseline.activeQueries, search: baseline.search !== null });
  return baseline;
}

/**
 * "Launch product": refused while blocking checklist items are open unless
 * the person explicitly launches anyway. Captures the baseline when missing,
 * then switches to LAUNCH with today's date.
 */
export async function launchProduct(tx: Tx, actor: Actor, productId: string, opts: { force?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const p = await productOf(tx, actor, productId);
  if (p.launchedAt) throw new Error("This product is already launched.");
  const items = await productLaunchChecklist(tx, actor.organizationId, p.id);
  const blockers = openBlockers(items);
  if (blockers.length && !opts.force) throw new Error(`Launch blocked by ${blockers.length} open item(s): ${blockers.map((b) => b.label).join(", ")}.`);
  if (!p.launchBaseline) await captureBaseline(tx, actor, p.id, now);
  await tx
    .update(products)
    .set({ launchMode: "LAUNCH", launchedAt: now, launchDate: isoDay(now) })
    .where(and(eq(products.id, p.id), eq(products.organizationId, actor.organizationId)));
  await audit(tx, actor, "launch.launch", "product", p.id, { blockers: blockers.map((b) => b.key), forced: Boolean(opts.force && blockers.length) });
  return { blockers };
}

export type MonitoringSeries = { key: "clicks" | "impressions" | "sessions" | "visitors" | "signups"; label: string; source: string; state: KpiState; rows: DeltaRow[] };

/**
 * Post-launch monitoring: daily values and day-over-day deltas for the 14
 * days from launch, per source. A source that is not connected is reported
 * as NOT_CONNECTED (no zeros); connected without rows is NO_DATA_YET.
 */
export async function launchMonitoring(tx: Tx, organizationId: string, productId: string, now = new Date()): Promise<{ start: string; end: string; series: MonitoringSeries[] } | null> {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!p?.launchedAt) return null;
  const start = p.launchDate ?? isoDay(p.launchedAt);
  const lastDay = isoDay(addDays(new Date(`${start}T00:00:00Z`), MONITORING_DAYS - 1));
  const end = lastDay < isoDay(now) ? lastDay : isoDay(now);
  const av = await availability(tx, organizationId, productId);
  const rows = (
    await tx.execute<{ day: string; clicks: number | null; impressions: number | null; sessions: number | null; visitors: number; signups: number }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day,
      (select sum(clicks)::float from search_daily where organization_id = ${organizationId} and product_id = ${productId} and query is null and page is null and country is null and device is null and day = d::date) as clicks,
      (select sum(impressions)::float from search_daily where organization_id = ${organizationId} and product_id = ${productId} and query is null and page is null and country is null and device is null and day = d::date) as impressions,
      (select sum(sessions)::float from analytics_daily where organization_id = ${organizationId} and product_id = ${productId} and report = 'landing' and day = d::date) as sessions,
      (select count(distinct visitor_id) from conversion_events where organization_id = ${organizationId} and product_id = ${productId} and type = 'PAGE_VIEW' and occurred_at >= d and occurred_at < d + interval '1 day')::int as visitors,
      (select count(*) from conversion_events where organization_id = ${organizationId} and product_id = ${productId} and type::text in (${sql.join(eventTypesFor("SIGNUP_COMPLETED").map((t) => sql`${t}`), sql`, `)}) and occurred_at >= d and occurred_at < d + interval '1 day')::int as signups
    from generate_series(${start}::date, ${end}::date, interval '1 day') d`)
  ).rows;
  const state = (connected: boolean, data: boolean): KpiState => (data ? "OK" : connected ? "NO_DATA_YET" : "NOT_CONNECTED");
  const col = (k: "clicks" | "impressions" | "sessions" | "visitors" | "signups", measured: boolean) =>
    dailyDeltas(rows.map((r) => ({ day: r.day, value: !measured ? null : r[k] === null || r[k] === undefined ? (k === "visitors" || k === "signups" ? 0 : null) : Number(r[k]) })));
  const searchData = rows.some((r) => r.clicks !== null);
  const gaData = rows.some((r) => r.sessions !== null);
  return {
    start,
    end,
    series: [
      { key: "impressions", label: "Search impressions", source: "Search Console / Bing", state: state(av.searchConnected, searchData), rows: col("impressions", av.searchConnected) },
      { key: "clicks", label: "Search clicks", source: "Search Console / Bing", state: state(av.searchConnected, searchData), rows: col("clicks", av.searchConnected) },
      { key: "sessions", label: "Sessions", source: "Google Analytics 4", state: state(av.ga4Connected, gaData), rows: col("sessions", av.ga4Connected) },
      { key: "visitors", label: "Visitors", source: "Beacon tracker", state: state(av.trackerKey, av.events), rows: col("visitors", av.trackerKey) },
      { key: "signups", label: "Signups", source: "Beacon tracker", state: state(av.trackerKey, av.events), rows: col("signups", av.trackerKey) },
    ],
  };
}

export { launchPhase, openBlockers };
