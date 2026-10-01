import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { AttributionModel } from "@/core/attribution/attribution";

export type ConversionFilter = { days: number; productId?: string | null; model: AttributionModel };

/**
 * Credited totals per channel for one attribution model: conversions (sum of
 * credit weights, so a multi-touch conversion is split across channels) and
 * revenue per currency (credited amounts; currencies never added together).
 */
export async function creditedTotals(tx: Tx, organizationId: string, f: ConversionFilter) {
  const pf = f.productId ? sql`and c.product_id = ${f.productId}` : sql``;
  const conv = await tx.execute<{ channel: string; conversions: number; events: number }>(sql`
    select coalesce(c.channel::text, 'UNATTRIBUTED') as channel, sum(c.weight)::float as conversions, count(distinct c.conversion_event_id)::int as events
    from attribution_credits c
    where c.organization_id = ${organizationId} and c.model = ${f.model} and c.conversion_event_id is not null
      and c.occurred_at >= now() - make_interval(days => ${f.days}) ${pf}
    group by 1 order by 2 desc`);
  const rev = await tx.execute<{ channel: string; currency: string; cents: number }>(sql`
    select coalesce(c.channel::text, 'UNATTRIBUTED') as channel, c.currency, sum(c.value_cents)::bigint as cents
    from attribution_credits c
    where c.organization_id = ${organizationId} and c.model = ${f.model} and c.revenue_event_id is not null and c.currency is not null
      and c.occurred_at >= now() - make_interval(days => ${f.days}) ${pf}
    group by 1, 2 order by 3 desc`);
  const channels = new Map<string, { channel: string; conversions: number; revenue: { currency: string; cents: number }[] }>();
  for (const r of conv.rows) channels.set(r.channel, { channel: r.channel, conversions: Number(r.conversions), revenue: [] });
  for (const r of rev.rows) {
    const e = channels.get(r.channel) ?? { channel: r.channel, conversions: 0, revenue: [] };
    e.revenue.push({ currency: r.currency, cents: Number(r.cents) });
    channels.set(r.channel, e);
  }
  return [...channels.values()].sort((a, b) => b.conversions - a.conversions);
}

export type ConversionRow = {
  id: string;
  type: string;
  occurredAt: string;
  product: string | null;
  channel: string | null;
  rule: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  campaignName: string | null;
  landingUrl: string | null;
  referrerHost: string | null;
  firstTouch: { channel: string; at: string; referrerHost: string | null; source: string | null } | null;
  lastTouch: { channel: string; at: string; referrerHost: string | null; source: string | null } | null;
  credits: { channel: string; weight: number }[];
  value: { currency: string; cents: number }[];
};

/**
 * One row per conversion (every event type except page views and CTA
 * clicks), newest first, with its persisted attribution: UTM, landing page,
 * first touch, the touch credited by the persisted single-touch rule, the
 * credits under `model`, and the measured revenue of the same person in the
 * same product (per currency).
 */
export async function conversionList(tx: Tx, organizationId: string, f: ConversionFilter & { page: number; pageSize: number }) {
  const pf = f.productId ? sql`and e.product_id = ${f.productId}` : sql``;
  const base = sql`from conversion_events e
    where e.organization_id = ${organizationId} and e.type::text not in ('PAGE_VIEW', 'CTA_CLICK', 'PRODUCT_VIEWED')
      and e.occurred_at >= now() - make_interval(days => ${f.days}) ${pf}`;
  const total = Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n ${base}`)).rows[0]?.n ?? 0);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select e.id, e.type::text as type, e.occurred_at, p.name as product, e.channel::text as channel, e.attribution_rule as rule,
      e.utm->>'source' as source, e.utm->>'medium' as medium, e.utm->>'campaign' as campaign, cp.name as campaign_name,
      e.landing_url, e.referrer_host,
      ft.channel::text as ft_channel, ft.occurred_at as ft_at, ft.referrer_host as ft_ref, ft.utm->>'utm_source' as ft_source,
      lt.channel::text as lt_channel, lt.occurred_at as lt_at, lt.referrer_host as lt_ref, lt.utm->>'utm_source' as lt_source,
      (select coalesce(json_agg(json_build_object('channel', coalesce(c.channel::text, 'UNATTRIBUTED'), 'weight', c.weight) order by c.weight desc), '[]'::json)
         from attribution_credits c where c.conversion_event_id = e.id and c.model = ${f.model}) as credits,
      (select coalesce(json_agg(json_build_object('currency', x.currency, 'cents', x.cents)), '[]'::json) from (
         select r.currency, sum(r.amount_cents)::bigint as cents from revenue_events r
         where e.identity_id is not null and r.organization_id = e.organization_id and r.identity_id = e.identity_id and r.product_id = e.product_id
         group by r.currency) x) as value
    from conversion_events e
    left join products p on p.id = e.product_id
    left join campaigns cp on cp.id = e.campaign_id
    left join attribution_events ft on ft.id = e.first_touch_id
    left join attribution_events lt on lt.id = e.attribution_touch_id
    where e.organization_id = ${organizationId} and e.type::text not in ('PAGE_VIEW', 'CTA_CLICK', 'PRODUCT_VIEWED')
      and e.occurred_at >= now() - make_interval(days => ${f.days}) ${pf}
    order by e.occurred_at desc, e.id
    limit ${f.pageSize} offset ${(Math.max(1, f.page) - 1) * f.pageSize}`);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const touch = (r: Record<string, unknown>, p: "ft" | "lt") => (r[`${p}_channel`] ? { channel: String(r[`${p}_channel`]), at: iso(r[`${p}_at`]), referrerHost: s(r[`${p}_ref`]), source: s(r[`${p}_source`]) } : null);
  const items: ConversionRow[] = rows.rows.map((r) => ({
    id: String(r.id),
    type: String(r.type),
    occurredAt: iso(r.occurred_at),
    product: s(r.product),
    channel: s(r.channel),
    rule: s(r.rule),
    source: s(r.source),
    medium: s(r.medium),
    campaign: s(r.campaign),
    campaignName: s(r.campaign_name),
    landingUrl: s(r.landing_url),
    referrerHost: s(r.referrer_host),
    firstTouch: touch(r, "ft"),
    lastTouch: touch(r, "lt"),
    credits: ((r.credits as { channel: string; weight: number }[]) ?? []).map((c) => ({ channel: c.channel, weight: Number(c.weight) })),
    value: ((r.value as { currency: string; cents: number }[]) ?? []).map((v) => ({ currency: v.currency, cents: Number(v.cents) })),
  }));
  return { total, items, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}
