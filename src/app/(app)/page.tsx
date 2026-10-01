import Link from "next/link";
import { EmptyState, LinkButton, PageHeader, Panel, Stat, Table, Td, Th, formatValue } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { RangePicker } from "@/components/shell/product-tabs";
import { prioritizeAttention, type AttentionItem } from "@/core/command/attention";
import { BEACON_CHANNELS } from "@/services/metrics";
import { attentionItems, commandCenterData } from "@/services/overview";
import { daysParam, pageData, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Command center") };
}

export default async function CommandCenter({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const days = daysParam(sp);
  const { data, ctx } = await pageData((tx, ctx) => commandCenterData(tx, ctx.org.id, days));
  const { t, intl, locale } = await getI18n();
  const c = data.counts;
  const n = (v: unknown) => Number(v ?? 0);
  const k = data.k;

  const items: AttentionItem[] = attentionItems(data, t);
  const attention = prioritizeAttention(items);
  const mrr7 = n(c.beacon_mrr_7d);
  const channelLabel = (v: string) => (locale === "fr" ? enumLabel(t, v) : v).toLocaleLowerCase(intl);
  const today = new Date().toLocaleDateString(intl, { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <PageHeader eyebrow={t("01 / Overview · {date}", { date: today })} title={t("What needs my attention today?")} description={t("{org} ecosystem: {n} product(s). Everything below is measured; unconnected sources are shown as such, never estimated.", { org: ctx.org.branding.displayName ?? ctx.org.name, n: n(c.products) })} actions={<RangePicker base="/" days={days} />} />

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
                    <span className="num text-sm text-platinum">{data.scores.has(p.id) ? Math.round(data.scores.get(p.id)!.total) : <span className="text-xs text-muted">{t("n/a")}</span>}</span>
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
          <p className="text-sm text-muted">{t("No first-party events yet. Install the Beacon tracker from a product’s Tracking tab.")}</p>
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
