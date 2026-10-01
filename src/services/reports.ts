import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { products, reports } from "@/db/schema";
import { rankTopActions, type TopAction } from "@/core/briefing/briefing";
import { metric, moneyMetrics, observedMetric, riskItems, type MetricState, type Period, type ReportItem, type ReportMetric, type ReportPayload, type ReportScope, type ReportSection } from "@/core/reports/report";
import { addDays, isoDay } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";
import { actionCandidates } from "./briefings";
import { availability, kpis, type Kpi } from "./metrics";
import { searchDataState, searchTotals, type SearchScope } from "./search-insights";

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const st = (k: Kpi): { state: MetricState; now: number | null; prev: number | null } => ({ state: k.state, now: k.now, prev: k.prev });
const stNow = (k: Kpi) => ({ state: k.state, now: k.now, prev: null });

/** The last complete week (UTC): the 7 days ending yesterday, and the 7 days before. */
export function weeklyPeriod(now = new Date()): { period: Period; previous: Period; end: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = addDays(today, -1);
  const start = addDays(today, -7);
  return { period: { start: isoDay(start), end: isoDay(end) }, previous: { start: isoDay(addDays(start, -7)), end: isoDay(addDays(start, -1)) }, end: today };
}

async function discovery(tx: Tx, organizationId: string, productId: string | null, period: Period, k: Awaited<ReturnType<typeof kpis>>): Promise<ReportMetric[]> {
  const base: SearchScope = { organizationId, productId };
  const all = await searchDataState(tx, base);
  const provider = all.integrations.some((i) => i.provider === "GOOGLE_SEARCH_CONSOLE") || !all.integrations.length ? "GOOGLE_SEARCH_CONSOLE" : "BING_WEBMASTER";
  const scope = { ...base, provider } as const;
  const s = await searchDataState(tx, scope);
  // Product scopes also use organisation-wide search integrations, so data presence decides "connected" there.
  const state: MetricState = s.hasData ? "OK" : s.connected || all.connected ? "NO_DATA_YET" : productId && (await availability(tx, organizationId, productId)).searchConnected ? "NO_DATA_YET" : "NOT_CONNECTED";
  const src = { source: provider === "GOOGLE_SEARCH_CONSOLE" ? "Google Search Console" : "Bing Webmaster Tools" };
  const out: ReportMetric[] = [];
  if (state === "OK") {
    const t = await searchTotals(tx, scope, period);
    out.push(metric("clicks", "Organic clicks", "count", { state, now: t.now.clicks, prev: t.prev.clicks }, src));
    out.push(metric("impressions", "Organic impressions", "count", { state, now: t.now.impressions, prev: t.prev.impressions }, src));
    out.push(metric("ctr", "Click-through rate", "percent", { state, now: t.now.ctr, prev: t.prev.ctr }, src));
    out.push(metric("position", "Average position", "position", { state, now: t.now.position, prev: t.prev.position }, src));
  } else
    for (const [key, label, unit] of [
      ["clicks", "Organic clicks", "count"],
      ["impressions", "Organic impressions", "count"],
      ["ctr", "Click-through rate", "percent"],
      ["position", "Average position", "position"],
    ] as const)
      out.push(metric(key, label, unit, { state, now: null, prev: null }, src));
  out.push(metric("branded", "Branded impressions", "count", st(k.discovery.brandedImpressions)));
  out.push(metric("ai_referrals", "AI referrals (Beacon tracker)", "count", st(k.discovery.aiReferrals)));
  out.push(metric("ai_ga4", "AI referral sessions (GA4)", "count", st(k.discovery.aiReferralSessionsGa4)));
  return out;
}

async function scopeData(tx: Tx, organizationId: string, productId: string | null, period: Period, previous: Period, end: Date, actions: TopAction[], productName: string | null): Promise<ReportSection[]> {
  const k = await kpis(tx, organizationId, { days: 7, productId, end });
  const pf = (col: string) => (productId ? sql`and ${sql.raw(col)} = ${productId}` : sql``);
  const ps = sql`${period.start}::date`;
  const pe = sql`(${period.end}::date + 1)`;
  const qs = sql`${previous.start}::date`;
  const counts = (
    await tx.execute<Record<string, number>>(sql`
    select
      (select count(*) from seo_issues i join (select distinct on (product_id) id, product_id from seo_audits where organization_id = ${organizationId} and status = 'SUCCEEDED' and created_at < ${pe} order by product_id, created_at desc) a on a.id = i.audit_id
        where i.severity = 'CRITICAL' and i.status = 'OPEN' ${pf("a.product_id")})::int as critical,
      (select count(*) from content_assets where organization_id = ${organizationId} and status = 'HUMAN_APPROVAL' ${pf("product_id")})::int as awaiting,
      (select count(*) from content_assets where organization_id = ${organizationId} and status in ('FACT_CHECK','SEO_CHECK') ${pf("product_id")})::int as blocked,
      (select count(*) from opportunities where organization_id = ${organizationId} and status = 'OPEN' ${pf("product_id")})::int as opp_open,
      (select count(*) from opportunities where organization_id = ${organizationId} and created_at >= ${ps} and created_at < ${pe} ${pf("product_id")})::int as opp_new,
      (select count(*) from opportunities where organization_id = ${organizationId} and created_at >= ${qs} and created_at < ${ps} ${pf("product_id")})::int as opp_new_prev,
      (select count(*) from opportunities where organization_id = ${organizationId} and status = 'DONE' and updated_at >= ${ps} and updated_at < ${pe} ${pf("product_id")})::int as opp_done,
      (select count(*) from opportunities where organization_id = ${organizationId} and status = 'DONE' and updated_at >= ${qs} and updated_at < ${ps} ${pf("product_id")})::int as opp_done_prev,
      (select count(*) from experiments where organization_id = ${organizationId} and status = 'RUNNING' ${pf("product_id")})::int as exp_running,
      (select count(*) from experiments where organization_id = ${organizationId} and status = 'READY_FOR_REVIEW' ${pf("product_id")})::int as exp_ready,
      (select count(*) from experiments where organization_id = ${organizationId} and status = 'CONCLUDED' and updated_at >= ${ps} and updated_at < ${pe} ${pf("product_id")})::int as exp_done,
      (select count(*) from experiments where organization_id = ${organizationId} and status = 'CONCLUDED' and updated_at >= ${qs} and updated_at < ${ps} ${pf("product_id")})::int as exp_done_prev,
      (select count(*) from jobs where organization_id = ${organizationId} and status = 'DEAD' and finished_at >= ${ps} and finished_at < ${pe})::int as dead_jobs,
      (select count(*) from queries where organization_id = ${organizationId} and status = 'ACTIVE' and coverage = 'COVERED' ${pf("product_id")})::int as covered`)
  ).rows[0];
  const a = await availability(tx, organizationId, productId);
  const aiState: MetricState = a.aiTests ? "OK" : a.aiConfigured ? "NO_DATA_YET" : "NOT_CONNECTED";
  const ai = (
    await tx.execute<Record<string, number>>(sql`
    select
      count(*) filter (where t.ran_at >= ${ps} and t.ran_at < ${pe})::int as y_now,
      count(*) filter (where t.ran_at >= ${qs} and t.ran_at < ${ps})::int as y_prev,
      count(*) filter (where t.ran_at >= ${ps} and t.ran_at < ${pe} and ${productId ? sql`t.products_mentioned @> ${JSON.stringify([{ productId }])}::jsonb` : sql`(t.org_mentioned or jsonb_array_length(t.products_mentioned) > 0)`})::int as x_now,
      count(*) filter (where t.ran_at >= ${qs} and t.ran_at < ${ps} and ${productId ? sql`t.products_mentioned @> ${JSON.stringify([{ productId }])}::jsonb` : sql`(t.org_mentioned or jsonb_array_length(t.products_mentioned) > 0)`})::int as x_prev,
      count(*) filter (where t.ran_at >= ${ps} and t.ran_at < ${pe} and t.own_domain_cited)::int as c_now,
      count(*) filter (where t.ran_at >= ${qs} and t.ran_at < ${ps} and t.own_domain_cited)::int as c_prev
    from ai_visibility_tests t join ai_visibility_prompts p on p.id = t.prompt_id
    where t.organization_id = ${organizationId} ${productId ? sql`and (p.product_id = ${productId} or p.product_id is null)` : sql``}`)
  ).rows[0];
  const score = productId
    ? (
        await tx.execute<{ now: number | null; prev: number | null }>(sql`
        select (select total from beacon_scores where organization_id = ${organizationId} and product_id = ${productId} and computed_at < ${pe} order by computed_at desc limit 1) as now,
               (select total from beacon_scores where organization_id = ${organizationId} and product_id = ${productId} and computed_at < ${ps} order by computed_at desc limit 1) as prev`)
      ).rows[0]
    : null;
  const opps = await tx.execute<{ id: string; title: string; priority: number }>(sql`
    select id, title, priority_score as priority from opportunities where organization_id = ${organizationId} and status = 'OPEN' ${pf("product_id")} order by priority_score desc, id limit 5`);
  const exps = await tx.execute<{ id: string; name: string; status: string }>(sql`
    select id, name, status::text as status from experiments where organization_id = ${organizationId} and status in ('RUNNING', 'READY_FOR_REVIEW') ${pf("product_id")} order by updated_at desc limit 10`);
  const failing = await tx.execute<{ provider: string; status: string }>(sql`
    select provider::text as provider, status::text as status from integrations where organization_id = ${organizationId} and status in ('ERROR', 'EXPIRED') ${productId ? sql`and (product_id = ${productId} or product_id is null)` : sql``}`);

  const disc = await discovery(tx, organizationId, productId, period, k);
  const clicks = disc.find((m) => m.key === "clicks")!;
  const okNow = (n: number) => ({ state: "OK" as const, now: n, prev: null });
  const okPair = (n: number, p: number) => ({ state: "OK" as const, now: n, prev: p });
  const scoped = actions.filter((x) => !productId || x.product === productName);

  return [
    { key: "DISCOVERY", metrics: disc, items: [] },
    {
      key: "VISIBILITY",
      metrics: [
        ...(score ? [metric("score", "Beacon Score", "score", score.now === null ? { state: "NO_DATA_YET", now: null, prev: null } : { state: "OK", now: num(score.now), prev: score.prev === null ? null : num(score.prev) })] : []),
        metric("indexable", "Indexable pages", "count", stNow(k.discovery.indexedPages)),
        metric("covered", "Covered queries", "count", okNow(num(counts.covered))),
        metric("critical", "Open critical SEO issues", "count", a.audits ? okNow(num(counts.critical)) : { state: "NO_DATA_YET", now: null, prev: null }),
      ],
      items: [],
    },
    {
      key: "CONTENT",
      metrics: [metric("published", "Published in period", "count", st(k.content.publishedInPeriod)), metric("awaiting", "Drafts awaiting approval", "count", okNow(num(counts.awaiting))), metric("blocked", "Drafts blocked by checks", "count", okNow(num(counts.blocked)))],
      items: [],
    },
    {
      key: "CONVERSION",
      metrics: [
        metric("visitors", "Visitors", "count", st(k.acquisition.visitors)),
        metric("signups", "Signups", "count", st(k.acquisition.signups)),
        metric("trials", "Trials", "count", st(k.acquisition.trials)),
        metric("activations", "Activations", "count", st(k.acquisition.activations)),
        metric("conversion_rate", "Conversion rate", "percent", st(k.revenue.conversionRate)),
      ],
      items: [],
    },
    {
      key: "REVENUE",
      metrics: [
        metric("new_subs", "New subscriptions", "count", st(k.revenue.newSubscriptions)),
        ...moneyMetrics("revenue", "Revenue in period", k.revenue.revenue),
        ...moneyMetrics("beacon_new_mrr", "New MRR via Beacon channels", k.revenue.beaconNewMrr),
        ...moneyMetrics("mrr", "MRR", k.revenue.mrr, false),
      ],
      items: [],
    },
    {
      key: "AI_OBSERVATIONS",
      metrics: [
        observedMetric("ai_mentions", productId ? "Sampled answers mentioning the product" : "Sampled answers mentioning a product", aiState, { x: num(ai?.x_now), y: num(ai?.y_now) }, { x: num(ai?.x_prev), y: num(ai?.y_prev) }),
        observedMetric("ai_own_citations", "Sampled answers citing your own domain", aiState, { x: num(ai?.c_now), y: num(ai?.y_now) }, { x: num(ai?.c_prev), y: num(ai?.y_prev) }),
      ],
      items: [],
    },
    {
      key: "OPPORTUNITIES",
      metrics: [metric("opp_open", "Open opportunities", "count", okNow(num(counts.opp_open))), metric("opp_new", "New opportunities", "count", okPair(num(counts.opp_new), num(counts.opp_new_prev))), metric("opp_done", "Opportunities done", "count", okPair(num(counts.opp_done), num(counts.opp_done_prev)))],
      items: opps.rows.map((o): ReportItem => ({ label: "{title} (priority {priority})", vars: { title: o.title, priority: Math.round(num(o.priority) * 10) / 10 }, href: `/opportunities/${o.id}` })),
    },
    {
      key: "EXPERIMENTS",
      metrics: [metric("exp_running", "Running experiments", "count", okNow(num(counts.exp_running))), metric("exp_ready", "Ready for review", "count", okNow(num(counts.exp_ready))), metric("exp_done", "Concluded in period", "count", okPair(num(counts.exp_done), num(counts.exp_done_prev)))],
      items: exps.rows.length ? exps.rows.map((e): ReportItem => ({ label: "{name}: {status}", vars: { name: e.name, status: e.status }, href: "/autopilot#experiments" })) : [{ label: "No experiment running" }],
    },
    {
      key: "RISKS",
      metrics: [],
      items: riskItems({ integrations: failing.rows, criticalIssues: num(counts.critical), clicks: { state: clicks.state, now: clicks.now, prev: clicks.prev }, failedJobs: productId ? 0 : num(counts.dead_jobs), blockedDrafts: num(counts.blocked) }),
    },
    { key: "NEXT_ACTIONS", metrics: [], items: scoped.length ? scoped.slice(0, 5).map(actionItem) : [{ label: "No action pending" }] },
  ];
}

/** A top action as a report item (English template, entity names as variables). */
export function actionItem(a: TopAction): ReportItem {
  switch (a.kind) {
    case "BLOCKING_SEO":
      return { label: "Fix the critical SEO issues on {subject} ({n})", vars: { n: a.count ?? 0, subject: a.subject }, href: a.href };
    case "INTEGRATION":
      return { label: "Reconnect {subject} ({status})", vars: { subject: a.subject, status: a.status ?? "" }, href: a.href };
    case "FACT_CHECK":
      return { label: "Resolve the high-severity fact-check blockers in {subject} ({n})", vars: { n: a.count ?? 0, subject: a.subject }, href: a.href };
    case "DRAFT":
      return { label: "Review {subject}", vars: { subject: a.subject }, href: a.href };
    default:
      return { label: "{subject}", vars: { subject: a.subject }, href: a.href };
  }
}

/** Build the weekly report payload: organisation total first, then one scope per product. */
export async function buildWeeklyReport(tx: Tx, organizationId: string, now = new Date()): Promise<ReportPayload> {
  const { period, previous, end } = weeklyPeriod(now);
  // More candidates than five, so each product scope can show its own next actions.
  const actions = rankTopActions(await actionCandidates(tx, organizationId, now), 100);
  const scopes: ReportScope[] = [{ productId: null, name: "Organisation total", slug: null, sections: await scopeData(tx, organizationId, null, period, previous, end, actions, null) }];
  const prods = await tx.select({ id: products.id, name: products.name, slug: products.slug }).from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name);
  for (const p of prods) scopes.push({ productId: p.id, name: p.name, slug: p.slug, sections: await scopeData(tx, organizationId, p.id, period, previous, end, actions, p.name) });
  scopes[0].sections.find((s) => s.key === "NEXT_ACTIONS")!.items = actions.length ? actions.slice(0, 5).map(actionItem) : [{ label: "No action pending" }];
  return { version: 1, period, previous, generatedAt: now.toISOString(), scopes };
}

/** Generate (or regenerate) the weekly report of the last complete week; one row per period. */
export async function generateWeeklyReport(tx: Tx, organizationId: string, opts: { actor?: Actor; now?: Date } = {}) {
  const payload = await buildWeeklyReport(tx, organizationId, opts.now);
  const userId = opts.actor?.actorType === "USER" ? (opts.actor.userId ?? null) : null;
  const [row] = await tx
    .insert(reports)
    .values({ organizationId, kind: "WEEKLY", periodStart: payload.period.start, periodEnd: payload.period.end, payload: payload as unknown as Record<string, unknown>, createdBy: userId })
    .onConflictDoUpdate({ target: [reports.organizationId, reports.kind, reports.periodStart, reports.periodEnd], set: { payload: payload as unknown as Record<string, unknown>, updatedAt: new Date(), createdBy: userId } })
    .returning();
  if (opts.actor) await audit(tx, opts.actor, "report.generate", "report", row.id, { kind: "WEEKLY", period: payload.period });
  return row;
}

export async function listReports(tx: Tx, organizationId: string, limit = 52) {
  return tx.select({ id: reports.id, kind: reports.kind, periodStart: reports.periodStart, periodEnd: reports.periodEnd, createdAt: reports.createdAt, updatedAt: reports.updatedAt }).from(reports).where(eq(reports.organizationId, organizationId)).orderBy(desc(reports.periodEnd), desc(reports.createdAt)).limit(limit);
}

export async function getReport(tx: Tx, organizationId: string, id: string) {
  const r = await tx.query.reports.findFirst({ where: and(eq(reports.organizationId, organizationId), eq(reports.id, id)) });
  return r ? { ...r, payload: r.payload as unknown as ReportPayload } : null;
}
