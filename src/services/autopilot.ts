import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { contentAssets, distributionTargets, growthReports, integrations, opportunities, recommendations } from "@/db/schema";
import { analyzeGrowth, type MetricPair, type PeriodEvent } from "@/core/autopilot/analyst";
import { addDays, isoDay } from "@/core/util/text";
import { kpis } from "./metrics";

/** Weekly growth analyst report. Deterministic; proposals land as recommendations awaiting approval. */
export async function generateGrowthReport(tx: Tx, organizationId: string, days = 7) {
  const k = await kpis(tx, organizationId, { days });
  const metrics: MetricPair[] = [];
  const push = (key: string, label: string, v: { now: number | null; prev: number | null; source: string }, unit: MetricPair["unit"] = "count") => {
    if (v.now !== null && v.prev !== null) metrics.push({ key, label, now: v.now, prev: v.prev, unit, source: v.source });
  };
  push("clicks", "Organic clicks", k.discovery.organicClicks);
  push("impressions", "Organic impressions", k.discovery.organicImpressions);
  push("ai_referrals", "AI-assistant referrals", k.discovery.aiReferrals);
  push("visitors", "Visitors", k.acquisition.visitors);
  push("signups", "Signups", k.acquisition.signups);
  push("new_subs", "New subscriptions", k.revenue.newSubscriptions);
  push("beacon_mrr", "New MRR via Beacon channels", k.revenue.beaconNewMrr, "cents");

  const since = addDays(new Date(), -days);
  const published = await tx.select().from(contentAssets).where(and(eq(contentAssets.organizationId, organizationId), eq(contentAssets.status, "PUBLISHED"), gte(contentAssets.publishedAt, since)));
  const dist = await tx.select().from(distributionTargets).where(and(eq(distributionTargets.organizationId, organizationId), eq(distributionTargets.status, "PUBLISHED"), gte(distributionTargets.updatedAt, since)));
  const errors = await tx.select().from(integrations).where(and(eq(integrations.organizationId, organizationId), eq(integrations.status, "ERROR")));
  const events: PeriodEvent[] = [
    ...published.map((p) => ({ kind: "CONTENT_PUBLISHED" as const, label: `Published: ${p.title}`, at: (p.publishedAt ?? p.updatedAt).toISOString(), productId: p.productId })),
    ...dist.map((d) => ({ kind: "DISTRIBUTION_PUBLISHED" as const, label: `Listed on ${d.name}`, at: d.updatedAt.toISOString(), productId: d.productId })),
    ...errors.map((e) => ({ kind: "INTEGRATION_ERROR" as const, label: `${e.provider} sync error`, at: e.updatedAt.toISOString() })),
  ];
  const opps = await tx.select().from(opportunities).where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.status, "OPEN")));
  const crit = await tx.execute<{ rule: string; n: number }>(sql`
    select i.rule, count(*)::int as n from seo_issues i
    join (select distinct on (product_id) id from seo_audits where organization_id = ${organizationId} and status = 'SUCCEEDED' order by product_id, created_at desc) a on a.id = i.audit_id
    where i.severity = 'CRITICAL' and i.status = 'OPEN' group by i.rule`);
  const connected = [...new Set((await tx.select({ p: integrations.provider }).from(integrations).where(and(eq(integrations.organizationId, organizationId), eq(integrations.status, "CONNECTED")))).map((r) => r.p))];
  const missing = ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "STRIPE"].filter((p) => !connected.includes(p as never));

  const analysis = analyzeGrowth({
    metrics,
    events,
    opportunities: opps.map((o) => ({ title: o.title, potential: o.potential, priorityScore: o.priorityScore, type: o.type })),
    openCriticalIssues: crit.rows.map((r) => ({ rule: r.rule, count: Number(r.n) })),
    connected,
    missing,
  });
  const [report] = await tx
    .insert(growthReports)
    .values({ organizationId, periodStart: isoDay(since), periodEnd: isoDay(new Date()), sections: analysis, generatedBy: "beacon-analyst:rules-v1" })
    .returning();
  for (const a of analysis.recommendedActions.slice(0, 10))
    await tx.insert(recommendations).values({ organizationId, reportId: report.id, kind: a.kind, title: a.title, body: a.body, requiresApproval: a.requiresApproval });
  return report;
}
