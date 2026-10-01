import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { queries } from "@/db/schema";
import { eventTypesFor } from "@/core/conversions/events";
import { POSITION_BUCKETS } from "@/core/search/insights";
import { normalizeQuery } from "@/core/util/text";
import { ORG_SCOPE, emptyContext, type AiScope, type ConversionScope, type EstimationContext, type QuerySearch, type ValueScope } from "@/core/estimate/context";
import type { EstimationContext as ImpactContext } from "@/core/estimate/impact";
import { SEARCH_PROVIDERS } from "@/integrations/registry";
import { learningTallies } from "./autopilot-learning";

/** Windows (days) of the estimator inputs. */
export const ESTIMATE_WINDOWS = { curve: 90, queries: 30, conversion: 90, value: 365, ai: 90 } as const;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const list = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const SIGNUP_TYPES = list(eventTypesFor("SIGNUP_COMPLETED"));
const QUERY_GRAIN = sql`query is not null and page is null and country is null and device is null`;

/** SQL bucket of a daily position, matching POSITION_BUCKETS (src/core/search/insights.ts). */
const BUCKET_SQL = sql`case ${sql.join(
  POSITION_BUCKETS.filter((b) => Number.isFinite(b.max)).map((b) => sql`when position < ${b.max} then ${b.key}`),
  sql` `,
)} else ${POSITION_BUCKETS[POSITION_BUCKETS.length - 1].key} end`;

async function loadSearch(tx: Tx, organizationId: string, ctx: EstimationContext) {
  const conn = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from integrations
    where organization_id = ${organizationId} and provider::text in (${list(SEARCH_PROVIDERS)}) and status not in ('DISABLED', 'NOT_CONNECTED')`);
  ctx.search.connected = n(conn.rows[0]?.n) > 0;

  // The organisation's CTR by position bucket (every product), last 90 days of its query rows.
  const curve = await tx.execute<{ bucket: string; clicks: number; impressions: number }>(sql`
    with last as (select max(day) as last from search_daily where organization_id = ${organizationId} and ${QUERY_GRAIN})
    select ${BUCKET_SQL} as bucket, coalesce(sum(clicks), 0)::float as clicks, coalesce(sum(impressions), 0)::float as impressions
    from search_daily, last
    where organization_id = ${organizationId} and ${QUERY_GRAIN} and position is not null
      and day between last.last - ${ESTIMATE_WINDOWS.curve - 1}::int and last.last
    group by 1`);
  ctx.search.curve = curve.rows.map((r) => ({ bucket: r.bucket, clicks: n(r.clicks), impressions: n(r.impressions) }));

  // Per query, the last 30 days of its product's data (each scope ends on its own newest day).
  const rows = await tx.execute<{ product_id: string | null; query: string; clicks: number; impressions: number; pos_sum: number; pos_w: number }>(sql`
    with last as (
      select product_id, max(day) as last from search_daily where organization_id = ${organizationId} and ${QUERY_GRAIN} group by product_id
    )
    select s.product_id, s.query, sum(s.clicks)::float as clicks, sum(s.impressions)::float as impressions,
      coalesce(sum(s.position * s.impressions) filter (where s.position is not null), 0)::float as pos_sum,
      coalesce(sum(s.impressions) filter (where s.position is not null), 0)::float as pos_w
    from search_daily s join last l on l.product_id is not distinct from s.product_id
    where s.organization_id = ${organizationId} and s.query is not null and s.page is null and s.country is null and s.device is null
      and s.day between l.last - ${ESTIMATE_WINDOWS.queries - 1}::int and l.last
    group by s.product_id, s.query`);
  if (!rows.rows.length) return;
  const agg = new Map<string, QuerySearch & { posSum: number; posW: number }>();
  for (const r of rows.rows) {
    const k = `${r.product_id ?? ""}|${normalizeQuery(r.query)}`;
    const cur = agg.get(k) ?? { productId: r.product_id, query: r.query, clicks: 0, impressions: 0, position: null, posSum: 0, posW: 0 };
    cur.clicks += n(r.clicks);
    cur.impressions += n(r.impressions);
    cur.posSum += n(r.pos_sum);
    cur.posW += n(r.pos_w);
    agg.set(k, cur);
  }
  const tracked = await tx
    .select({ id: queries.id, productId: queries.productId, normalized: queries.normalized })
    .from(queries)
    .where(and(eq(queries.organizationId, organizationId), ne(queries.status, "ARCHIVED")));
  for (const q of tracked) {
    const m = agg.get(`${q.productId ?? ""}|${q.normalized}`);
    if (m) ctx.search.queries[q.id] = { productId: m.productId, query: m.query, clicks: m.clicks, impressions: m.impressions, position: m.posW > 0 ? m.posSum / m.posW : null };
  }
}

/**
 * Tracked people (same identity resolution as `funnelCounts`): a server event
 * that only carries an identity joins that identity's first visitor. A person
 * is in the window when first seen in it; their channel is the channel of
 * their first event. Visitors have a page view; converters also signed up.
 */
async function loadConversion(tx: Tx, organizationId: string, ctx: EstimationContext) {
  const any = await tx.execute<{ n: number }>(sql`select count(*)::int as n from (select 1 from conversion_events where organization_id = ${organizationId} limit 1) x`);
  ctx.conversion.tracked = n(any.rows[0]?.n) > 0;
  if (!ctx.conversion.tracked) return;
  for (const byProduct of [true, false]) {
    const group = byProduct ? sql`product_id, person` : sql`person`;
    const r = await tx.execute<{ product_id: string | null; channel: string; visitors: number; converters: number }>(sql`
      with ev as (
        select e.product_id, e.type::text as type, e.occurred_at, e.channel::text as channel,
          coalesce(e.visitor_id, iv.visitor_id, e.identity_id::text) as person
        from conversion_events e
        left join lateral (
          select v.visitor_id from conversion_events v
          where v.organization_id = e.organization_id and v.identity_id = e.identity_id and v.visitor_id is not null
          order by v.occurred_at limit 1) iv on e.visitor_id is null and e.identity_id is not null
        where e.organization_id = ${organizationId} and (e.visitor_id is not null or e.identity_id is not null)
      ),
      people as (
        select ${byProduct ? sql`product_id` : sql`null::uuid as product_id`}, person,
          (array_agg(channel order by occurred_at))[1] as channel,
          bool_or(type = 'PAGE_VIEW') as viewed,
          bool_or(type in (${SIGNUP_TYPES})) as signed
        from ev group by ${group}
        having min(occurred_at) >= now() - make_interval(days => ${ESTIMATE_WINDOWS.conversion})
      )
      select product_id, coalesce(channel, 'UNCLASSIFIED') as channel,
        count(*) filter (where viewed)::int as visitors, count(*) filter (where viewed and signed)::int as converters
      from people group by 1, 2`);
    for (const row of r.rows) {
      const key = byProduct ? (row.product_id ?? ORG_SCOPE) : ORG_SCOPE;
      if (byProduct && !row.product_id) continue;
      const scope: ConversionScope = ctx.conversion.byScope[key] ?? { all: { visitors: 0, converters: 0 }, byChannel: {} };
      const v = n(row.visitors);
      const c = n(row.converters);
      scope.all.visitors += v;
      scope.all.converters += c;
      const ch = scope.byChannel[row.channel] ?? { visitors: 0, converters: 0 };
      ch.visitors += v;
      ch.converters += c;
      scope.byChannel[row.channel] = ch;
      ctx.conversion.byScope[key] = scope;
    }
  }
}

/**
 * Converting identities (a signup in the last 365 days) and the net revenue
 * to date of those who paid, per currency (never converted). Product scope:
 * signups and revenue of that product; organisation scope: any product.
 */
async function loadValue(tx: Tx, organizationId: string, ctx: EstimationContext) {
  const any = await tx.execute<{ n: number }>(sql`select count(*)::int as n from (select 1 from revenue_events where organization_id = ${organizationId} limit 1) x`);
  ctx.value.connected = n(any.rows[0]?.n) > 0;
  if (!ctx.value.connected) return;
  for (const byProduct of [true, false]) {
    const conv = sql`
      select distinct ${byProduct ? sql`product_id` : sql`null::uuid as product_id`}, identity_id from conversion_events
      where organization_id = ${organizationId} and identity_id is not null and type::text in (${SIGNUP_TYPES})
        and occurred_at >= now() - make_interval(days => ${ESTIMATE_WINDOWS.value})`;
    const counts = await tx.execute<{ product_id: string | null; converters: number }>(sql`
      select product_id, count(*)::int as converters from (${conv}) c group by product_id`);
    const paid = await tx.execute<{ product_id: string | null; currency: string; net: number }>(sql`
      with conv as (${conv})
      select c.product_id, r.currency, sum(r.amount_cents)::float as net
      from conv c join revenue_events r on r.organization_id = ${organizationId} and r.identity_id = c.identity_id
        ${byProduct ? sql`and r.product_id = c.product_id` : sql``}
      group by c.product_id, c.identity_id, r.currency
      having sum(r.amount_cents) > 0`);
    const scopeOf = (pid: string | null): ValueScope | null => {
      const key = byProduct ? pid : ORG_SCOPE;
      if (!key) return null;
      return (ctx.value.byScope[key] ??= { converters: 0, byCurrency: {} });
    };
    for (const row of counts.rows) {
      const s = scopeOf(row.product_id);
      if (s) s.converters = n(row.converters);
    }
    for (const row of paid.rows) {
      const s = scopeOf(row.product_id);
      if (s) (s.byCurrency[row.currency.toUpperCase()] ??= []).push(n(row.net));
    }
  }
  for (const s of Object.values(ctx.value.byScope)) for (const v of Object.values(s.byCurrency)) v.sort((a, b) => a - b);
}

async function loadAi(tx: Tx, organizationId: string, ctx: EstimationContext) {
  const any = await tx.execute<{ n: number }>(sql`select count(*)::int as n from (select 1 from ai_visibility_tests where organization_id = ${organizationId} limit 1) x`);
  ctx.ai.tested = n(any.rows[0]?.n) > 0;
  if (!ctx.ai.tested) return;
  const window = sql`t.organization_id = ${organizationId} and t.ran_at >= now() - make_interval(days => ${ESTIMATE_WINDOWS.ai})`;
  const totals = await tx.execute<{ product_id: string | null; samples: number; mentioned: number; org_mentioned: number }>(sql`
    select p.product_id, count(*)::int as samples,
      count(*) filter (where p.product_id is not null and t.products_mentioned @> jsonb_build_array(jsonb_build_object('productId', p.product_id::text)))::int as mentioned,
      count(*) filter (where t.org_mentioned)::int as org_mentioned
    from ai_visibility_tests t join ai_visibility_prompts p on p.id = t.prompt_id
    where ${window} group by p.product_id`);
  const comps = await tx.execute<{ product_id: string | null; id: string; name: string; n: number }>(sql`
    select p.product_id, c.value->>'competitorId' as id, min(c.value->>'name') as name, count(distinct t.id)::int as n
    from ai_visibility_tests t join ai_visibility_prompts p on p.id = t.prompt_id
      cross join lateral jsonb_array_elements(t.competitors_mentioned) c
    where ${window} and c.value->>'competitorId' is not null
    group by p.product_id, c.value->>'competitorId'`);
  const org: AiScope = { samples: 0, mentioned: 0, competitors: [] };
  for (const r of totals.rows) {
    org.samples += n(r.samples);
    org.mentioned += n(r.org_mentioned);
    if (r.product_id) ctx.ai.byScope[r.product_id] = { samples: n(r.samples), mentioned: n(r.mentioned), competitors: [] };
  }
  const orgComp = new Map<string, { id: string; name: string; mentioned: number }>();
  for (const r of comps.rows) {
    if (r.product_id) ctx.ai.byScope[r.product_id]?.competitors.push({ id: r.id, name: r.name, mentioned: n(r.n) });
    const cur = orgComp.get(r.id) ?? { id: r.id, name: r.name, mentioned: 0 };
    cur.mentioned += n(r.n);
    orgComp.set(r.id, cur);
  }
  org.competitors = [...orgComp.values()];
  ctx.ai.byScope[ORG_SCOPE] = org;
}

/**
 * Load every estimator input for one organisation. Sequential queries on
 * `tx` (never concurrent on one transaction); RLS scopes everything to the
 * organisation and every query also filters on it explicitly.
 */
export async function loadEstimationContext(tx: Tx, organizationId: string): Promise<ImpactContext> {
  const ctx = emptyContext(organizationId);
  ctx.search.curveDays = ESTIMATE_WINDOWS.curve;
  ctx.search.windowDays = ESTIMATE_WINDOWS.queries;
  ctx.conversion.windowDays = ESTIMATE_WINDOWS.conversion;
  ctx.value.windowDays = ESTIMATE_WINDOWS.value;
  ctx.ai.windowDays = ESTIMATE_WINDOWS.ai;
  await loadSearch(tx, organizationId, ctx);
  await loadConversion(tx, organizationId, ctx);
  await loadValue(tx, organizationId, ctx);
  ctx.learning = await learningTallies(tx, organizationId);
  await loadAi(tx, organizationId, ctx);
  return ctx;
}
