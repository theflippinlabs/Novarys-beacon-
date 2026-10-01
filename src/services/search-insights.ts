import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations } from "@/db/schema";
import { comparePeriods, ctrOf, deltaPct, lowCtrQueries, positionRange, previousPeriod, toStat, type QueryAgg, type QueryStat } from "@/core/search/insights";
import { SEARCH_PROVIDERS, type SearchProvider } from "@/integrations/registry";

/**
 * Search insights over search_daily (SQL, product-scoped, any range). Each
 * reader selects exactly one row grain (daily totals, query rows or page
 * rows), so the country, device and query x page splits never add up twice.
 */
export type SearchScope = { organizationId: string; productId?: string | null; provider?: SearchProvider | null };
export type DayRange = { start: string; end: string };

const scopeSql = (s: SearchScope): SQL =>
  sql`organization_id = ${s.organizationId} ${s.productId ? sql`and product_id = ${s.productId}` : sql``} ${s.provider ? sql`and provider = ${s.provider}` : sql``}`;

const GRAIN = {
  total: sql`query is null and page is null and country is null and device is null`,
  query: sql`query is not null and page is null and country is null and device is null`,
  page: sql`page is not null and query is null and country is null and device is null`,
} as const;

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Connection and data state for the scope: Not connected, No data yet, or data with its date span. */
export async function searchDataState(tx: Tx, scope: SearchScope) {
  const list = await tx
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.organizationId, scope.organizationId),
        inArray(integrations.provider, scope.provider ? [scope.provider] : [...SEARCH_PROVIDERS]),
        scope.productId ? eq(integrations.productId, scope.productId) : undefined,
      ),
    );
  const span = (
    await tx.execute<{ first: string | null; last: string | null; rows: number }>(sql`
      select min(day)::text as first, max(day)::text as last, count(*)::int as rows from search_daily where ${scopeSql(scope)} and ${GRAIN.total}`)
  ).rows[0];
  const connected = list.filter((i) => i.status !== "DISABLED" && i.status !== "NOT_CONNECTED");
  return {
    integrations: list.map((i) => ({ id: i.id, provider: i.provider as SearchProvider, productId: i.productId, status: i.status, lastSyncAt: i.lastSyncAt, lastSuccessAt: i.lastSuccessAt, lastFailureAt: i.lastFailureAt, backfillDone: i.config._backfillDone ?? null })),
    connected: connected.length > 0,
    hasData: num(span?.rows) > 0,
    firstDay: span?.first ?? null,
    lastDay: span?.last ?? null,
  };
}

export type Totals = { clicks: number; impressions: number; ctr: number | null; position: number | null };

async function totals(tx: Tx, scope: SearchScope, r: DayRange): Promise<Totals> {
  const row = (
    await tx.execute<{ clicks: number; impressions: number; pos_sum: number; pos_w: number }>(sql`
      select coalesce(sum(clicks), 0)::float as clicks, coalesce(sum(impressions), 0)::float as impressions,
        coalesce(sum(position * impressions) filter (where position is not null), 0)::float as pos_sum,
        coalesce(sum(impressions) filter (where position is not null), 0)::float as pos_w
      from search_daily where ${scopeSql(scope)} and ${GRAIN.total} and day between ${r.start}::date and ${r.end}::date`)
  ).rows[0];
  const clicks = num(row?.clicks);
  const impressions = num(row?.impressions);
  return { clicks, impressions, ctr: ctrOf(clicks, impressions), position: num(row?.pos_w) > 0 ? num(row?.pos_sum) / num(row?.pos_w) : null };
}

/** Totals for a range and the previous period of the same length, with deltas. */
export async function searchTotals(tx: Tx, scope: SearchScope, range: DayRange) {
  const prevRange = previousPeriod(range);
  const now = await totals(tx, scope, range);
  const prev = await totals(tx, scope, prevRange);
  return {
    range,
    prevRange,
    now,
    prev,
    delta: { clicks: deltaPct(now.clicks, prev.clicks), impressions: deltaPct(now.impressions, prev.impressions) },
  };
}

/** Per-key aggregates for a period and its previous period in one pass (query or page grain). */
async function periodStats(tx: Tx, scope: SearchScope, grain: "query" | "page", range: DayRange, opts: { minImpressions: number; limit?: number }) {
  const prev = previousPeriod(range);
  const col = grain === "query" ? sql.raw("query") : sql.raw("page");
  const cur = sql`day >= ${range.start}::date`;
  const res = await tx.execute<{ key: string; c_now: number; i_now: number; ps_now: number; pw_now: number; c_prev: number; i_prev: number; ps_prev: number; pw_prev: number }>(sql`
    select ${col} as key,
      coalesce(sum(clicks) filter (where ${cur}), 0)::float as c_now,
      coalesce(sum(impressions) filter (where ${cur}), 0)::float as i_now,
      coalesce(sum(position * impressions) filter (where ${cur} and position is not null), 0)::float as ps_now,
      coalesce(sum(impressions) filter (where ${cur} and position is not null), 0)::float as pw_now,
      coalesce(sum(clicks) filter (where not (${cur})), 0)::float as c_prev,
      coalesce(sum(impressions) filter (where not (${cur})), 0)::float as i_prev,
      coalesce(sum(position * impressions) filter (where not (${cur}) and position is not null), 0)::float as ps_prev,
      coalesce(sum(impressions) filter (where not (${cur}) and position is not null), 0)::float as pw_prev
    from search_daily
    where ${scopeSql(scope)} and ${GRAIN[grain]} and day between ${prev.start}::date and ${range.end}::date
    group by ${col}
    having greatest(coalesce(sum(impressions) filter (where ${cur}), 0), coalesce(sum(impressions) filter (where not (${cur})), 0)) >= ${Math.max(1, Math.min(opts.minImpressions, 5))}
    order by greatest(coalesce(sum(impressions) filter (where ${cur}), 0), coalesce(sum(impressions) filter (where not (${cur})), 0)) desc
    limit ${opts.limit ?? 20000}`);
  const now: QueryStat[] = [];
  const before: QueryStat[] = [];
  for (const r of res.rows) {
    const a: QueryAgg = { key: r.key, clicks: num(r.c_now), impressions: num(r.i_now), positionSum: num(r.ps_now), positionWeight: num(r.pw_now) };
    const b: QueryAgg = { key: r.key, clicks: num(r.c_prev), impressions: num(r.i_prev), positionSum: num(r.ps_prev), positionWeight: num(r.pw_prev) };
    if (a.impressions > 0 || a.clicks > 0) now.push(toStat(a));
    if (b.impressions > 0 || b.clicks > 0) before.push(toStat(b));
  }
  return { now, prev: before };
}

/** Default impressions threshold for movement and CTR insights, by range length. */
export function defaultMinImpressions(range: DayRange): number {
  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
  return days <= 7 ? 10 : days <= 31 ? 20 : 50;
}

export const LOW_CTR_METHOD =
  "Expected CTR = median CTR of this organisation's queries in the same position bucket (1, 2, 3, 4-5, 6-10, 11-20, 21+) over the same period; buckets with fewer than 5 queries are not used.";

/** Every insight for one scope and range. */
export async function searchInsights(tx: Tx, scope: SearchScope, range: DayRange, opts: { minImpressions?: number; limit?: number } = {}) {
  const minImpressions = opts.minImpressions ?? defaultMinImpressions(range);
  const limit = opts.limit ?? 25;
  const t = await searchTotals(tx, scope, range);
  const q = await periodStats(tx, scope, "query", range, { minImpressions });
  const p = await periodStats(tx, scope, "page", range, { minImpressions });
  // CTR expectation from the organisation's own data (all its products, same provider and period).
  const baseline = scope.productId ? (await periodStats(tx, { ...scope, productId: null }, "query", range, { minImpressions })).now : q.now;
  const queries = comparePeriods(q.now, q.prev, { minImpressions, limit });
  const pages = comparePeriods(p.now, p.prev, { minImpressions, limit });
  return {
    totals: t,
    minImpressions,
    queryCount: q.now.length,
    growingQueries: queries.growing,
    decliningQueries: queries.declining,
    newQueries: queries.added,
    lostQueries: queries.lost,
    lowCtr: lowCtrQueries(q.now, { minImpressions, limit, baseline }),
    lowCtrMethod: LOW_CTR_METHOD,
    strikingDistance: positionRange(q.now, { min: 4, max: 15, minImpressions, limit }),
    newPages: pages.added,
    decliningPages: pages.declining,
  };
}

export type QueryMetric = { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null };

/**
 * Per-query metrics for the last `days` days of available data (ending on the
 * newest day imported for the product). Clicks and impressions are summed
 * from daily query rows; position is impressions-weighted. Used by the
 * opportunity engine and metrics.
 */
export async function latestQueryMetrics(tx: Tx, organizationId: string, productId: string, days: number, opts: { provider?: SearchProvider | null } = {}): Promise<QueryMetric[]> {
  const scope: SearchScope = { organizationId, productId, provider: opts.provider ?? null };
  const last = (await tx.execute<{ last: string | null }>(sql`select max(day)::text as last from search_daily where ${scopeSql(scope)} and ${GRAIN.query}`)).rows[0]?.last;
  if (!last) return [];
  const start = new Date(Date.parse(`${last}T00:00:00Z`) - (Math.max(1, days) - 1) * 86_400_000).toISOString().slice(0, 10);
  const res = await tx.execute<{ query: string; clicks: number; impressions: number; pos_sum: number; pos_w: number }>(sql`
    select query, sum(clicks)::float as clicks, sum(impressions)::float as impressions,
      coalesce(sum(position * impressions) filter (where position is not null), 0)::float as pos_sum,
      coalesce(sum(impressions) filter (where position is not null), 0)::float as pos_w
    from search_daily where ${scopeSql(scope)} and ${GRAIN.query} and day between ${start}::date and ${last}::date
    group by query order by sum(impressions) desc, query limit 5000`);
  return res.rows.map((r) => ({
    query: r.query,
    clicks: num(r.clicks),
    impressions: num(r.impressions),
    ctr: ctrOf(num(r.clicks), num(r.impressions)),
    position: num(r.pos_w) > 0 ? num(r.pos_sum) / num(r.pos_w) : null,
  }));
}
