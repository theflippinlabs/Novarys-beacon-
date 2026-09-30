import Link from "next/link";
import { sql } from "drizzle-orm";
import { EmptyState, LinkButton, PageHeader, Panel, Stat, Table, Td, Th, formatValue } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { RangePicker } from "@/components/shell/product-tabs";
import { prioritizeAttention, type AttentionItem } from "@/core/command/attention";
import { dailySeries, kpis, BEACON_CHANNELS } from "@/services/metrics";
import { latestScores } from "@/services/score";
import { daysParam, pageData, type SP } from "@/lib/page";

export const metadata = { title: "Command center" };

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
  const c = data.counts;
  const n = (v: unknown) => Number(v ?? 0);
  const k = data.k;

  const items: AttentionItem[] = [
    { key: "crit", title: `${n(c.critical_issues)} critical SEO problem${n(c.critical_issues) === 1 ? "" : "s"}`, detail: "Open critical issues in the latest technical audits.", href: "/discovery", count: n(c.critical_issues), impact: 5, confidence: 5, effort: 2, urgency: 5 },
    { key: "losing", title: `${data.losing.length} product${data.losing.length === 1 ? "" : "s"} losing organic visibility`, detail: data.losing.map((l) => `${l.name} (${Math.round((1 - l.now / l.prev) * 100)}% fewer clicks)`).join(", "), href: "/opportunities", count: data.losing.length, impact: 5, confidence: 4, effort: 3, urgency: 5 },
    { key: "opps", title: `${n(c.high_opps)} high-potential opportunit${n(c.high_opps) === 1 ? "y" : "ies"}`, detail: "Prioritised by impact × confidence × urgency ÷ effort.", href: "/opportunities?potential=HIGH", count: n(c.high_opps), impact: 4, confidence: 3, effort: 3, urgency: 3 },
    { key: "drafts", title: `${n(c.drafts_ready)} content draft${n(c.drafts_ready) === 1 ? "" : "s"} ready for approval`, detail: "Passed fact and SEO/GEO checks — awaiting a human decision.", href: "/content?status=HUMAN_APPROVAL", count: n(c.drafts_ready), impact: 3, confidence: 5, effort: 1, urgency: 3 },
    { key: "blocked", title: `${n(c.drafts_blocked)} draft${n(c.drafts_blocked) === 1 ? "" : "s"} blocked by checks`, detail: "Unsupported claims or SEO issues need an editor.", href: "/content", count: n(c.drafts_blocked), impact: 2, confidence: 5, effort: 2, urgency: 2 },
    { key: "dist", title: `${n(c.dist_pending)} external submission${n(c.dist_pending) === 1 ? "" : "s"} awaiting approval`, detail: "Prepared distribution targets — nothing is submitted without approval.", href: "/distribution", count: n(c.dist_pending), impact: 3, confidence: 3, effort: 1, urgency: 2 },
    { key: "recs", title: `${n(c.recs)} autopilot recommendation${n(c.recs) === 1 ? "" : "s"} to review`, detail: "Proposed by the growth analyst.", href: "/autopilot", count: n(c.recs), impact: 3, confidence: 3, effort: 1, urgency: 2 },
    { key: "exp", title: `${n(c.experiments_ready)} experiment${n(c.experiments_ready) === 1 ? "" : "s"} ready for review`, detail: "Conclude and record results.", href: "/autopilot#experiments", count: n(c.experiments_ready), impact: 3, confidence: 4, effort: 1, urgency: 3 },
    { key: "ref", title: `${n(c.referral_conv)} new referral conversion${n(c.referral_conv) === 1 ? "" : "s"} (7d)`, detail: "New subscriptions attributed to referral/affiliate links.", href: "/referrals", count: n(c.referral_conv), impact: 2, confidence: 5, effort: 1, urgency: 1 },
    { key: "hold", title: `${n(c.commissions_hold)} commission${n(c.commissions_hold) === 1 ? "" : "s"} on hold (fraud flags)`, detail: "Review before payout.", href: "/referrals", count: n(c.commissions_hold), impact: 2, confidence: 4, effort: 1, urgency: 3 },
    { key: "integ", title: `${n(c.integ_errors)} integration${n(c.integ_errors) === 1 ? "" : "s"} failing`, detail: "Data is going stale.", href: "/settings/integrations", count: n(c.integ_errors), impact: 4, confidence: 5, effort: 1, urgency: 4 },
    { key: "jobs", title: `${data.failedJobs} background job${data.failedJobs === 1 ? "" : "s"} failed (24h)`, detail: "Exhausted retries.", href: "/settings/health", count: data.failedJobs, impact: 3, confidence: 5, effort: 1, urgency: 3 },
    { key: "onb", title: `${n(c.onboarding_open)} product${n(c.onboarding_open) === 1 ? "" : "s"} with incomplete onboarding`, detail: "Finish onboarding to start analysis.", href: "/products", count: n(c.onboarding_open), impact: 4, confidence: 5, effort: 2, urgency: 2 },
  ];
  const attention = prioritizeAttention(items);
  const mrr7 = n(c.beacon_mrr_7d);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <PageHeader eyebrow={`01 / Overview · ${today}`} title="What needs my attention today?" description={`${ctx.org.branding.displayName ?? ctx.org.name} ecosystem — ${n(c.products)} product(s). Everything below is measured; unconnected sources are shown as such, never estimated.`} actions={<RangePicker base="/" days={days} />} />

      {n(c.products) === 0 ? (
        <EmptyState title="Start here" action={<LinkButton variant="gold" href="/products">Add your first product →</LinkButton>}>
          Beacon has no products yet. Onboard a Novarys application: describe it once, connect its data sources, and Beacon builds its query universe, discovery plan, audits and opportunities.
        </EmptyState>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
          <Panel eyebrow="Priority queue" title={attention.length ? `${attention.length} item(s), ranked by impact · confidence · effort · urgency` : "Nothing needs attention"} pad={false}>
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
                      <span className="num hidden text-[10px] text-muted sm:block" title="impact · confidence · effort · urgency">
                        I{a.impact} C{a.confidence} E{a.effort} U{a.urgency}
                      </span>
                      <span className="num w-10 text-right text-xs text-gold">{a.priority}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="p-4 text-sm text-muted">All clear. Run audits, sync data sources and generate opportunities to surface work.</p>
            )}
          </Panel>
          <div className="flex flex-col gap-3">
            <Stat label="New attributed MRR · 7d" value={k.revenue.beaconNewMrr.now === null ? null : mrr7} fmt="money" currency={(c.currency as string) ?? "EUR"} source="Beacon channels" href="/revenue" />
            <Stat label="MRR attributable to Beacon" value={k.revenue.beaconMrr.now} fmt="money" currency={k.currency} source={k.revenue.beaconMrr.source} href="/revenue" />
            <Panel eyebrow="Products" title="Beacon scores" pad={false}>
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
        <div className="eyebrow mb-3">Discovery · last {days} days vs previous {days}</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Organic impressions" value={k.discovery.organicImpressions.now} prev={k.discovery.organicImpressions.prev} source={k.discovery.organicImpressions.source} />
          <Stat label="Organic clicks" value={k.discovery.organicClicks.now} prev={k.discovery.organicClicks.prev} source={k.discovery.organicClicks.source} />
          <Stat label="Indexable pages" value={k.discovery.indexedPages.now} source={k.discovery.indexedPages.source} />
          <Stat label="Covered queries" value={k.discovery.coveredQueries.now} source={k.discovery.coveredQueries.source} href="/queries" />
          <Stat label="Branded impressions" value={k.discovery.brandedImpressions.now} prev={k.discovery.brandedImpressions.prev} source={k.discovery.brandedImpressions.source} />
          <Stat label="AI referrals" value={k.discovery.aiReferrals.now} prev={k.discovery.aiReferrals.prev} source={k.discovery.aiReferrals.source} />
          <Stat label="Observed AI mentions" value={k.discovery.aiMentions.now} prev={k.discovery.aiMentions.prev} source={k.discovery.aiMentions.source} href="/ai-visibility" />
        </div>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">Acquisition</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Visitors" value={k.acquisition.visitors.now} prev={k.acquisition.visitors.prev} source={k.acquisition.visitors.source} href="/conversions" />
            <Stat label="Signups" value={k.acquisition.signups.now} prev={k.acquisition.signups.prev} source={k.acquisition.signups.source} />
            <Stat label="Trials" value={k.acquisition.trials.now} prev={k.acquisition.trials.prev} source={k.acquisition.trials.source} />
            <Stat label="Activations" value={k.acquisition.activations.now} prev={k.acquisition.activations.prev} source={k.acquisition.activations.source} />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3">Revenue</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="New subscriptions" value={k.revenue.newSubscriptions.now} prev={k.revenue.newSubscriptions.prev} source={k.revenue.newSubscriptions.source} href="/revenue" />
            <Stat label="ARR" value={k.revenue.arr.now} fmt="money" currency={k.currency} source={k.revenue.arr.source} />
            <Stat label="Conversion rate" value={k.revenue.conversionRate.now} prev={k.revenue.conversionRate.prev} fmt="percent" source={k.revenue.conversionRate.source} />
            <Stat label="Revenue in period" value={k.revenue.revenue.now} prev={k.revenue.revenue.prev} fmt="money" currency={k.currency} source={k.revenue.revenue.source} />
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">Ecosystem</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Cross-sell conversion" value={k.ecosystem.crossSellRate.now} prev={k.ecosystem.crossSellRate.prev} fmt="percent" source={k.ecosystem.crossSellRate.source} href="/autopilot#cross-sell" />
            <Stat label="Multi-product users" value={k.ecosystem.multiProductUsers.now} source={k.ecosystem.multiProductUsers.source} />
            <Stat label="Referral conversions" value={k.ecosystem.referralConversions.now} prev={k.ecosystem.referralConversions.prev} source={k.ecosystem.referralConversions.source} href="/referrals" />
            <Stat label="Affiliate revenue" value={k.ecosystem.affiliateRevenue.now} prev={k.ecosystem.affiliateRevenue.prev} fmt="money" currency={k.currency} source={k.ecosystem.affiliateRevenue.source} />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3">Content</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Published assets" value={k.content.published.now} source={k.content.published.source} href="/content" />
            <Stat label="Published this period" value={k.content.publishedInPeriod.now} prev={k.content.publishedInPeriod.prev} source={k.content.publishedInPeriod.source} />
          </div>
        </div>
      </section>

      <Panel eyebrow="Trend" title={`Visitors, signups & AI referrals · last ${days} days`} className="mt-8">
        {k.acquisition.visitors.now === null ? (
          <p className="text-sm text-muted">No first-party events yet — install the Beacon tracker from a product’s Tracking tab.</p>
        ) : (
          <LineChart
            title="Daily visitors, signups and AI referrals"
            series={[
              { key: "v", label: "Visitors", color: "var(--color-s1)", points: data.series.map((d) => ({ x: d.day, y: d.visitors })) },
              { key: "s", label: "Signups", color: "var(--color-s3)", points: data.series.map((d) => ({ x: d.day, y: d.signups })) },
              { key: "a", label: "AI referrals", color: "var(--color-s2)", points: data.series.map((d) => ({ x: d.day, y: d.ai })) },
            ]}
          />
        )}
      </Panel>

      <Panel eyebrow="Definitions" title="How these numbers are defined" className="mt-8">
        <Table>
          <tbody>
            <tr>
              <Th>Attributable to Beacon</Th>
              <Td>Revenue whose acquisition channel is {BEACON_CHANNELS.join(", ").toLowerCase()} under the organisation’s attribution rules (default: last non-direct touch, 30-day lookback, referral precedence).</Td>
            </tr>
            <tr>
              <Th>AI mentions</Th>
              <Td>Sampled observations from AI-visibility tests run through official APIs. They do not represent every user’s AI response.</Td>
            </tr>
            <tr>
              <Th>Deltas</Th>
              <Td>Current window vs the immediately preceding window of equal length. Example: {formatValue(1234)} vs previous shows ▲/▼ percentage.</Td>
            </tr>
          </tbody>
        </Table>
      </Panel>
    </>
  );
}
