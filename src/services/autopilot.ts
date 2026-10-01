import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, crawledPages, distributionTargets, experiments, growthReports, integrations, opportunities, products, queries, recommendations, seoAudits } from "@/db/schema";
import { analyzeGrowth, type MetricPair, type PeriodEvent } from "@/core/autopilot/analyst";
import {
  baselineWindow,
  dayPlus,
  dedupeKeyFor,
  labelOutcome,
  loopStage,
  MEASURE_AFTER_DAYS,
  measuredWindow,
  measureKindFor,
  planExecution,
  primaryMetric,
  type DayWindow,
  type ExecutedRef,
  type ExecutionPlan,
  type LoopStage,
  type MeasureKind,
  type MeasurementSnapshot,
  type RecommendationTarget,
} from "@/core/autopilot/loop";
import { addDays, isoDay } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { availability, kpis } from "./metrics";
import { createAssetFromOpportunity } from "./content";
import { queueAudit, latestAudit } from "./seo";
import { prepareTargetsForOpportunity } from "./distribution";
import { recordLearning } from "./autopilot-learning";

type Rec = typeof recommendations.$inferSelect;
type Opp = typeof opportunities.$inferSelect;

/** OBSERVE + ANALYZE + IDENTIFY + RECOMMEND: the weekly growth analyst report; proposals land deduped, awaiting approval. */
export async function generateGrowthReport(tx: Tx, organizationId: string, days = 7) {
  const k = await kpis(tx, organizationId, { days });
  const toPairs = (kk: typeof k, scope: { productId?: string; productName?: string } = {}) => {
    const out: MetricPair[] = [];
    const push = (key: string, label: string, v: { now: number | null; prev: number | null; source: string }, unit: MetricPair["unit"] = "count") => {
      if (v.now !== null && v.prev !== null) out.push({ key, label, now: v.now, prev: v.prev, unit, source: v.source, ...scope });
    };
    push("clicks", "Organic clicks", kk.discovery.organicClicks);
    push("impressions", "Organic impressions", kk.discovery.organicImpressions);
    push("ai_referrals", "AI-assistant referrals", kk.discovery.aiReferrals);
    push("visitors", "Visitors", kk.acquisition.visitors);
    push("signups", "Signups", kk.acquisition.signups);
    if (!scope.productId) {
      push("new_subs", "New subscriptions", kk.revenue.newSubscriptions);
      push("beacon_mrr", "New MRR via Beacon channels", kk.revenue.beaconNewMrr, "cents");
    }
    return out;
  };
  const metrics = toPairs(k);
  // Explanations are product-scoped: each product's metrics only meet that product's events.
  const prods = await tx.select({ id: products.id, name: products.name }).from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name);
  const scopedMetrics: MetricPair[] = [];
  for (const p of prods) scopedMetrics.push(...toPairs(await kpis(tx, organizationId, { days, productId: p.id }), { productId: p.id, productName: p.name }));

  const since = addDays(new Date(), -days);
  const published = await tx.select().from(contentAssets).where(and(eq(contentAssets.organizationId, organizationId), isNotNull(contentAssets.publishedVersionId), gte(contentAssets.publishedAt, since)));
  const dist = await tx.select().from(distributionTargets).where(and(eq(distributionTargets.organizationId, organizationId), eq(distributionTargets.status, "PUBLISHED"), gte(distributionTargets.updatedAt, since)));
  const errors = await tx.select().from(integrations).where(and(eq(integrations.organizationId, organizationId), inArray(integrations.status, ["ERROR", "EXPIRED"])));
  const PROVIDER_METRICS: Record<string, string[]> = { GOOGLE_SEARCH_CONSOLE: ["clicks", "impressions"], BING_WEBMASTER: ["clicks", "impressions"], GOOGLE_ANALYTICS: ["ai_referrals", "visitors"], STRIPE: ["new_subs", "beacon_mrr"] };
  const events: PeriodEvent[] = [
    ...published.map((p) => ({ kind: "CONTENT_PUBLISHED" as const, label: `Published: ${p.title}`, at: (p.publishedAt ?? p.updatedAt).toISOString(), productId: p.productId })),
    ...dist.map((d) => ({ kind: "DISTRIBUTION_PUBLISHED" as const, label: `Listed on ${d.name}`, at: d.updatedAt.toISOString(), productId: d.productId })),
    ...errors.map((e) => ({ kind: "INTEGRATION_ERROR" as const, label: `${e.provider} sync error`, at: e.updatedAt.toISOString(), productId: e.productId, metricKeys: PROVIDER_METRICS[e.provider] ?? [] })),
  ];
  const opps = await tx.select().from(opportunities).where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.status, "OPEN")));
  const crit = await tx.execute<{ rule: string; n: number; product_id: string | null }>(sql`
    select i.rule, a.product_id, count(*)::int as n from seo_issues i
    join (select distinct on (product_id) id, product_id from seo_audits where organization_id = ${organizationId} and status = 'SUCCEEDED' order by product_id, created_at desc) a on a.id = i.audit_id
    where i.severity = 'CRITICAL' and i.status = 'OPEN' group by i.rule, a.product_id`);
  const connected = [...new Set((await tx.select({ p: integrations.provider }).from(integrations).where(and(eq(integrations.organizationId, organizationId), eq(integrations.status, "CONNECTED")))).map((r) => r.p))];
  const missing = ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "STRIPE"].filter((p) => !connected.includes(p as never));

  const analysis = analyzeGrowth({
    metrics,
    scopedMetrics: prods.length ? scopedMetrics : undefined,
    events,
    opportunities: opps.map((o) => ({ id: o.id, productId: o.productId, title: o.title, potential: o.potential, priorityScore: o.priorityScore, type: o.type })),
    openCriticalIssues: crit.rows.map((r) => ({ rule: r.rule, count: Number(r.n), productId: r.product_id })),
    connected,
    missing,
  });
  const [report] = await tx
    .insert(growthReports)
    .values({ organizationId, periodStart: isoDay(since), periodEnd: isoDay(new Date()), sections: analysis, generatedBy: "beacon-analyst:rules-v2" })
    .returning();
  // Analyst findings that are not opportunities (critical issues), then the top opportunities per product.
  for (const a of analysis.recommendedActions.filter((x) => !x.opportunityId).slice(0, 10))
    await proposeRecommendation(tx, organizationId, { reportId: report.id, kind: a.kind, title: a.title, body: a.body, requiresApproval: a.requiresApproval, productId: a.productId ?? null, source: "ANALYST", targetRef: { productId: a.productId ?? null, opportunityType: a.kind } });
  await identifyRecommendations(tx, organizationId, { reportId: report.id });
  return report;
}

/** Insert one proposal unless an open (PROPOSED or APPROVED) copy with the same key exists. Returns the new row or null. */
async function proposeRecommendation(
  tx: Tx,
  organizationId: string,
  r: { reportId?: string | null; kind: string; title: string; body: string; requiresApproval: boolean; productId: string | null; opportunityId?: string | null; source: "OPPORTUNITY" | "ANALYST"; targetRef: RecommendationTarget },
) {
  const dedupeKey = dedupeKeyFor(r);
  const [row] = await tx
    .insert(recommendations)
    .values({ organizationId, reportId: r.reportId ?? null, productId: r.productId, opportunityId: r.opportunityId ?? null, source: r.source, dedupeKey, kind: r.kind, title: r.title, body: r.body, requiresApproval: r.requiresApproval, targetRef: r.targetRef })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Target of an opportunity: product, queries (text), pages and paths its metric is measured on. */
async function targetOf(tx: Tx, o: Opp): Promise<RecommendationTarget> {
  const ids = [...new Set([...(o.sources.queryIds ?? []), ...(o.queryId ? [o.queryId] : [])])].slice(0, 50);
  const qs = ids.length ? await tx.select({ query: queries.query }).from(queries).where(and(eq(queries.organizationId, o.organizationId), inArray(queries.id, ids))) : [];
  const path = o.type === "CONVERSION" ? /^cta:[^:]+:(.+)$/.exec(o.fingerprint)?.[1] : undefined;
  const domain = o.type === "CITATION" ? /^citation:[^:]+:(.+)$/.exec(o.fingerprint)?.[1] : undefined;
  return {
    productId: o.productId,
    opportunityType: o.type,
    ...(qs.length ? { queries: qs.map((q) => q.query) } : {}),
    ...(o.sources.urls?.length && o.type !== "CITATION" ? { pages: o.sources.urls.slice(0, 50) } : {}),
    ...(path ? { pagePaths: [path] } : {}),
    ...(o.sources.clusterId ? { clusterId: o.sources.clusterId } : {}),
    ...(domain ? { domain } : {}),
  };
}

const REPROPOSE_AFTER_DAYS = 90;
const PER_PRODUCT = 3;
const MAX_PER_RUN = 15;

/**
 * IDENTIFY + RECOMMEND: the top open opportunities of each product become
 * recommendations (deduped by opportunity; one rejected or measured in the
 * last 90 days is not proposed again). Runs weekly and after search syncs.
 */
export async function identifyRecommendations(tx: Tx, organizationId: string, opts: { productId?: string | null; reportId?: string | null } = {}) {
  const open = await tx
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.status, "OPEN"), isNotNull(opportunities.productId), opts.productId ? eq(opportunities.productId, opts.productId) : undefined))
    .orderBy(desc(opportunities.priorityScore), opportunities.fingerprint);
  const recent = await tx
    .select({ opportunityId: recommendations.opportunityId })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.organizationId, organizationId),
        isNotNull(recommendations.opportunityId),
        or(inArray(recommendations.status, ["PROPOSED", "APPROVED"]), gte(recommendations.decidedAt, addDays(new Date(), -REPROPOSE_AFTER_DAYS)), gte(recommendations.measuredAt, addDays(new Date(), -REPROPOSE_AFTER_DAYS))),
      ),
    );
  const skip = new Set(recent.map((r) => r.opportunityId));
  const perProduct = new Map<string, number>();
  let created = 0;
  for (const o of open) {
    if (created >= MAX_PER_RUN) break;
    if (skip.has(o.id)) continue;
    const n = perProduct.get(o.productId!) ?? 0;
    if (n >= PER_PRODUCT) continue;
    perProduct.set(o.productId!, n + 1);
    const row = await proposeRecommendation(tx, organizationId, {
      reportId: opts.reportId ?? null,
      kind: o.type,
      title: o.title,
      body: `From opportunity (${o.type}, ${o.potential} potential).`,
      requiresApproval: true,
      productId: o.productId,
      opportunityId: o.id,
      source: "OPPORTUNITY",
      targetRef: await targetOf(tx, o),
    });
    if (row) created++;
  }
  return { created };
}

// ─── APPROVE → EXECUTE ──────────────────────────────────────────────────────

async function getRec(tx: Tx, organizationId: string, id: string) {
  const r = await tx.query.recommendations.findFirst({ where: and(eq(recommendations.id, id), eq(recommendations.organizationId, organizationId)) });
  if (!r) throw new Error("Recommendation not found");
  return r;
}

/**
 * Human decision on a recommendation. REJECTED and APPROVED only from
 * PROPOSED; APPROVED records the baseline, then dispatches the safe execution
 * (never publication or external submission) and schedules the measurement.
 * DONE closes an approved recommendation by hand.
 */
export async function decideRecommendation(tx: Tx, actor: Actor, id: string, status: "APPROVED" | "REJECTED" | "DONE", now = new Date()) {
  const r = await getRec(tx, actor.organizationId, id);
  if (status === "DONE") {
    if (r.status !== "APPROVED") throw new Error("Only an approved recommendation can be marked done.");
  } else if (r.status !== "PROPOSED") throw new Error("This recommendation was already decided.");
  await tx.update(recommendations).set({ status, decidedBy: actor.userId ?? null, decidedAt: now }).where(eq(recommendations.id, r.id));
  await audit(tx, actor, "recommendation.decide", "recommendation", r.id, { status, kind: r.kind });
  if (status !== "APPROVED") return { ...r, status };
  return executeRecommendation(tx, actor, { ...r, status, decidedAt: now }, now);
}

/** EXECUTE: dispatch by kind inside savepoints; failures are recorded, never fatal for the approval. */
export async function executeRecommendation(tx: Tx, actor: Actor, r: Rec, now = new Date()) {
  const o = r.opportunityId ? ((await tx.query.opportunities.findFirst({ where: and(eq(opportunities.id, r.opportunityId), eq(opportunities.organizationId, actor.organizationId)) })) ?? null) : null;
  const productId = r.productId ?? o?.productId ?? null;
  const product = productId ? await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) }) : null;
  const target: RecommendationTarget = { ...r.targetRef, productId };
  const kind = measureKindFor(r.kind);
  const baseline = await measurementSnapshot(tx, actor.organizationId, kind, target, baselineWindow(now), now);

  // Context for a cluster page plan: the cluster's queries and the latest crawl's pages.
  const crawl = r.kind === "CONTENT_GAP" && productId ? await latestAudit(tx, actor.organizationId, productId) : null;
  const crawled = crawl ? await tx.select({ url: crawledPages.url, title: crawledPages.title, text: crawledPages.textSample }).from(crawledPages).where(eq(crawledPages.auditId, crawl.id)).limit(500) : [];
  const cta = product?.conversionUrls?.[0] ? { label: product.conversionUrls[0].label, url: product.conversionUrls[0].url } : null;
  const plan: ExecutionPlan = planExecution({ kind: r.kind, title: r.title }, { productName: product?.name, queries: target.queries, crawledPages: crawled.map((p) => ({ url: p.url, title: p.title, text: p.text ?? "" })), cta });

  const refs: ExecutedRef[] = [];
  const errors: string[] = [];
  const attempt = async (label: string, fn: (sp: Tx) => Promise<void>) => {
    try {
      await tx.transaction(async (sp) => fn(sp as unknown as Tx));
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      refs.push({ type: "task", href: o?.nextAction?.href ?? "/autopilot", label, status: "SKIPPED", reason: (e as Error).message });
    }
  };

  if (plan.action === "CREATE_CONTENT") {
    await attempt("Create a content draft", async (sp) => {
      if (!o) throw new Error("No opportunity to draft from.");
      const asset = await createAssetFromOpportunity(sp, actor, o.id, plan.contentType!);
      if (plan.page) {
        const p = plan.page;
        const brief = [`${o.title}`, o.problem, `Page title: ${p.title}`, `Meta description: ${p.description}`, p.faq.length ? `FAQ: ${p.faq.join(" | ")}` : "", `Schema: ${p.schemaTypes.join(", ")}`, p.cta ? `CTA: ${p.cta.label} (${p.cta.url})` : ""].filter(Boolean).join("\n");
        await sp.update(contentAssets).set({ brief: brief.slice(0, 4000) }).where(eq(contentAssets.id, asset.id));
      }
      await enqueue("content.generate", { assetId: asset.id, userId: actor.userId ?? null, baseVersion: 0, baseStatus: "IDEA" }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:1` });
      refs.push({ type: "content_asset", id: asset.id, href: `/content/${asset.id}`, label: asset.title, status: "DONE" });
    });
  } else if (plan.action === "CREATE_EXPERIMENT") {
    await attempt("Create an experiment draft", async (sp) => {
      const e = plan.experiment!;
      const pagePath = target.pagePaths?.[0];
      const [x] = await sp
        .insert(experiments)
        .values({
          organizationId: actor.organizationId,
          productId,
          recommendationId: r.id,
          name: e.name,
          hypothesis: e.hypothesis,
          primaryMetric: e.primaryMetric,
          signalToMonitor: e.signalToMonitor,
          metricKey: e.metricKey,
          control: { description: "Current page", ...(pagePath && product?.domain ? { url: `https://${product.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}${pagePath}` } : {}) },
          variant: { description: "Intent-matched CTA above the fold" },
        })
        .returning();
      await audit(sp, actor, "experiment.create", "experiment", x.id, { recommendationId: r.id });
      refs.push({ type: "experiment", id: x.id, href: `/autopilot#experiment-${x.id}`, label: x.name, status: "DONE" });
    });
  } else if (plan.action === "QUEUE_AUDIT") {
    await attempt("Queue a technical audit", async (sp) => {
      if (!productId) throw new Error("No product to audit.");
      const a = await queueAudit(sp, actor, productId);
      refs.push({ type: "seo_audit", id: a.id, href: `/discovery/audits/${a.id}`, label: a.startUrl, status: "DONE" });
    });
  } else if (plan.action === "PREPARE_DISTRIBUTION") {
    await attempt("Prepare distribution targets", async (sp) => {
      if (!o) throw new Error("No opportunity to prepare targets from.");
      const created = await prepareTargetsForOpportunity(sp, actor, o);
      if (!created.length) throw new Error("No new fitting venue to add.");
      for (const t of created) refs.push({ type: "distribution_target", id: t.id, href: "/distribution", label: t.name, status: "DONE" });
    });
  } else {
    refs.push({ type: "task", href: o?.nextAction?.href ?? "/opportunities", label: plan.steps[0], status: "DONE" });
  }

  const measureAfter = dayPlus(now, MEASURE_AFTER_DAYS);
  const [updated] = await tx
    .update(recommendations)
    .set({ baseline, executionPlan: plan, executedRef: refs, executedAt: now, executionError: errors.length ? errors.join(" ").slice(0, 2000) : null, measureAfter, targetRef: target })
    .where(eq(recommendations.id, r.id))
    .returning();
  await audit(tx, actor, "recommendation.execute", "recommendation", r.id, { action: plan.action, refs: refs.map((x) => `${x.type}:${x.id ?? x.status}`), baselineState: baseline.state, measureAfter });
  await enqueue("recommendation.measure", { recommendationId: r.id }, { organizationId: actor.organizationId, idempotencyKey: `measure:${r.id}`, runAt: new Date(`${measureAfter}T06:00:00Z`) });
  return updated;
}

// ─── MEASURE → LEARN ────────────────────────────────────────────────────────

const SIGNUP_TYPES = sql`('SIGNUP', 'SIGNUP_COMPLETED', 'TRIAL_STARTED', 'SUBSCRIBED', 'SUBSCRIPTION_STARTED')`;

/**
 * Metric values for a target and a window, with the data state:
 * SEARCH (search_daily clicks and impressions on the target queries, else its
 * pages, else the product), CONVERSIONS (CTA clicks on the target paths, else
 * signups), AI_REFERRALS (tracker visits from AI assistants).
 */
export async function measurementSnapshot(tx: Tx, organizationId: string, kind: MeasureKind, target: RecommendationTarget, window: DayWindow, now = new Date()): Promise<MeasurementSnapshot> {
  const productId = target.productId ?? null;
  const takenAt = now.toISOString();
  const a = await availability(tx, organizationId, productId);
  const pf = productId ? sql`and product_id = ${productId}` : sql``;
  const between = sql`day between ${window.start}::date and ${window.end}::date`;
  const inWindow = sql`occurred_at >= ${window.start}::date and occurred_at < (${window.end}::date + 1)`;
  if (kind === "SEARCH") {
    if (!a.searchConnected) return { kind, state: "NOT_CONNECTED", window, metrics: [], source: "Search Console / Bing", scope: "", takenAt };
    const provs = await tx.execute<{ p: string }>(sql`select distinct provider::text as p from search_daily where organization_id = ${organizationId} ${pf} and ${between}`);
    const source = `search_daily (${provs.rows.map((r) => r.p).sort().join(", ") || "Search Console / Bing"})`;
    if (!provs.rows.length) return { kind, state: "NO_DATA_YET", window, metrics: [], source, scope: "", takenAt };
    let clicks = 0;
    let impressions = 0;
    let scope = "product";
    if (target.queries?.length) {
      scope = `${target.queries.length} quer${target.queries.length === 1 ? "y" : "ies"}`;
      const wanted = target.queries.map((q) => q.trim().toLowerCase());
      const rows = await tx.execute<{ grain: string; clicks: number; impressions: number }>(sql`
        select case when page is null then 'q' else 'qp' end as grain, coalesce(sum(clicks), 0)::float as clicks, coalesce(sum(impressions), 0)::float as impressions
        from search_daily where organization_id = ${organizationId} ${pf} and ${between} and query is not null and country is null and device is null
          and lower(trim(query)) in (${sql.join(wanted.map((q) => sql`${q}`), sql`, `)})
        group by 1`);
      const pick = rows.rows.find((r) => r.grain === "q") ?? rows.rows.find((r) => r.grain === "qp");
      clicks = Number(pick?.clicks ?? 0);
      impressions = Number(pick?.impressions ?? 0);
    } else if (target.pages?.length) {
      scope = `${target.pages.length} page(s)`;
      const rows = await tx.execute<{ grain: string; clicks: number; impressions: number }>(sql`
        select case when query is null then 'p' else 'qp' end as grain, coalesce(sum(clicks), 0)::float as clicks, coalesce(sum(impressions), 0)::float as impressions
        from search_daily where organization_id = ${organizationId} ${pf} and ${between} and page in (${sql.join(target.pages.map((p) => sql`${p}`), sql`, `)}) and country is null and device is null
        group by 1`);
      const pick = rows.rows.find((r) => r.grain === "p") ?? rows.rows.find((r) => r.grain === "qp");
      clicks = Number(pick?.clicks ?? 0);
      impressions = Number(pick?.impressions ?? 0);
    } else {
      const row = (
        await tx.execute<{ clicks: number; impressions: number }>(sql`
        select coalesce(sum(clicks), 0)::float as clicks, coalesce(sum(impressions), 0)::float as impressions from search_daily
        where organization_id = ${organizationId} ${pf} and ${between} and query is null and page is null and country is null and device is null`)
      ).rows[0];
      clicks = Number(row?.clicks ?? 0);
      impressions = Number(row?.impressions ?? 0);
    }
    return { kind, state: "OK", window, metrics: [{ key: "clicks", value: clicks }, { key: "impressions", value: impressions }], source, scope, takenAt };
  }
  if (!a.trackerKey) return { kind, state: "NOT_CONNECTED", window, metrics: [], source: "Beacon tracker", scope: "", takenAt };
  if (kind === "CONVERSIONS") {
    if (!a.events) return { kind, state: "NO_DATA_YET", window, metrics: [], source: "Beacon tracker (conversion_events)", scope: "", takenAt };
    const paths = target.pagePaths ?? [];
    const row = (
      await tx.execute<{ n: number }>(
        paths.length
          ? sql`select count(*)::int as n from conversion_events where organization_id = ${organizationId} ${pf} and ${inWindow} and type = 'CTA_CLICK' and page_path in (${sql.join(paths.map((p) => sql`${p}`), sql`, `)})`
          : sql`select count(*)::int as n from conversion_events where organization_id = ${organizationId} ${pf} and ${inWindow} and type::text in ${SIGNUP_TYPES}`,
      )
    ).rows[0];
    return { kind, state: "OK", window, metrics: [{ key: "conversions", value: Number(row?.n ?? 0) }], source: paths.length ? "Beacon tracker (CTA clicks)" : "Beacon tracker (signups and subscriptions)", scope: paths.length ? paths.join(", ") : "product", takenAt };
  }
  const any = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from attribution_events where organization_id = ${organizationId} ${pf}`)).rows[0];
  if (!Number(any?.n)) return { kind, state: "NO_DATA_YET", window, metrics: [], source: "Beacon tracker (AI-assistant referrers)", scope: "", takenAt };
  const row = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from attribution_events where organization_id = ${organizationId} ${pf} and ${inWindow} and channel = 'AI_REFERRAL'`)).rows[0];
  return { kind, state: "OK", window, metrics: [{ key: "ai_referrals", value: Number(row?.n ?? 0) }], source: "Beacon tracker (AI-assistant referrers)", scope: "product", takenAt };
}

/**
 * MEASURE (job `recommendation.measure`, at measure_after): compare the
 * target metric over the measured window with the baseline, label the
 * outcome (correlation, not causation), close the recommendation and LEARN.
 */
export async function measureRecommendation(tx: Tx, organizationId: string, id: string, now = new Date()) {
  const r = await getRec(tx, organizationId, id);
  if (!r.executedAt || !r.measureAfter) return { skipped: "not executed" };
  if (r.outcomeLabel) return { skipped: "already measured", label: r.outcomeLabel };
  if (isoDay(now) < r.measureAfter) return { skipped: "not due", measureAfter: r.measureAfter };
  const kind = r.baseline?.kind ?? measureKindFor(r.kind);
  const measured = await measurementSnapshot(tx, organizationId, kind, r.targetRef, measuredWindow(r.executedAt, r.measureAfter), now);
  const outcome = labelOutcome(r.baseline ?? null, measured);
  await tx.update(recommendations).set({ outcome, outcomeLabel: outcome.label, measuredAt: now, status: "DONE" }).where(eq(recommendations.id, r.id));
  const type = r.targetRef.opportunityType ?? r.kind;
  if (r.opportunityId || r.source === "OPPORTUNITY") await recordLearning(tx, organizationId, type, outcome.label);
  await audit(tx, { organizationId, actorType: "SYSTEM" }, "recommendation.measure", "recommendation", r.id, { label: outcome.label, primary: primaryMetric(kind), before: outcome.before, after: outcome.after });
  return { label: outcome.label, outcome };
}

/** Recommendations whose measurement is due (any organisation visible to the caller), for the scheduler. */
export async function dueMeasurements(tx: Tx, today = isoDay(new Date())) {
  return tx
    .select({ id: recommendations.id, organizationId: recommendations.organizationId })
    .from(recommendations)
    .where(and(isNotNull(recommendations.executedAt), isNull(recommendations.outcomeLabel), lte(recommendations.measureAfter, today)))
    .limit(500);
}

// ─── Loop view ──────────────────────────────────────────────────────────────

export type LoopItem = Rec & { stage: LoopStage; opportunityTitle: string | null; productName: string | null; artefacts: (ExecutedRef & { currentStatus?: string | null })[] };

/** Recommendations with their loop stage and the live status of what their execution created. */
export async function autopilotLoop(tx: Tx, organizationId: string, opts: { limit?: number } = {}) {
  const rows = await tx
    .select({ r: recommendations, productName: products.name, oppTitle: opportunities.title })
    .from(recommendations)
    .leftJoin(products, eq(products.id, recommendations.productId))
    .leftJoin(opportunities, eq(opportunities.id, recommendations.opportunityId))
    .where(and(eq(recommendations.organizationId, organizationId), or(inArray(recommendations.status, ["PROPOSED", "APPROVED"]), isNotNull(recommendations.measuredAt), gte(recommendations.decidedAt, addDays(new Date(), -120)))))
    .orderBy(desc(recommendations.createdAt))
    .limit(opts.limit ?? 120);
  const refs = rows.flatMap((x) => x.r.executedRef ?? []);
  const ids = (t: ExecutedRef["type"]) => [...new Set(refs.filter((x) => x.type === t && x.id).map((x) => x.id!))];
  const assetIds = ids("content_asset");
  const expIds = ids("experiment");
  const auditIds = ids("seo_audit");
  const assets = assetIds.length ? await tx.select({ id: contentAssets.id, status: contentAssets.status }).from(contentAssets).where(and(eq(contentAssets.organizationId, organizationId), inArray(contentAssets.id, assetIds))) : [];
  const exps = expIds.length ? await tx.select({ id: experiments.id, status: experiments.status }).from(experiments).where(and(eq(experiments.organizationId, organizationId), inArray(experiments.id, expIds))) : [];
  const audits = auditIds.length ? await tx.select({ id: seoAudits.id, status: seoAudits.status }).from(seoAudits).where(and(eq(seoAudits.organizationId, organizationId), inArray(seoAudits.id, auditIds))) : [];
  const status = new Map<string, string>([...assets, ...exps, ...audits].map((x) => [x.id, x.status]));
  const PENDING = new Set(["IDEA", "GENERATED", "FACT_CHECK", "SEO_CHECK", "HUMAN_APPROVAL", "DRAFT", "RUNNING", "READY_FOR_REVIEW", "QUEUED"]);
  return rows.map(({ r, productName, oppTitle }): LoopItem => {
    const artefacts = (r.executedRef ?? []).map((x) => ({ ...x, currentStatus: x.id ? (status.get(x.id) ?? null) : null }));
    const pending = artefacts.some((x) => x.currentStatus && PENDING.has(x.currentStatus));
    return { ...r, stage: loopStage(r, pending), opportunityTitle: oppTitle ?? null, productName: productName ?? null, artefacts };
  });
}

