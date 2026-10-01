import Link from "next/link";
import { sql } from "drizzle-orm";
import { EmptyState, LinkButton, PageHeader, Panel, Stat, Table, Td, Th, formatValue } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { RangePicker } from "@/components/shell/product-tabs";
import { prioritizeAttention, type AttentionItem } from "@/core/command/attention";
import { dailySeries, kpis, BEACON_CHANNELS } from "@/services/metrics";
import { latestScores } from "@/services/score";
import { daysParam, pageData, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Command center") };
}

type Row = Record<string, number | string | null>;

export default async function CommandCenter({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const days = daysParam(sp);
  const { data, ctx } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
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
  });
  const { t, intl, locale } = await getI18n();
  const c = data.counts;
  const n = (v: unknown) => Number(v ?? 0);
  const k = data.k;

  const pl = (count: number, one: string, many: string) => t(count === 1 ? one : many, { n: count });
  const items: AttentionItem[] = [
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
  const attention = prioritizeAttention(items);
  const mrr7 = n(c.beacon_mrr_7d);
  const channelLabel = (v: string) => (locale === "fr" ? enumLabel(t, v) : v).toLocaleLowerCase(intl);
  const today = new Date().toLocaleDateString(intl, { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <PageHeader eyebrow={t("01 / Overview · {date}", { date: today })} title={t("What needs my attention today?")} description={t("{org} ecosystem — {n} product(s). Everything below is measured; unconnected sources are shown as such, never estimated.", { org: ctx.org.branding.displayName ?? ctx.org.name, n: n(c.products) })} actions={<RangePicker base="/" days={days} />} />

      {n(c.products) === 0 ? (
        <EmptyState title={t("Start here")} action={<LinkButton variant="gold" href="/products">{t("Add your first product →")}</LinkButton>}>
          {t("Beacon has no products yet. Onboard a Novarys application: describe it once, connect its data sources, and Beacon builds its query universe, discovery plan, audits and opportunities.")}
        </EmptyState>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
          <Panel eyebrow={t("Priority queue")} title={attention.length ? t("{n} item(s), ranked by impact · confidence · effort · urgency", { n: attention.length }) : t("Nothing needs attention")} pad={false}>
            {attention.length ? (
              <ol>
                {attention.map((a, i) => (
                  <li key={a.key} className="border-b border-line/60 last:border-0">
                    <Link href={a.href} className="flex items-start gap-4 px-4 py-3 hover:bg-panel-2">
                      <span className="num w-6 pt-0.5 text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-platinum">{a.title}</span>
                        <span className="block truncate text-xs text-muted">{a.detail}</span>
                      </span>
                      <span className="num hidden text-[10px] text-muted sm:block" title={t("impact · confidence · effort · urgency")}>
                        I{a.impact} C{a.confidence} E{a.effort} U{a.urgency}
                      </span>
                      <span className="num w-10 text-right text-xs text-gold">{a.priority}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="p-4 text-sm text-muted">{t("All clear. Run audits, sync data sources and generate opportunities to surface work.")}</p>
            )}
          </Panel>
          <div className="flex flex-col gap-3">
            <Stat label={t("New attributed MRR · 7d")} value={k.revenue.beaconNewMrr.now === null ? null : mrr7} fmt="money" currency={(c.currency as string) ?? "EUR"} source={t("Beacon channels")} href="/revenue" />
            <Stat label={t("MRR attributable to Beacon")} value={k.revenue.beaconMrr.now} fmt="money" currency={k.currency} source={t(k.revenue.beaconMrr.source)} href="/revenue" />
            <Panel eyebrow={t("Products")} title={t("Beacon scores")} pad={false}>
              <ul>
                {data.products.map((p) => (
                  <li key={p.id} className="flex items-center justify-between border-b border-line/60 px-4 py-2.5 last:border-0">
                    <Link href={`/products/${p.slug}`} className="text-sm text-chrome hover:text-platinum">
                      {p.name}
                    </Link>
                    <span className="num text-sm text-platinum">{data.scores.has(p.id) ? Math.round(data.scores.get(p.id)!.total) : <span className="text-xs text-muted">—</span>}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}

      <section className="mt-10">
        <div className="eyebrow mb-3">{t("Discovery · last {days} days vs previous {days}", { days })}</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label={t("Organic impressions")} value={k.discovery.organicImpressions.now} prev={k.discovery.organicImpressions.prev} source={t(k.discovery.organicImpressions.source)} />
          <Stat label={t("Organic clicks")} value={k.discovery.organicClicks.now} prev={k.discovery.organicClicks.prev} source={t(k.discovery.organicClicks.source)} />
          <Stat label={t("Indexable pages")} value={k.discovery.indexedPages.now} source={t(k.discovery.indexedPages.source)} />
          <Stat label={t("Covered queries")} value={k.discovery.coveredQueries.now} source={t(k.discovery.coveredQueries.source)} href="/queries" />
          <Stat label={t("Branded impressions")} value={k.discovery.brandedImpressions.now} prev={k.discovery.brandedImpressions.prev} source={t(k.discovery.brandedImpressions.source)} />
          <Stat label={t("AI referrals")} value={k.discovery.aiReferrals.now} prev={k.discovery.aiReferrals.prev} source={t(k.discovery.aiReferrals.source)} />
          <Stat label={t("Observed AI mentions")} value={k.discovery.aiMentions.now} prev={k.discovery.aiMentions.prev} source={t(k.discovery.aiMentions.source)} href="/ai-visibility" />
        </div>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">{t("Acquisition")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("Visitors")} value={k.acquisition.visitors.now} prev={k.acquisition.visitors.prev} source={t(k.acquisition.visitors.source)} href="/conversions" />
            <Stat label={t("Signups")} value={k.acquisition.signups.now} prev={k.acquisition.signups.prev} source={t(k.acquisition.signups.source)} />
            <Stat label={t("Trials")} value={k.acquisition.trials.now} prev={k.acquisition.trials.prev} source={t(k.acquisition.trials.source)} />
            <Stat label={t("Activations")} value={k.acquisition.activations.now} prev={k.acquisition.activations.prev} source={t(k.acquisition.activations.source)} />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3">{t("Revenue")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("New subscriptions")} value={k.revenue.newSubscriptions.now} prev={k.revenue.newSubscriptions.prev} source={t(k.revenue.newSubscriptions.source)} href="/revenue" />
            <Stat label={t("ARR")} value={k.revenue.arr.now} fmt="money" currency={k.currency} source={t(k.revenue.arr.source)} />
            <Stat label={t("Conversion rate")} value={k.revenue.conversionRate.now} prev={k.revenue.conversionRate.prev} fmt="percent" source={t(k.revenue.conversionRate.source)} />
            <Stat label={t("Revenue in period")} value={k.revenue.revenue.now} prev={k.revenue.revenue.prev} fmt="money" currency={k.currency} source={t(k.revenue.revenue.source)} />
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">{t("Ecosystem")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("Cross-sell conversion")} value={k.ecosystem.crossSellRate.now} prev={k.ecosystem.crossSellRate.prev} fmt="percent" source={t(k.ecosystem.crossSellRate.source)} href="/autopilot#cross-sell" />
            <Stat label={t("Multi-product users")} value={k.ecosystem.multiProductUsers.now} source={t(k.ecosystem.multiProductUsers.source)} />
            <Stat label={t("Referral conversions")} value={k.ecosystem.referralConversions.now} prev={k.ecosystem.referralConversions.prev} source={t(k.ecosystem.referralConversions.source)} href="/referrals" />
            <Stat label={t("Affiliate revenue")} value={k.ecosystem.affiliateRevenue.now} prev={k.ecosystem.affiliateRevenue.prev} fmt="money" currency={k.currency} source={t(k.ecosystem.affiliateRevenue.source)} />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3">{t("Content")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("Published assets")} value={k.content.published.now} source={t(k.content.published.source)} href="/content" />
            <Stat label={t("Published this period")} value={k.content.publishedInPeriod.now} prev={k.content.publishedInPeriod.prev} source={t(k.content.publishedInPeriod.source)} />
          </div>
        </div>
      </section>

      <Panel eyebrow={t("Trend")} title={t("Visitors, signups & AI referrals · last {days} days", { days })} className="mt-8">
        {k.acquisition.visitors.now === null ? (
          <p className="text-sm text-muted">{t("No first-party events yet — install the Beacon tracker from a product’s Tracking tab.")}</p>
        ) : (
          <LineChart
            title={t("Daily visitors, signups and AI referrals")}
            series={[
              { key: "v", label: t("Visitors"), color: "var(--color-s1)", points: data.series.map((d) => ({ x: d.day, y: d.visitors })) },
              { key: "s", label: t("Signups"), color: "var(--color-s3)", points: data.series.map((d) => ({ x: d.day, y: d.signups })) },
              { key: "a", label: t("AI referrals"), color: "var(--color-s2)", points: data.series.map((d) => ({ x: d.day, y: d.ai })) },
            ]}
          />
        )}
      </Panel>

      <Panel eyebrow={t("Definitions")} title={t("How these numbers are defined")} className="mt-8">
        <Table>
          <tbody>
            <tr>
              <Th>{t("Attributable to Beacon")}</Th>
              <Td>{t("Revenue whose acquisition channel is {channels} under the organisation’s attribution rules (default: last non-direct touch, 30-day lookback, referral precedence).", { channels: BEACON_CHANNELS.map(channelLabel).join(", ") })}</Td>
            </tr>
            <tr>
              <Th>{t("AI mentions")}</Th>
              <Td>{t("Sampled observations from AI-visibility tests run through official APIs. They do not represent every user’s AI response.")}</Td>
            </tr>
            <tr>
              <Th>{t("Deltas")}</Th>
              <Td>{t("Current window vs the immediately preceding window of equal length. Example: {value} vs previous shows ▲/▼ percentage.", { value: formatValue(1234, "count", undefined, intl) })}</Td>
            </tr>
          </tbody>
        </Table>
      </Panel>
    </>
  );
}
