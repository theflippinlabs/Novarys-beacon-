import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";

/** Channels whose acquisition Beacon operates (explicit definition of "attributable to Beacon"). */
export const BEACON_CHANNELS = ["ORGANIC_SEARCH", "AI_REFERRAL", "REFERRAL", "AFFILIATE", "CROSS_SELL"] as const;

export type Kpi = { now: number | null; prev: number | null; source: string };
export type Range = { days: number; productId?: string | null; end?: Date };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function windows(r: Range) {
  const end = r.end ?? new Date();
  const start = new Date(end.getTime() - r.days * 86_400_000);
  const prevStart = new Date(start.getTime() - r.days * 86_400_000);
  return { end: end.toISOString(), start: start.toISOString(), prevStart: prevStart.toISOString() };
}

const BEACON_CHANNEL_LIST = sql.join(BEACON_CHANNELS.map((c) => sql`${c}`), sql`, `);

/**
 * Command-center KPIs, current window vs previous window of equal length.
 * A KPI whose data source is not connected returns `now: null` so the UI can
 * show "not connected" instead of a misleading zero.
 */
export async function kpis(tx: Tx, organizationId: string, r: Range) {
  const w = windows(r);
  // Column names are static constants; the product id is always a bound parameter.
  const pf = (col: string): SQL => (r.productId ? sql`and ${sql.raw(col)} = ${r.productId}` : sql``);

  const vis = (
    await tx.execute(sql`
    select
      coalesce(sum(value) filter (where metric = 'search_impressions' and day >= ${w.start}::date), 0) as imp_now,
      coalesce(sum(value) filter (where metric = 'search_impressions' and day < ${w.start}::date and day >= ${w.prevStart}::date), 0) as imp_prev,
      coalesce(sum(value) filter (where metric = 'search_clicks' and day >= ${w.start}::date), 0) as clk_now,
      coalesce(sum(value) filter (where metric = 'search_clicks' and day < ${w.start}::date and day >= ${w.prevStart}::date), 0) as clk_prev,
      count(*) filter (where metric in ('search_impressions','search_clicks')) as has_search,
      coalesce(sum(value) filter (where metric = 'ai_referral_sessions' and day >= ${w.start}::date), 0) as ai_ga_now,
      coalesce(sum(value) filter (where metric = 'ai_referral_sessions' and day < ${w.start}::date and day >= ${w.prevStart}::date), 0) as ai_ga_prev,
      count(*) filter (where metric = 'sessions') as has_ga
    from visibility_metrics where organization_id = ${organizationId} and (dimension = '' or metric = 'sessions') ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const indexed = (
    await tx.execute(sql`
    select coalesce(sum(cnt), 0) as n, count(*) as audits from (
      select distinct on (a.product_id) (a.summary->>'indexable')::int as cnt from seo_audits a
      where a.organization_id = ${organizationId} and a.status = 'SUCCEEDED' ${pf("a.product_id")}
      order by a.product_id, a.created_at desc) x`)
  ).rows[0] as Record<string, unknown>;

  const q = (
    await tx.execute(sql`
    select count(*) filter (where coverage = 'COVERED') as covered, count(*) as active
    from queries where organization_id = ${organizationId} and status = 'ACTIVE' ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const branded = (
    await tx.execute(sql`
    select coalesce(sum(m.value) filter (where m.day >= ${w.start}::date), 0) as now, coalesce(sum(m.value) filter (where m.day < ${w.start}::date), 0) as prev, count(*) as rows
    from visibility_metrics m join products p on p.id = m.product_id
    where m.organization_id = ${organizationId} and m.metric = 'query_impressions' and m.day >= ${w.prevStart}::date
      and position(lower(p.name) in lower(m.dimension)) > 0 ${pf("m.product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const ev = (
    await tx.execute(sql`
    select
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and occurred_at >= ${w.start}) as visitors_now,
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and occurred_at < ${w.start}) as visitors_prev,
      count(*) filter (where type = 'SIGNUP' and occurred_at >= ${w.start}) as signups_now,
      count(*) filter (where type = 'SIGNUP' and occurred_at < ${w.start}) as signups_prev,
      count(*) filter (where type = 'TRIAL_STARTED' and occurred_at >= ${w.start}) as trials_now,
      count(*) filter (where type = 'TRIAL_STARTED' and occurred_at < ${w.start}) as trials_prev,
      count(*) filter (where type = 'ACTIVATED' and occurred_at >= ${w.start}) as act_now,
      count(*) filter (where type = 'ACTIVATED' and occurred_at < ${w.start}) as act_prev,
      count(*) filter (where type = 'SUBSCRIBED' and occurred_at >= ${w.start}) as subs_now,
      count(*) filter (where type = 'SUBSCRIBED' and occurred_at < ${w.start}) as subs_prev,
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and channel = 'AI_REFERRAL' and occurred_at >= ${w.start}) as ai_now,
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and channel = 'AI_REFERRAL' and occurred_at < ${w.start}) as ai_prev,
      count(*) as any_events
    from conversion_events where organization_id = ${organizationId} and occurred_at >= ${w.prevStart} and occurred_at < ${w.end} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const mentions = (
    await tx.execute(sql`
    select count(*) filter (where observed_at >= ${w.start}) as now, count(*) filter (where observed_at < ${w.start}) as prev,
      (select count(*) from ai_visibility_tests where organization_id = ${organizationId}) as tests
    from ai_mentions where organization_id = ${organizationId} and observed_at >= ${w.prevStart} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const rev = (
    await tx.execute(sql`
    select
      count(*) filter (where type = 'NEW' and occurred_at >= ${w.start}) as new_now,
      count(*) filter (where type = 'NEW' and occurred_at < ${w.start}) as new_prev,
      coalesce(sum(amount_cents) filter (where occurred_at >= ${w.start}), 0) as rev_now,
      coalesce(sum(amount_cents) filter (where occurred_at < ${w.start}), 0) as rev_prev,
      coalesce(sum(mrr_delta_cents) filter (where occurred_at >= ${w.start} and channel::text in (${BEACON_CHANNEL_LIST})), 0) as beacon_mrr_new_now,
      coalesce(sum(mrr_delta_cents) filter (where occurred_at < ${w.start} and channel::text in (${BEACON_CHANNEL_LIST})), 0) as beacon_mrr_new_prev,
      coalesce(sum(amount_cents) filter (where occurred_at >= ${w.start} and channel = 'AFFILIATE'), 0) as aff_now,
      coalesce(sum(amount_cents) filter (where occurred_at < ${w.start} and channel = 'AFFILIATE'), 0) as aff_prev,
      count(*) filter (where occurred_at >= ${w.start} and channel in ('REFERRAL','AFFILIATE') and type = 'NEW') as ref_conv_now,
      count(*) filter (where occurred_at < ${w.start} and channel in ('REFERRAL','AFFILIATE') and type = 'NEW') as ref_conv_prev,
      (select count(*) from revenue_events where organization_id = ${organizationId}) as any_rev,
      min(currency) as currency
    from revenue_events where organization_id = ${organizationId} and occurred_at >= ${w.prevStart} and occurred_at < ${w.end} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const mrr = (
    await tx.execute(sql`
    select coalesce(sum(mrr_cents), 0) as total,
      coalesce(sum(mrr_cents) filter (where channel::text in (${BEACON_CHANNEL_LIST})), 0) as beacon
    from subscriptions where organization_id = ${organizationId} and status in ('ACTIVE','PAST_DUE') ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const eco = (
    await tx.execute(sql`
    select
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'IMPRESSION' and occurred_at >= ${w.start}) as imp,
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'CONVERSION' and occurred_at >= ${w.start}) as conv,
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'IMPRESSION' and occurred_at < ${w.start} and occurred_at >= ${w.prevStart}) as imp_prev,
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'CONVERSION' and occurred_at < ${w.start} and occurred_at >= ${w.prevStart}) as conv_prev,
      (select count(*) from (select identity_id from identity_products where organization_id = ${organizationId} and status in ('ACTIVE','TRIALING') group by identity_id having count(*) >= 2) m) as multi,
      (select count(*) from identities where organization_id = ${organizationId}) as identities`)
  ).rows[0] as Record<string, unknown>;

  const content = (
    await tx.execute(sql`
    select count(*) filter (where status = 'PUBLISHED') as published,
      count(*) filter (where status = 'PUBLISHED' and published_at >= ${w.start}) as published_now,
      count(*) filter (where status = 'PUBLISHED' and published_at < ${w.start} and published_at >= ${w.prevStart}) as published_prev
    from content_assets where organization_id = ${organizationId} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const hasSearch = n(vis.has_search) > 0;
  const hasEvents = n(ev.any_events) > 0;
  const hasRev = n(rev.any_rev) > 0;
  const k = (now: unknown, prev: unknown, source: string, available = true): Kpi => (available ? { now: n(now), prev: n(prev), source } : { now: null, prev: null, source });
  const rate = (a: unknown, b: unknown) => (n(b) > 0 ? n(a) / n(b) : null);

  return {
    currency: (rev.currency as string | null) ?? "EUR",
    discovery: {
      organicImpressions: k(vis.imp_now, vis.imp_prev, "Search Console / Bing", hasSearch),
      organicClicks: k(vis.clk_now, vis.clk_prev, "Search Console / Bing", hasSearch),
      indexedPages: n(indexed.audits) > 0 ? { now: n(indexed.n), prev: null, source: "Latest technical audit (indexable pages)" } : { now: null, prev: null, source: "Technical audit" },
      coveredQueries: { now: n(q.covered), prev: null, source: `of ${n(q.active)} active queries` },
      brandedImpressions: k(branded.now, branded.prev, "Search Console (queries containing product names)", n(branded.rows) > 0),
      aiReferrals: hasEvents || n(vis.has_ga) > 0 ? { now: n(ev.ai_now) + n(vis.ai_ga_now), prev: n(ev.ai_prev) + n(vis.ai_ga_prev), source: "Beacon events + GA4 AI-assistant referrers" } : { now: null, prev: null, source: "Beacon tracker / GA4" },
      aiMentions: k(mentions.now, mentions.prev, "Sampled AI tests (observations, not totals)", n(mentions.tests) > 0),
    },
    acquisition: {
      visitors: k(ev.visitors_now, ev.visitors_prev, "Beacon tracker", hasEvents),
      signups: k(ev.signups_now, ev.signups_prev, "Beacon events", hasEvents),
      trials: k(ev.trials_now, ev.trials_prev, "Beacon events", hasEvents),
      activations: k(ev.act_now, ev.act_prev, "Beacon events", hasEvents),
    },
    revenue: {
      newSubscriptions: k(rev.new_now, rev.new_prev, "Revenue events", hasRev),
      revenue: k(rev.rev_now, rev.rev_prev, "Revenue events", hasRev),
      beaconNewMrr: k(rev.beacon_mrr_new_now, rev.beacon_mrr_new_prev, `New MRR from ${BEACON_CHANNELS.join(", ")}`, hasRev),
      mrr: hasRev ? { now: n(mrr.total), prev: null, source: "Active subscriptions" } : { now: null, prev: null, source: "Revenue events" },
      beaconMrr: hasRev ? { now: n(mrr.beacon), prev: null, source: "Active subscriptions acquired via Beacon channels" } : { now: null, prev: null, source: "Revenue events" },
      arr: hasRev ? { now: n(mrr.total) * 12, prev: null, source: "MRR × 12" } : { now: null, prev: null, source: "Revenue events" },
      conversionRate: hasEvents ? { now: rate(ev.subs_now, ev.visitors_now), prev: rate(ev.subs_prev, ev.visitors_prev), source: "SUBSCRIBED ÷ visitors" } : { now: null, prev: null, source: "Beacon events" },
    },
    ecosystem: {
      crossSellRate: n(eco.imp) + n(eco.imp_prev) > 0 ? { now: rate(eco.conv, eco.imp), prev: rate(eco.conv_prev, eco.imp_prev), source: "Cross-sell conversions ÷ impressions" } : { now: null, prev: null, source: "Cross-sell events" },
      multiProductUsers: n(eco.identities) > 0 ? { now: n(eco.multi), prev: null, source: "Identities active in ≥ 2 products" } : { now: null, prev: null, source: "Novarys ID" },
      referralConversions: k(rev.ref_conv_now, rev.ref_conv_prev, "New subscriptions attributed to referral/affiliate", hasRev),
      affiliateRevenue: k(rev.aff_now, rev.aff_prev, "Revenue attributed to affiliates", hasRev),
    },
    content: {
      published: { now: n(content.published), prev: null, source: "Published assets (all time)" },
      publishedInPeriod: { now: n(content.published_now), prev: n(content.published_prev), source: "Assets published in period" },
    },
  };
}

export type Kpis = Awaited<ReturnType<typeof kpis>>;

export async function dailySeries(tx: Tx, organizationId: string, days: number, productId?: string | null) {
  const pf = productId ? sql`and product_id = ${productId}` : sql``;
  const r = await tx.execute<{ day: string; visitors: number; signups: number; subs: number; ai: number }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day,
      coalesce((select count(distinct visitor_id) from conversion_events where organization_id = ${organizationId} and type = 'PAGE_VIEW' and occurred_at >= d and occurred_at < d + interval '1 day' ${pf}), 0)::int as visitors,
      coalesce((select count(*) from conversion_events where organization_id = ${organizationId} and type = 'SIGNUP' and occurred_at >= d and occurred_at < d + interval '1 day' ${pf}), 0)::int as signups,
      coalesce((select count(*) from conversion_events where organization_id = ${organizationId} and type = 'SUBSCRIBED' and occurred_at >= d and occurred_at < d + interval '1 day' ${pf}), 0)::int as subs,
      coalesce((select count(distinct visitor_id) from conversion_events where organization_id = ${organizationId} and type = 'PAGE_VIEW' and channel = 'AI_REFERRAL' and occurred_at >= d and occurred_at < d + interval '1 day' ${pf}), 0)::int as ai
    from generate_series(current_date - ${days - 1}::int, current_date, interval '1 day') d`);
  return r.rows.map((x) => ({ day: x.day, visitors: Number(x.visitors), signups: Number(x.signups), subs: Number(x.subs), ai: Number(x.ai) }));
}

export async function revenueByDimension(tx: Tx, organizationId: string, dim: "channel" | "product", days: number) {
  const col = dim === "channel" ? sql`r.channel::text` : sql`p.name`;
  const r = await tx.execute<{ key: string; revenue: number; new_mrr: number; events: number; currency: string }>(sql`
    select ${col} as key, sum(r.amount_cents)::bigint as revenue, sum(r.mrr_delta_cents)::bigint as new_mrr, count(*)::int as events, r.currency as currency
    from revenue_events r join products p on p.id = r.product_id
    where r.organization_id = ${organizationId} and r.occurred_at >= now() - make_interval(days => ${days})
    group by 1, r.currency order by 2 desc`);
  return r.rows.map((x) => ({ key: x.key, revenue: Number(x.revenue), newMrr: Number(x.new_mrr), events: Number(x.events), currency: x.currency }));
}

export async function mrrByDimension(tx: Tx, organizationId: string, dim: "channel" | "product") {
  const col = dim === "channel" ? sql`coalesce(s.channel::text, 'UNATTRIBUTED')` : sql`p.name`;
  // Grouped per currency: amounts in different currencies are never summed together.
  const r = await tx.execute<{ key: string; mrr: number; subs: number; currency: string }>(sql`
    select ${col} as key, sum(s.mrr_cents)::bigint as mrr, count(*)::int as subs, s.currency as currency
    from subscriptions s join products p on p.id = s.product_id
    where s.organization_id = ${organizationId} and s.status in ('ACTIVE','PAST_DUE')
    group by 1, s.currency order by 2 desc`);
  return r.rows.map((x) => ({ key: x.key, mrr: Number(x.mrr), subs: Number(x.subs), currency: x.currency }));
}

export async function funnelCounts(tx: Tx, organizationId: string, days: number, productId?: string | null, channel?: string | null) {
  const r = await tx.execute<{ type: string; n: number }>(sql`
    select type, count(distinct coalesce(identity_id::text, visitor_id))::int as n from conversion_events
    where organization_id = ${organizationId} and occurred_at >= now() - make_interval(days => ${days})
    ${productId ? sql`and product_id = ${productId}` : sql``} ${channel ? sql`and channel = ${channel}` : sql``}
    group by type`);
  return Object.fromEntries(r.rows.map((x) => [x.type, Number(x.n)]));
}

export async function contentPerformance(tx: Tx, organizationId: string, days: number) {
  const r = await tx.execute<{ id: string; title: string; type: string; path: string | null; product: string | null; views: number; cta: number; signups: number }>(sql`
    select a.id, a.title, a.type::text, pg.path, pr.slug as product,
      coalesce(sum(case when e.type = 'PAGE_VIEW' then 1 else 0 end), 0)::int as views,
      coalesce(sum(case when e.type = 'CTA_CLICK' then 1 else 0 end), 0)::int as cta,
      coalesce(sum(case when e.type = 'SIGNUP' then 1 else 0 end), 0)::int as signups
    from content_assets a
    left join pages pg on pg.id = a.page_id
    left join products pr on pr.id = a.product_id
    left join conversion_events e on e.organization_id = a.organization_id and e.product_id = a.product_id and e.page_path = pg.path and e.occurred_at >= now() - make_interval(days => ${days})
    where a.organization_id = ${organizationId} and a.status = 'PUBLISHED'
    group by a.id, a.title, a.type, pg.path, pr.slug order by views desc`);
  return r.rows.map((x) => ({ ...x, views: Number(x.views), cta: Number(x.cta), signups: Number(x.signups) }));
}
