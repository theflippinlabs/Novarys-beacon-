import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { eventTypesFor, LEGACY_ALIASES, type CanonicalEvent } from "@/core/conversions/events";

/** Channels whose acquisition Beacon operates (explicit definition of "attributable to Beacon"). */
export const BEACON_CHANNELS = ["ORGANIC_SEARCH", "AI_REFERRAL", "REFERRAL", "AFFILIATE", "CROSS_SELL"] as const;

/**
 * Three KPI states, never collapsed:
 * - NOT_CONNECTED: no integration, tracker key or setup for this source (`now` null; the tile links to `href`)
 * - NO_DATA_YET: connected or key created, but nothing received yet, all time (`now` null)
 * - OK: measured; a measured 0 is a real 0. `now` is null only for a rate without denominator ("n/a").
 * Money KPIs carry `byCurrency` (amounts are never summed across currencies);
 * `now`/`prev` and `currency` are set only when exactly one currency exists.
 */
export type KpiState = "NOT_CONNECTED" | "NO_DATA_YET" | "OK";
export type CurrencyAmount = { currency: string; now: number; prev: number | null };
export type Kpi = { state: KpiState; now: number | null; prev: number | null; source: string; href?: string; currency?: string | null; byCurrency?: CurrencyAmount[] };
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
 * Each KPI carries its state (see `Kpi`): availability comes from the
 * integrations, API keys and all-time data of the scope (organisation, or the
 * product when `productId` is given), never from rows inside the window.
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
    select coalesce(sum(s.impressions) filter (where s.day >= ${w.start}::date), 0) as now, coalesce(sum(s.impressions) filter (where s.day < ${w.start}::date), 0) as prev,
      (select count(*) from search_daily x where x.organization_id = ${organizationId} and x.query is not null and x.page is null ${pf("x.product_id")}) as rows
    from search_daily s join products p on p.id = s.product_id
    -- Daily per-query rows (query grain only: no page, country or device split), so each impression is counted once.
    where s.organization_id = ${organizationId} and s.query is not null and s.page is null and s.country is null and s.device is null
      and s.day >= ${w.prevStart}::date and s.day <= ${w.end}::date
      and position(lower(p.name) in lower(s.query)) > 0 ${pf("s.product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const ev = (
    await tx.execute(sql`
    select
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and occurred_at >= ${w.start}) as visitors_now,
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and occurred_at < ${w.start}) as visitors_prev,
      count(*) filter (where type::text in (${typeList("SIGNUP_COMPLETED")}) and occurred_at >= ${w.start}) as signups_now,
      count(*) filter (where type::text in (${typeList("SIGNUP_COMPLETED")}) and occurred_at < ${w.start}) as signups_prev,
      count(*) filter (where type = 'TRIAL_STARTED' and occurred_at >= ${w.start}) as trials_now,
      count(*) filter (where type = 'TRIAL_STARTED' and occurred_at < ${w.start}) as trials_prev,
      count(*) filter (where type::text in (${typeList("ACTIVATION_COMPLETED")}) and occurred_at >= ${w.start}) as act_now,
      count(*) filter (where type::text in (${typeList("ACTIVATION_COMPLETED")}) and occurred_at < ${w.start}) as act_prev,
      count(*) filter (where type::text in (${typeList("SUBSCRIPTION_STARTED")}) and occurred_at >= ${w.start}) as subs_now,
      count(*) filter (where type::text in (${typeList("SUBSCRIPTION_STARTED")}) and occurred_at < ${w.start}) as subs_prev,
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and channel = 'AI_REFERRAL' and occurred_at >= ${w.start}) as ai_now,
      count(distinct visitor_id) filter (where type = 'PAGE_VIEW' and channel = 'AI_REFERRAL' and occurred_at < ${w.start}) as ai_prev
    from conversion_events where organization_id = ${organizationId} and occurred_at >= ${w.prevStart} and occurred_at < ${w.end} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const mentions = (
    await tx.execute(sql`
    select count(*) filter (where observed_at >= ${w.start}) as now, count(*) filter (where observed_at < ${w.start}) as prev
    from ai_mentions where organization_id = ${organizationId} and observed_at >= ${w.prevStart} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const revRows = (
    await tx.execute(sql`
    select currency,
      coalesce(sum(amount_cents) filter (where occurred_at >= ${w.start}), 0) as rev_now,
      coalesce(sum(amount_cents) filter (where occurred_at < ${w.start}), 0) as rev_prev,
      coalesce(sum(mrr_delta_cents) filter (where occurred_at >= ${w.start} and channel::text in (${BEACON_CHANNEL_LIST})), 0) as beacon_mrr_new_now,
      coalesce(sum(mrr_delta_cents) filter (where occurred_at < ${w.start} and channel::text in (${BEACON_CHANNEL_LIST})), 0) as beacon_mrr_new_prev,
      coalesce(sum(amount_cents) filter (where occurred_at >= ${w.start} and channel = 'AFFILIATE'), 0) as aff_now,
      coalesce(sum(amount_cents) filter (where occurred_at < ${w.start} and channel = 'AFFILIATE'), 0) as aff_prev
    from revenue_events where organization_id = ${organizationId} and occurred_at >= ${w.prevStart} and occurred_at < ${w.end} ${pf("product_id")}
    group by currency`)
  ).rows as Record<string, unknown>[];

  const revCounts = (
    await tx.execute(sql`
    select
      count(*) filter (where type = 'NEW' and occurred_at >= ${w.start}) as new_now,
      count(*) filter (where type = 'NEW' and occurred_at < ${w.start}) as new_prev,
      count(*) filter (where occurred_at >= ${w.start} and channel in ('REFERRAL','AFFILIATE') and type = 'NEW') as ref_conv_now,
      count(*) filter (where occurred_at < ${w.start} and channel in ('REFERRAL','AFFILIATE') and type = 'NEW') as ref_conv_prev
    from revenue_events where organization_id = ${organizationId} and occurred_at >= ${w.prevStart} and occurred_at < ${w.end} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const mrrRows = (
    await tx.execute(sql`
    select currency, coalesce(sum(mrr_cents), 0) as total,
      coalesce(sum(mrr_cents) filter (where channel::text in (${BEACON_CHANNEL_LIST})), 0) as beacon
    from subscriptions where organization_id = ${organizationId} and status in ('ACTIVE','PAST_DUE') ${pf("product_id")}
    group by currency`)
  ).rows as Record<string, unknown>[];

  const eco = (
    await tx.execute(sql`
    select
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'IMPRESSION' and occurred_at >= ${w.start}) as imp,
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'CONVERSION' and occurred_at >= ${w.start}) as conv,
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'IMPRESSION' and occurred_at < ${w.start} and occurred_at >= ${w.prevStart}) as imp_prev,
      (select count(*) from cross_sell_events where organization_id = ${organizationId} and type = 'CONVERSION' and occurred_at < ${w.start} and occurred_at >= ${w.prevStart}) as conv_prev,
      (select count(*) from (select identity_id from identity_products where organization_id = ${organizationId} and status in ('ACTIVE','TRIALING') group by identity_id having count(*) >= 2) m) as multi`)
  ).rows[0] as Record<string, unknown>;

  const content = (
    await tx.execute(sql`
    select count(*) filter (where published_version_id is not null) as published,
      count(*) filter (where published_version_id is not null and published_at >= ${w.start}) as published_now,
      count(*) filter (where published_version_id is not null and published_at < ${w.start} and published_at >= ${w.prevStart}) as published_prev
    from content_assets where organization_id = ${organizationId} ${pf("product_id")}`)
  ).rows[0] as Record<string, unknown>;

  const a = await availability(tx, organizationId, r.productId ?? null);
  const hasSearch = n(vis.has_search) > 0 || a.searchData;
  const states = {
    search: state(a.searchConnected, hasSearch),
    ga4: state(a.ga4Connected, a.ga4Data || n(vis.has_ga) > 0),
    tracker: state(a.trackerKey, a.events),
    revenue: state(a.revenueConnected, a.revenue),
    ai: state(a.aiConfigured, a.aiTests),
    audit: a.audits ? ("OK" as const) : ("NO_DATA_YET" as const),
    crossSell: state(a.crossSellRules, a.crossSellEvents),
    identities: state(a.identities, a.identities),
  };
  const k = (st: KpiState, now: unknown, prev: unknown, source: string, href: string): Kpi => (st === "OK" ? { state: st, now: n(now), prev: prev === null ? null : n(prev), source } : { state: st, now: null, prev: null, source, href });
  const rateKpi = (st: KpiState, now: number | null, prev: number | null, source: string, href: string): Kpi => (st === "OK" ? { state: st, now, prev, source } : { state: st, now: null, prev: null, source, href });
  const rate = (x: unknown, y: unknown) => (n(y) > 0 ? n(x) / n(y) : null);
  // Currencies ever seen for this scope: a measured zero is shown in each of them.
  const currencies = a.currencies;
  const money = (st: KpiState, rows: Record<string, unknown>[], nowCol: string, prevCol: string | null, source: string, href: string): Kpi => {
    if (st !== "OK") return { state: st, now: null, prev: null, source, href, currency: null, byCurrency: [] };
    const byCurrency = currencies.map((c) => {
      const row = rows.find((x) => x.currency === c);
      return { currency: c, now: n(row?.[nowCol]), prev: prevCol ? n(row?.[prevCol]) : null };
    });
    const single = byCurrency.length === 1 ? byCurrency[0] : null;
    return { state: st, now: single ? single.now : null, prev: single ? single.prev : null, source, currency: single?.currency ?? null, byCurrency };
  };
  const arrRows = mrrRows.map((x) => ({ currency: x.currency, arr: n(x.total) * 12 }));

  return {
    /** The single currency of this scope, or null (none yet, or several: use each money KPI's `byCurrency`). */
    currency: currencies.length === 1 ? currencies[0] : null,
    currencies,
    discovery: {
      organicImpressions: k(states.search, vis.imp_now, vis.imp_prev, "Search Console / Bing", "/settings/integrations"),
      organicClicks: k(states.search, vis.clk_now, vis.clk_prev, "Search Console / Bing", "/settings/integrations"),
      indexedPages: k(states.audit, indexed.n, null, states.audit === "OK" ? "Latest technical audit (indexable pages)" : "Technical audit not run yet", "/discovery"),
      coveredQueries: { state: "OK", now: n(q.covered), prev: null, source: `of ${n(q.active)} active queries` } as Kpi,
      brandedImpressions: k(states.search === "OK" && n(branded.rows) === 0 ? "NO_DATA_YET" : states.search, branded.now, branded.prev, "Search Console / Bing (daily query rows containing product names)", "/settings/integrations"),
      /** First-party AI referrals (Beacon tracker). GA4's own count is reported separately, never added. */
      aiReferrals: k(states.tracker, ev.ai_now, ev.ai_prev, "Beacon tracker (AI-assistant referrers)", a.trackerHref),
      aiReferralSessionsGa4: k(states.ga4, vis.ai_ga_now, vis.ai_ga_prev, "GA4 sessions from AI-assistant referrers", "/settings/integrations"),
      aiMentions: k(states.ai, mentions.now, mentions.prev, "Sampled AI tests (observations, not totals)", "/ai-visibility"),
    },
    acquisition: {
      visitors: k(states.tracker, ev.visitors_now, ev.visitors_prev, "Beacon tracker", a.trackerHref),
      signups: k(states.tracker, ev.signups_now, ev.signups_prev, "Beacon events", a.trackerHref),
      trials: k(states.tracker, ev.trials_now, ev.trials_prev, "Beacon events", a.trackerHref),
      activations: k(states.tracker, ev.act_now, ev.act_prev, "Beacon events", a.trackerHref),
    },
    revenue: {
      newSubscriptions: k(states.revenue, revCounts.new_now, revCounts.new_prev, "Revenue events", "/settings/integrations"),
      revenue: money(states.revenue, revRows, "rev_now", "rev_prev", "Revenue events", "/settings/integrations"),
      beaconNewMrr: money(states.revenue, revRows, "beacon_mrr_new_now", "beacon_mrr_new_prev", `New MRR from ${BEACON_CHANNELS.join(", ")}`, "/settings/integrations"),
      mrr: money(states.revenue, mrrRows, "total", null, "Active subscriptions", "/settings/integrations"),
      beaconMrr: money(states.revenue, mrrRows, "beacon", null, "Active subscriptions acquired via Beacon channels", "/settings/integrations"),
      arr: money(states.revenue, arrRows, "arr", null, "MRR × 12", "/settings/integrations"),
      conversionRate: rateKpi(states.tracker, rate(ev.subs_now, ev.visitors_now), rate(ev.subs_prev, ev.visitors_prev), "Subscriptions started ÷ visitors", a.trackerHref),
    },
    ecosystem: {
      crossSellRate: rateKpi(states.crossSell, rate(eco.conv, eco.imp), rate(eco.conv_prev, eco.imp_prev), "Cross-sell conversions ÷ impressions", "/autopilot#cross-sell"),
      multiProductUsers: k(states.identities, eco.multi, null, "Identities active in ≥ 2 products", a.trackerHref),
      referralConversions: k(states.revenue, revCounts.ref_conv_now, revCounts.ref_conv_prev, "New subscriptions attributed to referral/affiliate", "/settings/integrations"),
      affiliateRevenue: money(states.revenue, revRows, "aff_now", "aff_prev", "Revenue attributed to affiliates", "/settings/integrations"),
    },
    content: {
      published: { state: "OK", now: n(content.published), prev: null, source: "Published assets (all time)" } as Kpi,
      publishedInPeriod: { state: "OK", now: n(content.published_now), prev: n(content.published_prev), source: "Assets published in period" } as Kpi,
    },
  };
}

const state = (connected: boolean, hasData: boolean): KpiState => (hasData ? "OK" : connected ? "NO_DATA_YET" : "NOT_CONNECTED");
const typeList = (step: CanonicalEvent) => sql.join(eventTypesFor(step).map((t) => sql`${t}`), sql`, `);

/**
 * What is connected and what has ever been received, for an organisation or
 * one product (all time, not the KPI window). Integrations count when their
 * status is CONNECTED, ERROR or EXPIRED (connected but possibly failing);
 * NOT_CONNECTED and DISABLED do not.
 */
export async function availability(tx: Tx, organizationId: string, productId: string | null) {
  const p = (col: string): SQL => (productId ? sql`and ${sql.raw(col)} = ${productId}` : sql``);
  // Product-agnostic integrations and keys (product_id null) serve every product of the organisation.
  const pOrAll = (col: string): SQL => (productId ? sql`and (${sql.raw(col)} = ${productId} or ${sql.raw(col)} is null)` : sql``);
  const live = sql`status::text in ('CONNECTED', 'ERROR', 'EXPIRED')`;
  const row = (
    await tx.execute(sql`
    select
      exists(select 1 from integrations where organization_id = ${organizationId} and provider in ('GOOGLE_SEARCH_CONSOLE','BING_WEBMASTER') and ${live} ${pOrAll("product_id")}) as search_connected,
      exists(select 1 from search_daily where organization_id = ${organizationId} ${p("product_id")}) as search_data,
      exists(select 1 from integrations where organization_id = ${organizationId} and provider = 'GOOGLE_ANALYTICS' and ${live} ${pOrAll("product_id")}) as ga4_connected,
      exists(select 1 from analytics_daily where organization_id = ${organizationId} ${p("product_id")}) as ga4_data,
      exists(select 1 from api_keys where organization_id = ${organizationId} and revoked_at is null ${pOrAll("product_id")}) as tracker_key,
      exists(select 1 from conversion_events where organization_id = ${organizationId} ${p("product_id")}) as events,
      (exists(select 1 from integrations where organization_id = ${organizationId} and provider = 'STRIPE' and ${live})
        or exists(select 1 from api_keys where organization_id = ${organizationId} and revoked_at is null and kind = 'SECRET' and 'revenue:write' = any(scopes) ${pOrAll("product_id")})) as revenue_connected,
      (exists(select 1 from revenue_events where organization_id = ${organizationId} ${p("product_id")})
        or exists(select 1 from subscriptions where organization_id = ${organizationId} ${p("product_id")})) as revenue,
      (exists(select 1 from integrations where organization_id = ${organizationId} and provider in ('ANTHROPIC','OPENAI','PERPLEXITY') and ${live})
        or exists(select 1 from ai_visibility_prompts where organization_id = ${organizationId} and active ${pOrAll("product_id")})) as ai_configured,
      exists(select 1 from ai_visibility_tests t join ai_visibility_prompts pr on pr.id = t.prompt_id where t.organization_id = ${organizationId} ${pOrAll("pr.product_id")}) as ai_tests,
      exists(select 1 from seo_audits where organization_id = ${organizationId} and status = 'SUCCEEDED' ${p("product_id")}) as audits,
      exists(select 1 from cross_sell_rules where organization_id = ${organizationId} ${productId ? sql`and (source_product_id = ${productId} or destination_product_id = ${productId})` : sql``}) as cross_sell_rules,
      exists(select 1 from cross_sell_events where organization_id = ${organizationId}) as cross_sell_events,
      exists(select 1 from identities where organization_id = ${organizationId}) as identities,
      (select slug from products where organization_id = ${organizationId} ${productId ? sql`and id = ${productId}` : sql``} order by name limit 1) as tracker_slug`)
  ).rows[0] as Record<string, unknown>;
  const currencies = (
    await tx.execute<{ currency: string }>(sql`
    select currency from revenue_events where organization_id = ${organizationId} ${p("product_id")}
    union select currency from subscriptions where organization_id = ${organizationId} ${p("product_id")}
    order by 1`)
  ).rows.map((x) => x.currency);
  const b = (k: string) => row[k] === true || row[k] === "t";
  return {
    searchConnected: b("search_connected"),
    searchData: b("search_data"),
    ga4Connected: b("ga4_connected"),
    ga4Data: b("ga4_data"),
    trackerKey: b("tracker_key"),
    events: b("events"),
    revenueConnected: b("revenue_connected"),
    revenue: b("revenue"),
    aiConfigured: b("ai_configured"),
    aiTests: b("ai_tests"),
    audits: b("audits"),
    crossSellRules: b("cross_sell_rules"),
    crossSellEvents: b("cross_sell_events"),
    identities: b("identities"),
    currencies,
    trackerHref: row.tracker_slug ? `/products/${String(row.tracker_slug)}/tracking` : "/products",
  };
}

export type Kpis = Awaited<ReturnType<typeof kpis>>;

/**
 * Daily visitors, signups, subscriptions and AI-referred visitors over the
 * last `days` days: one scan of the window grouped by day (FILTER aggregates),
 * left-joined to generate_series so days without events read 0.
 */
export async function dailySeries(tx: Tx, organizationId: string, days: number, productId?: string | null) {
  const pf = productId ? sql`and e.product_id = ${productId}` : sql``;
  const r = await tx.execute<{ day: string; visitors: number; signups: number; subs: number; ai: number }>(sql`
    with agg as (
      select (e.occurred_at)::date as d,
        count(distinct e.visitor_id) filter (where e.type = 'PAGE_VIEW') as visitors,
        count(*) filter (where e.type::text in (${typeList("SIGNUP_COMPLETED")})) as signups,
        count(*) filter (where e.type::text in (${typeList("SUBSCRIPTION_STARTED")})) as subs,
        count(distinct e.visitor_id) filter (where e.type = 'PAGE_VIEW' and e.channel = 'AI_REFERRAL') as ai
      from conversion_events e
      where e.organization_id = ${organizationId}
        and e.occurred_at >= (current_date - ${days - 1}::int)::timestamp
        and e.occurred_at < (current_date + 1)::timestamp
        ${pf}
      group by 1
    )
    select to_char(g.d, 'YYYY-MM-DD') as day,
      coalesce(agg.visitors, 0)::int as visitors, coalesce(agg.signups, 0)::int as signups,
      coalesce(agg.subs, 0)::int as subs, coalesce(agg.ai, 0)::int as ai
    from generate_series(current_date - ${days - 1}::int, current_date, interval '1 day') g(d)
    left join agg on agg.d = g.d::date
    order by g.d`);
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

/** Canonical event name of a stored type (legacy names mapped), as SQL. */
const canonicalSql = (col: SQL) => sql`case ${col}::text ${sql.join(Object.entries(LEGACY_ALIASES).map(([l, c]) => sql`when ${l} then ${c}`), sql` `)} else ${col}::text end`;

/**
 * Cohort funnel: people first seen (first event ever, all time) inside the
 * last `days`, and how many of them reached each step since. A person is the
 * tracker visitor; server events that only carry an identity are joined to
 * that identity's first known visitor, else counted by identity. With
 * `channel`, the cohort is restricted to people whose first event was
 * attributed to that channel.
 */
export async function funnelCounts(tx: Tx, organizationId: string, days: number, productId?: string | null, channel?: string | null) {
  const r = await tx.execute<{ type: string; n: number }>(sql`
    with ev as (
      select ${canonicalSql(sql`e.type`)} as type, e.occurred_at, e.channel::text as channel,
        coalesce(e.visitor_id, iv.visitor_id, e.identity_id::text) as person
      from conversion_events e
      left join lateral (
        select v.visitor_id from conversion_events v
        where v.organization_id = e.organization_id and v.identity_id = e.identity_id and v.visitor_id is not null
        order by v.occurred_at limit 1) iv on e.visitor_id is null and e.identity_id is not null
      where e.organization_id = ${organizationId} and (e.visitor_id is not null or e.identity_id is not null)
      ${productId ? sql`and e.product_id = ${productId}` : sql``}
    ),
    cohort as (
      select person from ev group by person
      having min(occurred_at) >= now() - make_interval(days => ${days})
      ${channel ? sql`and (array_agg(channel order by occurred_at))[1] = ${channel}` : sql``}
    )
    select ev.type, count(distinct ev.person)::int as n from ev join cohort using (person) group by ev.type`);
  return Object.fromEntries(r.rows.map((x) => [x.type, Number(x.n)]));
}

export async function contentPerformance(tx: Tx, organizationId: string, days: number) {
  const r = await tx.execute<{ id: string; title: string; type: string; path: string | null; product: string | null; views: number; cta: number; signups: number }>(sql`
    select a.id, a.title, a.type::text, pg.path, pr.slug as product,
      coalesce(sum(case when e.type = 'PAGE_VIEW' then 1 else 0 end), 0)::int as views,
      coalesce(sum(case when e.type = 'CTA_CLICK' then 1 else 0 end), 0)::int as cta,
      coalesce(sum(case when e.type::text in (${typeList("SIGNUP_COMPLETED")}) then 1 else 0 end), 0)::int as signups
    from content_assets a
    left join pages pg on pg.id = a.page_id
    left join products pr on pr.id = a.product_id
    left join conversion_events e on e.organization_id = a.organization_id and e.product_id = a.product_id and e.page_path = pg.path and e.occurred_at >= now() - make_interval(days => ${days})
    where a.organization_id = ${organizationId} and a.published_version_id is not null
    group by a.id, a.title, a.type, pg.path, pr.slug order by views desc`);
  return r.rows.map((x) => ({ ...x, views: Number(x.views), cta: Number(x.cta), signups: Number(x.signups) }));
}

/** Visitors, signups and subscriptions per acquisition channel over the last `days`. */
export async function conversionsByChannel(tx: Tx, organizationId: string, days: number, productId?: string | null) {
  const productFilter = productId ? sql`and product_id = ${productId}` : sql``;
  const r = await tx.execute<{ channel: string; visitors: number; signups: number; subs: number }>(sql`
      select coalesce(channel::text, 'UNCLASSIFIED') as channel,
        count(distinct visitor_id) filter (where type = 'PAGE_VIEW')::int as visitors,
        count(*) filter (where type::text in (${typeList("SIGNUP_COMPLETED")}))::int as signups,
        count(*) filter (where type::text in (${typeList("SUBSCRIPTION_STARTED")}))::int as subs
      from conversion_events
      where organization_id = ${organizationId} and occurred_at >= now() - make_interval(days => ${days}) ${productFilter}
      group by 1 order by 2 desc, 3 desc`);
  return r.rows.map((x) => ({ channel: x.channel, visitors: Number(x.visitors), signups: Number(x.signups), subs: Number(x.subs) }));
}

/** True once the organisation has received at least one first-party event. */
export async function hasConversionEvents(tx: Tx, organizationId: string) {
  const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from (select 1 from conversion_events where organization_id = ${organizationId} limit 1) x`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}
