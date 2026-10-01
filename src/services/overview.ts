import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { AttentionItem } from "@/core/command/attention";
import type { T } from "@/i18n/core";
import { BEACON_CHANNELS, dailySeries, kpis } from "./metrics";
import { latestScores } from "./score";

type Row = Record<string, number | string | null>;

/** Everything the daily command center measures for an organisation (current window vs previous window of `days`). */
export async function commandCenterData(tx: Tx, org: string, days: number) {
  const channelList = sql.join(BEACON_CHANNELS.map((c) => sql`${c}`), sql`, `);
  const counts = (
    await tx.execute<Row>(sql`
      select
        (select count(*) from seo_issues i join (select distinct on (product_id) id from seo_audits where organization_id = ${org} and status = 'SUCCEEDED' order by product_id, created_at desc) a on a.id = i.audit_id where i.severity = 'CRITICAL' and i.status = 'OPEN')::int as critical_issues,
        (select count(*) from opportunities where organization_id = ${org} and status = 'OPEN' and potential = 'HIGH')::int as high_opps,
        (select count(*) from content_assets where organization_id = ${org} and status = 'HUMAN_APPROVAL')::int as drafts_ready,
        (select count(*) from content_assets where organization_id = ${org} and status in ('FACT_CHECK','SEO_CHECK'))::int as drafts_blocked,
        (select count(*) from revenue_events where organization_id = ${org} and type = 'NEW' and channel in ('REFERRAL','AFFILIATE') and occurred_at >= now() - interval '7 days')::int as referral_conv,
        (select coalesce(sum(mrr_delta_cents), 0) from revenue_events where organization_id = ${org} and occurred_at >= now() - interval '7 days' and channel::text in (${channelList}))::bigint as beacon_mrr_7d,
        (select min(currency) from revenue_events where organization_id = ${org}) as currency,
        (select count(*) from experiments where organization_id = ${org} and status = 'READY_FOR_REVIEW')::int as experiments_ready,
        (select count(*) from distribution_targets where organization_id = ${org} and status = 'PREPARED' and submission_approved_at is null)::int as dist_pending,
        (select count(*) from recommendations where organization_id = ${org} and status = 'PROPOSED')::int as recs,
        (select count(*) from integrations where organization_id = ${org} and status = 'ERROR')::int as integ_errors,
        (select count(*) from products where organization_id = ${org})::int as products,
        (select count(*) from products where organization_id = ${org} and onboarding_completed_at is null)::int as onboarding_open,
        (select count(*) from commissions where organization_id = ${org} and status = 'ON_HOLD')::int as commissions_hold`)
  ).rows[0];
  const losing = (
    await tx.execute<{ name: string; slug: string; now: number; prev: number }>(sql`
      select p.name, p.slug, coalesce(sum(m.value) filter (where m.day >= current_date - 31), 0)::float as now,
        coalesce(sum(m.value) filter (where m.day < current_date - 31 and m.day >= current_date - 59), 0)::float as prev
      from products p join visibility_metrics m on m.product_id = p.id and m.metric = 'search_clicks' and m.dimension = ''
      where p.organization_id = ${org} group by p.name, p.slug
      having coalesce(sum(m.value) filter (where m.day < current_date - 31 and m.day >= current_date - 59), 0) >= 30
         and coalesce(sum(m.value) filter (where m.day >= current_date - 31), 0) < 0.8 * coalesce(sum(m.value) filter (where m.day < current_date - 31 and m.day >= current_date - 59), 0)`)
  ).rows;
  const failedJobs = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from jobs where organization_id = ${org} and status = 'DEAD' and finished_at >= now() - interval '24 hours'`)).rows[0];
  const products = (await tx.execute<{ id: string; name: string; slug: string; status: string }>(sql`select id, name, slug, status from products where organization_id = ${org} order by name`)).rows;
  const scores = await latestScores(tx, org);
  const k = await kpis(tx, org, { days });
  const series = await dailySeries(tx, org, days);
  return { counts, losing, failedJobs: Number(failedJobs?.n ?? 0), products, scores, k, series };
}

export type CommandCenterData = Awaited<ReturnType<typeof commandCenterData>>;

/** The "What needs my attention today?" candidates (rank them with `prioritizeAttention`). */
export function attentionItems(data: Pick<CommandCenterData, "counts" | "losing" | "failedJobs">, t: T): AttentionItem[] {
  const c = data.counts ?? {};
  const n = (v: unknown) => Number(v ?? 0);
  const pl = (count: number, one: string, many: string) => t(count === 1 ? one : many, { n: count });
  return [
    { key: "crit", title: pl(n(c.critical_issues), "{n} critical SEO problem", "{n} critical SEO problems"), detail: t("Open critical issues in the latest technical audits."), href: "/discovery", count: n(c.critical_issues), impact: 5, confidence: 5, effort: 2, urgency: 5 },
    { key: "losing", title: pl(data.losing.length, "{n} product losing organic visibility", "{n} products losing organic visibility"), detail: data.losing.map((l) => t("{name} ({pct}% fewer clicks)", { name: l.name, pct: Math.round((1 - l.now / l.prev) * 100) })).join(", "), href: "/opportunities", count: data.losing.length, impact: 5, confidence: 4, effort: 3, urgency: 5 },
    { key: "opps", title: pl(n(c.high_opps), "{n} high-potential opportunity", "{n} high-potential opportunities"), detail: t("Prioritised by impact × confidence × urgency ÷ effort."), href: "/opportunities?potential=HIGH", count: n(c.high_opps), impact: 4, confidence: 3, effort: 3, urgency: 3 },
    { key: "drafts", title: pl(n(c.drafts_ready), "{n} content draft ready for approval", "{n} content drafts ready for approval"), detail: t("Passed fact and SEO/GEO checks — awaiting a human decision."), href: "/content?status=HUMAN_APPROVAL", count: n(c.drafts_ready), impact: 3, confidence: 5, effort: 1, urgency: 3 },
    { key: "blocked", title: pl(n(c.drafts_blocked), "{n} draft blocked by checks", "{n} drafts blocked by checks"), detail: t("Unsupported claims or SEO issues need an editor."), href: "/content", count: n(c.drafts_blocked), impact: 2, confidence: 5, effort: 2, urgency: 2 },
    { key: "dist", title: pl(n(c.dist_pending), "{n} external submission awaiting approval", "{n} external submissions awaiting approval"), detail: t("Prepared distribution targets — nothing is submitted without approval."), href: "/distribution", count: n(c.dist_pending), impact: 3, confidence: 3, effort: 1, urgency: 2 },
    { key: "recs", title: pl(n(c.recs), "{n} autopilot recommendation to review", "{n} autopilot recommendations to review"), detail: t("Proposed by the growth analyst."), href: "/autopilot", count: n(c.recs), impact: 3, confidence: 3, effort: 1, urgency: 2 },
    { key: "exp", title: pl(n(c.experiments_ready), "{n} experiment ready for review", "{n} experiments ready for review"), detail: t("Conclude and record results."), href: "/autopilot#experiments", count: n(c.experiments_ready), impact: 3, confidence: 4, effort: 1, urgency: 3 },
    { key: "ref", title: pl(n(c.referral_conv), "{n} new referral conversion (7d)", "{n} new referral conversions (7d)"), detail: t("New subscriptions attributed to referral/affiliate links."), href: "/referrals", count: n(c.referral_conv), impact: 2, confidence: 5, effort: 1, urgency: 1 },
    { key: "hold", title: pl(n(c.commissions_hold), "{n} commission on hold (fraud flags)", "{n} commissions on hold (fraud flags)"), detail: t("Review before payout."), href: "/referrals", count: n(c.commissions_hold), impact: 2, confidence: 4, effort: 1, urgency: 3 },
    { key: "integ", title: pl(n(c.integ_errors), "{n} integration failing", "{n} integrations failing"), detail: t("Data is going stale."), href: "/settings/integrations", count: n(c.integ_errors), impact: 4, confidence: 5, effort: 1, urgency: 4 },
    { key: "jobs", title: pl(data.failedJobs, "{n} background job failed (24h)", "{n} background jobs failed (24h)"), detail: t("Exhausted retries."), href: "/settings/health", count: data.failedJobs, impact: 3, confidence: 5, effort: 1, urgency: 3 },
    { key: "onb", title: pl(n(c.onboarding_open), "{n} product with incomplete onboarding", "{n} products with incomplete onboarding"), detail: t("Finish onboarding to start analysis."), href: "/products", count: n(c.onboarding_open), impact: 4, confidence: 5, effort: 2, urgency: 2 },
  ];
}
