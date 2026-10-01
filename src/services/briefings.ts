import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { briefings, organizations, products } from "@/db/schema";
import { briefingLines, ORGANIC_CHANNELS, PAGE_MIN, rankTopActions, type ActionCandidate, type BriefingLine, type BriefingSnapshot, type SourceState, type TopAction } from "@/core/briefing/briefing";
import { DEFAULT_ATTRIBUTION } from "@/core/attribution/attribution";
import { eventTypesFor } from "@/core/conversions/events";
import { addDays, isoDay } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";
import { availability } from "./metrics";
import { latestQueryMetrics, searchDataState, searchTotals, type SearchScope } from "./search-insights";

/** Search window used by the briefing: the 7 most recent days of imported data. */
export const BRIEFING_WINDOW_DAYS = 7;
const MAX_PAGES = 500;
const MAX_QUERIES = 500;
const MAX_REFS = 300;

const state = (connected: boolean, hasData: boolean): SourceState => (hasData ? "OK" : connected ? "NO_DATA_YET" : "NOT_CONNECTED");
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export const BRIEFING_LINKS = {
  search: "/queries/search",
  gaps: "/opportunities?type=CONTENT_GAP",
  citations: "/opportunities?type=CITATION",
  drafts: "/content?status=HUMAN_APPROVAL",
  conversions: "/conversions",
  revenue: "/revenue",
  connect: "/settings/integrations",
  tracking: "/products",
} as const;

export async function orgAttributionModel(tx: Tx, organizationId: string): Promise<string> {
  const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId), columns: { settings: true } });
  return org?.settings.attribution?.model ?? DEFAULT_ATTRIBUTION.model;
}

/** Impressions per page (page grain rows only) over a window, pages with at least `min` impressions, biggest first. */
export async function pageImpressions(tx: Tx, scope: SearchScope, range: { start: string; end: string }, min: number, limit: number) {
  const r = await tx.execute<{ page: string; impressions: number }>(sql`
    select page, sum(impressions)::float as impressions from search_daily
    where organization_id = ${scope.organizationId} ${scope.provider ? sql`and provider = ${scope.provider}` : sql``}
      and page is not null and query is null and country is null and device is null
      and day between ${range.start}::date and ${range.end}::date
    group by page having sum(impressions) >= ${min} order by 2 desc, 1 limit ${limit + 1}`);
  return { rows: r.rows.slice(0, limit).map((x) => ({ page: x.page, impressions: num(x.impressions) })), capped: r.rows.length > limit };
}

async function searchSnapshot(tx: Tx, organizationId: string): Promise<BriefingSnapshot["search"]> {
  const empty = { provider: null, lastDay: null, windowStart: null, clicks: 0, impressions: 0, top10: [], pages: {}, pagesCapped: false, queryRefs: {} };
  const all = await searchDataState(tx, { organizationId });
  if (!all.connected && !all.hasData) return { state: "NOT_CONNECTED", ...empty };
  // One provider, never Search Console and Bing added together (Search Console first).
  const provider = all.integrations.some((i) => i.provider === "GOOGLE_SEARCH_CONSOLE" && i.status !== "NOT_CONNECTED" && i.status !== "DISABLED") ? "GOOGLE_SEARCH_CONSOLE" : "BING_WEBMASTER";
  const scope: SearchScope = { organizationId, provider };
  const st = await searchDataState(tx, scope);
  if (!st.hasData || !st.lastDay) return { state: st.connected || all.connected ? "NO_DATA_YET" : "NOT_CONNECTED", ...empty, provider };
  const end = st.lastDay;
  const start = isoDay(addDays(new Date(`${end}T00:00:00Z`), -(BRIEFING_WINDOW_DAYS - 1)));
  const totals = await searchTotals(tx, scope, { start, end });
  const prods = await tx.select({ id: products.id, slug: products.slug, name: products.name }).from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name);
  const top: { key: string; impressions: number; ref: { title: string; href: string; product: string } }[] = [];
  for (const p of prods) {
    const rows = await latestQueryMetrics(tx, organizationId, p.id, BRIEFING_WINDOW_DAYS, { provider });
    for (const q of rows)
      if (q.position !== null && q.position >= 4 && q.position <= 10 && q.impressions >= 5)
        top.push({ key: `${p.id}::${q.query}`, impressions: q.impressions, ref: { title: q.query, href: `/queries/search?product=${encodeURIComponent(p.slug)}`, product: p.name } });
  }
  top.sort((a, b) => b.impressions - a.impressions || a.key.localeCompare(b.key));
  const kept = top.slice(0, MAX_QUERIES);
  const pages = await pageImpressions(tx, scope, { start, end }, PAGE_MIN, MAX_PAGES);
  return {
    state: "OK",
    provider,
    lastDay: end,
    windowStart: start,
    clicks: totals.now.clicks,
    impressions: totals.now.impressions,
    top10: kept.map((k) => k.key),
    pages: Object.fromEntries(pages.rows.map((p) => [p.page, p.impressions])),
    pagesCapped: pages.capped,
    queryRefs: Object.fromEntries(kept.map((k) => [k.key, k.ref])),
  };
}

async function openOpportunityRefs(tx: Tx, organizationId: string, type: string) {
  const r = await tx.execute<{ id: string; title: string; product: string | null }>(sql`
    select o.id, o.title, p.name as product from opportunities o left join products p on p.id = o.product_id
    where o.organization_id = ${organizationId} and o.status = 'OPEN' and o.type = ${type}
    order by o.priority_score desc, o.id limit ${MAX_REFS}`);
  return { ids: r.rows.map((x) => x.id), refs: Object.fromEntries(r.rows.map((x) => [x.id, { title: x.title, href: `/opportunities/${x.id}`, product: x.product }])) };
}

/** Everything the briefing measures right now, for the period since `since`. */
export async function takeSnapshot(tx: Tx, organizationId: string, since: Date, now = new Date()): Promise<BriefingSnapshot> {
  const a = await availability(tx, organizationId, null);
  const model = await orgAttributionModel(tx, organizationId);
  const search = await searchSnapshot(tx, organizationId);
  const gaps = await openOpportunityRefs(tx, organizationId, "CONTENT_GAP");
  const aiState = state(a.aiConfigured, a.aiTests);
  const citations = aiState === "OK" ? await openOpportunityRefs(tx, organizationId, "CITATION") : { ids: [], refs: {} };
  const drafts = (await tx.execute<{ id: string }>(sql`select id from content_assets where organization_id = ${organizationId} and status = 'HUMAN_APPROVAL' order by updated_at, id`)).rows.map((r) => r.id);

  const trackerState = state(a.trackerKey, a.events);
  const signupTypes = sql.join(eventTypesFor("SIGNUP_COMPLETED").map((t) => sql`${t}`), sql`, `);
  const organic = sql.join(ORGANIC_CHANNELS.map((c) => sql`${c}`), sql`, `);
  let signups = 0;
  if (trackerState === "OK") {
    const r = await tx.execute<{ n: number }>(sql`
      select coalesce(sum(c.weight), 0)::float as n from attribution_credits c join conversion_events e on e.id = c.conversion_event_id
      where c.organization_id = ${organizationId} and c.model = ${model} and c.channel::text in (${organic})
        and e.type::text in (${signupTypes}) and c.occurred_at > ${since.toISOString()} and c.occurred_at <= ${now.toISOString()}`);
    signups = Math.round(num(r.rows[0]?.n) * 100) / 100;
  }
  const revState = state(a.revenueConnected, a.revenue);
  let byCurrency: { currency: string; cents: number }[] = [];
  if (revState === "OK") {
    const r = await tx.execute<{ currency: string; cents: number }>(sql`
      select r.currency, coalesce(sum(round(c.weight * r.mrr_delta_cents)), 0)::bigint as cents
      from attribution_credits c join revenue_events r on r.id = c.revenue_event_id
      where c.organization_id = ${organizationId} and c.model = ${model} and c.channel::text in (${organic})
        and r.mrr_delta_cents > 0 and c.occurred_at > ${since.toISOString()} and c.occurred_at <= ${now.toISOString()}
      group by r.currency`);
    // Every currency ever seen is listed (a measured 0 is a real 0); currencies are never added together.
    byCurrency = a.currencies.map((c) => ({ currency: c, cents: num(r.rows.find((x) => x.currency === c)?.cents) }));
  }
  return {
    version: 1,
    at: now.toISOString(),
    search,
    gaps,
    citations: { state: aiState, ...citations },
    drafts: { count: drafts.length, ids: drafts.slice(0, MAX_REFS) },
    signups: { state: trackerState, model, count: signups },
    mrr: { state: revState, model, byCurrency },
  };
}

/** Candidates for the top 5 actions: blocking issues, opportunities and drafts awaiting approval, each with the exact page to open. */
export async function actionCandidates(tx: Tx, organizationId: string, now = new Date()): Promise<ActionCandidate[]> {
  const out: ActionCandidate[] = [];
  const crit = await tx.execute<{ audit_id: string; product: string; n: number }>(sql`
    select a.id as audit_id, p.name as product, count(i.id)::int as n
    from (select distinct on (product_id) id, product_id from seo_audits where organization_id = ${organizationId} and status = 'SUCCEEDED' order by product_id, created_at desc) a
    join products p on p.id = a.product_id
    join seo_issues i on i.audit_id = a.id and i.severity = 'CRITICAL' and i.status = 'OPEN'
    group by a.id, p.name`);
  for (const r of crit.rows) out.push({ kind: "BLOCKING_SEO", id: r.audit_id, href: `/discovery/audits/${r.audit_id}`, subject: r.product, product: r.product, count: num(r.n) });
  const integ = await tx.execute<{ id: string; provider: string; status: string; product: string | null }>(sql`
    select i.id, i.provider::text as provider, i.status::text as status, p.name as product from integrations i left join products p on p.id = i.product_id
    where i.organization_id = ${organizationId} and i.status in ('ERROR', 'EXPIRED')`);
  for (const r of integ.rows) out.push({ kind: "INTEGRATION", id: r.id, href: "/settings/integrations", subject: r.provider, product: r.product, status: r.status });
  const facts = await tx.execute<{ id: string; title: string; n: number }>(sql`
    select a.id, a.title, (
      select count(*) from jsonb_array_elements(coalesce(v.fact_check->'claims', '[]'::jsonb)) c
      where c->>'status' <> 'SUPPORTED' and coalesce(c->>'severity', 'HIGH') = 'HIGH')::int as n
    from content_assets a join content_versions v on v.asset_id = a.id and v.version = a.current_version
    where a.organization_id = ${organizationId} and a.status not in ('PUBLISHED', 'REJECTED', 'APPROVED')`);
  for (const r of facts.rows) if (num(r.n) > 0) out.push({ kind: "FACT_CHECK", id: r.id, href: `/content/${r.id}`, subject: r.title, count: num(r.n) });
  const opps = await tx.execute<{ id: string; title: string; potential: string; priority: number; product: string | null }>(sql`
    select o.id, o.title, o.potential::text as potential, o.priority_score as priority, p.name as product
    from opportunities o left join products p on p.id = o.product_id
    where o.organization_id = ${organizationId} and o.status = 'OPEN' order by o.priority_score desc, o.id limit 20`);
  for (const r of opps.rows) out.push({ kind: "OPPORTUNITY", id: r.id, href: `/opportunities/${r.id}`, subject: r.title, product: r.product, potential: r.potential, priority: Math.round(num(r.priority) * 10) / 10 });
  const drafts = await tx.execute<{ id: string; title: string; updated_at: string }>(sql`
    select id, title, updated_at::text from content_assets where organization_id = ${organizationId} and status = 'HUMAN_APPROVAL' order by updated_at limit 20`);
  for (const r of drafts.rows) out.push({ kind: "DRAFT", id: r.id, href: `/content/${r.id}`, subject: r.title, ageDays: Math.max(0, Math.floor((now.getTime() - Date.parse(r.updated_at)) / 86_400_000)) });
  return out;
}

export type StoredBriefing = typeof briefings.$inferSelect;
export type BriefingView = Omit<StoredBriefing, "deltas" | "topActions" | "kpis"> & { deltas: BriefingLine[]; topActions: TopAction[]; kpis: BriefingSnapshot };
const view = (b: StoredBriefing): BriefingView => b as unknown as BriefingView;

/** The previous stored organisation-level briefing (product briefings are separate series). */
async function previousBriefing(tx: Tx, organizationId: string) {
  return tx.query.briefings.findFirst({ where: and(eq(briefings.organizationId, organizationId), isNull(briefings.productId)), orderBy: [desc(briefings.generatedAt)] });
}

/**
 * Generate and store the organisation briefing: snapshot now, lines against
 * the previous stored briefing, top 5 actions. Deterministic, no LLM.
 */
export async function generateBriefing(tx: Tx, organizationId: string, opts: { actor?: Actor; now?: Date } = {}): Promise<BriefingView> {
  const now = opts.now ?? new Date();
  const prev = await previousBriefing(tx, organizationId);
  const since = prev ? prev.periodEnd : addDays(now, -1);
  const snapshot = await takeSnapshot(tx, organizationId, since, now);
  const prevSnap = prev && (prev.kpis as { version?: number }).version === 1 ? (prev.kpis as unknown as BriefingSnapshot) : null;
  const lines = briefingLines(prevSnap, snapshot, BRIEFING_LINKS);
  const top = rankTopActions(await actionCandidates(tx, organizationId, now));
  const items = Object.fromEntries(lines.filter((l) => l.items?.length).map((l) => [l.key, l.items]));
  const [row] = await tx
    .insert(briefings)
    .values({
      organizationId,
      productId: null,
      previousId: prev?.id ?? null,
      periodStart: since,
      periodEnd: now,
      generatedAt: now,
      kpis: snapshot as unknown as Record<string, unknown>,
      deltas: lines,
      items,
      topActions: top,
      createdBy: opts.actor?.actorType === "USER" ? (opts.actor.userId ?? null) : null,
    })
    .returning();
  if (opts.actor) await audit(tx, opts.actor, "briefing.generate", "briefing", row.id, { previousId: prev?.id ?? null });
  return view(row);
}

export async function latestBriefing(tx: Tx, organizationId: string): Promise<BriefingView | null> {
  const b = await previousBriefing(tx, organizationId);
  return b ? view(b) : null;
}

export async function listBriefings(tx: Tx, organizationId: string, limit = 60): Promise<BriefingView[]> {
  const rows = await tx.select().from(briefings).where(and(eq(briefings.organizationId, organizationId), isNull(briefings.productId))).orderBy(desc(briefings.generatedAt)).limit(limit);
  return rows.map(view);
}

export async function getBriefing(tx: Tx, organizationId: string, id: string): Promise<BriefingView | null> {
  const b = await tx.query.briefings.findFirst({ where: and(eq(briefings.organizationId, organizationId), eq(briefings.id, id)) });
  return b ? view(b) : null;
}
