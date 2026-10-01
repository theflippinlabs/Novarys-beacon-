import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, organizations, products, queries, queryClusters, searchDaily, type QueryClassificationMeta } from "@/db/schema";
import { audit, type Actor } from "@/lib/audit";
import { loadProductGraph } from "@/core/knowledge/load";
import type { ProductGraph } from "@/core/knowledge/types";
import { classifyQueryFull, INTENT_TO_FUNNEL, type Intent, type TopicContext, type TopicType } from "@/core/queries/classify";
import { clusterQueries } from "@/core/queries/cluster";
import { expandQueryUniverse } from "@/core/queries/expand";
import type { SearchPairRef } from "@/core/queries/coverage";
import { normalizeQuery, slugify } from "@/core/util/text";
import { latestQueryMetrics } from "./search-insights";
import { isSearchProvider } from "@/integrations/registry";

export async function ensureCluster(tx: Tx, organizationId: string, productId: string | null, name: string) {
  const slug = slugify(name) || "general";
  const existing = await tx.query.queryClusters.findFirst({
    where: and(eq(queryClusters.organizationId, organizationId), productId ? eq(queryClusters.productId, productId) : isNull(queryClusters.productId), eq(queryClusters.slug, slug)),
  });
  if (existing) return existing;
  const [c] = await tx.insert(queryClusters).values({ organizationId, productId, name, slug, origin: "MANUAL" }).onConflictDoNothing().returning();
  return c ?? (await tx.query.queryClusters.findFirst({ where: and(eq(queryClusters.organizationId, organizationId), eq(queryClusters.slug, slug)) }))!;
}

export type NewQuery = {
  query: string;
  productId: string | null;
  intent?: Intent;
  importance?: number;
  market?: string;
  language?: string;
  clusterName?: string;
  notes?: string;
  status?: "CANDIDATE" | "ACTIVE";
  source?: "MANUAL" | "GENERATED" | "IMPORTED" | "SEARCH_CONSOLE";
  brandTerms?: string[];
  /** Topic type known from provenance (generation template); otherwise classified. */
  topicType?: TopicType;
  topic?: Omit<TopicContext, "brandTerms">;
};

const EMPTY_TOPIC: Omit<TopicContext, "brandTerms"> = { competitors: [], facets: [] };

function buildRow(organizationId: string, q: NewQuery, clusterId: string | null) {
  const normalized = normalizeQuery(q.query);
  if (!normalized || normalized.length > 200) throw new Error("Query must be 1 to 200 characters");
  const cls = classifyQueryFull(normalized, { brandTerms: q.brandTerms ?? [], ...(q.topic ?? EMPTY_TOPIC) });
  const intent = q.intent ?? cls.intent;
  const source = q.source ?? "MANUAL";
  const classification: QueryClassificationMeta = {
    source: q.topicType ? "generation" : source === "SEARCH_CONSOLE" ? "search_import" : q.intent && source === "MANUAL" ? "manual" : "rules",
    intentSignals: q.intent ? [`given:${q.intent.toLowerCase()}`] : cls.signals,
    topicSignals: q.topicType ? [`provenance:${q.topicType.toLowerCase()}`] : cls.topicSignals,
    brandTerm: cls.brandTerm,
  };
  return {
    organizationId,
    productId: q.productId,
    clusterId,
    query: q.query.trim(),
    normalized,
    intent,
    intentConfidence: q.intent ? 1 : cls.confidence,
    funnelStage: INTENT_TO_FUNNEL[intent],
    importance: Math.min(5, Math.max(1, q.importance ?? 3)),
    market: q.market || "global",
    language: q.language || "en",
    status: q.status ?? "ACTIVE",
    source,
    branded: cls.branded,
    topicType: q.topicType ?? cls.topicType,
    classification,
    notes: q.notes,
  };
}

/** Insert a query (idempotent on product + normalized text + language + market). Returns null when it already existed. */
export async function addQuery(tx: Tx, organizationId: string, q: NewQuery) {
  const cluster = q.clusterName ? await ensureCluster(tx, organizationId, q.productId, q.clusterName) : null;
  const [row] = await tx.insert(queries).values(buildRow(organizationId, q, cluster?.id ?? null)).onConflictDoNothing().returning();
  return row ?? null;
}

/** Batched insert (one statement per 500 rows, no N+1). Existing queries are skipped. Returns the inserted rows. */
export async function addQueries(tx: Tx, organizationId: string, list: NewQuery[]) {
  const rows = list.map((q) => buildRow(organizationId, q, null));
  const out: (typeof queries.$inferSelect)[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (chunk.length) out.push(...(await tx.insert(queries).values(chunk).onConflictDoNothing().returning()));
  }
  return out;
}

/** Brand terms of a product: its name and the organisation's name. */
export function topicContextFor(g: ProductGraph, orgName?: string | null): TopicContext {
  return {
    brandTerms: [g.product.name, ...(orgName ? [orgName] : [])],
    competitors: g.competitors.flatMap((c) => [c.competitor.name, ...(c.competitor.aliases ?? [])]),
    facets: g.facets.map((f) => ({ kind: f.kind as TopicContext["facets"][number]["kind"], name: f.name })),
  };
}

async function contextFor(tx: Tx, organizationId: string, productId: string) {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
  return { g, ctx: topicContextFor(g, org?.name) };
}

/** Generate the structured query universe from the knowledge graph as CANDIDATE queries for human curation, then cluster. */
export async function generateQueryUniverse(tx: Tx, organizationId: string, productId: string, opts: { max?: number } = {}) {
  const { g, ctx } = await contextFor(tx, organizationId, productId);
  const candidates = expandQueryUniverse(g, { max: opts.max ?? 150 });
  const inserted = await addQueries(
    tx,
    organizationId,
    candidates.map((c) => ({
      query: c.query,
      productId,
      intent: c.intent,
      topicType: c.topicType,
      notes: `Generated: ${c.rationale}`,
      status: "CANDIDATE" as const,
      source: "GENERATED" as const,
      importance: c.intent === "NAVIGATIONAL" ? 4 : 3,
      brandTerms: ctx.brandTerms,
      topic: ctx,
    })),
  );
  const clusters = await reclusterProduct(tx, organizationId, productId);
  return { candidates: candidates.length, inserted: inserted.length, clusters: clusters.clusters };
}

/** Add a curated query for an optional product (brand-aware classification) and audit it. Throws when it already exists. */
export async function addCuratedQuery(tx: Tx, actor: Actor, input: Omit<NewQuery, "productId" | "brandTerms"> & { productId: string | null }) {
  const product = input.productId ? await tx.query.products.findFirst({ where: and(eq(products.id, input.productId), eq(products.organizationId, actor.organizationId)) }) : null;
  const topic = product ? (await contextFor(tx, actor.organizationId, product.id)).ctx : null;
  const row = await addQuery(tx, actor.organizationId, { ...input, productId: product?.id ?? null, brandTerms: topic?.brandTerms ?? [], topic: topic ?? undefined });
  if (!row) throw new Error("That query already exists for this market and language.");
  await audit(tx, actor, "query.add", "query", row.id, { query: row.query, intent: row.intent });
  return row;
}

// ─── Measured search demand ─────────────────────────────────────────────
export type QueryDemand = { query: string; impressions: number; clicks: number; position: number | null; pages: SearchPairRef[] };
export type SearchDemand = { connected: boolean; provider: string | null; days: number; byQuery: Map<string, QueryDemand> };

/**
 * Measured search demand per query for a product. Per-query totals come from
 * latestQueryMetrics (search-insights: daily query-grain rows summed over the
 * window ending at the last imported day, impressions-weighted position).
 * Landing pages come from the query x page grain over the same window. Each
 * grain is read separately, so nothing is counted twice. `connected` is
 * false when the product has no search rows at all.
 */
export async function searchDemand(tx: Tx, organizationId: string, productId: string, days = 28): Promise<SearchDemand> {
  const totals = await latestQueryMetrics(tx, organizationId, productId, days);
  const last = (
    await tx.execute<{ last: string | null; provider: string | null }>(sql`
      select max(day) filter (where query is not null and page is not null and country is null and device is null)::text as last, min(provider::text) as provider
      from search_daily where organization_id = ${organizationId} and product_id = ${productId}`)
  ).rows[0];
  const pageRows = last?.last
    ? await tx
        .select({
          query: searchDaily.query,
          page: searchDaily.page,
          clicks: sql<number>`sum(${searchDaily.clicks})::float`,
          impressions: sql<number>`sum(${searchDaily.impressions})::float`,
          posSum: sql<number>`coalesce(sum(${searchDaily.position} * ${searchDaily.impressions}) filter (where ${searchDaily.position} is not null), 0)::float`,
          posW: sql<number>`coalesce(sum(${searchDaily.impressions}) filter (where ${searchDaily.position} is not null), 0)::float`,
        })
        .from(searchDaily)
        .where(
          and(
            eq(searchDaily.organizationId, organizationId),
            eq(searchDaily.productId, productId),
            sql`${searchDaily.day} between ${last.last}::date - ${Math.max(1, days) - 1}::int and ${last.last}::date`,
            sql`${searchDaily.query} is not null`,
            sql`${searchDaily.page} is not null`,
            isNull(searchDaily.country),
            isNull(searchDaily.device),
          ),
        )
        .groupBy(searchDaily.query, searchDaily.page)
    : [];
  const connected =
    totals.length > 0 || pageRows.length > 0 || Boolean(await tx.query.searchDaily.findFirst({ where: and(eq(searchDaily.organizationId, organizationId), eq(searchDaily.productId, productId)), columns: { id: true } }));
  const pagesByQuery = new Map<string, SearchPairRef[]>();
  for (const r of pageRows) {
    if (!r.query || !r.page) continue;
    const k = normalizeQuery(r.query);
    const posW = Number(r.posW);
    pagesByQuery.set(k, [...(pagesByQuery.get(k) ?? []), { page: r.page, clicks: Number(r.clicks), impressions: Number(r.impressions), position: posW > 0 ? Math.round((Number(r.posSum) / posW) * 10) / 10 : null }]);
  }
  const byQuery = new Map<string, QueryDemand>();
  for (const t of totals) {
    const k = normalizeQuery(t.query);
    byQuery.set(k, { query: t.query, impressions: t.impressions, clicks: t.clicks, position: t.position === null ? null : Math.round(t.position * 10) / 10, pages: (pagesByQuery.get(k) ?? []).sort((a, b) => b.impressions - a.impressions) });
  }
  // Providers that only deliver the query x page grain: totals are the sum of the pages.
  for (const [k, pages] of pagesByQuery) {
    if (byQuery.has(k)) continue;
    const i = pages.reduce((s, p) => s + p.impressions, 0);
    const w = pages.reduce((s, p) => s + (p.position === null ? 0 : p.impressions), 0);
    const ps = pages.reduce((s, p) => s + (p.position === null ? 0 : p.position * p.impressions), 0);
    byQuery.set(k, { query: pageRows.find((r) => r.query && normalizeQuery(r.query) === k)!.query!, impressions: i, clicks: pages.reduce((s, p) => s + p.clicks, 0), position: w > 0 ? Math.round((ps / w) * 10) / 10 : null, pages: pages.sort((a, b) => b.impressions - a.impressions) });
  }
  return { connected, provider: last?.provider ?? null, days, byQuery };
}

/**
 * Import real demand: queries with measured impressions above a threshold
 * become CANDIDATE queries (source SEARCH_CONSOLE) for human curation.
 * Importance is derived from measured impressions only. Then re-cluster.
 */
export async function importSearchQueries(tx: Tx, organizationId: string, productId: string, opts: { minImpressions?: number; days?: number; max?: number } = {}) {
  const min = opts.minImpressions ?? 20;
  const demand = await searchDemand(tx, organizationId, productId, opts.days ?? 28);
  if (!demand.connected) return { connected: false, considered: 0, inserted: 0 };
  const { ctx } = await contextFor(tx, organizationId, productId);
  const picks = [...demand.byQuery.values()]
    .filter((d) => d.impressions >= min && normalizeQuery(d.query).length <= 200)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, opts.max ?? 300);
  const inserted = await addQueries(
    tx,
    organizationId,
    picks.map((d) => ({
      query: d.query,
      productId,
      status: "CANDIDATE" as const,
      source: "SEARCH_CONSOLE" as const,
      importance: d.impressions >= 1000 ? 4 : d.impressions >= 100 ? 3 : 2,
      notes: `Imported from ${demand.provider ?? "search"} data: ${d.impressions} impressions in ${demand.days} days`,
      brandTerms: ctx.brandTerms,
      topic: ctx,
    })),
  );
  if (inserted.length) await reclusterProduct(tx, organizationId, productId, demand);
  return { connected: true, considered: picks.length, inserted: inserted.length };
}

/**
 * Semantic clustering of the product's query universe (generated, imported
 * and manual queries outside MANUAL clusters). Clusters are upserted in one
 * statement, memberships updated in one statement, and emptied automatic
 * clusters without a pillar page are removed.
 */
export async function reclusterProduct(tx: Tx, organizationId: string, productId: string, demand?: SearchDemand) {
  const rows = await tx
    .select({ q: queries, origin: queryClusters.origin })
    .from(queries)
    .leftJoin(queryClusters, eq(queryClusters.id, queries.clusterId))
    .where(and(eq(queries.organizationId, organizationId), eq(queries.productId, productId), ne(queries.status, "ARCHIVED")));
  const free = rows.filter((r) => !r.q.clusterId || r.origin !== "MANUAL").map((r) => r.q);
  const d = demand ?? (await searchDemand(tx, organizationId, productId));
  const clusters = clusterQueries(free.map((q) => ({ id: q.id, query: q.query, intent: q.intent, topicType: q.topicType, branded: q.branded, importance: q.importance, impressions: d.byQuery.get(q.normalized)?.impressions ?? null })));
  const idByKey = new Map<string, string>();
  if (clusters.length) {
    const upserted = await tx
      .insert(queryClusters)
      .values(clusters.map((c) => ({ organizationId, productId, name: c.name, slug: c.key, origin: "SEMANTIC" as const, intent: c.intent, topicType: c.topicType, branded: c.branded, headTerms: c.headTerms, recommendedAsset: c.recommendedAsset })))
      .onConflictDoUpdate({
        target: [queryClusters.organizationId, queryClusters.productId, queryClusters.slug],
        set: { name: sql`excluded.name`, origin: sql`case when ${queryClusters.origin} = 'MANUAL' then ${queryClusters.origin} else 'SEMANTIC' end`, intent: sql`excluded.intent`, topicType: sql`excluded.topic_type`, branded: sql`excluded.branded`, headTerms: sql`excluded.head_terms`, recommendedAsset: sql`excluded.recommended_asset`, updatedAt: new Date() },
      })
      .returning({ id: queryClusters.id, slug: queryClusters.slug });
    for (const u of upserted) idByKey.set(u.slug, u.id);
    const pairs = clusters.flatMap((c) => c.memberIds.map((qid) => sql`(${qid}::uuid, ${idByKey.get(c.key)!}::uuid)`));
    for (let i = 0; i < pairs.length; i += 1000)
      await tx.execute(sql`update queries q set cluster_id = v.cid from (values ${sql.join(pairs.slice(i, i + 1000), sql`, `)}) as v(id, cid) where q.id = v.id and q.organization_id = ${organizationId} and q.cluster_id is distinct from v.cid`);
  }
  const keep = [...idByKey.values()];
  const removed = await tx
    .delete(queryClusters)
    .where(
      and(
        eq(queryClusters.organizationId, organizationId),
        eq(queryClusters.productId, productId),
        or(eq(queryClusters.origin, "SEMANTIC"), eq(queryClusters.origin, "TEMPLATE")),
        isNull(queryClusters.pillarPageId),
        keep.length ? notInArray(queryClusters.id, keep) : undefined,
        sql`not exists (select 1 from queries q where q.cluster_id = ${queryClusters.id})`,
      ),
    )
    .returning({ id: queryClusters.id });
  return { clusters: clusters.length, removed: removed.length };
}

export async function clustersForProduct(tx: Tx, organizationId: string, productId: string) {
  return tx.select().from(queryClusters).where(and(eq(queryClusters.organizationId, organizationId), eq(queryClusters.productId, productId)));
}

export async function queriesByIds(tx: Tx, organizationId: string, ids: string[]) {
  if (!ids.length) return [];
  return tx.select().from(queries).where(and(eq(queries.organizationId, organizationId), inArray(queries.id, ids)));
}

/** After a search sync: import measured queries for the integration's product (or every product with search rows). */
export async function importQueriesAfterSync(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, organizationId: string, integrationId: string) {
  return run(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, integrationId), eq(integrations.organizationId, organizationId)) });
    if (!integ || !isSearchProvider(integ.provider)) return [];
    const ids = integ.productId
      ? [integ.productId]
      : (await tx.selectDistinct({ id: searchDaily.productId }).from(searchDaily).where(and(eq(searchDaily.organizationId, organizationId), eq(searchDaily.integrationId, integrationId)))).map((r) => r.id).filter((x): x is string => Boolean(x));
    const out = [];
    for (const id of ids) out.push({ productId: id, ...(await importSearchQueries(tx, organizationId, id)) });
    return out;
  });
}
